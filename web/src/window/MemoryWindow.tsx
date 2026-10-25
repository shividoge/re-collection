import { Canvas } from '@react-three/fiber'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CaptureAssets } from '../data/assets'
import type { NavMode } from '../scene/SceneViewer'
import { trimStop } from '../scene/depthSource'
import type { SplatStatus } from '../scene/SplatRoom'
// TEMPORARY: the real exports come from '../data' and '../scene' once they land.
import { useCaptureAssets } from '../data'
import { PlaybackDriver, SceneReplay, SceneRoom, useCaptureScene, usePlayback, usePlaybackState, useSceneNotes, type CaptureScene } from '../scene'
import { WithYou } from '../museum/Together'
import { useMuseumRoom, type MuseumRoom } from '../museum/useMuseumRoom'
import { EstimatedBadge } from '../views/EstimatedBadge'
import { VisitDock } from '../views/VisitDock'
import { useHeadTracker } from './useHeadTracker'
import { WindowCamera } from './WindowCamera'
import './window.css'

const IDLE_MS = 4000
const canTilt = typeof window !== 'undefined' && 'DeviceOrientationEvent' in window && navigator.maxTouchPoints > 0

/**
 * The Memory Window: the screen they already own (a TV, a laptop, an iPad) becomes a window
 * into the moment. The front camera follows the viewer's head, so leaning or shifting in the
 * chair looks around the room like a real window, with depth and no headset. The narrated
 * visit (VisitDock) runs inside it unchanged, so everything said is still grounded.
 */
export function MemoryWindow({ id, from }: { id: string; from?: string }) {
  // Visit together: opened from the museum, the window stays in the iPad's room, so the helper
  // pressing "Back to the museum" (or stepping into another moment) on their phone moves it too.
  const room = useMuseumRoom('patient', { enabled: from === 'museum' })
  const state = useCaptureAssets(id)
  const back = from === 'museum' ? '#/museum' : `#/capture/${id}`

  if (state.status === 'error') return <div className="window-message">{state.message}</div>
  if (state.status === 'missing') return <div className="window-message">This visit isn’t here any more.</div>
  if (state.status === 'loading') return <div className="window-message">Opening the window…</div>
  return <WindowScene assets={state.assets} back={back} room={room} />
}

function WindowScene({ assets, back, room }: { assets: CaptureAssets; back: string; room: MuseumRoom }) {
  const state = useCaptureScene(assets)
  if (state.status === 'ready') return <WindowStage scene={state.scene} back={back} room={room} />
  if (state.status === 'error') return <div className="window-message">{state.message}</div>
  if (state.status === 'loading') return <div className="window-message">Bringing the room in…</div>
  // Still being baked into a scene by the pipeline.
  return <div className="window-message">This visit is still being prepared…</div>
}

/** Drag distance, as a fraction of the screen's shorter side, for a full head movement. */
const DRAG_RANGE = 0.35
const DRAG_HOLD_MS = 8000

function WindowStage({ scene, back, room }: { scene: CaptureScene; back: string; room: MuseumRoom }) {
  const { manifest, moment: frames } = scene
  const tracker = useHeadTracker()
  // What didn't load (the splat, the room's photos, the people for a stretch), said plainly.
  const [notes, onNote] = useSceneNotes()
  const onSplatStatus = useCallback(
    (s: SplatStatus) => onNote('splat', s.state === 'failed' ? `The splat didn't load (${trimStop(s.message)}), so the room is drawn from its points.` : null),
    [onNote],
  )

  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null)
  const [videoError, setVideoError] = useState(false)
  const [speed, setSpeed] = useState(1)
  const video = scene.videoUrl && !videoError ? videoEl : null
  const duration = manifest.video?.durationSec ?? (frames.length ? frames[frames.length - 1].t : 0)
  const playback = usePlayback(video, duration, speed)
  const { playing } = usePlaybackState(playback)
  const canReplayPeople = scene.canReplay && Boolean(video)
  // The people layer is colored from the video and sits right in front of the window, so until
  // the video has played it would cover the room in black. Show it once the visit has started.
  const [started, setStarted] = useState(false)
  if (playing && !started) setStarted(true)

  // Controls fade away so only the window is left; any movement or tap brings them back.
  const [idle, setIdle] = useState(false)
  useEffect(() => {
    let timer = window.setTimeout(() => setIdle(true), IDLE_MS)
    const wake = () => {
      setIdle(false)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setIdle(true), IDLE_MS)
    }
    window.addEventListener('pointermove', wake)
    window.addEventListener('pointerdown', wake)
    window.addEventListener('keydown', wake)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('pointermove', wake)
      window.removeEventListener('pointerdown', wake)
      window.removeEventListener('keydown', wake)
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      if (e.code === 'Space' && duration > 0) {
        e.preventDefault()
        playback.toggle()
      }
      if (e.code === 'KeyC') tracker.recenter()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [duration, playback, tracker])

  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void document.documentElement.requestFullscreen?.().catch(() => undefined)
  }

  const tracking = tracker.status.kind === 'tracking'

  // Touch or mouse: dragging moves your eye behind the window, the same as moving your head.
  // Works everywhere (camera head tracking and tilt need https on iPad). After a while with no
  // touch, the gentle ambient drift takes over again.
  const dragHead = useRef({ x: 0, y: 0, z: 0 })
  const drag = useRef<{ x: number; y: number; head: { x: number; y: number } } | null>(null)
  const [dragging, setDragging] = useState(false)
  const lastDrag = useRef(0)
  useEffect(() => {
    if (!dragging) return
    const timer = window.setInterval(() => {
      if (!drag.current && Date.now() - lastDrag.current > DRAG_HOLD_MS) setDragging(false)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [dragging])
  const onPointerDown = (e: React.PointerEvent) => {
    if (tracking) return
    drag.current = { x: e.clientX, y: e.clientY, head: { x: dragHead.current.x, y: dragHead.current.y } }
    lastDrag.current = Date.now()
    setDragging(true)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const range = Math.min(window.innerWidth, window.innerHeight) * DRAG_RANGE
    const clamp = (v: number) => Math.max(-1, Math.min(1, v))
    // Dragging the room to the left is like stepping to the right.
    dragHead.current = { x: clamp(d.head.x - (e.clientX - d.x) / range), y: clamp(d.head.y + (e.clientY - d.y) / range), z: 0 }
    lastDrag.current = Date.now()
  }
  const onPointerUp = () => {
    drag.current = null
    lastDrag.current = Date.now()
  }
  const controls = {
    selection: null,
    playback,
    duration,
    mode: 'follow' as NavMode,
    switchMode: () => {},
    setSpeed,
    canFollow: frames.length > 0,
    video,
  }

  return (
    <div className={`window${idle ? ' idle' : ''}`}>
      <Canvas
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerUp}
        flat dpr={[1, 2]} camera={{ near: 0.02, far: 60 }} gl={{ antialias: true }} className="window-canvas">
        <color attach="background" args={['#07080a']} />
        <PlaybackDriver playback={playback} />
        <SceneRoom scene={scene} dim={canReplayPeople && playing ? 0.6 : 1} onSplatStatus={onSplatStatus} onNote={onNote} />
        {canReplayPeople && started && video && <SceneReplay scene={scene} video={video} timeRef={playback.timeRef} onNote={onNote} />}
        <WindowCamera
          frames={frames}
          timeRef={playback.timeRef}
          head={tracking ? tracker.head : dragHead}
          ambient={!tracking && !dragging}
          videoW={manifest.video?.width ?? 1920}
          videoH={manifest.video?.height ?? 1440}
        />
      </Canvas>

      {/* The video plays for sound and to color the people; the window shows it in 3D instead. */}
      {/* Only the duration loads until they press play; playing then fetches the rest. */}
      {scene.videoUrl && (
        <video
          ref={setVideoEl}
          className="window-video"
          src={scene.videoUrl}
          crossOrigin="anonymous"
          playsInline
          preload="metadata"
          onError={() => setVideoError(true)}
        />
      )}

      <header className="window-top">
        {/* Tell the helper's phone too (the link then goes back as usual). */}
        <a href={back} className="window-exit" onClick={room.leave}>
          {back === '#/museum' ? '← Back to the museum' : '← Back'}
        </a>
        <div className="window-title">
          {scene.label} <EstimatedBadge manifest={manifest} />
        </div>
        <div className="window-actions">
          <WithYou room={room} />
          <HeadButton tracker={tracker} />
          {canTilt && !tracking && (
            <button onClick={() => void tracker.startTilt()} title="Look around by tilting the tablet">
              Tilt to look
            </button>
          )}
          {tracking && (
            <button onClick={tracker.recenter} title="Make where you sit now the center (C)">
              Center
            </button>
          )}
          <button onClick={fullscreen} title="Fill the screen">
            Full screen
          </button>
        </div>
      </header>

      <TrackerHint status={tracker.status} />
      {notes.length > 0 && (
        <div className="window-notes" role="status">
          {notes.map((n) => (
            <div key={n}>{n}</div>
          ))}
        </div>
      )}

      <div className="window-dock">
        <VisitDock captureId={scene.id} controls={controls} />
        {duration > 0 && (
          <button className="window-play" onClick={playback.toggle}>
            {playing ? 'Pause' : 'Play the visit'}
          </button>
        )}
      </div>
    </div>
  )
}

function HeadButton({ tracker }: { tracker: ReturnType<typeof useHeadTracker> }) {
  const { status } = tracker
  if (status.kind === 'starting') return <button disabled>Starting the camera…</button>
  if (status.kind === 'tracking' && status.source === 'camera') {
    return (
      <button className="on" onClick={tracker.stop} title="Stop using the camera">
        Head tracking on
      </button>
    )
  }
  return (
    <button className="primary" onClick={() => void tracker.startCamera()} title="Use the front camera to follow your head. Nothing is recorded or sent anywhere.">
      Look with your head
    </button>
  )
}

function TrackerHint({ status }: { status: ReturnType<typeof useHeadTracker>['status'] }) {
  if (status.kind === 'error') return <div className="window-hint error">{status.message}</div>
  if (status.kind === 'tracking' && status.source === 'camera' && !status.faceVisible) {
    return <div className="window-hint">Sit facing the screen so the camera can see you.</div>
  }
  return null
}
