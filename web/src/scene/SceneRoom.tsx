// The room and the people replay of one capture, as R3F children for any canvas (the capture
// viewer, the museum's Memory Window). Data comes from useCaptureScene.
import { useThree } from '@react-three/fiber'
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type RefObject } from 'react'
import type { Async } from './assetCache'
import { DepthReplay } from './DepthReplay'
import { HoleFill } from './HoleFill'
import { RoomPoints } from './RoomPoints'
import { RoomSurfaceMesh } from './RoomSurfaceMesh'
import type { SelectionTint } from './selectionTint'
import type { SplatStatus } from './SplatRoom'
import type { CaptureScene, SceneNote } from './useCaptureScene'

// Spark is big; only captures with a splat load it.
const SplatRoom = lazy(() => import('./SplatRoom'))

export type RoomView = 'auto' | 'surface' | 'points' | 'dots' | 'splat'

/** Dots view: each dot this fraction of the size that would close the gaps to its neighbors. */
const DOT_FILL = 0.4

const ready = <T,>(a: Async<T> | null): T | null => (a?.status === 'ready' ? a.data : null)

/** What a room view resolves to with what's loaded now. */
export function shownRoom(scene: CaptureScene, view: RoomView, splatStatus: SplatStatus): 'surface' | 'points' | 'dots' | 'splat' | null {
  if (view === 'dots') return ready(scene.points) ? 'dots' : null
  const splatUsable = Boolean(scene.splat) && splatStatus.state !== 'failed'
  const want = view === 'auto' ? (splatUsable ? 'splat' : 'surface') : view
  if (want === 'splat' && splatUsable && splatStatus.state === 'ready') return 'splat'
  // Until the splat has loaded, the surface (or the points) stand in for it.
  if (want !== 'points' && ready(scene.surface)) return 'surface'
  if (ready(scene.points)) return 'points'
  return null
}

interface RoomProps {
  scene: CaptureScene
  view?: RoomView
  /** Brightness multiplier, e.g. to let the replay stand out. */
  dim?: number
  selection?: SelectionTint | null
  /** Most room points to draw (see RoomPoints); a small view can ask for fewer. */
  budget?: number
  /** Screen-space hole filling over the points (it takes over rendering for the whole canvas). */
  holeFill?: boolean
  onSplatStatus?: (status: SplatStatus) => void
  /** Live problems to show next to the view (the room's photos failing). */
  onNote?: SceneNote
}

/**
 * The room: the fused surface, the points (with hole filling), or the splat. Everything loaded
 * stays mounted and switching only toggles visibility, so nothing is uploaded twice.
 */
export function SceneRoom({ scene, view = 'auto', dim = 1, selection = null, budget, holeFill = true, onSplatStatus, onNote }: RoomProps) {
  const invalidate = useThree((s) => s.invalidate)
  const [splatWanted, setSplatWanted] = useState(view === 'auto' || view === 'splat')
  useEffect(() => {
    if (view === 'auto' || view === 'splat') setSplatWanted(true)
  }, [view])
  const [splatStatus, setSplatStatus] = useState<SplatStatus>({ state: 'loading' })
  const onStatus = useCallback(
    (s: SplatStatus) => {
      setSplatStatus(s)
      onSplatStatus?.(s)
    },
    [onSplatStatus],
  )
  const surface = ready(scene.surface)
  const points = ready(scene.points)
  const shown = shownRoom(scene, view, splatStatus)
  const keyframeUrls = useMemo(() => {
    if (!surface || surface.keyframes.length === 0) return null
    const urls = surface.keyframes.map((k) => scene.assets.rawUrl(k.file))
    return urls.every((u): u is string => u !== null) ? urls : null
  }, [surface, scene.assets])
  useEffect(() => invalidate(), [shown, invalidate])

  return (
    <>
      {holeFill && shown === 'points' && <HoleFill />}
      {surface && <RoomSurfaceMesh surface={surface} keyframeUrls={keyframeUrls} selection={selection} dim={dim} visible={shown === 'surface'} onNote={onNote} />}
      {points && (
        <RoomPoints points={points} budget={budget} dim={dim} visible={shown === 'points' || shown === 'dots'} dots={shown === 'dots' ? DOT_FILL : undefined} />
      )}
      {splatWanted && scene.splat && splatStatus.state !== 'failed' && (
        <Suspense fallback={null}>
          <SplatRoom url={scene.splat.url} format={scene.splat.format} visible={shown === 'splat'} dim={selection ? 0.45 * dim : dim} onStatus={onStatus} />
        </Suspense>
      )}
    </>
  )
}

interface ReplayProps {
  scene: CaptureScene
  video: HTMLVideoElement
  timeRef: RefObject<number>
  /**
   * Replay only what the room doesn't explain (the right thing over the fused surface); false
   * replays whole frames (over points or a splat, which the mask was not made for).
   */
  masked?: boolean
  selection?: SelectionTint | null
  show?: boolean
  /** Live problems to show next to the view (depth frames that didn't load). */
  onNote?: SceneNote
}

/** The people replay (DepthReplay) for a capture; renders nothing when it has no depth. */
export function SceneReplay({ scene, video, timeRef, masked = true, selection = null, show = true, onNote }: ReplayProps) {
  if (!scene.canReplay || !scene.depth) return null
  const t = scene.timeline
  const timeline = !masked || !t || t.status === 'failed' ? null : t.status === 'loading' ? 'loading' : t.data
  const { manifest } = scene
  return (
    <DepthReplay
      depth={scene.depth}
      frames={scene.moment}
      videoW={manifest.video.width}
      videoH={manifest.video.height}
      rateHz={manifest.depth.rateHz}
      video={video}
      timeRef={timeRef}
      timeline={timeline}
      selection={selection}
      show={show}
      onNote={onNote}
    />
  )
}
