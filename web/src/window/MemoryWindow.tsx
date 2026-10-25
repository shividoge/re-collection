import { Canvas } from '@react-three/fiber'
import { useEffect, useRef, useState } from 'react'
import { useCaptureAssets } from '../data'
import { PlaybackDriver, SceneReplay, SceneRoom, useCaptureScene, usePlayback, usePlaybackState, type CaptureScene, type NavMode } from '../scene'
import { WithYou } from '../museum/Together'
import { useMuseumRoom, type MuseumRoom } from '../museum/useMuseumRoom'
import { EstimatedBadge } from '../views/EstimatedBadge'
import { VisitDock } from '../views/VisitDock'
import { useHeadTracker } from './useHeadTracker'
import { WindowCamera } from './WindowCamera'
import './window.css'

const NO_FRAMES: never[] = []
const IDLE_MS = 4000
const canTilt = typeof window !== 'undefined' && 'DeviceOrientationEvent' in window && navigator.maxTouchPoints > 0

/**
 * The Memory Window: the screen they already own (a TV, a laptop, an iPad) becomes a window
 * into the moment. The front camera follows the viewer's head, so leaning or shifting in the
 * chair looks around the room like a real window, with depth and no headset. The narrated
 * visit (VisitDock) runs inside it unchanged, so everything said is still grounded.
 */
export function MemoryWindow({ id, from }: { id: string; from?: string }) {
  const assetsState = useCaptureAssets(id)
  const sceneState = useCaptureScene(assetsState.status === 'ready' ? assetsState.assets : null)
  const error = assetsState.status === 'error' ? assetsState.message : sceneState.status === 'error' ? sceneState.message : null
  // Visit together: opened from the museum, the window stays in the iPad's room, so the helper
  // pressing "Back to the museum" (or stepping into another moment) on their phone moves it too.
  const room = useMuseumRoom('patient', { enabled: from === 'museum' })

  if (error) {
    const locked = /Braindance-Key|401/.test(error)
    return (
      <div className="window-message">
        {locked ? (
          <span>
            This browser needs the team password first. <a href="#/">Unlock on the Captures page</a>, then come back.
          </span>
        ) : (
          error
        )}
      </div>
    )
  }
  if (sceneState.status === 'processing') return <div className="window-message">This visit's room is still being prepared.</div>
  if (sceneState.status !== 'ready') return <div className="window-message">Opening the window…</div>
  return <WindowStage id={id} scene={sceneState.scene} back={from === 'museum' ? '#/memories' : `#/capture/${id}`} room={room} />
}

/** Drag distance, as a fraction of the screen's shorter side, for a full head movement. */
const DRAG_RANGE = 0.35
const DRAG_HOLD_MS = 8000

function WindowStage({ id, scene, back, room }: { id: string; scene: CaptureScene; back: string; room: MuseumRoom }) {
  const { manifest } = scene
  const frames = scene.moment ?? NO_FRAMES
  const tracker = useHeadTracker()

  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null)
  const [videoError, setVideoError] = useState(false)
  const [speed, setSpeed] = useState(1)
  const hasVideo = Boolean(scene.videoUrl) && !videoError
  const duration = manifest?.video?.durationSec ?? (frames.length ? frames[frames.length - 1].t : 0)
  const playback = usePlayback(hasVideo ? videoEl : null, duration, speed)
  const { playing } = usePlaybackState(playback)
  const canReplayPeople = Boolean(scene.canReplay && videoEl && hasVideo)
  // The people layer is colored from the video and sits right in front of the window, so until
  // the video has played it would cover the room in black. Show it once the visit has started.
  const [started, setStarted] = useState(false)
  useEffect(() => {
    if (playing) setStarted(true)
  }, [playing])

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
    video: videoEl,
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
        <SceneRoom scene={scene} dim={canReplayPeople && playing ? 0.6 : 1} />
        {canReplayPeople && started && videoEl && <SceneReplay scene={scene} video={videoEl} timeRef={playback.timeRef} masked={scene.surface?.status === 'ready'} />}
        <WindowCamera
          frames={frames}
          timeRef={playback.timeRef}
          head={tracking ? tracker.head : dragHead}
          ambient={!tracking && !dragging}
          videoW={manifest?.video?.width ?? 1920}
          videoH={manifest?.video?.height ?? 1440}
        />
      </Canvas>

      {/* The video plays for sound and to color the people; the window shows it in 3D instead. */}
      {scene.videoUrl && (
        <video
          ref={setVideoEl}
          className="window-video"
          src={scene.videoUrl}
          crossOrigin="anonymous"
          playsInline
          preload="auto"
          onError={() => setVideoError(true)}
        />
      )}

      <header className="window-top">
        {/* Tell the helper's phone too (the link then goes back as usual). */}
        <a href={back} className="window-exit" onClick={room.leave}>
          {back === '#/memories' ? '← Back to the museum' : '← Back'}
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

      {scene.points?.status === 'loading' && scene.surface?.status !== 'ready' && <div className="window-loading">Bringing the room in…</div>}

      <TrackerHint status={tracker.status} />

      <div className="window-dock">
        <VisitDock captureId={id} controls={controls} />
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
