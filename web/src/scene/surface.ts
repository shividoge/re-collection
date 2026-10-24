// Turning the room scan into one connected surface, without inventing anything.
//
// TSDF fusion (as in KinectFusion): every depth frame from the room scan, each from its own
// camera pose, votes on where the surface is in a 3D grid of voxels. A voxel's value is its
// signed distance to the nearest measured surface along the camera ray, averaged over every
// view that saw it, so noise from one frame is outvoted by the others. Marching cubes then
// draws the surface where the averaged distance crosses zero, as one connected triangle mesh.
// Places no camera measured have no votes and stay open; nothing is filled by guesswork.
//
// Three rules keep surfaces from appearing where nothing is, the same way on every scan:
// - votes are counted per view, not per ray, so one close-up frame counts once;
// - depth pixels on a depth edge (where LiDAR blends foreground and background) don't vote;
// - free space wins: a voxel that more views saw straight through than saw a surface at is
//   dropped, so a surface one frame put there by mistake is carved away by the others.

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
  /** Use every n-th depth pixel for free-space votes (they only need to cover each voxel). */
  freeStride?: number
  /**
   * A voxel needs at least this share of the best-supported voxel within one truncation band,
   * so the noise around a well-seen surface can't form a second, ghost surface next to it.
   */
  ghostRatio?: number
}

/** A voxel grid over the room: voxel (x, y, z) is index (z·ny + y)·nx + x. */
export interface Grid {
  nx: number
  ny: number
  nz: number
  origin: Vec3
  voxel: number
}

export interface Volume extends Grid {
  /** Signed distance / truncation, in [−1, 1]; positive in front of the surface. */
  tsdf: Float32Array
  /**
   * How many views measured a surface at each voxel (capped at 255), or 0 where more views saw
   * straight through it than measured a surface there.
   */
  weight: Uint8Array
}

/** A depth pixel is on an edge when a neighbor is much nearer or farther (mixed depth). */
export function edgePixels(depth: Uint16Array, w: number, h: number): Uint8Array {
  const edge = new Uint8Array(w * h)
  for (let v = 0; v < h; v++)
    for (let u = 0; u < w; u++) {
      const k = v * w + u
      const d = depth[k]
      // Allowed jump: 2 cm plus 4% of the depth, so a floor seen at a grazing angle still counts.
      const limit = 20 + d * 0.04
      if (
        (u > 0 && Math.abs(depth[k - 1] - d) > limit) ||
        (u < w - 1 && Math.abs(depth[k + 1] - d) > limit) ||
        (v > 0 && Math.abs(depth[k - w] - d) > limit) ||
        (v < h - 1 && Math.abs(depth[k + w] - d) > limit)
      )
        edge[k] = 1
    }
  return edge
}

export function fuseTSDF(views: Iterable<DepthView>, o: FuseOptions): Volume {
  const voxel = o.voxel ?? 0.02
  const trunc = o.truncation ?? voxel * 3
  const minConf = o.minConfidence ?? 1
  const maxDepth = o.maxDepth ?? 4.5
  const stride = o.stride ?? 1
  const freeStride = o.freeStride ?? 4
  const nx = Math.ceil((o.max[0] - o.min[0]) / voxel) + 1
  const ny = Math.ceil((o.max[1] - o.min[1]) / voxel) + 1
  const nz = Math.ceil((o.max[2] - o.min[2]) / voxel) + 1
  const n = nx * ny * nz
  const tsdf = new Float32Array(n).fill(1)
  // Ray votes, for averaging the distance; views, for deciding what's real.
  const rays = new Uint8Array(n)
  const seen = new Uint8Array(n)
  const free = new Uint8Array(n)
  const seenBy = new Int32Array(n).fill(-1)
  const freeBy = new Int32Array(n).fill(-1)
  const [ox, oy, oz] = o.min
  const sx = o.depthW / o.videoW
  const sy = o.depthH / o.videoH
  const step = voxel * 0.6

  let viewId = 0
  for (const view of views) {
    const T = view.T
    const fx = view.K[0] * sx
    const fy = view.K[1] * sy
    const cx = view.K[2] * sx
    const cy = view.K[3] * sy
    const edge = edgePixels(view.depth, o.depthW, o.depthH)
    for (let v = 0; v < o.depthH; v++) {
      for (let u = 0; u < o.depthW; u++) {
        const surfaceRay = u % stride === 0 && v % stride === 0
        const freeRay = u % freeStride === 0 && v % freeStride === 0
        if (!surfaceRay && !freeRay) continue
        const k = v * o.depthW + u
        if (view.confidence[k] < minConf || edge[k]) continue
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
        if (freeRay) {
          // Free space: everything from the camera to well in front of the surface was seen
          // through. Stops a full truncation band short, so the surface's own voxels are safe.
          for (let t = 0.2; t < d - 2 * trunc; t += voxel / len) {
            const x = Math.floor((T[12] + wx * t - ox) / voxel)
            const y = Math.floor((T[13] + wy * t - oy) / voxel)
            const z = Math.floor((T[14] + wz * t - oz) / voxel)
            if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue
            const i = (z * ny + y) * nx + x
            if (freeBy[i] === viewId) continue
            freeBy[i] = viewId
            if (free[i] < 255) free[i]++
          }
        }
        if (!surfaceRay) continue
        // Vote at points along the ray from just in front of the surface to just behind it.
        for (let t = d - trunc; t <= d + trunc; t += step / len) {
          const sdf = (d - t) * len
          const x = Math.floor((T[12] + wx * t - ox) / voxel)
          const y = Math.floor((T[13] + wy * t - oy) / voxel)
          const z = Math.floor((T[14] + wz * t - oz) / voxel)
          if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue
          const i = (z * ny + y) * nx + x
          const w = rays[i]
          const value = Math.max(-1, Math.min(1, sdf / trunc))
          tsdf[i] = (tsdf[i] * w + value) / (w + 1)
          if (w < 255) rays[i] = w + 1
          if (seenBy[i] !== viewId) {
            seenBy[i] = viewId
            if (seen[i] < 255) seen[i]++
          }
        }
      }
    }
    viewId++
  }
  // Free space wins over a surface fewer views agree on.
  const weight = seen
  for (let i = 0; i < n; i++) if (free[i] > seen[i]) weight[i] = 0
  // Ghosts: much weaker support than the best surface within one truncation band.
  const ratio = o.ghostRatio ?? 0.3
  if (ratio > 0) {
    const best = maxFilter(weight, nx, ny, nz, Math.round(trunc / voxel))
    for (let i = 0; i < n; i++) if (weight[i] < best[i] * ratio) weight[i] = 0
  }
  return { nx, ny, nz, origin: [ox, oy, oz], voxel, tsdf, weight }
}

/** The largest value within `r` voxels along each axis (a separable box max). */
export function maxFilter(src: Uint8Array, nx: number, ny: number, nz: number, r: number): Uint8Array {
  let a = src.slice()
  let b = new Uint8Array(src.length)
  const strides = [1, nx, nx * ny]
  const sizes = [nx, ny, nz]
  for (let axis = 0; axis < 3; axis++) {
    const st = strides[axis]
    const len = sizes[axis]
    for (let i = 0; i < src.length; i++) {
      const c = Math.floor(i / st) % len
      let m = 0
      for (let k = Math.max(0, c - r); k <= Math.min(len - 1, c + r); k++) {
        const v = a[i + (k - c) * st]
        if (v > m) m = v
      }
      b[i] = m
    }
    ;[a, b] = [b, a]
  }
  return a
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
 * that close get neutral grey and are marked uncolored.
 */
export function colorFromPoints(
  meshPositions: Float32Array,
  points: Float32Array,
  colors: Uint8Array,
  cell = 0.02,
): { colors: Uint8Array; colored: Uint8Array } {
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
  const colored = new Uint8Array(meshPositions.length / 3)
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
    else {
      out.set([r / n, g / n, b / n], v * 3)
      colored[v] = 1
    }
  }
  return { colors: out, colored }
}

export type ColoredMesh = Mesh & { colors: Uint8Array }

/**
 * Keeps only triangles whose three vertices pass `keep`, then drops connected pieces smaller
 * than `minArea` square meters (specks floating on their own), and packs the vertices.
 */
export function trimMesh(mesh: ColoredMesh, keep: Uint8Array, minArea: number): ColoredMesh {
  const { positions: P, indices: I } = mesh
  const tris: number[] = []
  for (let k = 0; k < I.length; k += 3) if (keep[I[k]] && keep[I[k + 1]] && keep[I[k + 2]]) tris.push(k)

  // Connected pieces over shared vertices (union-find).
  const parent = new Int32Array(P.length / 3).map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]]
    return i
  }
  for (const k of tris) {
    const a = find(I[k])
    parent[find(I[k + 1])] = a
    parent[find(I[k + 2])] = a
  }
  const area = new Map<number, number>()
  for (const k of tris) {
    const root = find(I[k])
    area.set(root, (area.get(root) ?? 0) + triangleArea(P, I[k], I[k + 1], I[k + 2]))
  }

  const remap = new Int32Array(P.length / 3).fill(-1)
  const positions: number[] = []
  const normals: number[] = []
  const colors: number[] = []
  const indices: number[] = []
  for (const k of tris) {
    if ((area.get(find(I[k])) ?? 0) < minArea) continue
    for (let c = 0; c < 3; c++) {
      const v = I[k + c]
      if (remap[v] < 0) {
        remap[v] = positions.length / 3
        positions.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2])
        normals.push(mesh.normals[v * 3], mesh.normals[v * 3 + 1], mesh.normals[v * 3 + 2])
        colors.push(mesh.colors[v * 3], mesh.colors[v * 3 + 1], mesh.colors[v * 3 + 2])
      }
      indices.push(remap[v])
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Uint8Array(colors),
    indices: new Uint32Array(indices),
  }
}

function triangleArea(P: Float32Array, a: number, b: number, c: number): number {
  const ux = P[b * 3] - P[a * 3]
  const uy = P[b * 3 + 1] - P[a * 3 + 1]
  const uz = P[b * 3 + 2] - P[a * 3 + 2]
  const vx = P[c * 3] - P[a * 3]
  const vy = P[c * 3 + 1] - P[a * 3 + 1]
  const vz = P[c * 3 + 2] - P[a * 3 + 2]
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2
}

export interface RoomSurfaceInput {
  depthW: number
  depthH: number
  videoW: number
  videoH: number
  /** The phone's colored room points (room.bin). */
  points: Float32Array
  colors: Uint8Array
}

/**
 * The room's surface from its scan, with the same settings for every capture: 2 cm voxels,
 * high-confidence depth only, at least three views agreeing, and only where the phone also
 * kept colored points (so every triangle shown has a measured color), without specks.
 */
export function buildRoomSurface(views: DepthView[], o: RoomSurfaceInput): { mesh: ColoredMesh; grid: Grid } {
  const voxel = 0.02
  const volume = fuseTSDF(views, { ...roomExtent(o.points), voxel, depthW: o.depthW, depthH: o.depthH, videoW: o.videoW, videoH: o.videoH, minConfidence: 2 })
  const mesh = marchingCubes(volume, 3)
  const { colors, colored } = colorFromPoints(mesh.positions, o.points, o.colors, voxel)
  const { nx, ny, nz, origin } = volume
  return { mesh: trimMesh({ ...mesh, colors }, colored, MIN_PIECE_AREA), grid: { nx, ny, nz, origin, voxel } }
}

/** Pieces smaller than this (m²) are dropped: about a 7 × 7 cm patch. */
export const MIN_PIECE_AREA = 0.005

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
