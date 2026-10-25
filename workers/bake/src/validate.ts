// Deep checks of a raw capture package before baking (docs/capture-format.md,
// docs/architecture-v3.md §3). Every problem is a plain sentence a family member could read;
// the job fails without retrying when there are any.
import { parseDepthIndex, type DepthIndex } from '../../../shared/depth'
import type { Manifest } from '../../../shared/manifest'
import { parseFramesJsonl, type FrameLog } from '../../../web/src/scene/formats'

/** File name → size in bytes, for every raw file the capture has. */
export type Listing = ReadonlyMap<string, number>

export class ValidationError extends Error {
  constructor(readonly errors: string[]) {
    super(errors.join(' '))
  }
}

/** The keyframe files in the manifest, in second order (the browser's names: `kNNNN.jpg`). */
export function keyframeFiles(m: Manifest): { file: string; t: number }[] {
  const kf = m.keyframes
  if (!kf || !(kf.count > 0)) return []
  return Array.from({ length: kf.count }, (_, s) => ({ file: `${kf.dir}/k${String(s).padStart(4, '0')}.jpg`, t: s * kf.everySec }))
}

/** The raw files the bake reads (the video, transcript and thumbnail aren't needed). */
export function bakeInputs(m: Manifest): string[] {
  const names = ['manifest.json', 'frames.jsonl', m.depth.file]
  if (m.room?.bin) names.push(m.room.bin)
  if (m.depth.encoding === 'v2') names.push(m.depth.index)
  else names.push(m.depth.confidenceFile)
  for (const k of keyframeFiles(m)) names.push(k.file)
  return names
}

const positiveInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x > 0

/** Checks the manifest's own fields and which files exist with which sizes (no file contents needed). */
export function checkListing(m: Manifest, listing: Listing): string[] {
  const errors: string[] = []
  const v = m.video
  if (!positiveInt(v.frameCount)) errors.push('manifest.video.frameCount must be a whole number above 0.')
  if (!positiveInt(v.width) || !positiveInt(v.height)) errors.push('manifest.video needs its width and height in pixels.')
  if (!listing.has(v.file)) errors.push(`The video ${v.file} is missing.`)
  const d = m.depth
  const sizesOk = positiveInt(d.width) && positiveInt(d.height) && Number.isInteger(d.count) && d.count >= 0
  if (!sizesOk) errors.push('manifest.depth needs a width, height and frame count.')

  const need = (name: string, bytes: number | null, what: string) => {
    const size = listing.get(name)
    if (size === undefined) errors.push(`${name} is missing (${what}).`)
    else if (bytes !== null && size !== bytes) errors.push(`${name} is ${size} bytes, but the manifest implies ${bytes} (${what}).`)
    else if (size === 0) errors.push(`${name} is empty (${what}).`)
  }
  need('frames.jsonl', null, 'camera poses')
  if (sizesOk) {
    const px = d.width * d.height
    if (d.encoding === 'v2') {
      need(d.index, null, 'the depth index')
      need(d.file, null, `${d.count} depth frames, compressed`)
    } else {
      need(d.file, d.count * px * 2, `${d.count} depth frames of ${d.width}×${d.height} UInt16`)
      need(d.confidenceFile, d.count * px, `${d.count} confidence frames of ${d.width}×${d.height} UInt8`)
    }
  }
  if (!m.room?.bin) errors.push('manifest.room.bin is missing: there is no room cloud to bake.')
  else if (!positiveInt(m.room.points)) errors.push('manifest.room.points must be a whole number above 0.')
  else need(m.room.bin, 4 + m.room.points * 15, `${m.room.points} room points`)
  for (const k of keyframeFiles(m)) if (!listing.has(k.file)) errors.push(`The keyframe ${k.file} is missing.`)
  return errors
}

/** room.bin's header against the manifest. */
export function checkRoomBin(m: Manifest, bytes: Uint8Array): string[] {
  if (bytes.byteLength < 4) return [`${m.room?.bin} is too short to hold a point count.`]
  const count = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true)
  return count === m.room?.points ? [] : [`${m.room?.bin} says ${count} points, but manifest.room.points is ${m.room?.points}.`]
}

/** Parses frames.jsonl and checks it against the manifest. */
export function checkFrames(m: Manifest, text: string): { frames: FrameLog | null; errors: string[] } {
  let frames: FrameLog
  try {
    frames = parseFramesJsonl(text)
  } catch (e) {
    return { frames: null, errors: [`${(e as Error).message}.`] }
  }
  const errors: string[] = []
  if (frames.moment.length !== m.video.frameCount) errors.push(`frames.jsonl has ${frames.moment.length} moment lines, but manifest.video.frameCount is ${m.video.frameCount}.`)
  const bad = [...frames.scan, ...frames.moment].filter((f) => f.d !== null && !(Number.isInteger(f.d) && f.d >= 0 && f.d < m.depth.count))
  if (bad.length > 0) errors.push(`frames.jsonl points at depth frame ${bad[0].d} (and ${bad.length - 1} more bad ones), but manifest.depth.count is ${m.depth.count}.`)
  return { frames, errors }
}

/** depth.index.json (v2) against the manifest and the size of depth.bin. */
export function checkDepthIndex(m: Manifest, json: string, binBytes: number): { index: DepthIndex | null; errors: string[] } {
  let index: DepthIndex
  try {
    index = parseDepthIndex(json)
  } catch (e) {
    return { index: null, errors: [(e as Error).message] }
  }
  const errors: string[] = []
  const d = m.depth
  if (index.width !== d.width || index.height !== d.height || index.count !== d.count)
    errors.push(`depth.index.json describes ${index.count} frames of ${index.width}×${index.height}, but the manifest says ${d.count} of ${d.width}×${d.height}.`)
  let end = 0
  for (const [offset, length] of index.chunks) {
    if (offset !== end || !(length > 0)) {
      errors.push('depth.index.json chunks must follow each other with no gaps.')
      break
    }
    end = offset + length
  }
  if (errors.length === 0 && end !== binBytes) errors.push(`depth.index.json covers ${end} bytes, but ${d.file} is ${binBytes} bytes.`)
  return { index, errors }
}
