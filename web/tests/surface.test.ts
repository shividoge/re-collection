import { describe, expect, it } from 'vitest'
import { colorFromPoints, fuseTSDF, marchingCubes, type DepthView } from '../src/scene/surface'
import { lookAtPose } from './fixture'

// The phone's real depth resolution: rays land ~1 cm apart at 2 m, finer than the 2 cm voxels.
const W = 256
const H = 192
const VIDEO = { videoW: 1920, videoH: 1440 }
// Intrinsics at video resolution; scaled to the depth grid inside fuseTSDF.
const K = [1450, 1450, 960, 720]

/** A depth view of the plane z = −2 (a wall facing +z) from a camera at `pos`. */
function wallView(pos: [number, number, number], cover = (u: number) => u >= 0): DepthView {
  const T = lookAtPose(pos, [pos[0], pos[1], -2], 0)
  const depth = new Uint16Array(W * H)
  const confidence = new Uint8Array(W * H)
  for (let v = 0; v < H; v++)
    for (let u = 0; u < W; u++) {
      if (!cover(u)) continue
      // The camera looks straight at the wall, so every pixel's z-depth is the same.
      depth[v * W + u] = Math.round((pos[2] + 2) * 1000)
      confidence[v * W + u] = 2
    }
  return { T, K, depth, confidence }
}

const box = { min: [-1.5, -0.5, -2.5] as [number, number, number], max: [1.5, 2, 0] as [number, number, number] }

describe('TSDF fusion and marching cubes', () => {
  it('turns a wall seen from several views into one flat surface where the wall is', () => {
    const views = [wallView([0, 0.8, 0]), wallView([0.3, 0.9, -0.2]), wallView([-0.3, 0.7, 0])]
    const vol = fuseTSDF(views, { ...box, voxel: 0.02, depthW: W, depthH: H, ...VIDEO, minConfidence: 2 })
    const mesh = marchingCubes(vol, 2)
    expect(mesh.indices.length).toBeGreaterThan(300)
    for (let i = 2; i < mesh.positions.length; i += 3) expect(Math.abs(mesh.positions[i] + 2)).toBeLessThan(0.02)
  })

  it('leaves what no camera measured open', () => {
    // Only the left half of each image measures the wall.
    const views = [wallView([0, 0.8, 0], (u) => u < W / 2), wallView([0, 0.8, -0.1], (u) => u < W / 2)]
    const mesh = marchingCubes(fuseTSDF(views, { ...box, voxel: 0.02, depthW: W, depthH: H, ...VIDEO, minConfidence: 2 }), 2)
    expect(mesh.indices.length).toBeGreaterThan(300)
    // The camera at x = 0 looks down −z with x to the right, so measured wall is at x ≤ ~0.
    for (let i = 0; i < mesh.positions.length; i += 3) expect(mesh.positions[i]).toBeLessThan(0.05)
  })

  it('ignores low-confidence depth', () => {
    const view = wallView([0, 0.8, 0])
    view.confidence.fill(1)
    const mesh = marchingCubes(fuseTSDF([view, view], { ...box, voxel: 0.02, depthW: W, depthH: H, ...VIDEO, minConfidence: 2 }), 2)
    expect(mesh.indices.length).toBe(0)
  })

  it('colors the surface from nearby scan points, grey where there are none', () => {
    const positions = new Float32Array([0, 0, 0, 5, 5, 5])
    const colors = colorFromPoints(positions, new Float32Array([0.01, 0.01, 0.01]), new Uint8Array([200, 10, 20]), 0.02)
    expect(Array.from(colors)).toEqual([200, 10, 20, 128, 128, 128])
  })
})
