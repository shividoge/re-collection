import { describe, expect, test } from 'bun:test'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { decodePack, encodePack, packArray } from './pack'
import { chunkOfFrame, decodeChunk, encodeDepthV2, packPixel, packV1, parseDepthIndex, pixelConfidence, pixelMm, rowDelta, unpack } from './depth'
import { parseManifest, ManifestError } from './manifest'

const deflate = (b: Uint8Array) => new Uint8Array(deflateRawSync(b))
const inflate = (b: Uint8Array) => new Uint8Array(inflateRawSync(b))

describe('pack', () => {
  test('round trips arrays of every type with 16-byte alignment', () => {
    const arrays = [
      { name: 'p', data: new Float32Array([1.5, -2, 3, 4, 5, 6]), components: 3 },
      { name: 'c', data: new Uint8Array([1, 2, 3, 4, 5, 6]), components: 3 },
      { name: 'i', data: new Uint32Array([7, 8, 9]), components: 3 },
      { name: 'u', data: new Uint16Array([65535, 0]), components: 2 },
      { name: 's', data: new Int16Array([-1]), components: 1 },
      { name: 'n', data: new Int8Array([-127, 127, 0]), components: 3 },
    ]
    const bytes = encodePack({ kind: 'surface', meta: { grid: { nx: 1 }, note: 'héllo' }, arrays })
    const pack = decodePack<{ grid: { nx: number }; note: string }>(bytes)
    expect(pack.kind).toBe('surface')
    expect(pack.meta.note).toBe('héllo')
    for (const a of arrays) {
      const got = pack.arrays.get(a.name)!
      expect(Array.from(got.data)).toEqual(Array.from(a.data))
      expect(got.components).toBe(a.components)
      expect(got.data.byteOffset % 16).toBe(0)
    }
    expect(packArray(pack, 'p', Float32Array)[0]).toBe(1.5)
    expect(() => packArray(pack, 'p', Uint8Array)).toThrow()
  })
  test('rejects garbage', () => {
    expect(() => decodePack(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toThrow('bad magic')
  })
  test('rejects arrays not a multiple of components', () => {
    expect(() => encodePack({ kind: 'points', meta: {}, arrays: [{ name: 'x', data: new Float32Array(4), components: 3 }] })).toThrow()
  })
})

describe('depth v2', () => {
  test('pixel packing keeps 14 bits of mm and 2 of confidence', () => {
    const v = packPixel(1234, 2)
    expect(pixelMm(v)).toBe(1234)
    expect(pixelConfidence(v)).toBe(2)
    expect(pixelMm(packPixel(20000, 1))).toBe(16383)
    expect(pixelMm(packPixel(0, 0))).toBe(0)
  })
  test('encodes v1 frames into chunks and decodes any frame back', async () => {
    const w = 4, h = 3, count = 23, px = w * h
    const depth = new Uint16Array(px * count).map((_, i) => (i * 37) % 9000)
    const conf = new Uint8Array(px * count).map((_, i) => i % 3)
    const { bin, index } = await encodeDepthV2(packV1(depth, conf), { width: w, height: h, count, framesPerChunk: 10 }, deflate)
    expect(index.chunks.length).toBe(3)
    const parsed = parseDepthIndex(JSON.stringify(index))
    for (const frame of [0, 9, 10, 22]) {
      const c = chunkOfFrame(parsed, frame)
      const [off, len] = parsed.chunks[c]
      const frames = await decodeChunk(parsed, c, bin.subarray(off, off + len), inflate)
      const k = frame - c * parsed.framesPerChunk
      const { depth: d, confidence: cf } = unpack(frames.subarray(k * px, (k + 1) * px))
      expect(Array.from(d)).toEqual(Array.from(depth.subarray(frame * px, (frame + 1) * px)))
      expect(Array.from(cf)).toEqual(Array.from(conf.subarray(frame * px, (frame + 1) * px)))
    }
    expect(() => chunkOfFrame(parsed, 23)).toThrow()
  })
  test('row-delta filter round trips, including wraparound, and leaves the input alone', async () => {
    const w = 5, h = 2, count = 7, px = w * h
    const packed = new Uint16Array(px * count).map((_, i) => (i % 3 === 0 ? 0xffff : (i * 7919) & 0xffff))
    const before = packed.slice()
    const { bin, index } = await encodeDepthV2(packed, { width: w, height: h, count, framesPerChunk: 3, filter: 'row-delta' }, deflate)
    expect(Array.from(packed)).toEqual(Array.from(before))
    const parsed = parseDepthIndex(JSON.stringify(index))
    expect(parsed.filter).toBe('row-delta')
    const out: number[] = []
    for (let c = 0; c < parsed.chunks.length; c++) {
      const [off, len] = parsed.chunks[c]
      out.push(...(await decodeChunk(parsed, c, bin.subarray(off, off + len), inflate)))
    }
    expect(out).toEqual(Array.from(before))
    expect(Array.from(rowDelta(Uint16Array.from([5, 3, 65535, 0]), 4))).toEqual([5, 65534, 65532, 1])
    expect(() => parseDepthIndex(JSON.stringify({ ...index, filter: 'png-paeth' }))).toThrow()
  })
})

describe('manifest', () => {
  test('parses and normalizes', () => {
    const m = parseManifest(JSON.stringify({ id: 'AA8BA104-6D9C-462F-AB5C-A172B1E0B95E', video: { file: 'video.mp4' }, depth: { file: 'depth.bin', count: 3 } }))
    expect(m.id).toBe('aa8ba104-6d9c-462f-ab5c-a172b1e0b95e')
    expect(m.attendees).toEqual([])
  })
  test('rejects a bad id', () => {
    expect(() => parseManifest('{"id":"x"}')).toThrow(ManifestError)
  })
})
