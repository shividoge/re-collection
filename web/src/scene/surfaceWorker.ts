// Builds the room's surface (surface.ts), then the visit's timeline (timeline.ts), off the
// main thread. Posts the surface as soon as it's ready, then the timeline.
import { buildRoomSurface, type DepthView, type Grid, type KeyView, type RoomMesh } from './surface'
import { buildTimeline, meshMask, type MomentView, type Timeline } from './timeline'

/** Depth frames as offsets into one contiguous run of depth.bin / confidence.bin. */
export interface DepthRun {
  views: { T: number[]; K: number[]; t: number; offset: number }[]
  depth: ArrayBuffer
  confidence: ArrayBuffer
}

/** A keyframe: its moment time, the exact pose of that video frame, and a small copy for coloring. */
export interface KeyframeInfo {
  t: number
  T: number[]
  K: number[]
  small: ImageBitmap
}

export interface SurfaceJob {
  scan: DepthRun
  /** The visit's depth frames and its keyframes, in the order the page uploads them as layers. */
  moment: (DepthRun & { keyframes: KeyframeInfo[] }) | null
  depthW: number
  depthH: number
  videoW: number
  videoH: number
  points: Float32Array
  colors: Uint8Array
}

/** Voxels the room explains: its surface, grown by this many voxels for tracking drift. */
export const ROOM_MARGIN_VOXELS = 3

export type SurfaceMessage = { kind: 'surface'; surface: RoomMesh } | { kind: 'timeline'; timeline: Timeline; grid: Grid; room: Uint8Array }

self.onmessage = (e: MessageEvent<SurfaceJob>) => {
  const job = e.data
  const px = job.depthW * job.depthH
  const viewsOf = (run: DepthRun): (DepthView & { t: number })[] =>
    run.views.map((v) => ({
      T: v.T,
      K: v.K,
      t: v.t,
      depth: new Uint16Array(run.depth, v.offset * px * 2, px),
      confidence: new Uint8Array(run.confidence, v.offset * px, px),
    }))
  const post = (message: SurfaceMessage, transfer: Transferable[]) => (self as unknown as Worker).postMessage(message, transfer)

  const visit: MomentView[] = job.moment ? viewsOf(job.moment) : []
  const keyframes = job.moment?.keyframes ?? []
  // Each keyframe goes with the depth frame closest to it in time (depth is 10 Hz, so within
  // 0.05 s); one without any stays unused (no depth: can't tell what was in front).
  const nearest = keyframes.map(({ t }) => {
    let best = -1
    for (let i = 0; i < visit.length; i++) if (best < 0 || Math.abs(visit[i].t - t) < Math.abs(visit[best].t - t)) best = i
    return best >= 0 && Math.abs(visit[best].t - t) <= 0.06 ? best : -1
  })
  const noDepth = { depth: new Uint16Array(px), confidence: new Uint8Array(px) }
  const keys: KeyView[] = keyframes.map((k, j) => ({ T: k.T, K: k.K, ...(nearest[j] >= 0 ? visit[nearest[j]] : noDepth) }))

  const { mesh, grid } = buildRoomSurface(viewsOf(job.scan), visit, keys, job)
  const room = meshMask(mesh.positions, grid, ROOM_MARGIN_VOXELS)
  post({ kind: 'surface', surface: mesh }, [mesh.positions.buffer, mesh.normals.buffer, mesh.colors.buffer, mesh.uvs.buffer, mesh.layers.buffer])
  if (!job.moment) return

  // The timeline colors what the visit adds from the keyframes, at the depth grid's size.
  const canvas = new OffscreenCanvas(job.depthW, job.depthH)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  keyframes.forEach((k, j) => {
    if (nearest[j] >= 0) {
      ctx.drawImage(k.small, 0, 0, job.depthW, job.depthH)
      visit[nearest[j]].color = ctx.getImageData(0, 0, job.depthW, job.depthH).data
    }
    k.small.close()
  })
  const timeline = buildTimeline(visit, grid, room, job)
  post({ kind: 'timeline', timeline, grid, room }, [timeline.positions.buffer, timeline.colors.buffer, timeline.start.buffer, timeline.end.buffer, room.buffer])
}
