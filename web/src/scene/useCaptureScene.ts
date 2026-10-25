// Everything a 3D view needs from one capture, read only from the baked files (plus the video,
// keyframes and frames.jsonl). docs/architecture-v3.md §4. Nothing is rebuilt in the browser;
// while the bake isn't done the state says so, and the view shows the capture's status instead.
import { useCallback, useMemo, useState } from 'react'
import { parseDepthIndex, type DepthIndex } from '../../../shared/depth'
import type { RoomSplat } from '../../../shared/manifest'
import { fetchBytes, fetchText } from '../data'
import type { CaptureAssets, CaptureStatus, Manifest } from '../data/assets'
import { isEstimated } from '../views/EstimatedBadge'
import { useAsync, type Async } from './assetCache'
import { parseFramesJsonl, type FrameLog, type FrameRecord } from './formats'
import { boxBounds, gridBox, pathBox, readPoints, readSurface, readTimeline, type PointsData, type SceneBounds, type SurfaceData, type TimelineData } from './packs'

export type { Async }

export interface SplatInfo extends RoomSplat {
  url: string
}

export interface DepthSourceInfo {
  url: string
  index: DepthIndex
}

export interface CaptureScene {
  assets: CaptureAssets
  id: string
  label: string
  manifest: Manifest
  /** Rebuilt from an ordinary video: estimated, not measured. */
  estimated: boolean
  frames: FrameLog
  /** The visit's frames (frames.jsonl's moment phase), in time order. */
  moment: FrameRecord[]
  videoUrl: string | null
  splat: SplatInfo | null
  /** Null when not requested (a splat capture until "Points" is chosen). */
  points: Async<PointsData> | null
  /** Null when the bake made none (no scan phase). */
  surface: Async<SurfaceData> | null
  timeline: Async<TimelineData> | null
  depth: DepthSourceInfo | null
  bounds: SceneBounds
  /** Depth, visit frames with depth and a video: the people can be replayed. */
  canReplay: boolean
  /** Problems and notes to show next to the view (a missing file, the phone's warnings). */
  notes: string[]
}

/**
 * How a part of the scene inside the canvas tells the view around it about a live problem
 * (`key`: which part; `note`: what to show, or null once it's resolved).
 */
export type SceneNote = (key: string, note: string | null) => void

/** The notes the scene's parts report, kept by key (pure, for tests). */
export function withNote(notes: Record<string, string>, key: string, note: string | null): Record<string, string> {
  if ((notes[key] ?? null) === note) return notes
  const next = { ...notes }
  if (note === null) delete next[key]
  else next[key] = note
  return next
}

/** The live notes for a view and the callback its scene parts report them through. */
export function useSceneNotes(): [string[], SceneNote] {
  const [notes, setNotes] = useState<Record<string, string>>({})
  const onNote = useCallback<SceneNote>((key, note) => setNotes((n) => withNote(n, key, note)), [])
  return [useMemo(() => Object.values(notes), [notes]), onNote]
}

export type CaptureSceneState =
  | { status: 'processing'; captureStatus: CaptureStatus | null }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; scene: CaptureScene }

const EMPTY_LOG: FrameLog = { scan: [], moment: [] }

/**
 * Loads a capture's baked files. `points: false` skips the room points (a splat capture shows its
 * splat; the points load when "Points" is chosen). Every viewer of the same capture shares the
 * loaded data.
 */
export function useCaptureScene(assets: CaptureAssets | null, opts: { points?: boolean } = {}): CaptureSceneState {
  const derived = assets?.derived ?? null
  const durl = (name: string | undefined) => (assets && name ? assets.derivedUrl(name) : null)
  const framesUrl = assets?.rawUrl('frames.jsonl') ?? null
  const pointsUrl = opts.points === false ? null : durl(derived?.files.points)
  const surfaceUrl = durl(derived?.files.surface)
  const timelineUrl = durl(derived?.files.timeline)
  const depthUrl = durl(derived?.files.depth)
  const indexUrl = durl(derived?.files.depthIndex)

  const frames = useAsync(derived ? framesUrl : null, async () => parseFramesJsonl(await fetchText(framesUrl!)))
  const depthIndex = useAsync(derived && depthUrl ? indexUrl : null, async () => parseDepthIndex(await fetchText(indexUrl!)))
  const points = useAsync(derived ? pointsUrl : null, async () => readPoints(await fetchBytes(pointsUrl!)))
  const surface = useAsync(derived ? surfaceUrl : null, async () => readSurface(await fetchBytes(surfaceUrl!)))
  const timeline = useAsync(derived ? timelineUrl : null, async () => readTimeline(await fetchBytes(timelineUrl!)))
  // One object per change of what was loaded, so views can depend on it.
  return useMemo(() => sceneState(assets, frames, depthIndex, points, surface, timeline), [assets, frames, depthIndex, points, surface, timeline])
}

function sceneState(
  assets: CaptureAssets | null,
  frames: Async<FrameLog> | null,
  depthIndex: Async<DepthIndex> | null,
  points: Async<PointsData> | null,
  surface: Async<SurfaceData> | null,
  timeline: Async<TimelineData> | null,
): CaptureSceneState {
  if (!assets) return { status: 'loading' }
  const { derived } = assets
  const framesUrl = assets.rawUrl('frames.jsonl')
  const depthUrl = derived?.files.depth ? assets.derivedUrl(derived.files.depth) : null
  const indexUrl = derived?.files.depthIndex ? assets.derivedUrl(derived.files.depthIndex) : null
  if (!derived) return { status: 'processing', captureStatus: assets.status }
  if (!derived.files.points) return { status: 'error', message: 'The bake registered no room points (points.pack).' }
  // Small files the rest depends on; the room's parts arrive one by one after.
  if (frames?.status === 'loading' || depthIndex?.status === 'loading') return { status: 'loading' }

  const { manifest } = assets
  const notes: string[] = []
  if (!framesUrl) notes.push('This capture has no frames.jsonl, so there is no camera path or replay.')
  if (frames?.status === 'failed') notes.push(`frames.jsonl: ${frames.message}`)
  if (depthIndex?.status === 'failed') notes.push(`depth.index.json: ${depthIndex.message}`)
  if (depthUrl && !indexUrl) notes.push('The bake registered depth.bin without its index, so the people replay is off.')
  const from = manifest.source === 'video' ? 'Note' : 'Warning from the phone'
  for (const w of manifest.warnings ?? []) notes.push(`${from}: ${w}`)

  const log = frames?.status === 'ready' ? frames.data : EMPTY_LOG
  const depth = depthUrl && depthIndex?.status === 'ready' ? { url: depthUrl, index: depthIndex.data } : null
  const videoUrl = manifest.video?.file ? assets.rawUrl(manifest.video.file) : null
  const splatMeta = manifest.room?.splat
  const splatUrl = splatMeta ? assets.rawUrl(splatMeta.file) : null
  if (splatMeta && !splatUrl) notes.push(`The manifest lists a splat (${splatMeta.file}) that isn't uploaded.`)

  return {
    status: 'ready',
    scene: {
      assets,
      id: assets.id,
      label: manifest.title || 'Untitled visit',
      manifest,
      estimated: isEstimated(manifest),
      frames: log,
      moment: log.moment,
      videoUrl,
      splat: splatMeta && splatUrl ? { ...splatMeta, url: splatUrl } : null,
      points,
      surface,
      timeline,
      depth,
      bounds: sceneBounds(points, surface, log.moment),
      canReplay: Boolean(depth && videoUrl && log.moment.some((f) => f.d !== null)),
      notes,
    },
  }
}

/** The room's extent: the points' box, else the surface grid's, else around the camera path. */
function sceneBounds(points: Async<PointsData> | null, surface: Async<SurfaceData> | null, moment: FrameRecord[]): SceneBounds {
  if (points?.status === 'ready') return boxBounds(points.data.min, points.data.max)
  if (surface?.status === 'ready') {
    const b = gridBox(surface.data.grid)
    return boxBounds(b.min, b.max)
  }
  const p = pathBox(moment.map((f) => f.T))
  return p ? boxBounds(p.min, p.max) : { center: [0, 0, 0], radius: 2 }
}
