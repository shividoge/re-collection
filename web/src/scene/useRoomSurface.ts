import { useEffect, useState } from 'react'
import { fetchCaptureFile as fetchBytes, fetchCaptureRange as fetchRange, v1ConfidenceFile } from '../data/legacy'
import type { Manifest } from '../api'
import type { FrameRecord } from './formats'
import type { LoadedCapture } from './loadCapture'
import type { Grid, RoomMesh } from './surface'
import type { DepthRun, KeyframeInfo, SurfaceJob, SurfaceMessage } from './surfaceWorker'
import type { Timeline } from './timeline'

/** The keyframes as one array texture's pixels: RGBA rows, top first, `layers` images. */
export interface KeyframeImages {
  width: number
  height: number
  layers: number
  data: Uint8Array
}

export type RoomSurface = { mesh: RoomMesh; keyframes: KeyframeImages | null }
export type SurfaceState = { status: 'none' } | { status: 'building' } | { status: 'ready'; surface: RoomSurface } | { status: 'failed'; message: string }

/** The visit's timeline, plus the voxels where the replay draws nothing (surfaceWorker.ts `skip`). */
export type VisitTimeline = Timeline & { grid: Grid; skip: Uint8Array }
export type TimelineState = { status: 'none' } | { status: 'building' } | { status: 'ready'; timeline: VisitTimeline } | { status: 'failed'; message: string }

/** Fetches the depth frames of `frames` as one contiguous run of depth.bin and confidence.bin. */
async function depthRun(id: string, manifest: Manifest, frames: FrameRecord[]): Promise<DepthRun> {
  const ks = frames.map((f) => f.d as number)
  const first = Math.min(...ks)
  const last = Math.max(...ks)
  const { width, height, file } = manifest.depth
  const confidenceFile = v1ConfidenceFile(manifest.depth)
  const px = width * height
  const [depth, confidence] = await Promise.all([
    fetchRange(id, file, first * px * 2, (last - first + 1) * px * 2),
    fetchRange(id, confidenceFile, first * px, (last - first + 1) * px),
  ])
  return { views: frames.map((f) => ({ T: f.T, K: f.K, t: f.t, offset: (f.d as number) - first })), depth, confidence }
}

/** Most keyframes used to texture the room (evenly spaced); bounds the GPU memory they take. */
const MAX_KEYFRAMES = 32

/**
 * The keyframes (one per second of the visit) at full size for the room's texture, each with
 * the exact pose of its video frame, plus a copy at the depth grid's size for the timeline's
 * colors. Missing or broken ones are skipped.
 */
async function loadKeyframes(
  id: string,
  manifest: Manifest,
  moment: FrameRecord[],
): Promise<{ infos: KeyframeInfo[]; images: KeyframeImages } | null> {
  const kf = manifest.keyframes
  if (!kf || kf.count === 0 || moment.length === 0) return null
  const pick = kf.count <= MAX_KEYFRAMES ? [...Array(kf.count).keys()] : Array.from({ length: MAX_KEYFRAMES }, (_, i) => Math.round((i * (kf.count - 1)) / (MAX_KEYFRAMES - 1)))
  const loaded = await Promise.all(
    pick.map(async (s) => {
      try {
        const bytes = await fetchBytes(id, `${kf.dir}/k${String(s).padStart(4, '0')}.jpg`)
        return { t: s * kf.everySec, image: await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' })) }
      } catch {
        return null
      }
    }),
  )
  const ok = loaded.filter((k): k is { t: number; image: ImageBitmap } => k !== null)
  if (ok.length === 0) return null
  const width = ok[0].image.width
  const height = ok[0].image.height
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const data = new Uint8Array(width * height * 4 * ok.length)
  const infos: KeyframeInfo[] = []
  for (const [layer, { t, image }] of ok.entries()) {
    ctx.drawImage(image, 0, 0, width, height)
    data.set(ctx.getImageData(0, 0, width, height).data, layer * width * height * 4)
    // The pose of the video frame this keyframe is.
    let f = 0
    for (let i = 1; i < moment.length; i++) if (Math.abs(moment[i].t - t) < Math.abs(moment[f].t - t)) f = i
    const small = await createImageBitmap(image, { resizeWidth: manifest.depth.width, resizeHeight: manifest.depth.height, resizeQuality: 'medium' })
    image.close()
    infos.push({ t, T: moment[f].T, K: moment[f].K, small })
  }
  return { infos, images: { width, height, layers: ok.length, data } }
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
    const allMoment = frames?.moment ?? []
    const moment = allMoment.filter((f) => f.d !== null)
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
        moment.length > 0 ? loadKeyframes(id, manifest, allMoment) : Promise.resolve(null),
      ])
      if (cancelled) return
      const job: SurfaceJob = {
        scan: scanRun,
        moment: momentRun && { ...momentRun, keyframes: keyframes?.infos ?? [] },
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
        if (m.kind === 'surface') setSurface({ status: 'ready', surface: { mesh: m.surface, keyframes: keyframes?.images ?? null } })
        else setTimeline({ status: 'ready', timeline: { ...m.timeline, grid: m.grid, skip: m.skip } })
      }
      worker.onerror = (e) => fail(e.message || 'the surface worker failed')
      const transfer: Transferable[] = [scanRun.depth, scanRun.confidence, job.points.buffer, job.colors.buffer, ...(keyframes?.infos ?? []).map((k) => k.small)]
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
