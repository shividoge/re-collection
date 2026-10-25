import { describe, expect, it } from 'vitest'
import { SPLAT_MAX, SPLAT_MIN, depthMeshIndices, movingPixels, splatSizes } from '../src/scene/gaps'

/** A flat square patch of points on y = 0 with the given spacing. */
function patch(spacing: number, side = 0.6, offsetX = 0): Float32Array {
  const pts: number[] = []
  const n = Math.round(side / spacing)
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) pts.push(offsetX + i * spacing, 0, j * spacing)
  return new Float32Array(pts)
}

describe('splatSizes', () => {
  it('makes neighboring points on a surface overlap', () => {
    for (const spacing of [0.01, 0.015, 0.02]) {
      const sizes = splatSizes(patch(spacing))
      // Look at the middle of the patch, away from its edges.
      const mid = sizes[Math.floor(sizes.length / 2)]
      expect(mid).toBeGreaterThan(spacing * Math.SQRT2 * 0.9)
    }
  })

  it('never bridges more than SPLAT_MAX, however sparse the scan', () => {
    const sizes = splatSizes(patch(0.05, 1.2))
    expect(Math.max(...sizes)).toBeLessThanOrEqual(Math.fround(SPLAT_MAX))
  })

  it('keeps isolated stray points small instead of growing them into blobs', () => {
    const lonely = new Float32Array([5, 5, 5, -3, 2, 7])
    expect(Array.from(splatSizes(lonely))).toEqual([Math.fround(SPLAT_MIN), Math.fround(SPLAT_MIN)])
  })
})

describe('depthMeshIndices', () => {
  const W = 4
  const H = 3
  const grid = (fill: (u: number, v: number) => [number, number]) => {
    const data = new Float32Array(W * H * 2)
    for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) data.set(fill(u, v), (v * W + u) * 2)
    return data
  }
  const out = new Uint32Array((W - 1) * (H - 1) * 6)

  it('joins a flat surface into two triangles per cell', () => {
    expect(depthMeshIndices(grid(() => [1.5, 2]), W, H, 1, out)).toBe((W - 1) * (H - 1) * 6)
  })

  it('does not join a person in front of a wall', () => {
    // Left half at 1 m (a person), right half at 3 m (the wall behind).
    const n = depthMeshIndices(grid((u) => [u < 2 ? 1 : 3, 2]), W, H, 1, out)
    // Only cells fully on one side survive: column 0–1 and column 2–3, two rows each.
    expect(n).toBe(2 * 2 * 6)
    for (let k = 0; k < n; k += 3) {
      const us = [out[k], out[k + 1], out[k + 2]].map((i) => i % W)
      expect(us.every((u) => u < 2) || us.every((u) => u >= 2)).toBe(true)
    }
  })

  it('skips pixels without depth or with low confidence', () => {
    const holes = depthMeshIndices(grid((u, v) => (u === 1 && v === 1 ? [0, 2] : [2, u === 2 && v === 1 ? 0 : 2])), W, H, 1, out)
    expect(holes).toBeLessThan((W - 1) * (H - 1) * 6)
    for (let k = 0; k < holes; k++) expect([1 * W + 1, 1 * W + 2]).not.toContain(out[k])
  })
})

describe('moving pixels', () => {
  it('keeps a solid blob the room does not explain and drops scattered specks', () => {
    const w = 64
    const h = 48
    const depth = new Float32Array(w * h * 2)
    for (let k = 0; k < w * h; k++) {
      depth[k * 2] = 3
      depth[k * 2 + 1] = 2
    }
    // A 20×20 blob at 1 m, and three single-pixel specks at 1.5 m.
    for (let v = 10; v < 30; v++) for (let u = 10; u < 30; u++) depth[(v * w + u) * 2] = 1
    for (const k of [5 * w + 50, 40 * w + 5, 44 * w + 60]) depth[k * 2] = 1.5
    // The room is everything at 2 m or more from the camera (camera at the origin looking down −z).
    const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    const keep = movingPixels(depth, w, h, [50, 50, 32, 24], T, 1, (_x, _y, z) => z <= -2, 100)
    expect(keep[20 * w + 20]).toBe(1)
    expect(keep[5 * w + 50]).toBe(0)
    expect(keep[40 * w + 5]).toBe(0)
    expect(keep[0]).toBe(0)
    expect(keep.reduce((a, b) => a + b, 0)).toBe(400)
  })
})
