import { useEffect, useState } from 'react'
import type { FrameRecord, PointCloud } from './formats'
import type { Vec3 } from './pose'
import {
  boundsOfPoints,
  buildVoxelIndex,
  classifyStructure,
  estimateLevels,
  pointsOfVoxels,
  raycastVoxels,
  segmentAt,
  visibleIntervals,
  type Bounds,
  type Interval,
  type SurfaceKind,
  type VoxelIndex,
} from './spatial'

export interface RoomIndex {
  index: VoxelIndex
  structure: Uint8Array
  floorY: number | null
  ceilingY: number | null
}

export interface Selection {
  kind: SurfaceKind
  truncated: boolean
  pointCount: number
  bounds: Bounds
  /** The selected points as their own cloud, for highlighting. */
  cloud: PointCloud
  /** When the recording camera had it in view. */
  seen: Interval[]
  hit: Vec3
}

export type IndexState = { status: 'building' } | { status: 'ready'; room: RoomIndex } | { status: 'failed'; message: string }

/** Builds the voxel index after the cloud loads, off the first paint. */
export function useRoomIndex(cloud: PointCloud | null): IndexState {
  const [state, setState] = useState<IndexState>({ status: 'building' })
  useEffect(() => {
    if (!cloud) return
    let cancelled = false
    const timer = setTimeout(() => {
      try {
        const index = buildVoxelIndex(cloud.positions, 0.03)
        const { floorY, ceilingY } = estimateLevels(cloud.positions)
        const structure = classifyStructure(index, floorY, ceilingY)
        if (!cancelled) setState({ status: 'ready', room: { index, structure, floorY, ceilingY } })
      } catch (e) {
        if (!cancelled) setState({ status: 'failed', message: e instanceof Error ? e.message : String(e) })
      }
    }, 50)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [cloud])
  return state
}

export function selectAlongRay(room: RoomIndex, cloud: PointCloud, frames: FrameRecord[], videoW: number, videoH: number, origin: Vec3, dir: Vec3): Selection | null {
  const hit = raycastVoxels(room.index, origin, dir, 100)
  if (!hit) return null
  const seg = segmentAt(room.index, room.structure, hit.id)
  const points = pointsOfVoxels(room.index, seg.voxels)
  const positions = new Float32Array(points.length * 3)
  const colors = new Uint8Array(points.length * 3)
  points.forEach((p, i) => {
    positions.set(cloud.positions.subarray(p * 3, p * 3 + 3), i * 3)
    colors.set(cloud.colors.subarray(p * 3, p * 3 + 3), i * 3)
  })
  return {
    kind: seg.kind,
    truncated: seg.truncated,
    pointCount: points.length,
    bounds: boundsOfPoints(cloud.positions, points),
    cloud: { count: points.length, positions, colors },
    seen: visibleIntervals(room.index, seg.voxels, frames, videoW, videoH),
    hit: hit.point,
  }
}
