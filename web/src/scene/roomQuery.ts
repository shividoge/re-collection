// Pure: the room's selection index and what a click selects (spatial.ts does the geometry). Runs
// in roomWorker.ts; kept separate so it is testable without a worker.
import type { PointCloud } from './formats'
import { splatSizes } from './gaps'
import {
  boundsOfPoints,
  buildVoxelIndex,
  classifyStructure,
  estimateLevels,
  pointsOfVoxels,
  raycastVoxels,
  segmentAt,
  visibleIntervals,
  voxelCoords,
  type Bounds,
  type Interval,
  type PoseFrame,
  type SurfaceKind,
  type Vec3,
  type VoxelIndex,
} from './spatial'

export type RoomPointsInput =
  /** A room.bin's floats; sizes are worked out here when not given. */
  | { kind: 'float'; positions: Float32Array; colors: Uint8Array; sizes: Float32Array | null }
  /** points.pack as stored (§4.2). */
  | { kind: 'quantized'; positions: Uint16Array; min: Vec3; max: Vec3; colors: Uint8Array; sizes: Uint8Array; sizeMin: number; sizeMax: number }

export interface RoomIndex {
  index: VoxelIndex
  structure: Uint8Array
  positions: Float32Array
  colors: Uint8Array
  /** Splat diameter of every point, meters. */
  sizes: Float32Array
}

/** Voxel size of the selection index, meters. */
export const SELECT_VOXEL = 0.03

export function dequantize(q: Uint16Array, min: Vec3, max: Vec3): Float32Array {
  const out = new Float32Array(q.length)
  const s = [(max[0] - min[0]) / 65535, (max[1] - min[1]) / 65535, (max[2] - min[2]) / 65535]
  for (let i = 0; i < q.length; i++) out[i] = min[i % 3] + q[i] * s[i % 3]
  return out
}

export function buildRoomIndex(input: RoomPointsInput): RoomIndex {
  let positions: Float32Array
  let sizes: Float32Array
  if (input.kind === 'float') {
    positions = input.positions
    sizes = input.sizes ?? splatSizes(positions)
  } else {
    positions = dequantize(input.positions, input.min, input.max)
    const range = input.sizeMax - input.sizeMin
    sizes = Float32Array.from(input.sizes, (q) => input.sizeMin + (q / 255) * range)
  }
  const index = buildVoxelIndex(positions, SELECT_VOXEL)
  const { floorY, ceilingY } = estimateLevels(positions)
  const structure = classifyStructure(index, floorY, ceilingY)
  return { index, structure, positions, colors: input.colors, sizes }
}

export interface SelectionData {
  kind: SurfaceKind
  truncated: boolean
  pointCount: number
  bounds: Bounds
  /** The selected points as their own cloud, for highlighting. */
  cloud: PointCloud
  /** Their splat diameters, meters. */
  sizes: Float32Array
  /** Their indices in the room's points. */
  points: Uint32Array
  /** ix, iy, iz of each voxel they fill in the selection index (for the tint mask). */
  voxelCoords: Int32Array
  /** When the recording camera had it in view. */
  seen: Interval[]
  hit: Vec3
}

export function roomSelection(room: RoomIndex, frames: PoseFrame[], videoW: number, videoH: number, origin: Vec3, dir: Vec3): SelectionData | null {
  const hit = raycastVoxels(room.index, origin, dir, 100)
  if (!hit) return null
  const seg = segmentAt(room.index, room.structure, hit.id)
  const points = pointsOfVoxels(room.index, seg.voxels)
  const positions = new Float32Array(points.length * 3)
  const colors = new Uint8Array(points.length * 3)
  const sizes = new Float32Array(points.length)
  points.forEach((p, i) => {
    positions.set(room.positions.subarray(p * 3, p * 3 + 3), i * 3)
    colors.set(room.colors.subarray(p * 3, p * 3 + 3), i * 3)
    sizes[i] = room.sizes[p]
  })
  return {
    kind: seg.kind,
    truncated: seg.truncated,
    pointCount: points.length,
    bounds: boundsOfPoints(room.positions, points),
    cloud: { count: points.length, positions, colors },
    sizes,
    points,
    voxelCoords: voxelCoords(room.index, seg.voxels),
    seen: visibleIntervals(room.index, seg.voxels, frames, videoW, videoH),
    hit: hit.point,
  }
}
