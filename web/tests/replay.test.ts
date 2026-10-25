import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { decodeChunk, encodeDepthV2, packPixel } from '../../shared/depth'
import { depthChunkMeshes, roomTest, unpackMeters } from '../src/scene/depthMesh'
import { keepChunk } from '../src/scene/depthSource'
import { depthMeshIndices, movingPixels } from '../src/scene/gaps'

const W = 64
const H = 48
const K = [1450, 1450, 960, 720]
const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/** A frame with a near "person" blob in front of a far wall, and some unmeasured pixels. */
function frame(seed: number): { mm: Uint16Array; conf: Uint8Array } {
  const mm = new Uint16Array(W * H)
  const conf = new Uint8Array(W * H)
  for (let v = 0; v < H; v++)
    for (let u = 0; u < W; u++) {
      const k = v * W + u
      const person = u >= 10 && u < 40 && v >= 8 && v < 40
      mm[k] = (u * 3 + v * 5 + seed) % 17 === 0 ? 0 : person ? 1200 + u * 3 : 3000 + v * 5
      conf[k] = (u * 31 + v * 17 + seed) % 23 === 0 ? 0 : 2
    }
  return { mm, conf }
}

/** What the old viewer fed gaps.ts: (meters, confidence) floats from depth.bin + confidence.bin. */
function v1Floats(mm: Uint16Array, conf: Uint8Array): Float32Array {
  const out = new Float32Array(mm.length * 2)
  for (let i = 0; i < mm.length; i++) {
    out[i * 2] = mm[i] / 1000
    out[i * 2 + 1] = conf[i]
  }
  return out
}

describe('depth v2 replay meshing', () => {
  it('unpacks v2 pixels to exactly what the v1 path produced', () => {
    const { mm, conf } = frame(1)
    const packed = Uint16Array.from(mm, (d, i) => packPixel(d, conf[i]))
    expect(unpackMeters(packed, new Float32Array(mm.length * 2))).toEqual(v1Floats(mm, conf))
  })

  it('meshes every frame of a chunk the same as the old per-frame path, masked and unmasked', async () => {
    const frames = [0, 1, 2, 3, 4].map(frame)
    const packed = new Uint16Array(W * H * frames.length)
    frames.forEach((f, i) => packed.set(Uint16Array.from(f.mm, (d, j) => packPixel(d, f.conf[j])), i * W * H))
    const { bin, index } = await encodeDepthV2(packed, { width: W, height: H, count: frames.length, framesPerChunk: 3 }, (raw) => deflateRawSync(raw))
    // A room grid that explains everything farther than 2 m (the wall), so only the person stays.
    const grid = { nx: 1, ny: 1, nz: 2, origin: [-100, -100, -202] as [number, number, number], voxel: 200 }
    const skip = new Uint8Array([1, 0])
    const sx = W / 1920
    const sy = H / 1440
    const Kd = [K[0] * sx, K[1] * sy, K[2] * sx, K[3] * sy]
    for (const room of [null, { grid, skip }]) {
      const opts = { poses: frames.map((_, k) => ({ k, T, K })), videoW: 1920, videoH: 1440, minConfidence: 1, room }
      for (let c = 0; c < index.chunks.length; c++) {
        const [off, len] = index.chunks[c]
        const chunk = await decodeChunk(index, c, bin.subarray(off, off + len), (x) => inflateRawSync(x))
        const meshes = depthChunkMeshes(chunk, index, c, opts)
        meshes.forEach((indices, f) => {
          const { mm, conf } = frames[c * 3 + f]
          const floats = v1Floats(mm, conf)
          const keep = room ? movingPixels(floats, W, H, Kd, T, 1, roomTest(grid, skip)) : null
          const expected = new Uint32Array((W - 1) * (H - 1) * 6)
          const n = depthMeshIndices(floats, W, H, 1, expected, keep)
          expect(Array.from(indices)).toEqual(Array.from(expected.subarray(0, n)))
          // Masked, only the person is left (and it is there).
          if (room) expect(n).toBeGreaterThan(0)
        })
      }
    }
  })

  it('keeps the chunks around the playhead, both ways', () => {
    expect([2, 3, 4, 5, 6, 7].filter((c) => keepChunk(c, 4))).toEqual([3, 4, 5, 6])
  })

  it('treats space outside the room grid as room', () => {
    const isRoom = roomTest({ nx: 2, ny: 1, nz: 1, origin: [0, 0, 0], voxel: 1 }, new Uint8Array([0, 1]))
    expect(isRoom(0.5, 0.5, 0.5)).toBe(false)
    expect(isRoom(1.5, 0.5, 0.5)).toBe(true)
    expect(isRoom(-1, 0.5, 0.5)).toBe(true)
  })
})
