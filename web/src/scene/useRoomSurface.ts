import { useEffect, useState } from 'react'
import { fetchRange } from '../api'
import type { LoadedCapture } from './loadCapture'
import type { Mesh } from './surface'
import type { SurfaceJob } from './surfaceWorker'

export type RoomSurface = Mesh & { colors: Uint8Array }
export type SurfaceState = { status: 'none' } | { status: 'building' } | { status: 'ready'; surface: RoomSurface } | { status: 'failed'; message: string }

/**
 * The room as one connected surface, fused from every depth frame of the room scan. Needs the
 * scan's depth frames, so a bare room.bin (no recording) stays as points.
 */
export function useRoomSurface(capture: LoadedCapture): SurfaceState {
  const [state, setState] = useState<SurfaceState>({ status: 'none' })
  useEffect(() => {
    const { id, manifest, cloud, frames } = capture
    const scan = (frames?.scan ?? []).filter((f) => f.d !== null)
    if (!id || !manifest || !cloud || scan.length === 0) return
    let cancelled = false
    let worker: Worker | null = null
    setState({ status: 'building' })
    ;(async () => {
      // The scan's depth frames are one contiguous run in depth.bin and confidence.bin.
      const ks = scan.map((f) => f.d as number)
      const first = Math.min(...ks)
      const last = Math.max(...ks)
      const { width, height, file, confidenceFile } = manifest.depth
      const px = width * height
      const [depth, confidence] = await Promise.all([
        fetchRange(id, file, first * px * 2, (last - first + 1) * px * 2),
        fetchRange(id, confidenceFile, first * px, (last - first + 1) * px),
      ])
      if (cancelled) return
      const job: SurfaceJob = {
        views: scan.map((f) => ({ T: f.T, K: f.K, offset: (f.d as number) - first })),
        depth,
        confidence,
        depthW: width,
        depthH: height,
        videoW: manifest.video.width,
        videoH: manifest.video.height,
        points: cloud.positions.slice(),
        colors: cloud.colors.slice(),
      }
      worker = new Worker(new URL('./surfaceWorker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (e: MessageEvent<RoomSurface>) => !cancelled && setState({ status: 'ready', surface: e.data })
      worker.onerror = (e) => !cancelled && setState({ status: 'failed', message: e.message || 'the surface worker failed' })
      worker.postMessage(job, [depth, confidence, job.points.buffer, job.colors.buffer])
    })().catch((e: Error) => !cancelled && setState({ status: 'failed', message: e.message }))
    return () => {
      cancelled = true
      worker?.terminate()
    }
  }, [capture])
  return state
}
