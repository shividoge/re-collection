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

/** How the depth frames are read; shared by the room's fusion and the visit timeline. */
export interface ViewOptions {
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
  /** Voxels these views may not add surface to (they can still see through them). */
  blocked?: Uint8Array | null
}

export interface FuseOptions extends ViewOptions {
  /** Room extent to fuse, in world meters. */
  min: Vec3
  max: Vec3
  /** Voxel edge in meters. */
  voxel?: number
  /** How far either side of a measured surface a view votes, in meters. */
  truncation?: number
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

/** Fusion in progress: more views can be added before the volume is finished. */
export interface Fusion extends Grid {
  truncation: number
  tsdf: Float32Array
  /** Ray votes, for averaging the distance. */
  rays: Uint8Array
  /** Views that measured a surface here, and views that saw straight through (capped at 255). */
  seen: Uint8Array
  free: Uint8Array
  seenBy: Uint16Array
  freeBy: Uint16Array
  views: number
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

const NO_VIEW = 0xffff

export function createFusion(min: Vec3, max: Vec3, voxel = 0.02, truncation = voxel * 3): Fusion {
  const nx = Math.ceil((max[0] - min[0]) / voxel) + 1
  const ny = Math.ceil((max[1] - min[1]) / voxel) + 1
  const nz = Math.ceil((max[2] - min[2]) / voxel) + 1
  const n = nx * ny * nz
  return {
    nx,
    ny,
    nz,
    origin: [min[0], min[1], min[2]],
    voxel,
    truncation,
    tsdf: new Float32Array(n).fill(1),
    rays: new Uint8Array(n),
    seen: new Uint8Array(n),
    free: new Uint8Array(n),
    seenBy: new Uint16Array(n).fill(NO_VIEW),
    freeBy: new Uint16Array(n).fill(NO_VIEW),
    views: 0,
  }
}

/** Adds depth views to the fusion. */
export function fuseViews(fu: Fusion, views: Iterable<DepthView>, o: ViewOptions) {
  const { nx, ny, nz, voxel, truncation: trunc, tsdf, rays, seen, free, seenBy, freeBy } = fu
  const minConf = o.minConfidence ?? 1
  const maxDepth = o.maxDepth ?? 4.5
  const stride = o.stride ?? 1
  const freeStride = o.freeStride ?? 4
  const blocked = o.blocked ?? null
  const [ox, oy, oz] = fu.origin
  const sx = o.depthW / o.videoW
  const sy = o.depthH / o.videoH
  const step = voxel * 0.6

  for (const view of views) {
    const viewId = fu.views++ % NO_VIEW
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
          if (blocked && blocked[i]) continue
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
  }
}

/**
 * Space the views so far saw as empty: seen through by at least two views, and by more views
 * than measured a surface there.
 */
export function knownEmpty(fu: Fusion): Uint8Array {
  const out = new Uint8Array(fu.free.length)
  for (let i = 0; i < out.length; i++) if (fu.free[i] >= 2 && fu.free[i] > fu.seen[i]) out[i] = 1
  return out
}

/** Settles which voxels hold a surface: free space wins, and ghost layers are dropped. */
export function finishVolume(fu: Fusion, ghostRatio = 0.3): Volume {
  const { nx, ny, nz, origin, voxel, tsdf, seen, free } = fu
  const weight = seen.slice()
  // Free space wins over a surface fewer views agree on.
  for (let i = 0; i < weight.length; i++) if (free[i] > seen[i]) weight[i] = 0
  // Ghosts: much weaker support than the best surface within one truncation band.
  if (ghostRatio > 0) {
    const best = maxFilter(weight, nx, ny, nz, Math.round(fu.truncation / voxel))
    for (let i = 0; i < weight.length; i++) if (weight[i] < best[i] * ghostRatio) weight[i] = 0
  }
  return { nx, ny, nz, origin, voxel, tsdf, weight }
}

export function fuseTSDF(views: Iterable<DepthView>, o: FuseOptions): Volume {
  const fu = createFusion(o.min, o.max, o.voxel ?? 0.02, o.truncation)
  fuseViews(fu, views, o)
  return finishVolume(fu, o.ghostRatio ?? 0.3)
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

/** A keyframe as the texturing sees it: its exact pose, and the depth frame taken with it. */
export interface KeyView {
  /** Camera-to-world and intrinsics (at video resolution) of the video frame the image is. */
  T: ArrayLike<number>
  K: ArrayLike<number>
  /** The depth frame closest in time, to tell what was in front of the surface then. */
  depth: Uint16Array
  confidence: Uint8Array
}

/** Which keyframe each triangle shows (−1: none), and each corner's image coordinates in it. */
export interface KeyframeAssignment {
  layer: Int16Array
  uv: Float32Array
}

/**
 * Picks, for every triangle, the keyframe that sees it best: facing it most directly, from
 * closest, inside the image, and not blocked by anything (the depth measured with that
 * keyframe must land on the triangle, so a person standing in front never gets painted on
 * the wall). Image coordinates are 0–1, rows from the top, as the keyframes are stored.
 */
export function assignKeyframes(mesh: Mesh, keys: KeyView[], o: { videoW: number; videoH: number; depthW: number; depthH: number }): KeyframeAssignment {
  const { positions: P, indices: I } = mesh
  const tris = I.length / 3
  const layer = new Int16Array(tris).fill(-1)
  const uv = new Float32Array(tris * 6)
  // World-to-camera for each keyframe (the inverse of a rigid T).
  const inv = keys.map(({ T }) => {
    const r = [T[0], T[1], T[2], T[4], T[5], T[6], T[8], T[9], T[10]]
    const t = [T[12], T[13], T[14]]
    return { r, t }
  })
  const toCam = (j: number, x: number, y: number, z: number) => {
    const { r, t } = inv[j]
    const dx = x - t[0]
    const dy = y - t[1]
    const dz = z - t[2]
    // Rows of Rᵀ are T's columns.
    return [r[0] * dx + r[1] * dy + r[2] * dz, r[3] * dx + r[4] * dy + r[5] * dz, r[6] * dx + r[7] * dy + r[8] * dz]
  }
  const sx = o.depthW / o.videoW
  const sy = o.depthH / o.videoH
  // Every keyframe's score for every triangle (0: can't be used).
  const nk = keys.length
  const score = new Float32Array(tris * nk)
  for (let f = 0; f < tris; f++) {
    const a = I[f * 3] * 3
    const b = I[f * 3 + 1] * 3
    const c = I[f * 3 + 2] * 3
    const mx = (P[a] + P[b] + P[c]) / 3
    const my = (P[a + 1] + P[b + 1] + P[c + 1]) / 3
    const mz = (P[a + 2] + P[b + 2] + P[c + 2]) / 3
    const ux = P[b] - P[a]
    const uy = P[b + 1] - P[a + 1]
    const uz = P[b + 2] - P[a + 2]
    const vx = P[c] - P[a]
    const vy = P[c + 1] - P[a + 1]
    const vz = P[c + 2] - P[a + 2]
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx
    const nl = Math.hypot(nx, ny, nz) || 1
    nx /= nl
    ny /= nl
    nz /= nl
    for (let j = 0; j < nk; j++) {
      const [cx3, cy3, cz3] = toCam(j, mx, my, mz)
      const d = -cz3
      if (d < 0.2 || d > 4.5) continue
      const K = keys[j].K
      const px = K[2] + (K[0] * cx3) / d
      const py = K[3] - (K[1] * cy3) / d
      // Stay off the image border, where a corner could fall outside.
      if (px < o.videoW * 0.02 || py < o.videoH * 0.02 || px > o.videoW * 0.98 || py > o.videoH * 0.98) continue
      // Facing: the triangle's normal against the direction to the camera (either side).
      const T = keys[j].T
      const tx = T[12] - mx
      const ty = T[13] - my
      const tz = T[14] - mz
      const facing = Math.abs(nx * tx + ny * ty + nz * tz) / (Math.hypot(tx, ty, tz) || 1)
      if (facing < 0.25) continue
      // Not blocked: the depth measured at that pixel lands on the triangle.
      const du = Math.min(o.depthW - 1, Math.floor(px * sx))
      const dv = Math.min(o.depthH - 1, Math.floor(py * sy))
      const k = dv * o.depthW + du
      if (keys[j].confidence[k] < 1) continue
      const measured = keys[j].depth[k] / 1000
      if (Math.abs(measured - d) > 0.03 + 0.02 * d) continue
      score[f * nk + j] = facing / Math.max(d, 0.5)
    }
    let best = -1
    for (let j = 0; j < nk; j++) if (score[f * nk + j] > 0 && (best < 0 || score[f * nk + j] > score[f * nk + best])) best = j
    layer[f] = best
  }

  // Neighbors agree: where a keyframe nearly as good as the best is the one most triangles
  // around use, take it. Fewer, larger patches from one keyframe each mean fewer seams where
  // two keyframes' slightly different views of the same spot meet.
  const around: number[][] = Array.from({ length: P.length / 3 }, () => [])
  for (let f = 0; f < tris; f++) for (let corner = 0; corner < 3; corner++) around[I[f * 3 + corner]].push(f)
  const votes = new Float32Array(nk)
  for (let round = 0; round < 4; round++) {
    const next = layer.slice()
    for (let f = 0; f < tris; f++) {
      if (layer[f] < 0) continue
      votes.fill(0)
      for (let corner = 0; corner < 3; corner++) for (const g of around[I[f * 3 + corner]]) if (g !== f && layer[g] >= 0) votes[layer[g]]++
      const top = score[f * nk + layer[f]]
      let pick = layer[f]
      for (let j = 0; j < nk; j++) {
        if (score[f * nk + j] < top * 0.6) continue
        if (votes[j] > votes[pick] || (votes[j] === votes[pick] && score[f * nk + j] > score[f * nk + pick])) pick = j
      }
      next[f] = pick
    }
    layer.set(next)
  }

  for (let f = 0; f < tris; f++) {
    const best = layer[f]
    if (best < 0) continue
    const K = keys[best].K
    for (let corner = 0; corner < 3; corner++) {
      const q = I[f * 3 + corner] * 3
      const [x3, y3, z3] = toCam(best, P[q], P[q + 1], P[q + 2])
      const d = -z3
      uv[f * 6 + corner * 2] = (K[2] + (K[0] * x3) / d) / o.videoW
      uv[f * 6 + corner * 2 + 1] = (K[3] - (K[1] * y3) / d) / o.videoH
    }
  }
  return { layer, uv }
}

/**
 * The room surface ready to draw: one vertex per triangle corner (a triangle's texture
 * coordinates belong to its own keyframe), with the keyframe layer (−1: vertex color only).
 */
export interface RoomMesh {
  positions: Float32Array
  normals: Float32Array
  colors: Uint8Array
  uvs: Float32Array
  layers: Float32Array
}

/**
 * Keeps the triangles that have a measured color: a keyframe that sees them, or scan points
 * near all three corners. Then drops connected pieces smaller than `minArea` square meters
 * (specks floating on their own).
 */
export function finishSurface(mesh: ColoredMesh, colored: Uint8Array, keys: KeyframeAssignment, minArea: number): RoomMesh {
  const { positions: P, indices: I } = mesh
  const tris: number[] = []
  for (let f = 0; f < I.length / 3; f++) {
    if (keys.layer[f] >= 0 || (colored[I[f * 3]] && colored[I[f * 3 + 1]] && colored[I[f * 3 + 2]])) tris.push(f)
  }

  // Connected pieces over shared vertices (union-find).
  const parent = new Int32Array(P.length / 3).map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]]
    return i
  }
  for (const f of tris) {
    const a = find(I[f * 3])
    parent[find(I[f * 3 + 1])] = a
    parent[find(I[f * 3 + 2])] = a
  }
  const area = new Map<number, number>()
  for (const f of tris) {
    const root = find(I[f * 3])
    area.set(root, (area.get(root) ?? 0) + triangleArea(P, I[f * 3], I[f * 3 + 1], I[f * 3 + 2]))
  }
  const kept = tris.filter((f) => (area.get(find(I[f * 3])) ?? 0) >= minArea)

  const n = kept.length * 3
  const out: RoomMesh = {
    positions: new Float32Array(n * 3),
    normals: new Float32Array(n * 3),
    colors: new Uint8Array(n * 3),
    uvs: new Float32Array(n * 2),
    layers: new Float32Array(n),
  }
  kept.forEach((f, t) => {
    for (let corner = 0; corner < 3; corner++) {
      const v = I[f * 3 + corner]
      const o = t * 3 + corner
      out.positions.set(P.subarray(v * 3, v * 3 + 3), o * 3)
      out.normals.set(mesh.normals.subarray(v * 3, v * 3 + 3), o * 3)
      out.colors.set(mesh.colors.subarray(v * 3, v * 3 + 3), o * 3)
      out.uvs[o * 2] = keys.uv[f * 6 + corner * 2]
      out.uvs[o * 2 + 1] = keys.uv[f * 6 + corner * 2 + 1]
      out.layers[o] = keys.layer[f]
    }
  })
  return out
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
 * The room's surface, with the same settings for every capture: 2 cm voxels, high-confidence
 * depth only, at least three views agreeing.
 *
 * The room scan comes first. The visit's depth frames then add what the scan missed, but only
 * where the scan didn't see empty space: space the scan saw empty is where people and things
 * brought in appear later, and those must stay out of the room (the replay shows them). What
 * the visit adds is textured from its keyframes, as is everything they see well; the rest keeps
 * the scan points' colors. Triangles with neither are left out, as are specks.
 */
export function buildRoomSurface(
  scan: DepthView[],
  visit: DepthView[],
  keys: KeyView[],
  o: RoomSurfaceInput,
): { mesh: RoomMesh; grid: Grid; empty: Uint8Array } {
  const voxel = 0.02
  const fu = createFusion(roomExtent(o.points).min, roomExtent(o.points).max, voxel)
  const read = { depthW: o.depthW, depthH: o.depthH, videoW: o.videoW, videoH: o.videoH, minConfidence: 2 }
  fuseViews(fu, scan, read)
  const empty = knownEmpty(fu)
  if (visit.length > 0) fuseViews(fu, visit, { ...read, blocked: empty })
  const volume = finishVolume(fu)
  const mesh = marchingCubes(volume, 3)
  // 1 cm cells (the phone's point spacing): colors average over ~3 cm, not 6, so they stay crisper.
  const { colors, colored } = colorFromPoints(mesh.positions, o.points, o.colors, 0.01)
  const assignment = assignKeyframes(mesh, keys, o)
  const { nx, ny, nz, origin } = volume
  return { mesh: finishSurface({ ...mesh, colors }, colored, assignment, MIN_PIECE_AREA), grid: { nx, ny, nz, origin, voxel }, empty }
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
