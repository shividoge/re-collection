// Builds the room's connected surface off the main thread (see surface.ts).
import { colorFromPoints, fuseTSDF, marchingCubes, roomExtent, type DepthView } from './surface'

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
  // High-confidence depth only (what the phone's colored points come from), and at least three
  // views agreeing on a voxel: on the sample scan that's ~240k triangles, 10% without color nearby.
  const volume = fuseTSDF(views, {
    ...roomExtent(job.points),
    voxel: 0.02,
    depthW: job.depthW,
    depthH: job.depthH,
    videoW: job.videoW,
    videoH: job.videoH,
    minConfidence: 2,
  })
  const mesh = marchingCubes(volume, 3)
  const colors = colorFromPoints(mesh.positions, job.points, job.colors, 0.02)
  ;(self as unknown as Worker).postMessage({ ...mesh, colors }, [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer, colors.buffer])
}
