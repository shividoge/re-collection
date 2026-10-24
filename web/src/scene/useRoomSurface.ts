import { useEffect, useState } from 'react'
import { fetchBytes, fetchRange } from '../api'
import type { Manifest } from '../api'
import type { FrameRecord } from './formats'
import type { LoadedCapture } from './loadCapture'
import type { ColoredMesh, Grid } from './surface'
import type { DepthRun, SurfaceJob, SurfaceMessage } from './surfaceWorker'
import type { Timeline } from './timeline'

export type RoomSurface = ColoredMesh
export type SurfaceState = { status: 'none' } | { status: 'building' } | { status: 'ready'; surface: RoomSurface } | { status: 'failed'; message: string }

/** The visit's timeline, plus the voxels the room explains (the live replay leaves those out). */
export type VisitTimeline = Timeline & { grid: Grid; room: Uint8Array }
export type TimelineState = { status: 'none' } | { status: 'building' } | { status: 'ready'; timeline: VisitTimeline } | { status: 'failed'; message: string }

/** Fetches the depth frames of `frames` as one contiguous run of depth.bin and confidence.bin. */
async function depthRun(id: string, manifest: Manifest, frames: FrameRecord[]): Promise<DepthRun> {
  const ks = frames.map((f) => f.d as number)
  const first = Math.min(...ks)
  const last = Math.max(...ks)
  const { width, height, file, confidenceFile } = manifest.depth
  const px = width * height
  const [depth, confidence] = await Promise.all([
    fetchRange(id, file, first * px * 2, (last - first + 1) * px * 2),
    fetchRange(id, confidenceFile, first * px, (last - first + 1) * px),
  ])
  return { views: frames.map((f) => ({ T: f.T, K: f.K, t: f.t, offset: (f.d as number) - first })), depth, confidence }
}

/** The keyframes (one per second of the visit), scaled down to the depth grid. Missing ones are skipped. */
async function loadKeyframes(id: string, manifest: Manifest): Promise<{ t: number; image: ImageBitmap }[]> {
  const kf = manifest.keyframes
  if (!kf) return []
  const out = await Promise.all(
    Array.from({ length: kf.count }, async (_, s) => {
      try {
        const bytes = await fetchBytes(id, `${kf.dir}/k${String(s).padStart(4, '0')}.jpg`)
        const image = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }), {
          resizeWidth: manifest.depth.width,
          resizeHeight: manifest.depth.height,
          resizeQuality: 'medium',
        })
        return { t: s * kf.everySec, image }
      } catch {
        return null
      }
    }),
  )
  return out.filter((k): k is { t: number; image: ImageBitmap } => k !== null)
}

/**
 * The room as one connected surface, fused from every depth frame of the room scan, then the
 * visit's timeline: what the video adds to the room, and when (timeline.ts). Needs the scan's
 * depth frames, so a bare room.bin (no recording) stays as points.
 */
export function useRoomSurface(capture: LoadedCapture): { surface: SurfaceState; timeline: TimelineState } {
  const [surface, setSurface] = useState<SurfaceState>({ status: 'none' })
  const [timeline, setTimeline] = useState<TimelineState>({ status: 'none' })
  useEffect(() => {
    const { id, manifest, cloud, frames } = capture
    const scan = (frames?.scan ?? []).filter((f) => f.d !== null)
    const moment = (frames?.moment ?? []).filter((f) => f.d !== null)
    if (!id || !manifest || !cloud || scan.length === 0) return
    let cancelled = false
    let worker: Worker | null = null
    setSurface({ status: 'building' })
    if (moment.length > 0) setTimeline({ status: 'building' })
    const fail = (message: string) => {
      if (cancelled) return
      setSurface((s) => (s.status === 'ready' ? s : { status: 'failed', message }))
      setTimeline((s) => (s.status === 'building' ? { status: 'failed', message } : s))
    }
    ;(async () => {
      const [scanRun, momentRun, keyframes] = await Promise.all([
        depthRun(id, manifest, scan),
        moment.length > 0 ? depthRun(id, manifest, moment) : Promise.resolve(null),
        moment.length > 0 ? loadKeyframes(id, manifest) : Promise.resolve([]),
      ])
      if (cancelled) return
      const job: SurfaceJob = {
        scan: scanRun,
        moment: momentRun && { ...momentRun, keyframes },
        depthW: manifest.depth.width,
        depthH: manifest.depth.height,
        videoW: manifest.video.width,
        videoH: manifest.video.height,
        points: cloud.positions.slice(),
        colors: cloud.colors.slice(),
      }
      worker = new Worker(new URL('./surfaceWorker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (e: MessageEvent<SurfaceMessage>) => {
        if (cancelled) return
        const m = e.data
        if (m.kind === 'surface') setSurface({ status: 'ready', surface: m.surface })
        else setTimeline({ status: 'ready', timeline: { ...m.timeline, grid: m.grid, room: m.room } })
      }
      worker.onerror = (e) => fail(e.message || 'the surface worker failed')
      const transfer: Transferable[] = [scanRun.depth, scanRun.confidence, job.points.buffer, job.colors.buffer, ...keyframes.map((k) => k.image)]
      if (momentRun) transfer.push(momentRun.depth, momentRun.confidence)
      worker.postMessage(job, transfer)
    })().catch((e: Error) => fail(e.message))
    return () => {
      cancelled = true
      worker?.terminate()
    }
  }, [capture])
  return { surface, timeline }
}
