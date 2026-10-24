// Spatial queries over the room cloud: a voxel index, ray picking, floor/wall/ceiling
// detection, "object" selection by region growing, and when the camera saw an object.
// All of it works on measured points only; nothing is inferred where the scan has no data.

export type Vec3 = [number, number, number]

/** One recorded camera frame: moment seconds, camera-to-world (column-major), and fx, fy, cx, cy. */
export interface PoseFrame {
  t: number
  T: ArrayLike<number>
  K: ArrayLike<number>
}

/** 2^17 voxels per axis; three axes pack into 51 bits, which a double holds exactly. */
const AXIS = 131072

export interface VoxelIndex {
  size: number
  /** World position of voxel (0, 0, 0)'s min corner. */
  origin: Vec3
  dims: [number, number, number]
  map: Map<number, number>
  /** ix, iy, iz per voxel id. */
  coords: Int32Array
  /** Voxel id → first slot in `points`; length is voxelCount + 1. */
  start: Uint32Array
  /** Point indices grouped by voxel. */
  points: Uint32Array
  voxelCount: number
}

const packKey = (ix: number, iy: number, iz: number) => (ix * AXIS + iy) * AXIS + iz

export function buildVoxelIndex(positions: Float32Array, size = 0.03): VoxelIndex {
  const n = positions.length / 3
  if (n === 0) throw new Error('cannot index an empty cloud')
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < n; i++)
    for (let a = 0; a < 3; a++) {
      const v = positions[i * 3 + a]
      if (v < min[a]) min[a] = v
      if (v > max[a]) max[a] = v
    }
  // One empty voxel of margin on every side keeps neighbor lookups in range.
  const origin: Vec3 = [min[0] - size, min[1] - size, min[2] - size]
  const dims = [0, 1, 2].map((a) => Math.floor((max[a] - origin[a]) / size) + 2) as [number, number, number]
  if (dims.some((d) => d >= AXIS)) throw new Error(`cloud too large to index at ${size} m voxels`)

  const map = new Map<number, number>()
  const voxOf = new Uint32Array(n)
  const coordList: number[] = []
  for (let i = 0; i < n; i++) {
    const ix = Math.floor((positions[i * 3] - origin[0]) / size)
    const iy = Math.floor((positions[i * 3 + 1] - origin[1]) / size)
    const iz = Math.floor((positions[i * 3 + 2] - origin[2]) / size)
    const key = packKey(ix, iy, iz)
    let id = map.get(key)
    if (id === undefined) {
      id = map.size
      map.set(key, id)
      coordList.push(ix, iy, iz)
    }
    voxOf[i] = id
  }
  const voxelCount = map.size
  const start = new Uint32Array(voxelCount + 1)
  for (let i = 0; i < n; i++) start[voxOf[i] + 1]++
  for (let v = 0; v < voxelCount; v++) start[v + 1] += start[v]
  const fill = start.slice(0, voxelCount)
  const points = new Uint32Array(n)
  for (let i = 0; i < n; i++) points[fill[voxOf[i]]++] = i
  return { size, origin, dims, map, coords: Int32Array.from(coordList), start, points, voxelCount }
}

export function voxelId(idx: VoxelIndex, ix: number, iy: number, iz: number): number {
  if (ix < 0 || iy < 0 || iz < 0 || ix >= idx.dims[0] || iy >= idx.dims[1] || iz >= idx.dims[2]) return -1
  return idx.map.get(packKey(ix, iy, iz)) ?? -1
}

export function voxelCenter(idx: VoxelIndex, id: number): Vec3 {
  const s = idx.size
  return [
    idx.origin[0] + (idx.coords[id * 3] + 0.5) * s,
    idx.origin[1] + (idx.coords[id * 3 + 1] + 0.5) * s,
    idx.origin[2] + (idx.coords[id * 3 + 2] + 0.5) * s,
  ]
}

export interface RayHit {
  id: number
  distance: number
  point: Vec3
}

/** First occupied voxel along a ray (Amanatides–Woo grid traversal). */
export function raycastVoxels(idx: VoxelIndex, origin: Vec3, direction: Vec3, maxDist = 50, skip?: (id: number) => boolean): RayHit | null {
  const len = Math.hypot(direction[0], direction[1], direction[2])
  const d: Vec3 = [direction[0] / len, direction[1] / len, direction[2] / len]
  const s = idx.size
  // Clip the ray to the grid's box.
  let tEnter = 0
  let tExit = maxDist
  for (let a = 0; a < 3; a++) {
    const lo = idx.origin[a]
    const hi = idx.origin[a] + idx.dims[a] * s
    if (Math.abs(d[a]) < 1e-12) {
      if (origin[a] < lo || origin[a] > hi) return null
      continue
    }
    let t0 = (lo - origin[a]) / d[a]
    let t1 = (hi - origin[a]) / d[a]
    if (t0 > t1) [t0, t1] = [t1, t0]
    tEnter = Math.max(tEnter, t0)
    tExit = Math.min(tExit, t1)
  }
  if (tEnter > tExit) return null

  const g = [0, 1, 2].map((a) => (origin[a] + d[a] * (tEnter + 1e-7) - idx.origin[a]) / s)
  const cell = g.map((v, a) => Math.min(idx.dims[a] - 1, Math.max(0, Math.floor(v))))
  const step = d.map((v) => (v > 0 ? 1 : -1))
  const tMax = [0, 1, 2].map((a) => (Math.abs(d[a]) < 1e-12 ? Infinity : tEnter + ((cell[a] + (step[a] > 0 ? 1 : 0) - g[a]) * s) / d[a]))
  const tDelta = d.map((v) => (Math.abs(v) < 1e-12 ? Infinity : s / Math.abs(v)))
  let t = tEnter
  while (t <= tExit) {
    const id = voxelId(idx, cell[0], cell[1], cell[2])
    if (id >= 0 && !(skip && skip(id))) {
      return { id, distance: t, point: [origin[0] + d[0] * t, origin[1] + d[1] * t, origin[2] + d[2] * t] }
    }
    const a = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : tMax[1] < tMax[2] ? 1 : 2
    t = tMax[a]
    cell[a] += step[a]
    if (cell[a] < 0 || cell[a] >= idx.dims[a]) break
    tMax[a] += tDelta[a]
  }
  return null
}

/** Heights of large horizontal surfaces, from a histogram of point heights. */
export function estimateLevels(positions: Float32Array, bin = 0.02): { floorY: number | null; ceilingY: number | null } {
  const n = positions.length / 3
  if (n === 0) return { floorY: null, ceilingY: null }
  const stride = Math.max(1, Math.floor(n / 500_000))
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < n; i += stride) {
    const y = positions[i * 3 + 1]
    if (y < lo) lo = y
    if (y > hi) hi = y
  }
  const bins = Math.max(1, Math.ceil((hi - lo) / bin) + 1)
  const count = new Float64Array(bins)
  const sum = new Float64Array(bins)
  for (let i = 0; i < n; i += stride) {
    const y = positions[i * 3 + 1]
    const b = Math.floor((y - lo) / bin)
    count[b]++
    sum[b] += y
  }
  let peak = 0
  for (let b = 0; b < bins; b++) peak = Math.max(peak, count[b])
  const dense = (b: number) => count[b] >= 0.3 * peak
  let floorBin = -1
  for (let b = 0; b < bins && floorBin < 0; b++) if (dense(b)) floorBin = b
  if (floorBin < 0) return { floorY: null, ceilingY: null }
  const floorY = sum[floorBin] / count[floorBin]
  let ceilingY: number | null = null
  for (let b = bins - 1; b > floorBin; b--) {
    if (lo + b * bin < floorY + 1.8) break
    if (dense(b)) {
      ceilingY = sum[b] / count[b]
      break
    }
  }
  return { floorY, ceilingY }
}

export const OBJECT = 0
export const FLOOR = 1
export const WALL = 2
export const CEILING = 3
export type SurfaceKind = 'object' | 'floor' | 'wall' | 'ceiling'
const KIND_NAMES: SurfaceKind[] = ['object', 'floor', 'wall', 'ceiling']

/**
 * Label each voxel as floor, ceiling, wall or other ("object"). Walls are columns of
 * voxels that are occupied over most of a person's height, or large vertical planes that
 * rise well above the floor (real scans leave gaps in walls); furniture rarely is either.
 */
export function classifyStructure(idx: VoxelIndex, floorY: number | null, ceilingY: number | null): Uint8Array {
  const out = new Uint8Array(idx.voxelCount)
  const s = idx.size
  const yOf = (iy: number) => idx.origin[1] + (iy + 0.5) * s
  // Real floors are noisy by a few centimeters; a thin band leaves a layer that joins everything.
  const band = 0.1
  const floor = floorY ?? -Infinity
  const columns = new Map<number, { count: number; top: number }>()
  for (let v = 0; v < idx.voxelCount; v++) {
    const y = yOf(idx.coords[v * 3 + 1])
    if (y <= floor + band) out[v] = FLOOR
    else if (ceilingY !== null && y >= ceilingY - band) out[v] = CEILING
    else {
      const key = idx.coords[v * 3] * AXIS + idx.coords[v * 3 + 2]
      const c = columns.get(key)
      if (c) {
        c.count++
        c.top = Math.max(c.top, y)
      } else columns.set(key, { count: 1, top: y })
    }
  }
  if (floorY === null) return out
  for (let v = 0; v < idx.voxelCount; v++) {
    if (out[v] !== OBJECT) continue
    const c = columns.get(idx.coords[v * 3] * AXIS + idx.coords[v * 3 + 2])!
    if (c.count * s >= 1.2 && c.top >= floorY + 1.8) out[v] = WALL
  }
  markWallPlanes(idx, out, floorY)
  return out
}

const WALL_FIT = {
  maxPlanes: 8,
  iterations: 400,
  /** Voxels scored per candidate plane; the full set is only checked for the winner. */
  sample: 6000,
  inlierDist: 0.045,
  minVoxels: 600,
  /** A wall piece must span at least this much height and reach this far above the floor. */
  minHeight: 1.2,
  minTop: 1.5,
}

/** Small deterministic PRNG (mulberry32), so the same scan always classifies the same way. */
function prng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Finds big vertical planes among the remaining "object" voxels (RANSAC) and marks the tall,
 * connected parts of each as wall. A table's front, a low cabinet or a person stays an object
 * because it doesn't reach WALL_FIT.minTop above the floor.
 */
function markWallPlanes(idx: VoxelIndex, out: Uint8Array, floorY: number) {
  const random = prng(1234)
  const n = idx.voxelCount
  const cx = new Float32Array(n)
  const cy = new Float32Array(n)
  const cz = new Float32Array(n)
  for (let v = 0; v < n; v++) [cx[v], cy[v], cz[v]] = voxelCenter(idx, v)
  const tried = new Uint8Array(n)

  for (let plane = 0; plane < WALL_FIT.maxPlanes; plane++) {
    const pool: number[] = []
    for (let v = 0; v < n; v++) if (out[v] === OBJECT && !tried[v]) pool.push(v)
    if (pool.length < WALL_FIT.minVoxels) return
    const pick = () => pool[Math.floor(random() * pool.length)]
    const sample = Array.from({ length: Math.min(WALL_FIT.sample, pool.length) }, pick)

    let best: { nx: number; nz: number; ny: number; d: number } | null = null
    let bestScore = 0
    for (let it = 0; it < WALL_FIT.iterations; it++) {
      const a = pick()
      const b = pick()
      const c = pick()
      const ux = cx[b] - cx[a],
        uy = cy[b] - cy[a],
        uz = cz[b] - cz[a]
      const wx = cx[c] - cx[a],
        wy = cy[c] - cy[a],
        wz = cz[c] - cz[a]
      let nx = uy * wz - uz * wy
      let ny = uz * wx - ux * wz
      let nz = ux * wy - uy * wx
      const len = Math.hypot(nx, ny, nz)
      if (len < 1e-6) continue
      nx /= len
      ny /= len
      nz /= len
      if (Math.abs(ny) > 0.2) continue // walls are vertical
      const d = -(nx * cx[a] + ny * cy[a] + nz * cz[a])
      let score = 0
      for (const v of sample) if (Math.abs(nx * cx[v] + ny * cy[v] + nz * cz[v] + d) < WALL_FIT.inlierDist) score++
      if (score > bestScore) {
        bestScore = score
        best = { nx, ny, nz, d }
      }
    }
    if (!best) return

    const inlier = new Uint8Array(n)
    let count = 0
    for (const v of pool) {
      if (Math.abs(best.nx * cx[v] + best.ny * cy[v] + best.nz * cz[v] + best.d) < WALL_FIT.inlierDist) {
        inlier[v] = 1
        tried[v] = 1
        count++
      }
    }
    if (count < WALL_FIT.minVoxels) return

    // Only the tall connected pieces of the plane are wall.
    const seen = new Uint8Array(n)
    for (const start of pool) {
      if (!inlier[start] || seen[start]) continue
      const comp = [start]
      seen[start] = 1
      let lo = cy[start]
      let hi = cy[start]
      for (let q = 0; q < comp.length; q++) {
        const v = comp[q]
        const x = idx.coords[v * 3]
        const y = idx.coords[v * 3 + 1]
        const z = idx.coords[v * 3 + 2]
        for (let dx = -1; dx <= 1; dx++)
          for (let dy = -1; dy <= 1; dy++)
            for (let dz = -1; dz <= 1; dz++) {
              const m = voxelId(idx, x + dx, y + dy, z + dz)
              if (m < 0 || !inlier[m] || seen[m]) continue
              seen[m] = 1
              comp.push(m)
              lo = Math.min(lo, cy[m])
              hi = Math.max(hi, cy[m])
            }
      }
      if (hi - lo >= WALL_FIT.minHeight && hi >= floorY + WALL_FIT.minTop) for (const v of comp) out[v] = WALL
    }
  }
}

export interface Segment {
  kind: SurfaceKind
  voxels: Uint32Array
  /** True when growth hit the size cap, so the selection may be part of something larger. */
  truncated: boolean
}

/**
 * Grow a selection from the seed voxel. Objects: every connected non-structural voxel
 * (26-neighborhood) within `maxRadius`. Floor, wall or ceiling: a patch of that surface.
 */
export function segmentAt(
  idx: VoxelIndex,
  structure: Uint8Array,
  seed: number,
  opts: { maxRadius?: number; maxVoxels?: number; patchRadius?: number } = {},
): Segment {
  const cls = structure[seed]
  const radius = cls === OBJECT ? (opts.maxRadius ?? 4) : (opts.patchRadius ?? 0.25)
  const maxVoxels = opts.maxVoxels ?? 250_000
  const r2 = (radius / idx.size) ** 2
  const [sx, sy, sz] = [idx.coords[seed * 3], idx.coords[seed * 3 + 1], idx.coords[seed * 3 + 2]]
  const seen = new Set<number>([seed])
  const queue = [seed]
  let truncated = false
  for (let qi = 0; qi < queue.length; qi++) {
    const v = queue[qi]
    const [x, y, z] = [idx.coords[v * 3], idx.coords[v * 3 + 1], idx.coords[v * 3 + 2]]
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const nx = x + dx
          const ny = y + dy
          const nz = z + dz
          const n = voxelId(idx, nx, ny, nz)
          if (n < 0 || seen.has(n) || structure[n] !== cls) continue
          if ((nx - sx) ** 2 + (ny - sy) ** 2 + (nz - sz) ** 2 > r2) {
            if (cls === OBJECT) truncated = true
            continue
          }
          if (queue.length >= maxVoxels) {
            truncated = true
            continue
          }
          seen.add(n)
          queue.push(n)
        }
  }
  return { kind: KIND_NAMES[cls], voxels: Uint32Array.from(queue), truncated }
}

export function pointsOfVoxels(idx: VoxelIndex, voxels: Uint32Array): Uint32Array {
  let total = 0
  for (const v of voxels) total += idx.start[v + 1] - idx.start[v]
  const out = new Uint32Array(total)
  let o = 0
  for (const v of voxels) {
    out.set(idx.points.subarray(idx.start[v], idx.start[v + 1]), o)
    o += idx.start[v + 1] - idx.start[v]
  }
  return out
}

export interface Bounds {
  min: Vec3
  max: Vec3
  center: Vec3
  size: Vec3
}

/**
 * A selection as a dense voxel grid (x fastest, then y, then z, over `idx.dims`): 1 in its voxels
 * and their face neighbors, since a fused surface or a replayed depth pixel sits within a voxel of
 * the points it matches. Uploaded as a 3D texture so shaders can tint the selected object.
 */
export function selectionMask(idx: VoxelIndex, voxels: Uint32Array): Uint8Array {
  const [dx, dy, dz] = idx.dims
  const mask = new Uint8Array(dx * dy * dz)
  const set = (x: number, y: number, z: number) => {
    if (x >= 0 && y >= 0 && z >= 0 && x < dx && y < dy && z < dz) mask[(z * dy + y) * dx + x] = 1
  }
  for (const v of voxels) {
    const x = idx.coords[v * 3]
    const y = idx.coords[v * 3 + 1]
    const z = idx.coords[v * 3 + 2]
    set(x, y, z)
    set(x + 1, y, z)
    set(x - 1, y, z)
    set(x, y + 1, z)
    set(x, y - 1, z)
    set(x, y, z + 1)
    set(x, y, z - 1)
  }
  return mask
}

export function boundsOfPoints(positions: Float32Array, points: Uint32Array): Bounds {
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const i of points)
    for (let a = 0; a < 3; a++) {
      const v = positions[i * 3 + a]
      if (v < min[a]) min[a] = v
      if (v > max[a]) max[a] = v
    }
  return {
    min,
    max,
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
  }
}

export interface Interval {
  tStart: number
  tEnd: number
}

/**
 * When the recording camera had the object in view: inside the image, in front of the
 * camera, and with no other scanned surface in between. People are not in the room
 * cloud, so they never count as blocking the view.
 */
export function visibleIntervals(
  idx: VoxelIndex,
  voxels: Uint32Array,
  frames: PoseFrame[],
  videoW: number,
  videoH: number,
  opts: { sampleHz?: number; maxGap?: number; maxSamples?: number } = {},
): Interval[] {
  if (frames.length === 0 || voxels.length === 0) return []
  const sampleHz = opts.sampleHz ?? 10
  const maxGap = opts.maxGap ?? 0.3
  const mask = new Uint8Array(idx.voxelCount)
  for (const v of voxels) mask[v] = 1
  const nSamples = Math.min(opts.maxSamples ?? 12, voxels.length)
  const samples: Vec3[] = []
  for (let k = 0; k < nSamples; k++) samples.push(voxelCenter(idx, voxels[Math.floor((k * voxels.length) / nSamples)]))
  const skip = (id: number) => mask[id] === 1

  const intervals: Interval[] = []
  let lastT = -Infinity
  for (const f of frames) {
    if (f.t - lastT < 1 / sampleHz - 1e-6) continue
    lastT = f.t
    const T = f.T
    const cam: Vec3 = [T[12], T[13], T[14]]
    const seen = samples.some((p) => {
      const dx = p[0] - cam[0]
      const dy = p[1] - cam[1]
      const dz = p[2] - cam[2]
      // Camera looks down −z (column 2), so depth is −(column 2 · offset).
      const depth = -(T[8] * dx + T[9] * dy + T[10] * dz)
      if (depth < 0.1) return false
      const xc = T[0] * dx + T[1] * dy + T[2] * dz
      const yc = T[4] * dx + T[5] * dy + T[6] * dz
      const u = f.K[0] * (xc / depth) + f.K[2]
      const v = f.K[1] * (-yc / depth) + f.K[3]
      if (u < 0 || v < 0 || u > videoW || v > videoH) return false
      const dist = Math.hypot(dx, dy, dz)
      return raycastVoxels(idx, cam, [dx, dy, dz], dist - idx.size * 1.5, skip) === null
    })
    if (!seen) continue
    const last = intervals[intervals.length - 1]
    if (last && f.t - last.tEnd <= maxGap) last.tEnd = f.t
    else intervals.push({ tStart: f.t, tEnd: f.t })
  }
  return intervals
}
