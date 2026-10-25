import { expect, test } from 'bun:test'
import type { RoomMesh } from '../../../web/src/scene/surface'
import { indexMesh, snorm8, unorm16 } from '../src/surfacePack'

/** Two triangles sharing an edge: once from one keyframe (4 vertices), once across a seam (6). */
function quad(secondLayer: number): RoomMesh {
  const corners = [
    [0, 0, 0, 0.1, 0.1, 0],
    [1, 0, 0, 0.2, 0.1, 0],
    [0, 1, 0, 0.1, 0.2, 0],
    [1, 0, 0, 0.2, 0.1, secondLayer],
    [1, 1, 0, 0.2, 0.2, secondLayer],
    [0, 1, 0, 0.1, 0.2, secondLayer],
  ]
  return {
    positions: Float32Array.from(corners.flatMap((c) => c.slice(0, 3))),
    normals: Float32Array.from(corners.flatMap(() => [0, 0, 1])),
    colors: Uint8Array.from(corners.flatMap(() => [1, 2, 3])),
    uvs: Float32Array.from(corners.flatMap((c) => c.slice(3, 5))),
    layers: Float32Array.from(corners.map((c) => c[5])),
  }
}

function expand(m: ReturnType<typeof indexMesh>): RoomMesh {
  const I = m.indices
  const pick = <T extends Float32Array | Uint8Array>(src: ArrayLike<number>, k: number, out: T) => {
    I.forEach((v, c) => {
      for (let a = 0; a < k; a++) out[c * k + a] = src[v * k + a]
    })
    return out
  }
  return {
    positions: pick(m.positions, 3, new Float32Array(I.length * 3)),
    normals: pick(m.normals, 3, new Float32Array(I.length * 3)),
    colors: pick(m.colors, 3, new Uint8Array(I.length * 3)),
    uvs: pick(m.uvs, 2, new Float32Array(I.length * 2)),
    layers: pick(m.layers, 1, new Float32Array(I.length)),
  }
}

test('shares identical corners and splits at keyframe seams', () => {
  expect(indexMesh(quad(0)).positions.length / 3).toBe(4)
  expect(indexMesh(quad(1)).positions.length / 3).toBe(6)
  expect(Array.from(indexMesh(quad(0)).indices)).toEqual([0, 1, 2, 1, 3, 2])
})

test('re-expanding the indexed mesh gives the original triangles exactly', () => {
  // A messier mesh: random corners, many repeated.
  const base = quad(1)
  const n = 3000
  const rnd = (i: number) => (Math.sin(i * 12.9898) * 43758.5453) % 1
  const m: RoomMesh = { positions: new Float32Array(n * 3), normals: new Float32Array(n * 3), colors: new Uint8Array(n * 3), uvs: new Float32Array(n * 2), layers: new Float32Array(n) }
  for (let c = 0; c < n; c++) {
    const src = Math.floor(Math.abs(rnd(c)) * 40) // 40 distinct corners
    const s = src % 6
    m.positions.set([base.positions[s * 3] + src, base.positions[s * 3 + 1], base.positions[s * 3 + 2]], c * 3)
    m.normals.set([0, Math.SQRT1_2, -Math.SQRT1_2], c * 3)
    m.colors.set([src, 2, 3], c * 3)
    m.uvs.set([base.uvs[s * 2], base.uvs[s * 2 + 1]], c * 2)
    m.layers[c] = src % 3 === 0 ? -1 : base.layers[s]
  }
  const indexed = indexMesh(m)
  expect(indexed.positions.length / 3).toBe(40)
  expect(expand(indexed)).toEqual(m)
})

test('snorm8 and unorm16 clamp and round', () => {
  expect(Array.from(snorm8(Float32Array.from([-1, -0.5, 0, 0.5, 1, 1.2])))).toEqual([-127, -63, 0, 64, 127, 127])
  expect(Array.from(unorm16(Float32Array.from([-0.1, 0, 0.5, 1, 1.1])))).toEqual([0, 0, 32768, 65535, 65535])
})
