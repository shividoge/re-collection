import { describe, expect, test } from 'bun:test'
import { decodePack, packArray, type PointsMeta } from '../../../shared/pack'
import { splatSizes } from '../../../web/src/scene/gaps'
import { bakePoints, kthNeighbor, lodOrder, permutation, quantizeUnorm16, sizeScaleFor } from '../src/points'

/** An L-shaped room corner sampled every 1 cm: a 3 × 2 m floor and a 3 × 1.5 m wall. */
function corner(): Float32Array {
  const p: number[] = []
  for (let x = 0; x < 300; x++) for (let z = 0; z < 200; z++) p.push(x / 100, 0, z / 100)
  for (let x = 0; x < 300; x++) for (let y = 1; y < 150; y++) p.push(x / 100, y / 100, 0)
  return new Float32Array(p)
}

const reorder = (P: Float32Array, order: Uint32Array) => {
  const out = new Float32Array(P.length)
  order.forEach((i, j) => out.set(P.subarray(i * 3, i * 3 + 3), j * 3))
  return out
}

/** Largest distance from any point of the cloud (sampled) to the nearest of the first `m`. */
function worstGap(ordered: Float32Array, m: number, cell: number, rings: number): number {
  const n = ordered.length / 3
  const probes = Array.from({ length: 3000 }, (_, i) => Math.floor((i * n) / 3000))
  // The probes go after the prefix; kthNeighbor searches the first m points only.
  const P = new Float32Array((m + probes.length) * 3)
  P.set(ordered.subarray(0, m * 3))
  probes.forEach((i, k) => P.set(ordered.subarray(i * 3, i * 3 + 3), (m + k) * 3))
  const d = kthNeighbor(P, m, probes.map((_, k) => m + k), 1, cell, rings)
  return Math.max(...Array.from(d, (x) => (Number.isNaN(x) ? Infinity : x)))
}

describe('level of detail', () => {
  const P = corner()
  const n = P.length / 3
  const order = lodOrder(P)
  const ordered = reorder(P, order)

  test('is a deterministic permutation', () => {
    expect(new Set(order).size).toBe(n)
    expect(Array.from(lodOrder(P).subarray(0, 1000))).toEqual(Array.from(order.subarray(0, 1000)))
    expect(Array.from(permutation(10, 1))).not.toEqual(Array.from(permutation(10, 2)))
  })

  test('every prefix covers the whole room evenly', () => {
    for (const m of [2000, 8000, 32000, 50000]) {
      const expected = Math.sqrt(n / m) * 0.01 // spacing of an even sample of m points
      // Within a few times the even spacing everywhere (the room's input order leaves whole areas uncovered).
      expect(worstGap(ordered, m, expected * 2, 4)).toBeLessThan(expected * 4)
      expect(worstGap(P, m, 0.1, 3)).toBeGreaterThan(0.3)
    }
  })

  test('sizeScale follows the spacing (2× for a quarter of a surface) and keeps it covered', () => {
    const quarter = Math.floor(n / 4)
    const scale = sizeScaleFor(ordered, quarter)
    expect(scale).toBeGreaterThan(1.7)
    expect(scale).toBeLessThan(2.4)
    expect(sizeScaleFor(ordered, n)).toBe(1)
    // Coverage: nearly every point of the room is inside some scaled splat of the prefix.
    const sizes = splatSizes(ordered)
    const probes = Array.from({ length: 2000 }, (_, i) => Math.floor((i * n) / 2000))
    let covered = 0
    for (const i of probes) {
      let best = Infinity
      let bestJ = -1
      for (let j = 0; j < quarter; j++) {
        const d = (ordered[j * 3] - ordered[i * 3]) ** 2 + (ordered[j * 3 + 1] - ordered[i * 3 + 1]) ** 2 + (ordered[j * 3 + 2] - ordered[i * 3 + 2]) ** 2
        if (d < best) (best = d), (bestJ = j)
      }
      if (Math.sqrt(best) <= (sizes[bestJ] * scale) / 2) covered++
    }
    expect(covered / probes.length).toBeGreaterThan(0.97)
  })

  test('points.pack has ascending levels ending with the full cloud', () => {
    const colors = new Uint8Array(n * 3).fill(7)
    const { bytes, meta } = bakePoints(P, colors)
    expect(meta.levels.map((l) => l.count)).toEqual([65536, n])
    expect(meta.levels[0].sizeScale).toBeGreaterThan(1)
    expect(meta.levels.at(-1)!.sizeScale).toBe(1)
    const pack = decodePack<PointsMeta>(bytes)
    expect(pack.meta).toEqual(meta)
    expect(packArray(pack, 'positions', Uint16Array).length).toBe(n * 3)
  })
})

test('unorm16 quantization stays within half a step, also for a flat axis', () => {
  const v = new Float32Array([-2, 5, 1, 3.3, 5, 1, -1.234567, 5, 1])
  const min: [number, number, number] = [-2, 5, 1]
  const max: [number, number, number] = [3.3, 5, 1]
  const q = quantizeUnorm16(v, min, max)
  for (let i = 0; i < v.length; i++) {
    const a = i % 3
    const span = max[a] - min[a]
    const back = min[a] + (q[i] / 65535) * span
    expect(Math.abs(back - v[i])).toBeLessThanOrEqual(span / 65535 / 2 + 1e-6)
  }
  expect(q[0]).toBe(0)
  expect(q[3]).toBe(65535)
})
