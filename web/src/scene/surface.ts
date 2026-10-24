// Turning the room scan into one connected surface, without inventing anything.
//
// TSDF fusion (as in KinectFusion): every depth frame from the room scan, each from its own
// camera pose, votes on where the surface is in a 3D grid of voxels. A voxel's value is its
// signed distance to the nearest measured surface along the camera ray, averaged over every
// view that saw it, so noise from one frame is outvoted by the others. Marching cubes then
// draws the surface where the averaged distance crosses zero, as one connected triangle mesh.
// Places no camera measured have no votes and stay open; nothing is filled by guesswork.

import { edgeTable, triTable } from 'three/examples/jsm/objects/MarchingCubes.js'

export type Vec3 = [number, number, number]

/** One depth frame: UInt16 millimeters and UInt8 confidence, row-major, from camera pose T. */
export interface DepthView {
  /** Camera-to-world, column-major (ARKit camera: x right, y up, looks down −z). */
  T: ArrayLike<number>
  /** fx, fy, cx, cy at full video resolution. */
  K: ArrayLike<number>
  depth: Uint16Array
  confidence: Uint8Array
}

export interface FuseOptions {
  /** Room extent to fuse, in world meters. */
  min: Vec3
  max: Vec3
  /** Voxel edge in meters. */
  voxel?: number
  /** How far either side of a measured surface a view votes, in meters. */
  truncation?: number
  depthW: number
  depthH: number
  videoW: number
  videoH: number
  /** Pixels below this confidence (0 low, 1 medium, 2 high) don't vote. */
  minConfidence?: number
  maxDepth?: number
  /** Use every n-th depth pixel in each direction. */
  stride?: number
}

export interface Volume {
  nx: number
  ny: number
  nz: number
  origin: Vec3
  voxel: number
  /** Signed distance / truncation, in [−1, 1]; positive in front of the surface. */
  tsdf: Float32Array
  /** How many votes each voxel got (capped at 255). */
  weight: Uint8Array
}

export function fuseTSDF(views: Iterable<DepthView>, o: FuseOptions): Volume {
  const voxel = o.voxel ?? 0.02
  const trunc = o.truncation ?? voxel * 3
  const minConf = o.minConfidence ?? 1
  const maxDepth = o.maxDepth ?? 4.5
  const stride = o.stride ?? 1
  const nx = Math.ceil((o.max[0] - o.min[0]) / voxel) + 1
  const ny = Math.ceil((o.max[1] - o.min[1]) / voxel) + 1
  const nz = Math.ceil((o.max[2] - o.min[2]) / voxel) + 1
  const tsdf = new Float32Array(nx * ny * nz).fill(1)
  const weight = new Uint8Array(nx * ny * nz)
  const [ox, oy, oz] = o.min
  const sx = o.depthW / o.videoW
  const sy = o.depthH / o.videoH
  const step = voxel * 0.6

  for (const view of views) {
    const T = view.T
    const fx = view.K[0] * sx
    const fy = view.K[1] * sy
    const cx = view.K[2] * sx
    const cy = view.K[3] * sy
    for (let v = 0; v < o.depthH; v += stride) {
      for (let u = 0; u < o.depthW; u += stride) {
        const k = v * o.depthW + u
        if (view.confidence[k] < minConf) continue
        const d = view.depth[k] / 1000
        if (d < 0.2 || d > maxDepth) continue
        // Ray direction in ARKit camera space, scaled so that its −z component is 1.
        const rx = (u + 0.5 - cx) / fx
        const ry = -(v + 0.5 - cy) / fy
        // World-space direction and camera origin.
        const wx = T[0] * rx + T[4] * ry - T[8]
        const wy = T[1] * rx + T[5] * ry - T[9]
        const wz = T[2] * rx + T[6] * ry - T[10]
        const len = Math.hypot(rx, ry, 1)
        // Vote at points along the ray from just in front of the surface to just behind it.
        for (let t = d - trunc; t <= d + trunc; t += step / len) {
          const sdf = (d - t) * len
          const x = Math.floor((T[12] + wx * t - ox) / voxel)
          const y = Math.floor((T[13] + wy * t - oy) / voxel)
          const z = Math.floor((T[14] + wz * t - oz) / voxel)
          if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue
          const i = (z * ny + y) * nx + x
          const w = weight[i]
          const value = Math.max(-1, Math.min(1, sdf / trunc))
          tsdf[i] = (tsdf[i] * w + value) / (w + 1)
          if (w < 255) weight[i] = w + 1
        }
      }
    }
  }
  return { nx, ny, nz, origin: [ox, oy, oz], voxel, tsdf, weight }
}

export interface Mesh {
  positions: Float32Array
  normals: Float32Array
  indices: Uint32Array
}

/** Lattice corner offsets in marching-cubes order (Paul Bourke's numbering, as three.js uses). */
const CORNERS = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
]
/** The two corners each of the 12 cube edges joins. */
const EDGES = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 4],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
]

/**
 * Marching cubes on the fused volume: the surface where the averaged signed distance is zero.
 * A cube only produces triangles when all eight corners got at least `minWeight` votes, so a
 * single noisy view can't make a surface on its own. Vertices on shared edges are shared, so
 * the mesh is connected.
 */
export function marchingCubes(vol: Volume, minWeight = 2): Mesh {
  const { nx, ny, nz, tsdf, weight, voxel, origin } = vol
  const positions: number[] = []
  const indices: number[] = []
  const vertexOfEdge = new Map<number, number>()
  const at = (x: number, y: number, z: number) => (z * ny + y) * nx + x
  const values = new Float32Array(8)
  const cornerIndex = new Int32Array(8)
  const edgeVertex = new Int32Array(12)

  for (let z = 0; z < nz - 1; z++)
    for (let y = 0; y < ny - 1; y++)
      for (let x = 0; x < nx - 1; x++) {
        if (weight[at(x, y, z)] < minWeight) continue
        let cube = 0
        let ok = true
        for (let c = 0; c < 8; c++) {
          const i = at(x + CORNERS[c][0], y + CORNERS[c][1], z + CORNERS[c][2])
          if (weight[i] < minWeight) {
            ok = false
            break
          }
          cornerIndex[c] = i
          values[c] = tsdf[i]
          if (values[c] < 0) cube |= 1 << c
        }
        if (!ok) continue
        const edges = edgeTable[cube]
        if (edges === 0) continue
        for (let e = 0; e < 12; e++) {
          if (!(edges & (1 << e))) continue
          const [a, b] = EDGES[e]
          // One id per lattice edge, so neighboring cubes share the vertex.
          const lo = Math.min(cornerIndex[a], cornerIndex[b])
          const hi = Math.max(cornerIndex[a], cornerIndex[b])
          const axis = hi - lo === 1 ? 0 : hi - lo === nx ? 1 : 2
          const key = lo * 3 + axis
          let id = vertexOfEdge.get(key)
          if (id === undefined) {
            const t = values[a] / (values[a] - values[b])
            const pa = CORNERS[a]
            const pb = CORNERS[b]
            id = positions.length / 3
            positions.push(
              origin[0] + (x + pa[0] + (pb[0] - pa[0]) * t) * voxel,
              origin[1] + (y + pa[1] + (pb[1] - pa[1]) * t) * voxel,
              origin[2] + (z + pa[2] + (pb[2] - pa[2]) * t) * voxel,
            )
            vertexOfEdge.set(key, id)
          }
          edgeVertex[e] = id
        }
        for (let k = cube * 16; triTable[k] !== -1; k += 3) {
          indices.push(edgeVertex[triTable[k]], edgeVertex[triTable[k + 1]], edgeVertex[triTable[k + 2]])
        }
      }

  const pos = new Float32Array(positions)
  const idx = new Uint32Array(indices)
  return { positions: pos, normals: vertexNormals(pos, idx), indices: idx }
}

function vertexNormals(pos: Float32Array, idx: Uint32Array): Float32Array {
  const n = new Float32Array(pos.length)
  for (let k = 0; k < idx.length; k += 3) {
    const a = idx[k] * 3
    const b = idx[k + 1] * 3
    const c = idx[k + 2] * 3
    const ux = pos[b] - pos[a]
    const uy = pos[b + 1] - pos[a + 1]
    const uz = pos[b + 2] - pos[a + 2]
    const vx = pos[c] - pos[a]
    const vy = pos[c + 1] - pos[a + 1]
    const vz = pos[c + 2] - pos[a + 2]
    const fx = uy * vz - uz * vy
    const fy = uz * vx - ux * vz
    const fz = ux * vy - uy * vx
    for (const i of [a, b, c]) {
      n[i] += fx
      n[i + 1] += fy
      n[i + 2] += fz
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1
    n[i] /= l
    n[i + 1] /= l
    n[i + 2] /= l
  }
  return n
}

/**
 * Colors each mesh vertex from the scan's own colored points nearby: the average of the points
 * in the 3×3×3 cells around it, or the 5×5×5 cells when those are empty. Vertices with no point
 * that close get neutral grey.
 */
export function colorFromPoints(meshPositions: Float32Array, points: Float32Array, colors: Uint8Array, cell = 0.02): Uint8Array {
  const AXIS = 1 << 16
  const OFF = AXIS / 2
  const keyOf = (x: number, y: number, z: number) => ((x + OFF) * AXIS + (y + OFF)) * AXIS + (z + OFF)
  const sums = new Map<number, number[]>()
  for (let i = 0; i < points.length / 3; i++) {
    const k = keyOf(Math.floor(points[i * 3] / cell), Math.floor(points[i * 3 + 1] / cell), Math.floor(points[i * 3 + 2] / cell))
    let s = sums.get(k)
    if (!s) sums.set(k, (s = [0, 0, 0, 0]))
    s[0] += colors[i * 3]
    s[1] += colors[i * 3 + 1]
    s[2] += colors[i * 3 + 2]
    s[3]++
  }
  const out = new Uint8Array(meshPositions.length)
  for (let v = 0; v < meshPositions.length / 3; v++) {
    const cx = Math.floor(meshPositions[v * 3] / cell)
    const cy = Math.floor(meshPositions[v * 3 + 1] / cell)
    const cz = Math.floor(meshPositions[v * 3 + 2] / cell)
    let r = 0
    let g = 0
    let b = 0
    let n = 0
    for (let ring = 1; ring <= 2 && n === 0; ring++)
      for (let dx = -ring; dx <= ring; dx++)
        for (let dy = -ring; dy <= ring; dy++)
          for (let dz = -ring; dz <= ring; dz++) {
            const s = sums.get(keyOf(cx + dx, cy + dy, cz + dz))
            if (!s) continue
            r += s[0]
            g += s[1]
            b += s[2]
            n += s[3]
          }
    if (n === 0) out.set([128, 128, 128], v * 3)
    else out.set([r / n, g / n, b / n], v * 3)
  }
  return out
}

/** The room's extent from its points, ignoring the most extreme 0.5% on each axis (stray points). */
export function roomExtent(points: Float32Array, pad = 0.15): { min: Vec3; max: Vec3 } {
  const n = points.length / 3
  const step = Math.max(1, Math.floor(n / 200_000))
  const axes: number[][] = [[], [], []]
  for (let i = 0; i < n; i += step) for (let a = 0; a < 3; a++) axes[a].push(points[i * 3 + a])
  const min = [0, 0, 0] as Vec3
  const max = [0, 0, 0] as Vec3
  for (let a = 0; a < 3; a++) {
    const s = axes[a].sort((p, q) => p - q)
    min[a] = s[Math.floor(s.length * 0.005)] - pad
    max[a] = s[Math.floor(s.length * 0.995)] + pad
  }
  return { min, max }
}
