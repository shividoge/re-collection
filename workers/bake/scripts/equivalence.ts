// Shows the bake makes the same room as the browser did: runs the web's own
// web/src/scene/surfaceWorker.ts (unchanged, fed exactly as useRoomSurface.ts fed it from the raw
// v1 files) next to bakeCapture, and compares surface and timeline. v3 deleted that file from the
// web, so it's taken from git at the last commit that had it (BROWSER_COMMIT), with its imports
// pointed at today's pure modules (align, surface, timeline), which the bake uses too.
//
//   bun scripts/equivalence.ts <captureDir>...
//
// The browser decoded keyframes with createImageBitmap; here both sides get the same sharp
// decode (keyframes.ts), so this compares the geometry pipeline, not two JPEG resizers. The
// keyframe pixels only color the timeline voxels; which voxels exist doesn't depend on them.
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { decodePack, packArray } from '../../../shared/pack'
import { parseManifest } from '../../../shared/manifest'
import { parseFramesJsonl, parseRoomBin, type FrameRecord } from '../../../web/src/scene/formats'
import type { RoomMesh } from '../../../web/src/scene/surface'
import type { Grid } from '../../../web/src/scene/surface'
import type { Timeline } from '../../../web/src/scene/timeline'
import { bakeCapture } from '../src/bake'
import { smallKeyframe } from '../src/keyframes'
import { listDir } from '../src/listing'
import { pickKeyframes } from '../src/room'
import { keyframeFiles } from '../src/validate'

// surfaceWorker.ts's job and message shapes, as at BROWSER_COMMIT.
interface DepthRun {
  views: { T: number[]; K: number[]; t: number; offset: number }[]
  depth: ArrayBuffer
  confidence: ArrayBuffer
}
interface SurfaceJob {
  scan: DepthRun
  moment: (DepthRun & { keyframes: { t: number; T: number[]; K: number[]; small: ImageBitmap }[] }) | null
  depthW: number
  depthH: number
  videoW: number
  videoH: number
  points: Float32Array
  colors: Uint8Array
}
type SurfaceMessage = { kind: 'surface'; surface: RoomMesh } | { kind: 'timeline'; timeline: Timeline; grid: Grid; skip: Uint8Array }

// ---- the browser side, with the two browser-only APIs it touches shimmed -----------------

type FakeBitmap = { width: number; height: number; data: Uint8ClampedArray; close(): void }
class FakeCanvas {
  private pixels: Uint8ClampedArray | null = null
  getContext() {
    return {
      drawImage: (img: FakeBitmap) => (this.pixels = img.data),
      getImageData: () => ({ data: this.pixels }),
    }
  }
}
const g = globalThis as unknown as { OffscreenCanvas: unknown; postMessage: (m: SurfaceMessage) => void; onmessage: ((e: { data: SurfaceJob }) => void) | null }
g.OffscreenCanvas = FakeCanvas
let received: SurfaceMessage[] = []
g.postMessage = (m) => received.push(m)
const BROWSER_COMMIT = 'a46255c'
const scene = resolve(import.meta.dir, '../../../web/src/scene')
const git = Bun.spawnSync(['git', 'show', `${BROWSER_COMMIT}:web/src/scene/surfaceWorker.ts`], { cwd: import.meta.dir })
if (!git.success) throw new Error(`Can't read surfaceWorker.ts from git commit ${BROWSER_COMMIT}: ${git.stderr.toString()}`)
const workerFile = join(await mkdtemp(join(tmpdir(), 'bd-browser-')), 'surfaceWorker.ts')
await writeFile(workerFile, git.stdout.toString().replaceAll("from './", `from '${scene}/`))
await import(workerFile)
const runWorker = g.onmessage!

async function browserBuild(dir: string): Promise<{ surface: RoomMesh | null; timeline: (Timeline & { skip: Uint8Array }) | null; ms: number }> {
  const read = (name: string) => Bun.file(join(dir, name)).arrayBuffer()
  const manifest = parseManifest(await Bun.file(join(dir, 'manifest.json')).text())
  if (manifest.depth.encoding === 'v2') throw new Error('The browser path read v1 depth only.')
  const { width, height, file, confidenceFile } = manifest.depth
  const frames = parseFramesJsonl(await Bun.file(join(dir, 'frames.jsonl')).text())
  const cloud = parseRoomBin(await read(manifest.room!.bin))
  const depthAll = await read(file)
  const confAll = await read(confidenceFile)
  const px = width * height
  // useRoomSurface.ts depthRun
  const depthRun = (fs: FrameRecord[]): DepthRun => {
    const ks = fs.map((f) => f.d as number)
    const first = Math.min(...ks)
    const last = Math.max(...ks)
    return {
      views: fs.map((f) => ({ T: f.T, K: f.K, t: f.t, offset: (f.d as number) - first })),
      depth: depthAll.slice(first * px * 2, (last + 1) * px * 2),
      confidence: confAll.slice(first * px, (last + 1) * px),
    }
  }
  const scan = frames.scan.filter((f) => f.d !== null)
  const allMoment = frames.moment
  const moment = allMoment.filter((f) => f.d !== null)
  if (scan.length === 0) return { surface: null, timeline: null, ms: 0 }
  // useRoomSurface.ts loadKeyframes
  const all = keyframeFiles(manifest)
  const infos = []
  if (moment.length > 0)
    for (const s of pickKeyframes(all.length)) {
      const t = s * manifest.keyframes!.everySec
      let f = 0
      for (let i = 1; i < allMoment.length; i++) if (Math.abs(allMoment[i].t - t) < Math.abs(allMoment[f].t - t)) f = i
      const data = await smallKeyframe(all[s].file, await Bun.file(join(dir, all[s].file)).bytes(), width, height)
      const small: FakeBitmap = { width, height, data, close() {} }
      infos.push({ t, T: allMoment[f].T, K: allMoment[f].K, small: small as unknown as ImageBitmap })
    }
  const job: SurfaceJob = {
    scan: depthRun(scan),
    moment: moment.length > 0 ? { ...depthRun(moment), keyframes: infos } : null,
    depthW: width,
    depthH: height,
    videoW: manifest.video.width,
    videoH: manifest.video.height,
    points: cloud.positions.slice(),
    colors: cloud.colors.slice(),
  }
  received = []
  const t0 = performance.now()
  runWorker({ data: job })
  const ms = performance.now() - t0
  let surface: RoomMesh | null = null
  let timeline: (Timeline & { skip: Uint8Array }) | null = null
  for (const m of received) {
    if (m.kind === 'surface') surface = m.surface
    else timeline = { ...m.timeline, skip: m.skip }
  }
  return { surface, timeline, ms }
}

// ---- comparison ----------------------------------------------------------------------------

const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>, scale = 1) => {
  if (a.length !== b.length) return Infinity
  let m = 0
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i] * scale))
  return m
}
const equal = (a: ArrayLike<number>, b: ArrayLike<number>) => maxDiff(a, b) === 0

let failed = false
const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failed = true
}

for (const dir of process.argv.slice(2)) {
  const id = dir.split('/').filter(Boolean).at(-1)
  console.log(`== ${id}`)
  const browser = await browserBuild(dir)
  const listing = await listDir(dir)
  const baked = await bakeCapture(dir, listing, { bakeVersion: 'equivalence' })
  const file = (name: string) => baked.files.find((f) => f.name === name)
  const rawBytes = [...listing.values()].reduce((s, b) => s + b, 0)
  const derivedBytes = baked.files.reduce((s, f) => s + f.bytes.byteLength, 0)
  const uploadBytes = baked.files.reduce((s, f) => s + (f.gzip ? gzipSync(f.bytes, { level: 6 }).byteLength : f.bytes.byteLength), 0)
  console.log(`  bake ${baked.derived.stats.bakeMs} ms (browser worker alone ${Math.round(browser.ms)} ms); raw ${(rawBytes / 1e6).toFixed(1)} MB, derived ${(derivedBytes / 1e6).toFixed(1)} MB, uploaded (gzip) ${(uploadBytes / 1e6).toFixed(1)} MB`)

  check(!!browser.surface === !!file('surface.pack'), `surface ${browser.surface ? 'built' : 'absent'} on both sides`)
  if (browser.surface && file('surface.pack')) {
    const pack = decodePack(file('surface.pack')!.bytes)
    const P = packArray(pack, 'positions', Float32Array)
    const N = packArray(pack, 'normals', Int8Array)
    const C = packArray(pack, 'colors', Uint8Array)
    const UV = packArray(pack, 'uvs', Uint16Array)
    const L = packArray(pack, 'layers', Int16Array)
    const I = packArray(pack, 'indices', Uint32Array)
    const s = browser.surface
    const corners = s.layers.length
    check(I.length === corners, `triangles: browser ${corners / 3}, baked ${I.length / 3} (${P.length / 3} shared vertices, ${(corners / (P.length / 3)).toFixed(2)} corners each)`)
    if (I.length === corners) {
      const e = { pos: 0, nrm: 0, uv: 0, col: 0, layer: 0 }
      for (let c = 0; c < corners; c++) {
        const v = I[c]
        for (let a = 0; a < 3; a++) {
          e.pos = Math.max(e.pos, Math.abs(P[v * 3 + a] - s.positions[c * 3 + a]))
          e.nrm = Math.max(e.nrm, Math.abs(N[v * 3 + a] / 127 - s.normals[c * 3 + a]))
          e.col = Math.max(e.col, Math.abs(C[v * 3 + a] - s.colors[c * 3 + a]))
        }
        for (let a = 0; a < 2; a++) e.uv = Math.max(e.uv, Math.abs(UV[v * 2 + a] / 65535 - Math.max(0, Math.min(1, s.uvs[c * 2 + a]))))
        e.layer = Math.max(e.layer, Math.abs(L[v] - s.layers[c]))
      }
      check(e.pos === 0, `positions identical (max diff ${e.pos})`)
      check(e.nrm <= 0.5 / 127 + 1e-6, `normals within snorm8 (max diff ${e.nrm.toExponential(2)})`)
      check(e.uv <= 0.5 / 65535 + 1e-7, `uvs within unorm16 (max diff ${e.uv.toExponential(2)})`)
      check(e.col === 0 && e.layer === 0, `colors and layers identical`)
      const meta = pack.meta as { keyframes: unknown[] }
      console.log(`  ${meta.keyframes.length} keyframe layers`)
    }
  }
  check(!!browser.timeline === !!file('timeline.pack'), `timeline ${browser.timeline ? 'built' : 'absent'} on both sides`)
  if (browser.timeline && file('timeline.pack')) {
    const pack = decodePack(file('timeline.pack')!.bytes)
    const t = browser.timeline
    const P = packArray(pack, 'positions', Float32Array)
    check(P.length === t.positions.length, `timeline voxels: browser ${t.positions.length / 3}, baked ${P.length / 3}`)
    check(
      equal(P, t.positions) && equal(packArray(pack, 'colors', Uint8Array), t.colors) && equal(packArray(pack, 'start', Float32Array), t.start) && equal(packArray(pack, 'end', Float32Array), t.end),
      'timeline positions, colors, start and end identical',
    )
    check(equal(packArray(pack, 'skip', Uint8Array), t.skip), `skip mask identical (${t.skip.length} voxels)`)
  }
}
process.exit(failed ? 1 : 0)
