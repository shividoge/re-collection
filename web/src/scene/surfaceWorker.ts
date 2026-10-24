// Builds the room's connected surface (surface.ts), then the visit's timeline (timeline.ts),
// off the main thread. Posts the surface as soon as it's ready, then the timeline.
import { buildRoomSurface, type ColoredMesh, type DepthView, type Grid } from './surface'
import { buildTimeline, meshMask, type MomentView, type Timeline } from './timeline'

/** Depth frames as offsets into one contiguous run of depth.bin / confidence.bin. */
export interface DepthRun {
  views: { T: number[]; K: number[]; t: number; offset: number }[]
  depth: ArrayBuffer
  confidence: ArrayBuffer
}

export interface SurfaceJob {
  scan: DepthRun
  /** The visit's depth frames, and its keyframes (seconds → image) for color. */
  moment: (DepthRun & { keyframes: { t: number; image: ImageBitmap }[] }) | null
  depthW: number
  depthH: number
  videoW: number
  videoH: number
  points: Float32Array
  colors: Uint8Array
}

/** Voxels the room explains: its surface, grown by this many voxels for tracking drift. */
export const ROOM_MARGIN_VOXELS = 3

export type SurfaceMessage =
  | { kind: 'surface'; surface: ColoredMesh }
  | { kind: 'timeline'; timeline: Timeline; grid: Grid; room: Uint8Array }

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

  const { mesh, grid } = buildRoomSurface(viewsOf(job.scan), job)
  const room = meshMask(mesh.positions, grid, ROOM_MARGIN_VOXELS)
  post({ kind: 'surface', surface: mesh }, [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer, mesh.colors.buffer])
  if (!job.moment) return

  // Each keyframe colors the depth frame closest to it in time (depth is 10 Hz, so within 0.05 s).
  const views: MomentView[] = viewsOf(job.moment)
  const canvas = new OffscreenCanvas(job.depthW, job.depthH)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  for (const { t, image } of job.moment.keyframes) {
    let best = -1
    for (let i = 0; i < views.length; i++) if (best < 0 || Math.abs(views[i].t - t) < Math.abs(views[best].t - t)) best = i
    if (best < 0 || Math.abs(views[best].t - t) > 0.06) continue
    ctx.drawImage(image, 0, 0, job.depthW, job.depthH)
    views[best].color = ctx.getImageData(0, 0, job.depthW, job.depthH).data
    image.close()
  }
  const timeline = buildTimeline(views, grid, room, job)
  post({ kind: 'timeline', timeline, grid, room }, [
    timeline.positions.buffer,
    timeline.colors.buffer,
    timeline.start.buffer,
    timeline.end.buffer,
    room.buffer,
  ])
}
