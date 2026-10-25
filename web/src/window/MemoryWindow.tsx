import { Canvas } from '@react-three/fiber'
import { useCallback, useEffect, useRef, useState } from 'react'
import { DepthReplay } from '../scene/DepthReplay'
import { HoleFill } from '../scene/HoleFill'
import { loadGuideCapture, type LoadedCapture } from '../scene/loadCapture'
import type { NavMode } from '../scene/SceneViewer'
import { StaticCloud } from '../scene/StaticCloud'
import { usePlayback } from '../scene/usePlayback'
import { useSplatSizes } from '../scene/useSplatSizes'
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
export function MemoryWindow({ id }: { id: string }) {
  const [capture, setCapture] = useState<LoadedCapture | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    loadGuideCapture(id)
      .then((c) => !cancelled && setCapture(c))
      .catch((e: Error) => !cancelled && setError(e.message))
    return () => {
      cancelled = true
    }
  }, [id])

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
  if (!capture) return <div className="window-message">Opening the window…</div>
  if (!capture.cloud) return <div className="window-message">This visit has no room scan to look into.</div>
  return <WindowStage id={id} capture={capture} />
}

function WindowStage({ id, capture }: { id: string; capture: LoadedCapture }) {
  const { cloud, manifest } = capture
  const frames = capture.frames?.moment ?? NO_FRAMES
  const sizes = useSplatSizes(cloud)
  const tracker = useHeadTracker()

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null)
  const attachVideo = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el
    setVideoEl(el)
  }, [])
  const [videoError, setVideoError] = useState(false)
  const [speed, setSpeed] = useState(1)
  const hasVideo = Boolean(capture.videoUrl) && !videoError
  const duration = manifest?.video?.durationSec ?? (frames.length ? frames[frames.length - 1].t : 0)
  const playback = usePlayback(videoRef, hasVideo, duration, speed)
  const canReplayPeople = Boolean(manifest && manifest.depth?.count > 0 && frames.length > 0 && videoEl && hasVideo)
  // The people layer is colored from the video and sits right in front of the window, so until
  // the video has played it would cover the room in black. Show it once the visit has started.
  const [started, setStarted] = useState(false)
  useEffect(() => {
    if (playback.playing) setStarted(true)
  }, [playback.playing])

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
        if (playback.playing) playback.pause()
        else playback.play()
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
      <Canvas flat dpr={[1, 2]} camera={{ near: 0.02, far: 60 }} gl={{ antialias: true }} className="window-canvas">
        <color attach="background" args={['#07080a']} />
        <HoleFill />
        <StaticCloud cloud={cloud!} sizes={sizes} dim={canReplayPeople && playback.playing ? 0.6 : 1} />
        {canReplayPeople && started && manifest && videoEl && (
          <DepthReplay captureId={id} manifest={manifest} frames={frames} video={videoEl} timeRef={playback.timeRef} />
        )}
        <WindowCamera
          frames={frames}
          timeRef={playback.timeRef}
          head={tracker.head}
          ambient={!tracking}
          videoW={manifest?.video?.width ?? 1920}
          videoH={manifest?.video?.height ?? 1440}
        />
      </Canvas>

      {/* The video plays for sound and to color the people; the window shows it in 3D instead. */}
      {capture.videoUrl && (
        <video
          ref={attachVideo}
          className="window-video"
          src={capture.videoUrl}
          crossOrigin="anonymous"
          playsInline
          preload="auto"
          onError={() => setVideoError(true)}
        />
      )}

      <header className="window-top">
        <a href={`#/capture/${id}`} className="window-exit">
          ← Back
        </a>
        <div className="window-title">{capture.label}</div>
        <div className="window-actions">
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

      {!sizes && <div className="window-loading">Bringing the room in…</div>}

      <TrackerHint status={tracker.status} />

      <div className="window-dock">
        <VisitDock captureId={id} controls={controls} />
        {duration > 0 && (
          <button className="window-play" onClick={playback.playing ? playback.pause : playback.play}>
            {playback.playing ? 'Pause' : 'Play the visit'}
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
