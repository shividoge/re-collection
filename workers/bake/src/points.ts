// points.pack (docs/architecture-v3.md §4.2): the room cloud reordered so every prefix is an
// even sample of the room, quantized, with splat sizes computed once on the full cloud.
import { encodePack, type PointsMeta, type Vec3 } from '../../../shared/pack'
import { SPLAT_MAX, SPLAT_MIN, splatSizes } from '../../../web/src/scene/gaps'

/** Prefix sizes drawn as coarser levels; the full cloud is always the last level. */
export const LEVEL_COUNTS = [65_536, 262_144]

/** mulberry32: a small, fast, deterministic PRNG. */
function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A deterministic shuffle of 0..n−1 (Fisher–Yates). */
export function permutation(n: number, seed: number): Uint32Array {
  const p = new Uint32Array(n)
  for (let i = 0; i < n; i++) p[i] = i
  const rnd = random(seed)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    const t = p[i]
    p[i] = p[j]
    p[j] = t
  }
  return p
}

const AXIS = 1 << 17
const OFF = AXIS / 2
const cellKey = (P: Float32Array, i: number, cell: number) =>
  ((Math.floor(P[i * 3] / cell) + OFF) * AXIS + (Math.floor(P[i * 3 + 1] / cell) + OFF)) * AXIS + (Math.floor(P[i * 3 + 2] / cell) + OFF)

/**
 * Point order for level of detail. Cells halve in size from `coarsest` to `finest`; at each
 * size, every cell that holds no point chosen so far gets one (the first in a seeded shuffle).
 * So the points chosen through any cell size are one per occupied cell of that size (an even
 * sample of the whole room), and within a size the shuffle spreads a partial prefix evenly too.
 */
export function lodOrder(positions: Float32Array, o: { coarsest?: number; finest?: number; seed?: number } = {}): Uint32Array {
  const n = positions.length / 3
  const perm = permutation(n, o.seed ?? 0x9e3779b9)
  const order = new Uint32Array(n)
  const taken = new Uint8Array(n)
  let filled = 0
  for (let cell = o.coarsest ?? 0.64; cell >= (o.finest ?? 0.005) && filled < n; cell /= 2) {
    const occupied = new Set<number>()
    for (let j = 0; j < filled; j++) occupied.add(cellKey(positions, order[j], cell))
    for (let j = 0; j < n; j++) {
      const i = perm[j]
      if (taken[i]) continue
      const k = cellKey(positions, i, cell)
      if (occupied.has(k)) continue
      occupied.add(k)
      taken[i] = 1
      order[filled++] = i
    }
  }
  for (let j = 0; j < n && filled < n; j++) if (!taken[perm[j]]) order[filled++] = perm[j]
  return order
}

/**
 * Distance from each of `samples` to its K-th nearest neighbor among the first `m` points of
 * `positions` (exact: the grid search widens ring by ring until nothing closer can exist).
 * Samples with fewer than K neighbors within `maxRings` cells are NaN.
 */
export function kthNeighbor(positions: Float32Array, m: number, samples: ArrayLike<number>, K: number, cell: number, maxRings = 6): Float64Array {
  const cells = new Map<number, number[]>()
  for (let i = 0; i < m; i++) {
    const k = cellKey(positions, i, cell)
    let list = cells.get(k)
    if (!list) cells.set(k, (list = []))
    list.push(i)
  }
  const out = new Float64Array(samples.length)
  const best = new Float64Array(K)
  for (let s = 0; s < samples.length; s++) {
    const i = samples[s]
    const px = positions[i * 3]
    const py = positions[i * 3 + 1]
    const pz = positions[i * 3 + 2]
    const cx = Math.floor(px / cell)
    const cy = Math.floor(py / cell)
    const cz = Math.floor(pz / cell)
    best.fill(Infinity)
    out[s] = NaN
    for (let r = 0; r <= maxRings; r++) {
      for (let dx = -r; dx <= r; dx++)
        for (let dy = -r; dy <= r; dy++)
          for (let dz = -r; dz <= r; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue
            const list = cells.get(((cx + dx + OFF) * AXIS + (cy + dy + OFF)) * AXIS + (cz + dz + OFF))
            if (!list) continue
            for (const j of list) {
              if (j === i) continue
              const d2 = (positions[j * 3] - px) ** 2 + (positions[j * 3 + 1] - py) ** 2 + (positions[j * 3 + 2] - pz) ** 2
              if (d2 >= best[K - 1]) continue
              let at = K - 1
              while (at > 0 && best[at - 1] > d2) {
                best[at] = best[at - 1]
                at--
              }
              best[at] = d2
            }
          }
      // Every point within r·cell of the sample has been seen.
      if (Math.sqrt(best[K - 1]) <= r * cell) {
        out[s] = Math.sqrt(best[K - 1])
        break
      }
    }
  }
  return out
}

const mean = (a: Float64Array) => {
  let s = 0
  let n = 0
  for (const x of a)
    if (Number.isFinite(x)) {
      s += x
      n++
    }
  return n ? s / n : NaN
}

/**
 * How much bigger splats must be when only the first `m` points (of a LOD-ordered cloud) are
 * drawn: the mean distance to the 4th nearest neighbor among those `m`, over the same distance
 * in the full cloud, measured at the same sample points. The full cloud's sizes already close
 * gaps at its spacing (gaps.ts), so scaling them by the spacing ratio closes them at the prefix's.
 */
export function sizeScaleFor(ordered: Float32Array, m: number, sampleCount = 4000): number {
  const n = ordered.length / 3
  if (m >= n) return 1
  const step = Math.max(1, Math.floor(m / sampleCount))
  const samples: number[] = []
  for (let i = 0; i < m; i += step) samples.push(i)
  const full = mean(kthNeighbor(ordered, n, samples, 4, 0.03))
  const guess = Math.min(0.5, Math.max(0.01, (Number.isFinite(full) ? full : 0.01) * Math.sqrt(n / m)))
  const prefix = mean(kthNeighbor(ordered, m, samples, 4, guess))
  if (!Number.isFinite(full) || !Number.isFinite(prefix) || full <= 0) return 1
  return Math.max(1, Math.round((prefix / full) * 100) / 100)
}

export function quantizeUnorm16(values: Float32Array, min: Vec3, max: Vec3): Uint16Array {
  const out = new Uint16Array(values.length)
  for (let i = 0; i < values.length; i++) {
    const a = i % 3
    const span = max[a] - min[a]
    out[i] = span > 0 ? Math.round(((values[i] - min[a]) / span) * 65535) : 0
  }
  return out
}

export function bounds(positions: Float32Array): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i++) {
    const a = i % 3
    if (positions[i] < min[a]) min[a] = positions[i]
    if (positions[i] > max[a]) max[a] = positions[i]
  }
  if (positions.length === 0) return { min: [0, 0, 0], max: [0, 0, 0] }
  return { min, max }
}

export interface PointsBake {
  bytes: Uint8Array
  meta: PointsMeta
}

/** room.bin's points and colors → points.pack. */
export function bakePoints(positions: Float32Array, colors: Uint8Array): PointsBake {
  const n = positions.length / 3
  const sizes = splatSizes(positions)
  const order = lodOrder(positions)
  const P = new Float32Array(n * 3)
  const C = new Uint8Array(n * 3)
  const S = new Uint8Array(n)
  for (let j = 0; j < n; j++) {
    const i = order[j]
    P[j * 3] = positions[i * 3]
    P[j * 3 + 1] = positions[i * 3 + 1]
    P[j * 3 + 2] = positions[i * 3 + 2]
    C[j * 3] = colors[i * 3]
    C[j * 3 + 1] = colors[i * 3 + 1]
    C[j * 3 + 2] = colors[i * 3 + 2]
    S[j] = Math.round(((sizes[i] - SPLAT_MIN) / (SPLAT_MAX - SPLAT_MIN)) * 255)
  }
  const { min, max } = bounds(P)
  const levels = [...LEVEL_COUNTS.filter((c) => c < n).map((count) => ({ count, sizeScale: sizeScaleFor(P, count) })), { count: n, sizeScale: 1 }]
  const meta: PointsMeta = { count: n, min, max, sizeMin: SPLAT_MIN, sizeMax: SPLAT_MAX, levels }
  const bytes = encodePack({
    kind: 'points',
    meta,
    arrays: [
      { name: 'positions', data: quantizeUnorm16(P, min, max), components: 3 },
      { name: 'colors', data: C, components: 3 },
      { name: 'sizes', data: S, components: 1 },
    ],
  })
  return { bytes, meta }
}
