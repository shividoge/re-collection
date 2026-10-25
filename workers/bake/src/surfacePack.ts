// surface.pack and timeline.pack (docs/architecture-v3.md §4.3, §4.4).
import { encodePack, type GridMeta, type SurfaceMeta, type TimelineMeta } from '../../../shared/pack'
import type { Grid, RoomMesh } from '../../../web/src/scene/surface'
import type { Timeline } from '../../../web/src/scene/timeline'

export interface IndexedMesh {
  positions: Float32Array
  normals: Float32Array
  colors: Uint8Array
  uvs: Float32Array
  layers: Int16Array
  indices: Uint32Array
}

/**
 * Shares vertices between triangles: corners with exactly the same position, normal, color,
 * texture coordinates and layer become one vertex. Marching cubes made the corners of one
 * vertex identical, so they only stay split where triangles take it from different keyframes.
 */
export function indexMesh(m: RoomMesh): IndexedMesh {
  const corners = m.layers.length
  // A corner's attributes as ten 32-bit words (floats by their bits).
  const fill = (c: number, words: Uint32Array, f: Float32Array) => {
    f[0] = m.positions[c * 3]
    f[1] = m.positions[c * 3 + 1]
    f[2] = m.positions[c * 3 + 2]
    f[3] = m.normals[c * 3]
    f[4] = m.normals[c * 3 + 1]
    f[5] = m.normals[c * 3 + 2]
    f[6] = m.uvs[c * 2]
    f[7] = m.uvs[c * 2 + 1]
    f[8] = m.layers[c]
    words[9] = m.colors[c * 3] | (m.colors[c * 3 + 1] << 8) | (m.colors[c * 3 + 2] << 16)
  }
  const words = new Uint32Array(10)
  const wordsF = new Float32Array(words.buffer)
  const other = new Uint32Array(10)
  const otherF = new Float32Array(other.buffer)
  const same = (c: number) => {
    fill(c, other, otherF)
    for (let w = 0; w < 10; w++) if (other[w] !== words[w]) return false
    return true
  }
  // Open addressing: table slot → first corner with that key, + 1 (0 = empty).
  let size = 1
  while (size < corners * 2) size <<= 1
  const table = new Uint32Array(size)
  const vertexOfCorner = new Uint32Array(corners)
  const first: number[] = []
  for (let c = 0; c < corners; c++) {
    fill(c, words, wordsF)
    let h = 2166136261
    for (let w = 0; w < 10; w++) h = Math.imul(h ^ words[w], 16777619)
    let slot = (h >>> 0) & (size - 1)
    for (;;) {
      const at = table[slot]
      if (at === 0) {
        table[slot] = c + 1
        vertexOfCorner[c] = first.length
        first.push(c)
        break
      }
      if (same(at - 1)) {
        vertexOfCorner[c] = vertexOfCorner[at - 1]
        break
      }
      slot = (slot + 1) & (size - 1)
    }
  }
  const n = first.length
  const out: IndexedMesh = {
    positions: new Float32Array(n * 3),
    normals: new Float32Array(n * 3),
    colors: new Uint8Array(n * 3),
    uvs: new Float32Array(n * 2),
    layers: new Int16Array(n),
    indices: vertexOfCorner,
  }
  first.forEach((c, v) => {
    out.positions.set(m.positions.subarray(c * 3, c * 3 + 3), v * 3)
    out.normals.set(m.normals.subarray(c * 3, c * 3 + 3), v * 3)
    out.colors.set(m.colors.subarray(c * 3, c * 3 + 3), v * 3)
    out.uvs.set(m.uvs.subarray(c * 2, c * 2 + 2), v * 2)
    out.layers[v] = m.layers[c]
  })
  return out
}

export function snorm8(values: Float32Array): Int8Array {
  return Int8Array.from(values, (x) => Math.round(Math.max(-1, Math.min(1, x)) * 127))
}

export function unorm16(values: Float32Array): Uint16Array {
  return Uint16Array.from(values, (x) => Math.round(Math.max(0, Math.min(1, x)) * 65535))
}

const gridMeta = (g: Grid): GridMeta => ({ nx: g.nx, ny: g.ny, nz: g.nz, origin: [g.origin[0], g.origin[1], g.origin[2]], voxel: g.voxel })

export function encodeSurface(mesh: IndexedMesh, grid: Grid, keyframes: { file: string; t: number }[]): Uint8Array {
  return encodePack<SurfaceMeta>({
    kind: 'surface',
    meta: { grid: gridMeta(grid), keyframes },
    arrays: [
      { name: 'positions', data: mesh.positions, components: 3 },
      { name: 'normals', data: snorm8(mesh.normals), components: 3 },
      { name: 'colors', data: mesh.colors, components: 3 },
      { name: 'uvs', data: unorm16(mesh.uvs), components: 2 },
      { name: 'layers', data: mesh.layers, components: 1 },
      { name: 'indices', data: mesh.indices, components: 3 },
    ],
  })
}

export function encodeTimeline(t: Timeline, grid: Grid, skip: Uint8Array): Uint8Array {
  return encodePack<TimelineMeta>({
    kind: 'timeline',
    meta: { grid: gridMeta(grid) },
    arrays: [
      { name: 'positions', data: t.positions, components: 3 },
      { name: 'colors', data: t.colors, components: 3 },
      { name: 'start', data: t.start, components: 1 },
      { name: 'end', data: t.end, components: 1 },
      { name: 'skip', data: skip, components: 1 },
    ],
  })
}
