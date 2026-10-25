// The bake reorders room points (points.pack is shuffled for level of detail), so the selection
// index must label and select the same way whatever order the points arrive in.
import { describe, expect, it } from 'vitest'
import { buildRoomIndex, roomSelection, type RoomIndex } from '../src/scene/roomQuery'
import { FLOOR, OBJECT, WALL, type Vec3 } from '../src/scene/spatial'
import { VIDEO, makeFixture } from './fixture'

function mulberry(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** perm[j] = the original index of shuffled point j (Fisher–Yates, fixed seed). */
function permutation(n: number, seed: number): Uint32Array {
  const random = mulberry(seed)
  const perm = Uint32Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[perm[i], perm[j]] = [perm[j], perm[i]]
  }
  return perm
}

function permute(src: Float32Array | Uint8Array, perm: Uint32Array) {
  const out = new (src.constructor as Float32ArrayConstructor | Uint8ArrayConstructor)(src.length)
  perm.forEach((p, j) => out.set(src.subarray(p * 3, p * 3 + 3), j * 3))
  return out
}

function pointLabels(room: RoomIndex): Uint8Array {
  const { index, structure } = room
  const out = new Uint8Array(index.points.length)
  for (let v = 0; v < index.voxelCount; v++) for (let k = index.start[v]; k < index.start[v + 1]; k++) out[index.points[k]] = structure[v]
  return out
}

/** The fixture with walls cut to 1.7 m and a few millimeters of noise: walls have to come from the plane fit. */
function lowWallRoom() {
  const { cloud } = makeFixture()
  const random = mulberry(7)
  const pos: number[] = []
  const col: number[] = []
  for (let i = 0; i < cloud.positions.length / 3; i++) {
    const p = cloud.positions.subarray(i * 3, i * 3 + 3)
    if (p[1] > 1.7) continue
    pos.push(p[0] + (random() - 0.5) * 0.03, p[1] + (random() - 0.5) * 0.03, p[2] + (random() - 0.5) * 0.03)
    col.push(...cloud.colors.subarray(i * 3, i * 3 + 3))
  }
  return { positions: new Float32Array(pos), colors: new Uint8Array(col) }
}

const RAYS: [Vec3, Vec3][] = [
  [[0, 3, 0.1], [0, -1, 0]], // table
  [[0, 1.2, 0], [1, 0, 0]], // wall
  [[0, 1.2, 0], [0, 0, -1]], // other wall
  [[1.5, 2, 1.2], [0, -1, 0]], // floor
  [[0, 1.0, 0], [0.7, 0.2, 0.6]],
]

describe.each([
  ['the box room', () => makeFixture().cloud],
  ['a room with low, noisy walls', lowWallRoom],
])('classification of %s does not depend on point order', (_, make) => {
  const { positions, colors } = make()
  const perm = permutation(positions.length / 3, 99)
  const sizes = new Float32Array(positions.length / 3).fill(0.02)
  const a = buildRoomIndex({ kind: 'float', positions, colors, sizes })
  const b = buildRoomIndex({ kind: 'float', positions: permute(positions, perm) as Float32Array, colors: permute(colors, perm) as Uint8Array, sizes })
  const { frames } = makeFixture()

  it('gives every point the same label', () => {
    const la = pointLabels(a)
    const lb = pointLabels(b)
    let mismatched = 0
    perm.forEach((p, j) => (mismatched += la[p] === lb[j] ? 0 : 1))
    expect(mismatched).toBe(0)
    for (const kind of [FLOOR, WALL, OBJECT]) expect(la.includes(kind)).toBe(true)
  })

  it.each(RAYS)('selects the same points and box for a click from %j', (origin, dir) => {
    const sa = roomSelection(a, frames.moment, VIDEO.width, VIDEO.height, origin, dir)!
    const sb = roomSelection(b, frames.moment, VIDEO.width, VIDEO.height, origin, dir)!
    expect(sb.kind).toBe(sa.kind)
    expect(sb.truncated).toBe(sa.truncated)
    expect(sb.bounds).toEqual(sa.bounds)
    expect(sb.seen).toEqual(sa.seen)
    expect(Array.from(sb.points, (j) => perm[j]).sort((x, y) => x - y)).toEqual(Array.from(sa.points).sort((x, y) => x - y))
    expect(sb.voxelCoords).toEqual(sa.voxelCoords)
  })
})
