import { describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeChunk, encodeDepthV2, packV1, parseDepthIndex, type DepthIndex } from '../../../shared/depth'
import { decodePack, packArray, type PointsMeta, type SurfaceMeta } from '../../../shared/pack'
import { parseRoomBin } from '../../../web/src/scene/formats'
import { SPLAT_MAX, SPLAT_MIN, splatSizes } from '../../../web/src/scene/gaps'
import { bakeCapture, type BakeResult } from '../src/bake'
import { deflate, depthSource, fromV1, inflate } from '../src/depth'
import { smallKeyframe } from '../src/keyframes'
import { listDir } from '../src/listing'
import { bakeSurface, bakeTimeline } from '../src/room'
import { ValidationError } from '../src/validate'
import { DH, DW, ID, makeCapture, manifest } from './fixture'

async function bakeDir(dir: string): Promise<BakeResult> {
  try {
    return await bakeCapture(dir, await listDir(dir), { bakeVersion: 'test' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function errorsOf(edit: Parameters<typeof makeCapture>[0]): Promise<string[]> {
  try {
    await bakeDir(await makeCapture(edit))
  } catch (e) {
    if (e instanceof ValidationError) return e.errors
    throw e
  }
  throw new Error('expected a validation error')
}

const fileOf = (r: BakeResult, name: string) => r.files.find((f) => f.name === name)!

describe('validation', () => {
  test('a valid capture bakes every derived file', async () => {
    const r = await bakeDir(await makeCapture())
    expect(r.files.map((f) => f.name)).toEqual(['points.pack', 'surface.pack', 'timeline.pack', 'depth.bin', 'depth.index.json', 'derived.json'])
    expect(r.files.filter((f) => !f.gzip).map((f) => f.name)).toEqual(['depth.bin'])
    expect(r.derived).toMatchObject({ format: 'braindance.derived', version: 1, captureId: ID, files: { points: 'points.pack', surface: 'surface.pack', timeline: 'timeline.pack', depth: 'depth.bin', depthIndex: 'depth.index.json' } })
    expect(r.derived.stats.surfaceTriangles).toBeGreaterThan(1000)
    expect(r.derived.stats.timelineVoxels).toBeGreaterThan(100)
    expect(JSON.parse(new TextDecoder().decode(fileOf(r, 'derived.json').bytes)).stats).toEqual(r.derived.stats)
  })

  test('missing and wrong-sized files are listed in plain words', async () => {
    const errors = await errorsOf((f) => {
      f.delete('keyframes/k0001.jpg')
      f.set('confidence.bin', new Uint8Array(10))
      f.delete('video.mp4')
    })
    expect(errors).toContain('The keyframe keyframes/k0001.jpg is missing.')
    expect(errors).toContain('The video video.mp4 is missing.')
    expect(errors.some((e) => e.startsWith('confidence.bin is 10 bytes, but the manifest implies'))).toBe(true)
  })

  test('frames.jsonl must match the video and point inside depth.bin', async () => {
    const errors = await errorsOf((f) => {
      const lines = (f.get('frames.jsonl') as string).trim().split('\n')
      lines.pop()
      lines[0] = lines[0].replace('"d":0', '"d":99')
      f.set('frames.jsonl', lines.join('\n'))
    })
    expect(errors).toContain('frames.jsonl has 3 moment lines, but manifest.video.frameCount is 4.')
    expect(errors.some((e) => e.startsWith('frames.jsonl points at depth frame 99'))).toBe(true)
    expect(await errorsOf((f) => f.set('frames.jsonl', '{"t":0,"T":[1],"K":[1,1,1,1]}\n'))).toEqual(['frames.jsonl line 1: T must be 16 numbers.'])
  })

  test('room.bin header and manifest must agree; manifest must parse', async () => {
    const room = await errorsOf((f) => {
      const b = new Uint8Array(f.get('room.bin') as Uint8Array)
      new DataView(b.buffer).setUint32(0, 7, true)
      f.set('room.bin', b)
    })
    expect(room).toEqual([`room.bin says 7 points, but manifest.room.points is ${(28980).toString()}.`])
    expect((await errorsOf((f) => f.set('manifest.json', '{ nope')))[0]).toStartWith("manifest.json isn't valid JSON")
    const noRoom = await errorsOf((f) => f.set('manifest.json', JSON.stringify(manifest({ room: undefined }))))
    expect(noRoom).toContain('manifest.room.bin is missing: there is no room cloud to bake.')
  })

  test('a v2 capture is validated against its index and copied as is', async () => {
    // The fixture's depth as v2, unfiltered and 2 frames per chunk (as a phone may write it).
    const src = await makeCapture()
    const v1 = await fromV1(await Bun.file(join(src, 'depth.bin')).bytes(), await Bun.file(join(src, 'confidence.bin')).bytes(), { width: DW, height: DH, count: 5 })
    await rm(src, { recursive: true, force: true })
    const v2 = await encodeDepthV2(v1.packed, { width: DW, height: DH, count: 5, framesPerChunk: 2 }, deflate)
    const asV2 = (index: DepthIndex) => (f: Map<string, Uint8Array | string>) => {
      const m = JSON.parse(f.get('manifest.json') as string)
      m.depth = { file: 'depth.bin', index: 'depth.index.json', encoding: 'v2', width: DW, height: DH, unit: 'mm', rateHz: 2, count: 5 }
      f.set('manifest.json', JSON.stringify(m))
      f.set('depth.bin', v2.bin)
      f.set('depth.index.json', JSON.stringify(index))
      f.delete('confidence.bin')
    }
    const ok = await bakeDir(await makeCapture(asV2(v2.index)))
    expect(Array.from(fileOf(ok, 'depth.bin').bytes)).toEqual(Array.from(v2.bin))
    expect(JSON.parse(new TextDecoder().decode(fileOf(ok, 'depth.index.json').bytes))).toEqual(v2.index)
    expect(ok.derived.stats.surfaceTriangles).toBeGreaterThan(1000)
    const gap = { ...v2.index, chunks: v2.index.chunks.map(([o, l], c): [number, number] => [c === 1 ? o + 3 : o, l]) }
    expect(await errorsOf(asV2(gap))).toEqual(['depth.index.json chunks must follow each other with no gaps.'])
  })
})

describe('derived files', () => {
  test('depth v2 decodes back to the v1 frames', async () => {
    const dir = await makeCapture()
    const depth = await Bun.file(join(dir, 'depth.bin')).bytes()
    const conf = await Bun.file(join(dir, 'confidence.bin')).bytes()
    const r = await bakeDir(dir)
    const index = parseDepthIndex(new TextDecoder().decode(fileOf(r, 'depth.index.json').bytes))
    expect(index.filter).toBe('row-delta')
    const bin = fileOf(r, 'depth.bin').bytes
    const want = packV1(new Uint16Array(depth.buffer), conf)
    const got: number[] = []
    for (let c = 0; c < index.chunks.length; c++) got.push(...(await decodeChunk(index, c, bin.subarray(index.chunks[c][0], index.chunks[c][0] + index.chunks[c][1]), inflate)))
    expect(got).toEqual(Array.from(want))
  })

  test('points.pack: every point once, quantized within half a step, sizes from gaps.ts', async () => {
    const dir = await makeCapture()
    const cloud = parseRoomBin((await Bun.file(join(dir, 'room.bin')).bytes()).buffer as ArrayBuffer)
    const r = await bakeDir(dir)
    const pack = decodePack<PointsMeta>(fileOf(r, 'points.pack').bytes)
    const { min, max, count, levels } = pack.meta
    expect(count).toBe(cloud.count)
    expect(levels).toEqual([{ count, sizeScale: 1 }]) // fewer points than the first level
    const q = packArray(pack, 'positions', Uint16Array)
    const colors = packArray(pack, 'colors', Uint8Array)
    const sizes = packArray(pack, 'sizes', Uint8Array)
    const full = splatSizes(cloud.positions)
    // Match each decoded point to its original by rounding to the 1 cm grid the fixture used.
    const keyOf = (x: number, y: number, z: number) => `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`
    const original = new Map<string, number>()
    for (let i = 0; i < cloud.count; i++) original.set(keyOf(cloud.positions[i * 3], cloud.positions[i * 3 + 1], cloud.positions[i * 3 + 2]), i)
    const seen = new Set<number>()
    let worst = 0
    for (let j = 0; j < count; j++) {
      const p = [0, 1, 2].map((a) => min[a] + (q[j * 3 + a] / 65535) * (max[a] - min[a]))
      const i = original.get(keyOf(p[0], p[1], p[2]))!
      expect(i).toBeDefined()
      seen.add(i)
      for (let a = 0; a < 3; a++) worst = Math.max(worst, Math.abs(p[a] - cloud.positions[i * 3 + a]) / ((max[a] - min[a]) / 65535 / 2))
      expect([colors[j * 3], colors[j * 3 + 1], colors[j * 3 + 2]]).toEqual([cloud.colors[i * 3], cloud.colors[i * 3 + 1], cloud.colors[i * 3 + 2]])
      const size = SPLAT_MIN + (sizes[j] / 255) * (SPLAT_MAX - SPLAT_MIN)
      expect(Math.abs(size - full[i])).toBeLessThanOrEqual((SPLAT_MAX - SPLAT_MIN) / 255 / 2 + 1e-6)
    }
    expect(seen.size).toBe(count)
    expect(worst).toBeLessThanOrEqual(1.001)
  })

  test('surface.pack re-expands to the unindexed surface, within quantization', async () => {
    const dir = await makeCapture()
    const listing = await listDir(dir)
    const read = (n: string) => Bun.file(join(dir, n)).bytes()
    const m = JSON.parse(new TextDecoder().decode(await read('manifest.json')))
    const v1 = await fromV1(await read('depth.bin'), await read('confidence.bin'), { width: DW, height: DH, count: 5 })
    const cloud = parseRoomBin((await read('room.bin')).buffer as ArrayBuffer)
    const { parseFramesJsonl } = await import('../../../web/src/scene/formats')
    const keyframes = []
    for (const s of [0, 1]) keyframes.push({ file: `keyframes/k000${s}.jpg`, t: s, small: await smallKeyframe('k', await read(`keyframes/k000${s}.jpg`), DW, DH) })
    const direct = bakeSurface({ frames: parseFramesJsonl(new TextDecoder().decode(await read('frames.jsonl'))), depth: depthSource(v1.packed, DW * DH), depthW: DW, depthH: DH, videoW: m.video.width, videoH: m.video.height, points: cloud.positions, colors: cloud.colors, keyframes })!
    const timeline = bakeTimeline(direct)!
    const r = await bakeCapture(dir, listing, { bakeVersion: 'test' })
    await rm(dir, { recursive: true, force: true })
    const pack = decodePack<SurfaceMeta>(fileOf(r, 'surface.pack').bytes)
    expect(pack.meta.keyframes).toEqual([{ file: 'keyframes/k0000.jpg', t: 0 }, { file: 'keyframes/k0001.jpg', t: 1 }])
    expect(pack.meta.grid).toEqual({ ...direct.grid, origin: [...direct.grid.origin] })
    const P = packArray(pack, 'positions', Float32Array)
    const N = packArray(pack, 'normals', Int8Array)
    const UV = packArray(pack, 'uvs', Uint16Array)
    const L = packArray(pack, 'layers', Int16Array)
    const I = packArray(pack, 'indices', Uint32Array)
    const s = direct.surface
    expect(I.length).toBe(s.layers.length)
    expect(P.length).toBeLessThan(s.positions.length / 2) // vertices really are shared
    for (let c = 0; c < I.length; c++) {
      const v = I[c]
      for (let a = 0; a < 3; a++) {
        expect(P[v * 3 + a]).toBe(s.positions[c * 3 + a])
        expect(Math.abs(N[v * 3 + a] / 127 - s.normals[c * 3 + a])).toBeLessThanOrEqual(0.5 / 127 + 1e-6)
      }
      for (let a = 0; a < 2; a++) expect(Math.abs(UV[v * 2 + a] / 65535 - s.uvs[c * 2 + a])).toBeLessThanOrEqual(0.5 / 65535 + 1e-7)
      expect(L[v]).toBe(s.layers[c])
    }
    const tl = decodePack(fileOf(r, 'timeline.pack').bytes)
    expect(Array.from(packArray(tl, 'positions', Float32Array))).toEqual(Array.from(timeline.positions))
    expect(Array.from(packArray(tl, 'start', Float32Array))).toEqual(Array.from(timeline.start))
    expect(Array.from(packArray(tl, 'skip', Uint8Array))).toEqual(Array.from(direct.skip))
  })

  test('a capture without scan depth bakes points and depth only', async () => {
    const r = await bakeDir(
      await makeCapture((f) => {
        f.set('frames.jsonl', (f.get('frames.jsonl') as string).split('\n').filter((l) => !l.includes('"scan"')).join('\n'))
      }),
    )
    expect(r.files.map((f) => f.name)).toEqual(['points.pack', 'depth.bin', 'depth.index.json', 'derived.json'])
    expect(r.derived.files.surface).toBeUndefined()
    expect(r.derived.stats.surfaceTriangles).toBeUndefined()
  })
})
