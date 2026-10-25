// The bake job (docs/architecture-v3.md §4): a raw capture folder in, the derived files out.
// Runs the same way from the job loop (worker.ts) and the command line (cli.ts).
import { join } from 'node:path'
import type { Derived } from '../../../backend/convex/validators'
import type { DepthIndex } from '../../../shared/depth'
import { parseManifest, type Manifest } from '../../../shared/manifest'
import { parseRoomBin } from '../../../web/src/scene/formats'
import { depthSource, fromV1, fromV2, type DepthV2 } from './depth'
import { smallKeyframe } from './keyframes'
import { bakePoints } from './points'
import { bakeSurface, bakeTimeline, pickKeyframes, type RoomKeyframe } from './room'
import { encodeSurface, encodeTimeline, indexMesh } from './surfacePack'
import { checkDepthIndex, checkFrames, checkListing, checkRoomBin, keyframeFiles, ValidationError, type Listing } from './validate'

export interface Progress {
  stage: string
  fraction: number | null
  message: string
}

export interface BakeOptions {
  bakeVersion: string
  /** Called between stages; may be async (the job loop sends a heartbeat). */
  onProgress?: (p: Progress) => void | Promise<void>
  /** Aborts between stages (the job was cancelled). */
  signal?: AbortSignal
}

export interface DerivedFile {
  name: string
  bytes: Uint8Array
  contentType: string
  /** Stored gzip-compressed with Content-Encoding: gzip (everything but depth.bin, §2). */
  gzip: boolean
}

export interface BakeResult {
  derived: Derived
  files: DerivedFile[]
  /** Milliseconds per stage. */
  timings: Record<string, number>
}

const BIN = 'application/octet-stream'
const JSON_TYPE = 'application/json'

/** Bakes the capture whose raw files are in `dir`. `listing` names every raw file the capture has (with sizes). */
export async function bakeCapture(dir: string, listing: Listing, o: BakeOptions): Promise<BakeResult> {
  const started = performance.now()
  const timings: Record<string, number> = {}
  let mark = started
  const stage = async (name: string, fraction: number, message: string) => {
    const now = performance.now()
    timings[name] = Math.round(now - mark)
    mark = now
    o.signal?.throwIfAborted()
    await o.onProgress?.({ stage: 'bake', fraction, message })
    // Let timers (heartbeats) run between the long synchronous steps.
    await new Promise((r) => setTimeout(r, 0))
    o.signal?.throwIfAborted()
  }
  const read = (name: string) => Bun.file(join(dir, name)).bytes()
  const text = async (name: string) => new TextDecoder().decode(await read(name))

  if (!listing.has('manifest.json')) throw new ValidationError(['manifest.json is missing.'])
  let m: Manifest
  try {
    m = parseManifest(await text('manifest.json'))
  } catch (e) {
    throw new ValidationError([(e as Error).message])
  }
  const listingErrors = checkListing(m, listing)
  if (listingErrors.length) throw new ValidationError(listingErrors)
  const room = m.room!
  const d = m.depth

  const roomBytes = await read(room.bin)
  const framesCheck = checkFrames(m, await text('frames.jsonl'))
  const errors = [...checkRoomBin(m, roomBytes), ...framesCheck.errors]
  let depthBin: Uint8Array = await read(d.file)
  let v2Index: DepthIndex | null = null
  if (d.encoding === 'v2') {
    const check = checkDepthIndex(m, await text(d.index), depthBin.byteLength)
    errors.push(...check.errors)
    v2Index = check.index
  }
  if (errors.length) throw new ValidationError(errors)
  const frames = framesCheck.frames!
  await stage('validate', 0.05, 'Checked the capture')

  let depth: DepthV2
  if (d.encoding === 'v2') {
    try {
      depth = await fromV2(depthBin, v2Index!)
    } catch (e) {
      throw new ValidationError([`${d.file} can't be read: ${(e as Error).message}`])
    }
  } else {
    depth = await fromV1(depthBin, await read(d.confidenceFile), { width: d.width, height: d.height, count: d.count })
  }
  depthBin = new Uint8Array(0) // only depth.bin v2 is kept from here
  await stage('depth', 0.15, 'Compressed the depth')

  const cloud = parseRoomBin(roomBytes.buffer as ArrayBuffer)
  const points = bakePoints(cloud.positions, cloud.colors)
  await stage('points', 0.3, 'Ordered the room points')

  const all = keyframeFiles(m)
  const picked = pickKeyframes(all.length).map((s) => all[s])
  const keyframes: RoomKeyframe[] = []
  const badKeyframes: string[] = []
  for (const k of picked) {
    try {
      keyframes.push({ ...k, small: await smallKeyframe(k.file, await read(k.file), d.width, d.height) })
    } catch (e) {
      badKeyframes.push((e as Error).message)
    }
  }
  if (badKeyframes.length) throw new ValidationError(badKeyframes)
  await stage('keyframes', 0.35, 'Read the keyframes')

  const files: DerivedFile[] = [{ name: 'points.pack', bytes: points.bytes, contentType: BIN, gzip: true }]
  const filesMeta: Derived['files'] = { points: 'points.pack' }
  const stats: Derived['stats'] = { points: points.meta.count, bakeMs: 0 }
  const built = bakeSurface({
    frames,
    depth: depthSource(depth.packed, d.width * d.height),
    depthW: d.width,
    depthH: d.height,
    videoW: m.video.width,
    videoH: m.video.height,
    points: cloud.positions,
    colors: cloud.colors,
    keyframes,
  })
  if (built) {
    const mesh = indexMesh(built.surface)
    files.push({ name: 'surface.pack', bytes: encodeSurface(mesh, built.grid, keyframes.map(({ file, t }) => ({ file, t }))), contentType: BIN, gzip: true })
    filesMeta.surface = 'surface.pack'
    stats.surfaceTriangles = mesh.indices.length / 3
    await stage('surface', 0.75, 'Built the room surface')
    const timeline = bakeTimeline(built)
    if (timeline) {
      files.push({ name: 'timeline.pack', bytes: encodeTimeline(timeline, built.grid, built.skip), contentType: BIN, gzip: true })
      filesMeta.timeline = 'timeline.pack'
      stats.timelineVoxels = timeline.positions.length / 3
      await stage('timeline', 0.95, 'Built the visit timeline')
    }
  }

  files.push({ name: 'depth.bin', bytes: depth.bin, contentType: BIN, gzip: false })
  files.push({ name: 'depth.index.json', bytes: new TextEncoder().encode(JSON.stringify(depth.index)), contentType: JSON_TYPE, gzip: true })
  filesMeta.depth = 'depth.bin'
  filesMeta.depthIndex = 'depth.index.json'
  stats.bakeMs = Math.round(performance.now() - started)
  const derived: Derived = {
    format: 'braindance.derived',
    version: 1,
    captureId: m.id,
    bakedAt: new Date().toISOString(),
    bakeVersion: o.bakeVersion,
    files: filesMeta,
    stats,
  }
  // derived.json also records where the time went (readers ignore unknown keys).
  files.push({ name: 'derived.json', bytes: new TextEncoder().encode(JSON.stringify({ ...derived, timings }, null, 2)), contentType: JSON_TYPE, gzip: true })
  return { derived, files, timings }
}
