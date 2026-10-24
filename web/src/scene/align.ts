// Lines a video frame up with the scanned room. ARKit's pose for each frame drifts a little
// (1–4 cm and up to about a degree on these captures) from where the room scan put things; at
// 3 m a degree is 5 cm, enough to paint a table's color onto the floor beside it. Aligning the
// frame's own depth to the room's measured points (ICP) gives the small rigid correction.

import type { DepthView } from './surface'

/** The room's points in 2 cm cells, for nearest-point lookups. */
export interface PointIndex {
  points: Float32Array
  cell: number
  cells: Map<number, number[]>
}

const key = (x: number, y: number, z: number) => ((x + 4096) * 8192 + (y + 4096)) * 8192 + (z + 4096)

export function indexPoints(points: Float32Array, cell = 0.02, every = 2): PointIndex {
  const cells = new Map<number, number[]>()
  for (let i = 0; i < points.length / 3; i += every) {
    const k = key(Math.floor(points[i * 3] / cell), Math.floor(points[i * 3 + 1] / cell), Math.floor(points[i * 3 + 2] / cell))
    let list = cells.get(k)
    if (!list) cells.set(k, (list = []))
    list.push(i)
  }
  return { points, cell, cells }
}

/** The nearest indexed point within `radius` meters, or −1. */
function nearest(ix: PointIndex, x: number, y: number, z: number, radius: number): number {
  const r = Math.ceil(radius / ix.cell)
  const X = Math.floor(x / ix.cell)
  const Y = Math.floor(y / ix.cell)
  const Z = Math.floor(z / ix.cell)
  const P = ix.points
  let best = -1
  let bestD = radius * radius
  for (let a = -r; a <= r; a++)
    for (let b = -r; b <= r; b++)
      for (let c = -r; c <= r; c++) {
        const list = ix.cells.get(key(X + a, Y + b, Z + c))
        if (!list) continue
        for (const i of list) {
          const d = (P[i * 3] - x) ** 2 + (P[i * 3 + 1] - y) ** 2 + (P[i * 3 + 2] - z) ** 2
          if (d < bestD) {
            bestD = d
            best = i
          }
        }
      }
  return best
}

/** 4×4 column-major product a·b. */
function mul(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const out = new Array<number>(16).fill(0)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]
  return out
}

/**
 * The rotation and translation that best move points `a` onto `b` (least squares), by Horn's
 * quaternion method: the largest eigenvector of a 4×4 symmetric matrix, by power iteration.
 * Returned as a column-major 4×4.
 */
export function bestRigid(a: number[], b: number[]): number[] {
  const n = a.length / 3
  const ca = [0, 0, 0]
  const cb = [0, 0, 0]
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
    ca[k] += a[i * 3 + k] / n
    cb[k] += b[i * 3 + k] / n
  }
  const S = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  for (let i = 0; i < n; i++)
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r * 3 + c] += (a[i * 3 + r] - ca[r]) * (b[i * 3 + c] - cb[c])
  const [xx, xy, xz, yx, yy, yz, zx, zy, zz] = S
  const N = [
    [xx + yy + zz, yz - zy, zx - xz, xy - yx],
    [yz - zy, xx - yy - zz, xy + yx, zx + xz],
    [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
    [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
  ]
  // Shift so the wanted (largest) eigenvalue is also the largest in magnitude.
  const shift = N.flat().reduce((s, v) => s + Math.abs(v), 0)
  let q = [1, 0, 0, 0]
  for (let it = 0; it < 100; it++) {
    const next = [0, 1, 2, 3].map((r) => N[r].reduce((s, v, c) => s + v * q[c], 0) + shift * q[r])
    const len = Math.hypot(...next) || 1
    q = next.map((v) => v / len)
  }
  const [w, x, y, z] = q
  const R = [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ]
  const t = [0, 1, 2].map((r) => cb[r] - (R[r][0] * ca[0] + R[r][1] * ca[1] + R[r][2] * ca[2]))
  return [R[0][0], R[1][0], R[2][0], 0, R[0][1], R[1][1], R[2][1], 0, R[0][2], R[1][2], R[2][2], 0, t[0], t[1], t[2], 1]
}

/**
 * The frame's pose, corrected to line up with the room: its depth (high confidence, within
 * 3.5 m) is matched to the nearest room points and moved by the best rigid fit, repeatedly.
 * Pairs farther apart than 2.5× the median are left out (something that isn't the room, like
 * a person). If too little of the frame matches the room, the pose is returned unchanged.
 */
export function alignToRoom(view: DepthView, room: PointIndex, o: { depthW: number; depthH: number; videoW: number; videoH: number }): number[] {
  const { depthW: W, depthH: H } = o
  const sx = W / o.videoW
  const sy = H / o.videoH
  const fx = view.K[0] * sx
  const fy = view.K[1] * sy
  const cx = view.K[2] * sx
  const cy = view.K[3] * sy
  const local: number[] = []
  for (let v = 0; v < H; v += 6)
    for (let u = 0; u < W; u += 6) {
      const k = v * W + u
      if (view.confidence[k] < 2) continue
      const d = view.depth[k] / 1000
      if (d < 0.3 || d > 3.5) continue
      local.push(((u + 0.5 - cx) / fx) * d, -((v + 0.5 - cy) / fy) * d, -d)
    }
  let T = Array.from(view.T)
  if (local.length < 300) return T
  let firstError = -1
  let lastError = -1
  // Point-to-point matching slides slowly along flat walls, so it takes a few dozen rounds;
  // stop early once a round moves the frame by less than half a millimeter.
  for (let it = 0; it < 40; it++) {
    const src: number[] = []
    const dst: number[] = []
    const dist: number[] = []
    for (let i = 0; i < local.length; i += 3) {
      const [x, y, z] = [local[i], local[i + 1], local[i + 2]]
      const wx = T[0] * x + T[4] * y + T[8] * z + T[12]
      const wy = T[1] * x + T[5] * y + T[9] * z + T[13]
      const wz = T[2] * x + T[6] * y + T[10] * z + T[14]
      const j = nearest(room, wx, wy, wz, 0.04)
      if (j < 0) continue
      const P = room.points
      src.push(wx, wy, wz)
      dst.push(P[j * 3], P[j * 3 + 1], P[j * 3 + 2])
      dist.push(Math.hypot(P[j * 3] - wx, P[j * 3 + 1] - wy, P[j * 3 + 2] - wz))
    }
    if (dist.length < 100) return Array.from(view.T)
    const median = [...dist].sort((p, q) => p - q)[dist.length >> 1]
    if (firstError < 0) firstError = median
    lastError = median
    const a: number[] = []
    const b: number[] = []
    dist.forEach((d, i) => {
      if (d > Math.max(0.005, median * 2.5)) return
      a.push(src[i * 3], src[i * 3 + 1], src[i * 3 + 2])
      b.push(dst[i * 3], dst[i * 3 + 1], dst[i * 3 + 2])
    })
    const step = bestRigid(a, b)
    T = mul(step, T)
    if (Math.hypot(step[12], step[13], step[14]) < 0.0005 && Math.abs(step[0] + step[5] + step[10] - 3) < 1e-7) break
  }
  // Kept only if it fits no worse and is the size drift is (a few centimeters, a degree or
  // two): a frame that sees mostly one flat floor can slide along it into a wrong fit, and
  // ARKit's own pose is the safer guess then.
  const moved = Math.hypot(T[12] - view.T[12], T[13] - view.T[13], T[14] - view.T[14])
  const turned = Math.acos(Math.min(1, (T[0] * view.T[0] + T[1] * view.T[1] + T[2] * view.T[2] + T[4] * view.T[4] + T[5] * view.T[5] + T[6] * view.T[6] + T[8] * view.T[8] + T[9] * view.T[9] + T[10] * view.T[10] - 1) / 2))
  const better = lastError <= firstError
  return better && moved <= 0.05 && turned <= (2 * Math.PI) / 180 ? T : Array.from(view.T)
}
