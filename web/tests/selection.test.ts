import { describe, expect, it } from 'vitest'
import { buildRoomIndex, dequantize, roomSelection } from '../src/scene/roomQuery'
import { createVoxelHash, hashGet, hashSet, markVoxels, selectionMask, voxelCoords, buildVoxelIndex } from '../src/scene/spatial'
import { TABLE, VIDEO, makeFixture } from './fixture'

describe('typed-array voxel hash', () => {
  it('stores and finds many keys through growth', () => {
    const h = createVoxelHash(4)
    let id = 0
    for (let x = 0; x < 40; x++) for (let y = 0; y < 30; y++) for (let z = 0; z < 5; z++) hashSet(h, x * 3, y, z * 100, id++)
    expect(h.size).toBe(6000)
    expect(h.ids.length).toBeGreaterThanOrEqual(12000)
    let ok = true
    id = 0
    for (let x = 0; x < 40; x++) for (let y = 0; y < 30; y++) for (let z = 0; z < 5; z++) ok &&= hashGet(h, x * 3, y, z * 100) === id++
    expect(ok).toBe(true)
    expect(hashGet(h, 1, 0, 0)).toBe(-1)
  })
})

describe('incremental selection mask', () => {
  it('clearing one selection and marking another equals building the new mask from scratch', () => {
    const { cloud } = makeFixture()
    const idx = buildVoxelIndex(cloud.positions, 0.03)
    const a = Uint32Array.from({ length: 50 }, (_, i) => i * 7)
    const b = Uint32Array.from({ length: 80 }, (_, i) => 300 + i * 3)
    const mask = selectionMask(idx, a)
    markVoxels(mask, idx.dims, voxelCoords(idx, a), 0)
    markVoxels(mask, idx.dims, voxelCoords(idx, b), 1)
    expect(mask).toEqual(selectionMask(idx, b))
  })
})

describe('room selection (worker side)', () => {
  const { cloud, frames } = makeFixture()

  it('dequantizes unorm16 positions inside the box', () => {
    const q = new Uint16Array([0, 65535, 32768])
    const p = dequantize(q, [-1, 0, 2], [1, 4, 4])
    expect(p[0]).toBeCloseTo(-1)
    expect(p[1]).toBeCloseTo(4)
    expect(p[2]).toBeCloseTo(3, 4)
  })

  it('selects the table from quantized points as it does from floats', () => {
    // Quantize the fixture the way the bake does.
    const min: [number, number, number] = [Infinity, Infinity, Infinity]
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < cloud.positions.length; i++) {
      min[i % 3] = Math.min(min[i % 3], cloud.positions[i])
      max[i % 3] = Math.max(max[i % 3], cloud.positions[i])
    }
    const q = Uint16Array.from(cloud.positions, (v, i) => Math.round(((v - min[i % 3]) / (max[i % 3] - min[i % 3])) * 65535))
    const sizes = new Uint8Array(cloud.positions.length / 3).fill(128)
    const quantized = buildRoomIndex({ kind: 'quantized', positions: q, min, max, colors: cloud.colors, sizes, sizeMin: 0.008, sizeMax: 0.035 })
    const floats = buildRoomIndex({ kind: 'float', positions: cloud.positions, colors: cloud.colors, sizes: null })
    const ray = { origin: [0, 3, 0.1] as [number, number, number], dir: [0, -1, 0] as [number, number, number] }
    const fromQ = roomSelection(quantized, frames.moment, VIDEO.width, VIDEO.height, ray.origin, ray.dir)!
    const fromF = roomSelection(floats, frames.moment, VIDEO.width, VIDEO.height, ray.origin, ray.dir)!
    expect(fromQ.kind).toBe('object')
    expect(fromQ.pointCount).toBe(fromF.pointCount)
    expect(fromQ.bounds.center[1]).toBeCloseTo(TABLE.center[1], 1)
    expect(fromQ.sizes[0]).toBeCloseTo(0.008 + (128 / 255) * 0.027, 6)
    expect(fromQ.voxelCoords.length).toBeGreaterThan(0)
    // Floats without sizes get them worked out (gaps.ts splatSizes).
    expect(floats.sizes.length).toBe(cloud.positions.length / 3)
    expect(fromQ.seen.length).toBeGreaterThan(0)
  })

  it('returns null when the ray misses the room', () => {
    const room = buildRoomIndex({ kind: 'float', positions: cloud.positions, colors: cloud.colors, sizes: null })
    expect(roomSelection(room, frames.moment, VIDEO.width, VIDEO.height, [0, 10, 0], [0, 1, 0])).toBeNull()
  })
})
