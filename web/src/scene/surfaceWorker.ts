// Builds the room's connected surface off the main thread (see surface.ts).
import { buildRoomSurface, type DepthView } from './surface'

export interface SurfaceJob {
  views: { T: number[]; K: number[]; offset: number }[]
  depth: ArrayBuffer
  confidence: ArrayBuffer
  depthW: number
  depthH: number
  videoW: number
  videoH: number
  points: Float32Array
  colors: Uint8Array
}

self.onmessage = (e: MessageEvent<SurfaceJob>) => {
  const job = e.data
  const px = job.depthW * job.depthH
  const views: DepthView[] = job.views.map((v) => ({
    T: v.T,
    K: v.K,
    depth: new Uint16Array(job.depth, v.offset * px * 2, px),
    confidence: new Uint8Array(job.confidence, v.offset * px, px),
  }))
  const surface = buildRoomSurface(views, job)
  ;(self as unknown as Worker).postMessage(surface, [surface.positions.buffer, surface.normals.buffer, surface.indices.buffer, surface.colors.buffer])
}
