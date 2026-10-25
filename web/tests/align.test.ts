import { describe, expect, it } from 'vitest'
import { alignToRoom, bestRigid, indexPoints } from '../src/scene/align'
import { lookAtPose } from './fixture'

const W = 256
const H = 192
const VIDEO = { videoW: 1920, videoH: 1440 }
const K = [1450, 1450, 960, 720]
type Vec3 = [number, number, number]

/** A room corner: floor y = 0, back wall z = −2, side wall x = −1.2, as points every 1 cm. */
function roomPoints(): Float32Array {
  const p: number[] = []
  for (let x = -1.2; x <= 1.2; x += 0.01) for (let z = -2; z <= 0.5; z += 0.01) p.push(x, 0, z)
  for (let x = -1.2; x <= 1.2; x += 0.01) for (let y = 0; y <= 2; y += 0.01) p.push(x, y, -2)
  for (let z = -2; z <= 0.5; z += 0.01) for (let y = 0; y <= 2; y += 0.01) p.push(-1.2, y, z)
  return new Float32Array(p)
}

/** Depth of that corner seen from `pos` toward `target` (ray-traced per pixel). */
function view(pos: Vec3, target: Vec3) {
  const T = lookAtPose(pos, target, 0)
  const depth = new Uint16Array(W * H)
  const confidence = new Uint8Array(W * H).fill(2)
  const s = W / VIDEO.videoW
  for (let v = 0; v < H; v++)
    for (let u = 0; u < W; u++) {
      const rx = (u + 0.5 - K[2] * s) / (K[0] * s)
      const ry = -(v + 0.5 - K[3] * s) / (K[1] * s)
      const d = [T[0] * rx + T[4] * ry - T[8], T[1] * rx + T[5] * ry - T[9], T[2] * rx + T[6] * ry - T[10]]
      let hit = Infinity
      if (d[1] < 0) hit = Math.min(hit, -pos[1] / d[1])
      if (d[2] < 0) hit = Math.min(hit, (-2 - pos[2]) / d[2])
      if (d[0] < 0) hit = Math.min(hit, (-1.2 - pos[0]) / d[0])
      if (hit < 4.5) depth[v * W + u] = Math.round(hit * 1000)
    }
  return { T, K, depth, confidence }
}

/** Rotation about y by `deg` and a translation, as a column-major 4×4, applied on the left of T. */
function nudge(T: number[], deg: number, t: Vec3): number[] {
  const c = Math.cos((deg * Math.PI) / 180)
  const s = Math.sin((deg * Math.PI) / 180)
  const R = [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, t[0], t[1], t[2], 1]
  const out = new Array<number>(16).fill(0)
  for (let col = 0; col < 4; col++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[col * 4 + r] += R[k * 4 + r] * T[col * 4 + k]
  return out
}

describe('aligning a frame to the room', () => {
  it('finds the exact rigid motion between two point sets', () => {
    const a = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0]
    // Rotate 10° about z, then move by (0.1, −0.2, 0.05).
    const c = Math.cos(0.1745)
    const s = Math.sin(0.1745)
    const b: number[] = []
    for (let i = 0; i < a.length; i += 3) b.push(c * a[i] - s * a[i + 1] + 0.1, s * a[i] + c * a[i + 1] - 0.2, a[i + 2] + 0.05)
    const M = bestRigid(a, b)
    for (let i = 0; i < a.length; i += 3) {
      const x = M[0] * a[i] + M[4] * a[i + 1] + M[8] * a[i + 2] + M[12]
      const y = M[1] * a[i] + M[5] * a[i + 1] + M[9] * a[i + 2] + M[13]
      const z = M[2] * a[i] + M[6] * a[i + 1] + M[10] * a[i + 2] + M[14]
      expect(Math.hypot(x - b[i], y - b[i + 1], z - b[i + 2])).toBeLessThan(1e-6)
    }
  })

  it('undoes a pose drifted by 3 cm and 1°', () => {
    const room = indexPoints(roomPoints())
    const truth = view([0.2, 1.4, 0.3], [-0.4, 0.6, -2])
    // The depth was taken from the true pose; ARKit reports a drifted one.
    const drifted = { ...truth, T: nudge(truth.T, 1, [0.02, -0.01, 0.02]) }
    const fixed = alignToRoom(drifted, room, { depthW: W, depthH: H, ...VIDEO })
    expect(Math.hypot(fixed[12] - truth.T[12], fixed[13] - truth.T[13], fixed[14] - truth.T[14])).toBeLessThan(0.005)
    // The camera's viewing direction matches to within 0.2°.
    const dot = -(fixed[8] * -truth.T[8] + fixed[9] * -truth.T[9] + fixed[10] * -truth.T[10])
    expect(Math.acos(Math.min(1, dot)) * (180 / Math.PI)).toBeLessThan(0.2)
  })
})
