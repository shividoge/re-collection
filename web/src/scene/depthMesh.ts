// Pure: which depth pixels of each frame the people replay draws, and how they join into
// triangles. Same rules as before depth v2 (gaps.ts movingPixels + depthMeshIndices); this only
// unpacks v2 pixels for them.
import { framesOfChunk, MAX_MM, type DepthIndex } from '../../../shared/depth'
import { depthMeshIndices, movingPixels } from './gaps'
import type { GridMeta } from './packs'

export interface DepthPose {
  /** Depth frame index (frames.jsonl `d`). */
  k: number
  T: number[]
  /** fx, fy, cx, cy for the full-size video frame. */
  K: number[]
}

export interface DepthMeshOptions {
  poses: DepthPose[]
  videoW: number
  videoH: number
  minConfidence: number
  /**
   * The voxels the room explains (timeline.pack `skip`): only what's outside them, as solid blobs,
   * is replayed. Null replays the whole frame.
   */
  room: { grid: GridMeta; skip: Uint8Array } | null
}

/** Packed v2 pixels → (meters, confidence) pairs, the layout gaps.ts reads. */
export function unpackMeters(packed: Uint16Array, out: Float32Array): Float32Array {
  for (let i = 0; i < packed.length; i++) {
    out[i * 2] = (packed[i] & MAX_MM) / 1000
    out[i * 2 + 1] = packed[i] >>> 14
  }
  return out
}

/** World point → is it room (inside a skip voxel, or outside the grid: far stray depth). */
export function roomTest(grid: GridMeta, skip: Uint8Array): (x: number, y: number, z: number) => boolean {
  const { nx, ny, nz, origin, voxel } = grid
  return (x, y, z) => {
    const ix = Math.floor((x - origin[0]) / voxel)
    const iy = Math.floor((y - origin[1]) / voxel)
    const iz = Math.floor((z - origin[2]) / voxel)
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return true
    return skip[(iz * ny + iy) * nx + ix] === 1
  }
}

/**
 * Triangle indices (into the width × height pixel grid, which fits UInt16) for every frame in a
 * decoded chunk. A frame with no pose in frames.jsonl gets none.
 */
export function depthChunkMeshes(packed: Uint16Array, index: DepthIndex, chunk: number, o: DepthMeshOptions): Uint16Array[] {
  const { width, height } = index
  const px = width * height
  const { first, n } = framesOfChunk(index, chunk)
  const poses = new Map(o.poses.map((p) => [p.k, p]))
  const isRoom = o.room ? roomTest(o.room.grid, o.room.skip) : null
  const meters = new Float32Array(px * 2)
  const scratch = new Uint32Array((width - 1) * (height - 1) * 6)
  const sx = width / o.videoW
  const sy = height / o.videoH
  const out: Uint16Array[] = []
  for (let f = 0; f < n; f++) {
    const pose = poses.get(first + f)
    if (!pose) {
      out.push(new Uint16Array(0))
      continue
    }
    unpackMeters(packed.subarray(f * px, (f + 1) * px), meters)
    const Kd = [pose.K[0] * sx, pose.K[1] * sy, pose.K[2] * sx, pose.K[3] * sy]
    const keep = isRoom ? movingPixels(meters, width, height, Kd, pose.T, o.minConfidence, isRoom) : null
    const count = depthMeshIndices(meters, width, height, o.minConfidence, scratch, keep)
    out.push(Uint16Array.from(scratch.subarray(0, count)))
  }
  return out
}
