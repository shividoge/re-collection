import { describe, expect, it } from 'vitest'
import { fuseTSDF, marchingCubes, type Grid } from '../src/scene/surface'
import { buildTimeline, FOREVER, meshMask, type MomentView } from '../src/scene/timeline'
import { lookAtPose } from './fixture'

const W = 256
const H = 192
const VIDEO = { videoW: 1920, videoH: 1440 }
const K = [1450, 1450, 960, 720]
type Vec3 = [number, number, number]
type Box = { min: Vec3; max: Vec3 }

/** The box in front of the wall: 30 cm cube standing 1 m in front of it. */
const BOX: Box = { min: [-0.15, 0.6, -1.15], max: [0.15, 0.9, -0.85] }
const extent = { min: [-1.5, -0.5, -2.5] as Vec3, max: [1.5, 2, 0.5] as Vec3 }

/**
 * Depth of a scene made of the wall z = −2 and an optional box, seen from `pos` toward
 * `target`: ray-traced per pixel, all high confidence.
 */
function render(pos: Vec3, target: Vec3, box: Box | null, t: number, keyframe = false): MomentView {
  const T = lookAtPose(pos, target, 0)
  const depth = new Uint16Array(W * H)
  const confidence = new Uint8Array(W * H).fill(2)
  const fx = K[0] * (W / VIDEO.videoW)
  const fy = K[1] * (H / VIDEO.videoH)
  const cx = K[2] * (W / VIDEO.videoW)
  const cy = K[3] * (H / VIDEO.videoH)
  for (let v = 0; v < H; v++)
    for (let u = 0; u < W; u++) {
      // Camera-space direction with z-depth 1, to world.
      const rx = (u + 0.5 - cx) / fx
      const ry = -(v + 0.5 - cy) / fy
      const d: Vec3 = [T[0] * rx + T[4] * ry - T[8], T[1] * rx + T[5] * ry - T[9], T[2] * rx + T[6] * ry - T[10]]
      let hit = d[2] < 0 ? (-2 - pos[2]) / d[2] : Infinity
      if (box) {
        let near = -Infinity
        let far = Infinity
        for (let a = 0; a < 3; a++) {
          if (Math.abs(d[a]) < 1e-9) {
            if (pos[a] < box.min[a] || pos[a] > box.max[a]) near = Infinity
            continue
          }
          const t1 = (box.min[a] - pos[a]) / d[a]
          const t2 = (box.max[a] - pos[a]) / d[a]
          near = Math.max(near, Math.min(t1, t2))
          far = Math.min(far, Math.max(t1, t2))
        }
        if (near <= far && near > 0) hit = Math.min(hit, near)
      }
      if (Number.isFinite(hit) && hit < 4.5) depth[v * W + u] = Math.round(hit * 1000)
    }
  return { T, K, depth, confidence, t, color: keyframe ? new Uint8ClampedArray(W * H * 4).fill(180) : null }
}

/** The room surface from a scan of the scene, and its masks, as the worker builds them. */
function roomFrom(scan: MomentView[]) {
  const vol = fuseTSDF(scan, { ...extent, voxel: 0.02, depthW: W, depthH: H, ...VIDEO, minConfidence: 2 })
  const mesh = marchingCubes(vol, 3)
  const grid: Grid = vol
  return { grid, room: meshMask(mesh.positions, grid, 2) }
}

const scanOf = (box: Box | null) => [-0.3, -0.15, 0, 0.15, 0.3].map((x, i) => render([x, 0.8, 0.5], [x * 0.5, 0.75, -2], box, -5 + i))
const opts = { depthW: W, depthH: H, ...VIDEO }
const inBox = (p: Float32Array, i: number, b: Box, pad = 0.04) =>
  p[i * 3] > b.min[0] - pad && p[i * 3] < b.max[0] + pad && p[i * 3 + 1] > b.min[1] - pad && p[i * 3 + 1] < b.max[1] + pad && p[i * 3 + 2] > b.min[2] - pad && p[i * 3 + 2] < b.max[2] + pad

describe('moment timeline', () => {
  it('adds nothing when the visit shows just the scanned room', () => {
    const { grid, room } = roomFrom(scanOf(null))
    const views = Array.from({ length: 20 }, (_, f) => render([0.1 * Math.sin(f / 3), 0.8, 0.4], [0, 0.75, -2], null, f / 10, f % 10 === 0))
    const tl = buildTimeline(views, grid, room, opts)
    expect(tl.start.length).toBe(0)
  })

  it('keeps something brought in from when it is seen, also while the camera looks away', () => {
    const { grid, room } = roomFrom(scanOf(null))
    // 0–0.9 s: the empty wall. 1.0–1.9 s: the box is there and seen. 2.0–3.9 s: the camera
    // turns far to the right; the box is out of view (and never seen through).
    const views = Array.from({ length: 40 }, (_, f) => {
      const t = f / 10
      const target: Vec3 = t < 2 ? [0, 0.75, -2] : [3, 0.75, -1]
      return render([0, 0.8, 0.5], target, t >= 1 ? BOX : null, t, f % 10 === 0)
    })
    const tl = buildTimeline(views, grid, room, opts)
    expect(tl.start.length).toBeGreaterThan(50)
    for (let i = 0; i < tl.start.length; i++) {
      expect(inBox(tl.positions, i, BOX)).toBe(true)
      expect(tl.start[i]).toBeGreaterThanOrEqual(1)
      expect(tl.end[i]).toBe(FOREVER)
    }
  })

  it('ends it once the camera sees straight through where it was', () => {
    const { grid, room } = roomFrom(scanOf(null))
    // The box is there from 0 to 1.9 s, then taken away while the camera keeps watching.
    const views = Array.from({ length: 40 }, (_, f) => render([0.05 * Math.sin(f), 0.8, 0.5], [0, 0.75, -2], f < 20 ? BOX : null, f / 10, f % 10 === 0))
    const tl = buildTimeline(views, grid, room, opts)
    expect(tl.start.length).toBeGreaterThan(50)
    let ended = 0
    for (let i = 0; i < tl.end.length; i++) if (tl.end[i] >= 2 && tl.end[i] <= 2.2) ended++
    // The box's front is seen through once it's gone; its hidden back can't be, and stays.
    expect(ended / tl.end.length).toBeGreaterThan(0.5)
  })
})
