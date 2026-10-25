// Readers for the bake's derived files (docs/architecture-v3.md §4.2–4.4). The arrays stay
// views into the fetched bytes: nothing is expanded on the CPU, the GPU decodes them.
import { decodePack, packArray, PackError, type GridMeta, type PointsMeta, type SurfaceMeta, type TimelineMeta, type Vec3 } from '../../../shared/pack'

export type { GridMeta, Vec3 }

export interface PointsData {
  count: number
  /** unorm16 xyz inside min..max. */
  positions: Uint16Array
  /** sRGB bytes. */
  colors: Uint8Array
  /** unorm8 splat diameter between sizeMin and sizeMax (meters), for the full cloud. */
  sizes: Uint8Array
  min: Vec3
  max: Vec3
  sizeMin: number
  sizeMax: number
  /** Ascending prefixes of the cloud, each an even sample of the room; the last is all of it. */
  levels: { count: number; sizeScale: number }[]
}

export interface SurfaceData {
  positions: Float32Array
  normals: Int8Array
  colors: Uint8Array
  uvs: Uint16Array
  layers: Int16Array
  indices: Uint32Array
  grid: GridMeta
  keyframes: { file: string; t: number }[]
}

export interface TimelineData {
  positions: Float32Array
  colors: Uint8Array
  start: Float32Array
  end: Float32Array
  /** One byte per grid voxel; 1 = the replay draws nothing there. */
  skip: Uint8Array
  grid: GridMeta
}

function expectLength(name: string, actual: number, expected: number) {
  if (actual !== expected) throw new PackError(`"${name}" has ${actual} values, expected ${expected}.`)
}

export function readPoints(buf: ArrayBuffer | Uint8Array): PointsData {
  const pack = decodePack<PointsMeta>(buf)
  if (pack.kind !== 'points') throw new PackError(`Expected a points pack, got "${pack.kind}".`)
  const { count, min, max, sizeMin, sizeMax, levels } = pack.meta
  const positions = packArray(pack, 'positions', Uint16Array)
  const colors = packArray(pack, 'colors', Uint8Array)
  const sizes = packArray(pack, 'sizes', Uint8Array)
  expectLength('positions', positions.length, count * 3)
  expectLength('colors', colors.length, count * 3)
  expectLength('sizes', sizes.length, count)
  const valid = levels.length > 0 && levels.every((l, i) => l.count > 0 && l.count <= count && (i === 0 || l.count > levels[i - 1].count))
  if (!valid || levels[levels.length - 1].count !== count) throw new PackError('points.pack levels must ascend and end with the full cloud.')
  return { count, positions, colors, sizes, min, max, sizeMin, sizeMax, levels }
}

export function readSurface(buf: ArrayBuffer | Uint8Array): SurfaceData {
  const pack = decodePack<SurfaceMeta>(buf)
  if (pack.kind !== 'surface') throw new PackError(`Expected a surface pack, got "${pack.kind}".`)
  const positions = packArray(pack, 'positions', Float32Array)
  const n = positions.length / 3
  const out: SurfaceData = {
    positions,
    normals: packArray(pack, 'normals', Int8Array),
    colors: packArray(pack, 'colors', Uint8Array),
    uvs: packArray(pack, 'uvs', Uint16Array),
    layers: packArray(pack, 'layers', Int16Array),
    indices: packArray(pack, 'indices', Uint32Array),
    grid: pack.meta.grid,
    keyframes: pack.meta.keyframes ?? [],
  }
  expectLength('normals', out.normals.length, n * 3)
  expectLength('colors', out.colors.length, n * 3)
  expectLength('uvs', out.uvs.length, n * 2)
  expectLength('layers', out.layers.length, n)
  if (out.indices.length % 3 !== 0) throw new PackError('surface.pack indices are not whole triangles.')
  for (let i = 0; i < out.indices.length; i++) if (out.indices[i] >= n) throw new PackError('surface.pack has an index past the last vertex.')
  return out
}

export function readTimeline(buf: ArrayBuffer | Uint8Array): TimelineData {
  const pack = decodePack<TimelineMeta>(buf)
  if (pack.kind !== 'timeline') throw new PackError(`Expected a timeline pack, got "${pack.kind}".`)
  const positions = packArray(pack, 'positions', Float32Array)
  const n = positions.length / 3
  const { grid } = pack.meta
  const out: TimelineData = {
    positions,
    colors: packArray(pack, 'colors', Uint8Array),
    start: packArray(pack, 'start', Float32Array),
    end: packArray(pack, 'end', Float32Array),
    skip: packArray(pack, 'skip', Uint8Array),
    grid,
  }
  expectLength('colors', out.colors.length, n * 3)
  expectLength('start', out.start.length, n)
  expectLength('end', out.end.length, n)
  expectLength('skip', out.skip.length, grid.nx * grid.ny * grid.nz)
  return out
}

/** Points to draw per drawing-buffer pixel: past about one per pixel, more points add nothing visible. */
export const POINTS_PER_PIXEL = 0.5

/** The sparsest level that still has `budget` points (the full cloud when none does). */
export function pointLevel(levels: PointsData['levels'], budget: number): number {
  const i = levels.findIndex((l) => l.count >= budget)
  return i < 0 ? levels.length - 1 : i
}

export interface SceneBounds {
  center: Vec3
  radius: number
}

/** Center and radius of a box, for framing the camera (same rule as the old cloudBounds). */
export function boxBounds(min: Vec3, max: Vec3): SceneBounds {
  const size = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2])
  return { center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2], radius: Math.max(0.5, size / 2) }
}

export function gridBox(g: GridMeta): { min: Vec3; max: Vec3 } {
  return { min: g.origin, max: [g.origin[0] + g.nx * g.voxel, g.origin[1] + g.ny * g.voxel, g.origin[2] + g.nz * g.voxel] }
}

/** Box around the camera path, grown by `pad` meters: a frame when nothing else is loaded yet. */
export function pathBox(translations: ArrayLike<number>[], pad = 1.5): { min: Vec3; max: Vec3 } | null {
  if (translations.length === 0) return null
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const T of translations)
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], T[12 + a] - pad)
      max[a] = Math.max(max[a], T[12 + a] + pad)
    }
  return { min, max }
}

/** Width × height of a baseline or progressive JPEG, from its SOF marker; null if it isn't one. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null
    const marker = bytes[i + 1]
    if (marker === 0xff) {
      i++
      continue
    }
    const len = (bytes[i + 2] << 8) | bytes[i + 3]
    // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] }
    }
    i += 2 + len
  }
  return null
}

/** Size that fits `maxSide` on the long side, keeping the aspect ratio (never enlarges). */
export function fitSize(width: number, height: number, maxSide: number): { width: number; height: number } {
  const s = Math.min(1, maxSide / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) }
}
