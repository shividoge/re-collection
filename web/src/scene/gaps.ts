// Closing sampling gaps without inventing surfaces.
//
// A scanned surface is a set of measured points with small gaps between them. These helpers
// join neighbors that belong together: room points grow just enough to overlap their
// neighbors, and the people replay connects neighboring depth pixels into triangles. Gaps
// bigger than that (places the phone never saw, or the jump from a person to the wall
// behind) stay open, as the plan requires: areas without data stay empty.

/** Splat diameter limits in meters. The upper limit is the largest gap we'll ever bridge. */
export const SPLAT_MIN = 0.008
export const SPLAT_MAX = 0.035
/** Disk diameter relative to point spacing; above √2 so a square grid of disks has no holes. */
const OVERLAP = 1.5
/** Spacing is the distance to this many-th nearest neighbor (robust to noisy, thick walls). */
const K = 4
/** Points sampled per cell to estimate its spacing. */
const SAMPLES = 2

/**
 * Per-point splat diameter (meters) from how far apart its neighbors actually are. Points are
 * binned in `cell`-sized cubes; in each cube a couple of sample points measure the distance to
 * their K-th nearest neighbor (searching the 3×3×3 cubes around), and every point in the cube
 * gets OVERLAP × that, within [SPLAT_MIN, SPLAT_MAX]. Points with fewer than K neighbors nearby
 * are noise or edges and stay small.
 */
export function splatSizes(positions: Float32Array, cell = 0.03): Float32Array {
  const n = positions.length / 3
  const out = new Float32Array(n)
  if (n === 0) return out
  // Integer cell coordinates, offset to stay positive, packed into one exact double key.
  const AXIS = 1 << 16
  const OFF = AXIS / 2
  const keyOf = (x: number, y: number, z: number) => ((x + OFF) * AXIS + (y + OFF)) * AXIS + (z + OFF)
  const cellOfPoint = new Uint32Array(n)
  const ids = new Map<number, number>()
  const coords: number[] = []
  for (let i = 0; i < n; i++) {
    const x = Math.floor(positions[i * 3] / cell)
    const y = Math.floor(positions[i * 3 + 1] / cell)
    const z = Math.floor(positions[i * 3 + 2] / cell)
    const k = keyOf(x, y, z)
    let id = ids.get(k)
    if (id === undefined) {
      id = ids.size
      ids.set(k, id)
      coords.push(x, y, z)
    }
    cellOfPoint[i] = id
  }
  // Points grouped by cell (counting sort).
  const cells = ids.size
  const start = new Uint32Array(cells + 1)
  for (let i = 0; i < n; i++) start[cellOfPoint[i] + 1]++
  for (let c = 0; c < cells; c++) start[c + 1] += start[c]
  const fill = start.slice(0, cells)
  const members = new Uint32Array(n)
  for (let i = 0; i < n; i++) members[fill[cellOfPoint[i]]++] = i

  const best = new Float64Array(K)
  const kthNearest = (i: number, cx: number, cy: number, cz: number): number => {
    best.fill(Infinity)
    const px = positions[i * 3]
    const py = positions[i * 3 + 1]
    const pz = positions[i * 3 + 2]
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const c = ids.get(keyOf(cx + dx, cy + dy, cz + dz))
          if (c === undefined) continue
          for (let m = start[c]; m < start[c + 1]; m++) {
            const j = members[m]
            if (j === i) continue
            const ex = positions[j * 3] - px
            const ey = positions[j * 3 + 1] - py
            const ez = positions[j * 3 + 2] - pz
            const d2 = ex * ex + ey * ey + ez * ez
            if (d2 >= best[K - 1]) continue
            // Insert into the sorted list of the K smallest.
            let at = K - 1
            while (at > 0 && best[at - 1] > d2) {
              best[at] = best[at - 1]
              at--
            }
            best[at] = d2
          }
        }
    return Math.sqrt(best[K - 1])
  }

  for (let c = 0; c < cells; c++) {
    const count = start[c + 1] - start[c]
    let sum = 0
    let used = 0
    for (let s = 0; s < Math.min(SAMPLES, count); s++) {
      const i = members[start[c] + Math.floor((s * count) / SAMPLES)]
      const d = kthNearest(i, coords[c * 3], coords[c * 3 + 1], coords[c * 3 + 2])
      if (Number.isFinite(d)) {
        sum += d
        used++
      }
    }
    const size = used ? Math.min(SPLAT_MAX, Math.max(SPLAT_MIN, (OVERLAP * sum) / used)) : SPLAT_MIN
    for (let m = start[c]; m < start[c + 1]; m++) out[members[m]] = size
  }
  return out
}

/** Fewest depth pixels a moving thing must cover to be replayed (about 0.6% of the frame). */
export const MIN_BLOB_PIXELS = 300

/**
 * The depth pixels that show something the room doesn't explain, kept only as solid blobs: a
 * connected region (neighbors at nearly the same depth) of at least `minPixels`. People and
 * things brought in are blobs; depth noise around the room is scattered specks and is dropped.
 * `depth` holds (meters, confidence) pairs; `K` is on the depth grid; `isRoom` says whether a
 * world point is already part of the room.
 */
export function movingPixels(
  depth: Float32Array,
  width: number,
  height: number,
  K: ArrayLike<number>,
  T: ArrayLike<number>,
  minConfidence: number,
  isRoom: (x: number, y: number, z: number) => boolean,
  minPixels = MIN_BLOB_PIXELS,
): Uint8Array {
  const n = width * height
  const moving = new Uint8Array(n)
  for (let v = 0; v < height; v++)
    for (let u = 0; u < width; u++) {
      const k = v * width + u
      const d = depth[k * 2]
      if (!(d > 0) || depth[k * 2 + 1] < minConfidence) continue
      const x = ((u - K[2]) * d) / K[0]
      const y = -((v - K[3]) * d) / K[1]
      const z = -d
      const wx = T[0] * x + T[4] * y + T[8] * z + T[12]
      const wy = T[1] * x + T[5] * y + T[9] * z + T[13]
      const wz = T[2] * x + T[6] * y + T[10] * z + T[14]
      if (!isRoom(wx, wy, wz)) moving[k] = 1
    }
  // Connected regions over 4-neighbors on one surface; small ones are dropped.
  const keep = new Uint8Array(n)
  const label = new Int32Array(n).fill(-1)
  const stack: number[] = []
  const region: number[] = []
  for (let start = 0; start < n; start++) {
    if (!moving[start] || label[start] >= 0) continue
    region.length = 0
    stack.push(start)
    label[start] = start
    while (stack.length) {
      const k = stack.pop()!
      region.push(k)
      const u = k % width
      const dk = depth[k * 2]
      for (const j of [u > 0 ? k - 1 : -1, u < width - 1 ? k + 1 : -1, k - width, k + width]) {
        if (j < 0 || j >= n || !moving[j] || label[j] >= 0) continue
        if (Math.abs(depth[j * 2] - dk) > 0.02 + 0.03 * dk) continue
        label[j] = start
        stack.push(j)
      }
    }
    if (region.length >= minPixels) for (const k of region) keep[k] = 1
  }
  return keep
}

/**
 * Triangles joining neighboring depth pixels into a surface. `depth` holds (meters, confidence)
 * pairs, row-major, `width`×`height`. A triangle is kept only when all three pixels are measured
 * with enough confidence and lie at nearly the same depth, so a person's outline is never
 * stretched into a sheet reaching back to the wall. Writes vertex indices into `out` (room for
 * (w−1)·(h−1)·6) and returns how many it wrote.
 */
export function depthMeshIndices(depth: Float32Array, width: number, height: number, minConfidence: number, out: Uint32Array, keep: Uint8Array | null = null): number {
  const ok = (k: number) => depth[k * 2] > 0 && depth[k * 2 + 1] >= minConfidence && (!keep || keep[k] === 1)
  const d = (k: number) => depth[k * 2]
  // Neighbors on one surface differ by a little, more when seen at a slant or far away.
  const joined = (a: number, b: number, c: number) => {
    const lo = Math.min(d(a), d(b), d(c))
    const hi = Math.max(d(a), d(b), d(c))
    return hi - lo <= 0.02 + 0.03 * lo
  }
  let n = 0
  for (let v = 0; v < height - 1; v++) {
    for (let u = 0; u < width - 1; u++) {
      const a = v * width + u
      const b = a + 1
      const c = a + width
      const e = c + 1
      const okA = ok(a)
      const okB = ok(b)
      const okC = ok(c)
      const okE = ok(e)
      if (okA && okB && okC && joined(a, b, c)) {
        out[n++] = a
        out[n++] = c
        out[n++] = b
      }
      if (okB && okC && okE && joined(b, c, e)) {
        out[n++] = b
        out[n++] = c
        out[n++] = e
      }
    }
  }
  return n
}
