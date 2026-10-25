import { describe, expect, it } from 'vitest'
import { assignKeyframes, colorFromPoints, createFusion, finishSurface, fuseTSDF, fuseViews, marchingCubes, type DepthView } from '../src/scene/surface'
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

  it('counts views, not rays: one frame alone never makes a surface', () => {
    // A single close view sends many rays through each voxel; it still counts once.
    const mesh = marchingCubes(fuseTSDF([wallView([0, 0.8, -1.2])], { ...box, voxel: 0.02, depthW: W, depthH: H, ...VIDEO, minConfidence: 2 }), 2)
    expect(mesh.indices.length).toBe(0)
  })

  it('carves away a surface one frame saw where the others saw straight through', () => {
    // Three good views of the wall, plus three frames that wrongly measured something at z = −1
    // on the right of the image. Six more views see the wall through that spot.
    const bogus = (pos: [number, number, number]) => {
      const view = wallView(pos)
      for (let v = 0; v < H; v++) for (let u = W / 2; u < W; u++) view.depth[v * W + u] = Math.round((pos[2] + 1) * 1000)
      return view
    }
    const good = [0, 0.1, -0.1, 0.2, -0.2, 0.05].map((dx) => wallView([dx, 0.8, 0]))
    const views = [...good, bogus([0, 0.8, 0]), bogus([0.05, 0.8, 0]), bogus([-0.05, 0.8, 0])]
    const mesh = marchingCubes(fuseTSDF(views, { ...box, voxel: 0.02, depthW: W, depthH: H, ...VIDEO, minConfidence: 2 }), 3)
    expect(mesh.indices.length).toBeGreaterThan(300)
    for (let i = 2; i < mesh.positions.length; i += 3) expect(mesh.positions[i]).toBeLessThan(-1.9)
  })

  it('ignores the mixed depth on an edge between near and far', () => {
    // Left half at 1 m, right half at 2 m, and one column in between at 1.5 m (a flying pixel
    // column, as LiDAR gives at silhouettes). No surface may appear at 1.5 m.
    const views = [0, 0.02, -0.02].map((dx) => {
      const view = wallView([dx, 0.8, 0])
      for (let v = 0; v < H; v++)
        for (let u = 0; u < W; u++) view.depth[v * W + u] = u < W / 2 ? 1000 : u === W / 2 ? 1500 : 2000
      return view
    })
    const mesh = marchingCubes(fuseTSDF(views, { ...box, voxel: 0.02, depthW: W, depthH: H, ...VIDEO, minConfidence: 2 }), 3)
    expect(mesh.indices.length).toBeGreaterThan(300)
    for (let i = 2; i < mesh.positions.length; i += 3) expect(Math.abs(mesh.positions[i] + 1.5)).toBeGreaterThan(0.2)
  })

  it('keeps triangles with a color and drops small floating pieces', () => {
    // A big triangle (0.5 m²), a speck (0.00005 m²), and one with an uncolored corner and no keyframe.
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 5, 5, 5.01, 5, 5, 5, 5.01, 5, 0, 0, 1])
    const mesh = {
      positions,
      normals: new Float32Array(positions.length),
      colors: new Uint8Array(positions.length),
      indices: new Uint32Array([0, 1, 2, 3, 4, 5, 0, 1, 6]),
    }
    const keys = { layer: new Int16Array([-1, -1, -1]), uv: new Float32Array(18) }
    const out = finishSurface(mesh, new Uint8Array([1, 1, 1, 1, 1, 1, 0]), keys, 0.005)
    expect(Array.from(out.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0])
    expect(Array.from(out.layers)).toEqual([-1, -1, -1])
  })

  it('keeps a triangle a keyframe sees even without scan colors', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
    const mesh = { positions, normals: new Float32Array(9), colors: new Uint8Array(9), indices: new Uint32Array([0, 1, 2]) }
    const keys = { layer: new Int16Array([3]), uv: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]) }
    const out = finishSurface(mesh, new Uint8Array(3), keys, 0.005)
    expect(Array.from(out.layers)).toEqual([3, 3, 3])
    expect(Array.from(out.uvs)).toEqual(Array.from(keys.uv))
  })

  it('textures the wall from a keyframe that sees it, not one where something stands in front', () => {
    const views = [wallView([0, 0.8, 0]), wallView([0.3, 0.9, -0.2]), wallView([-0.3, 0.7, 0])]
    const mesh = marchingCubes(fuseTSDF(views, { ...box, voxel: 0.02, depthW: W, depthH: H, ...VIDEO, minConfidence: 2 }), 3)
    // Keyframe 0: something 1 m in front of the camera covers the whole view. Keyframe 1: clear.
    const blocked = wallView([0, 0.8, 0])
    blocked.depth.fill(1000)
    const clear = wallView([0, 0.8, -0.5])
    const a = assignKeyframes(mesh, [blocked, clear], { depthW: W, depthH: H, ...VIDEO })
    const layers = new Set(a.layer)
    expect(layers.has(0)).toBe(false)
    expect(layers.has(1)).toBe(true)
    // Texture coordinates of a textured triangle are inside the image.
    const f = a.layer.indexOf(1)
    for (let c = 0; c < 6; c++) expect(a.uv[f * 6 + c]).toBeGreaterThanOrEqual(0)
    for (let c = 0; c < 6; c++) expect(a.uv[f * 6 + c]).toBeLessThanOrEqual(1)
  })

  it('marks the space the views reached, and nothing they never saw', () => {
    // Only the left half of each image measures the wall.
    const views = [wallView([0, 0.8, 0], (u) => u < W / 2), wallView([0, 0.8, -0.1], (u) => u < W / 2)]
    const fu = createFusion(box.min, box.max, 0.02)
    fuseViews(fu, views, { depthW: W, depthH: H, ...VIDEO, minConfidence: 2 })
    const at = (x: number, y: number, z: number) =>
      fu.reached[(Math.floor((z - fu.origin[2]) / 0.02) * fu.ny + Math.floor((y - fu.origin[1]) / 0.02)) * fu.nx + Math.floor((x - fu.origin[0]) / 0.02)]
    // In front of the measured (left) half, up to the wall: reached. Right half: never measured.
    expect(at(-0.3, 0.8, -1)).toBe(1)
    expect(at(-0.3, 0.8, -1.95)).toBe(1)
    expect(at(0.4, 0.8, -1)).toBe(0)
  })

  it('colors the surface from nearby scan points, grey where there are none', () => {
    const positions = new Float32Array([0, 0, 0, 5, 5, 5])
    const { colors, colored } = colorFromPoints(positions, new Float32Array([0.01, 0.01, 0.01]), new Uint8Array([200, 10, 20]), 0.02)
    expect(Array.from(colors)).toEqual([200, 10, 20, 128, 128, 128])
    expect(Array.from(colored)).toEqual([1, 0])
  })
})
