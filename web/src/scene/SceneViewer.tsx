import { OrbitControls } from '@react-three/drei'
import { Canvas } from '@react-three/fiber'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as THREE from 'three'
import { CameraPath, FollowCamera } from './CameraPath'
import { cloudBounds } from './cloudBounds'
import { DepthReplay } from './DepthReplay'
import { HoleFill } from './HoleFill'
import type { FrameRecord } from './formats'
import type { LoadedCapture } from './loadCapture'
import { CameraTween, FlyControls, PickHandler, PivotMarker, type CameraGoal, type NavMode } from './Navigation'
import { dominantQuarterTurns, type Vec3 } from './pose'
import { StaticCloud } from './StaticCloud'
import { usePlayback } from './usePlayback'
import { useSplatSizes } from './useSplatSizes'
import { useVirtualCursor } from './useVirtualCursor'
import { selectAlongRay, useRoomIndex, type Selection } from './useRoomIndex'
import './viewer.css'

const NO_FRAMES: FrameRecord[] = []
const ACCENT = '#ff5c3a'
const IS_WINDOWS = typeof navigator !== 'undefined' && /win/i.test(navigator.platform)

export type { NavMode }

/** What an overlay (the visit dock) can see and drive in the viewer. */
export interface ViewerControls {
  selection: Selection | null
  playback: ReturnType<typeof usePlayback>
  duration: number
  mode: NavMode
  switchMode: (next: NavMode) => void
  /** Playback speed, e.g. 0.75 for the narrated tour. */
  setSpeed: (speed: number) => void
  /** True when the capture has camera poses to follow. */
  canFollow: boolean
  video: HTMLVideoElement | null
}

interface Props {
  capture: LoadedCapture
  initialMode?: NavMode
  /** Playback speed. */
  rate?: number
  showVideo?: boolean
  /** Turn off flying and selection. */
  interactive?: boolean
  /** Seconds into the visit to start at, e.g. when opened from a fact's evidence. */
  startAt?: number
  /** Drawn over the 3D view, with access to playback, the view mode and the selection. */
  overlay?: (controls: ViewerControls) => ReactNode
}

const HELP: Record<NavMode, string> = {
  orbit: 'Drag to view the pivot from any angle · scroll to get closer · right-drag to pan · click something to orbit it · Esc back to room center · V video',
  fly: 'Drag rotates the room around you · hold WASD to fly and steer with the mouse, no click needed · E up · Q/C down · Shift faster · Alt slower · click to select · V video',
  follow: 'Following the recording camera · click to select · V video',
}

/**
 * The shared scene viewer (CLAUDE.md 8.2): the scanned room as a point cloud you can orbit,
 * fly through, the recorder's path, object selection, and the recorded video in a
 * synced panel. Areas without data stay empty.
 */
export function SceneViewer({ capture, initialMode = 'orbit', rate = 1, showVideo = true, interactive = true, startAt, overlay }: Props) {
  const { cloud, frames, manifest } = capture
  const moment = frames?.moment ?? NO_FRAMES
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null)
  const attachVideo = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el
    setVideoEl(el)
  }, [])
  const [showPath, setShowPath] = useState(true)
  // The video plays all the time (sound, people replay); this only hides or shows its panel.
  const [videoOpen, setVideoOpen] = useState(false)
  const cameraRef = useRef<THREE.Camera | null>(null)
  const [mode, setMode] = useState<NavMode>(initialMode)
  const [orbitTarget, setOrbitTarget] = useState<Vec3 | null>(null)
  const [videoError, setVideoError] = useState<string | null>(null)
  const [videoDuration, setVideoDuration] = useState<number | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [pickMiss, setPickMiss] = useState(false)
  const [goal, setGoal] = useState<CameraGoal | null>(null)
  const goalActive = useRef(false)
  const [steering, setSteering] = useState(false)
  const canvasBoxRef = useRef<HTMLDivElement>(null)
  const virtualCursor = useVirtualCursor(interactive && mode === 'fly')
  const wasSteering = useRef(false)
  const { placeAt: placeCursor, stop: stopCursor } = virtualCursor
  useEffect(() => {
    // Letting go of WASD brings the pointer back at the crosshair, where your aim was.
    if (steering) stopCursor()
    else if (wasSteering.current && canvasBoxRef.current) {
      const r = canvasBoxRef.current.getBoundingClientRect()
      placeCursor(r.left + r.width / 2, r.top + r.height / 2)
    }
    wasSteering.current = steering
  }, [steering, placeCursor, stopCursor])

  const hasVideo = Boolean(capture.videoUrl) && !videoError
  const duration = videoDuration ?? manifest?.video?.durationSec ?? (moment.length ? moment[moment.length - 1].t : 0)
  const [speed, setSpeed] = useState(rate)
  const playback = usePlayback(videoRef, hasVideo, duration, speed)

  const videoW = manifest?.video?.width ?? 1920
  const videoH = manifest?.video?.height ?? 1440
  const turns = useMemo(() => (moment.length ? dominantQuarterTurns(moment) : 0), [moment])
  // Stored frames are sensor-landscape; turn them upright the same way the camera path does.
  const videoTurns = turns
  const canReplayPeople = Boolean(capture.id && manifest && manifest.depth?.count > 0 && moment.length > 0 && videoEl && hasVideo)
  // Jump to `startAt` once, as soon as the video knows its length.
  const startedAt = useRef(false)
  useEffect(() => {
    if (startAt === undefined || startedAt.current || videoDuration === null) return
    startedAt.current = true
    playback.seek(startAt)
  }, [startAt, videoDuration, playback])
  const bounds = useMemo(() => (cloud ? cloudBounds(cloud) : null), [cloud])
  const canFollow = moment.length > 0
  const indexState = useRoomIndex(interactive ? cloud : null)
  const sizes = useSplatSizes(cloud)
  const selectionSizes = useMemo(() => (sizes && selection ? Float32Array.from(selection.points, (i) => sizes[i]) : null), [sizes, selection])
  const room = indexState.status === 'ready' ? indexState.room : null

  const startCam = bounds
    ? ([bounds.center.x + bounds.radius * 0.6, bounds.center.y + bounds.radius * 1.3, bounds.center.z + bounds.radius * 1.0] as const)
    : ([2, 2, 3] as const)

  /** Turn the camera in place to face `p`; in orbit mode `p` becomes the fixed pivot. */
  const faceTowards = useCallback((p: Vec3) => {
    const cam = cameraRef.current
    if (!cam) return
    setGoal({ position: [cam.position.x, cam.position.y, cam.position.z], lookAt: p })
  }, [])

  const roomCenter = useMemo<Vec3>(() => (bounds ? [bounds.center.x, bounds.center.y, bounds.center.z] : [0, 0, 0]), [bounds])

  const switchMode = (next: NavMode) => {
    const cam = cameraRef.current
    if (next === 'orbit' && cam) {
      // Orbit the selection, or the room center when nothing is selected. Mount the controls
      // on the point straight ahead, then turn smoothly to the pivot so the view never jumps.
      const pivot = selection ? pivotOf(selection) : roomCenter
      const fwd = cam.getWorldDirection(new THREE.Vector3())
      const ahead = cam.position.clone().addScaledVector(fwd, Math.max(0.3, cam.position.distanceTo(new THREE.Vector3(...pivot))))
      setOrbitTarget([ahead.x, ahead.y, ahead.z])
      faceTowards(pivot)
    }
    setMode(next)
  }

  const clearSelection = useCallback(() => {
    setSelection(null)
    if (mode === 'orbit') faceTowards(roomCenter)
  }, [mode, faceTowards, roomCenter])

  const onPick = useCallback(
    (origin: Vec3, dir: Vec3) => {
      if (!room || !cloud) return
      const sel = selectAlongRay(room, cloud, moment, videoW, videoH, origin, dir)
      setSelection(sel)
      setPickMiss(!sel)
      // In orbit, whatever you click becomes the point you circle around.
      if (sel && mode === 'orbit') faceTowards(pivotOf(sel))
    },
    [room, cloud, moment, videoW, videoH, mode, faceTowards],
  )

  const goToSelection = useCallback(() => {
    const cam = cameraRef.current
    if (!selection || !cam) return
    const c = new THREE.Vector3(...selection.bounds.center)
    const s = selection.bounds.size
    const reach = Math.max(0.35, Math.hypot(s[0], s[1], s[2]) * 0.8 + 0.25)
    const away = cam.position.clone().sub(c).setY(0)
    if (away.lengthSq() < 1e-6) away.set(0, 0, 1)
    away.normalize()
    const pos = c.clone().addScaledVector(away, reach)
    pos.y = c.y + reach * 0.5
    if (mode === 'follow') setMode('fly')
    setGoal({ position: [pos.x, pos.y, pos.z], lookAt: [c.x, c.y, c.z] })
  }, [selection, mode])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      if (e.code === 'Escape') clearSelection()
      if (e.code === 'KeyF') goToSelection()
      if (e.code === 'KeyV' && showVideo) setVideoOpen((o) => !o)
      if (e.code === 'Space' && duration > 0) {
        e.preventDefault()
        if (playback.playing) playback.pause()
        else playback.play()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goToSelection, clearSelection, duration, playback, showVideo])

  // Only read when OrbitControls mounts; afterwards the pivot moves through CameraTween.
  const orbitAt = orbitTarget ?? roomCenter

  return (
    <div className="viewer">
      <div className="viewer-stage">
        <div className="viewer-canvas" ref={canvasBoxRef}>
          {cloud ? (
            <Canvas
              flat
              dpr={[1, 2]}
              camera={{ position: [...startCam], fov: 60, near: 0.005, far: 200 }}
              gl={{ antialias: true }}
              onCreated={(s) => {
                cameraRef.current = s.camera
                // Dev-only handle for inspecting the camera from the browser console.
                if (import.meta.env.DEV) Object.assign(window, { __bdCamera: s.camera, __bdState: s.get })
              }}
            >
              <color attach="background" args={['#07080a']} />
              <HoleFill />
              <StaticCloud cloud={cloud} sizes={sizes} dim={selection ? 0.45 : canReplayPeople && playback.playing ? 0.55 : 1} />
              {selection && (
                <>
                  <StaticCloud cloud={selection.cloud} sizes={selectionSizes} pointSize={1.2} tint={ACCENT} tintMix={0.35} renderOrder={1} />
                  <SelectionBox selection={selection} />
                </>
              )}
              {canFollow && showPath && <CameraPath frames={moment} timeRef={playback.timeRef} />}
              {canReplayPeople && capture.id && manifest && videoEl && (
                <DepthReplay captureId={capture.id} manifest={manifest} frames={moment} video={videoEl} timeRef={playback.timeRef} />
              )}
              {mode === 'follow' && canFollow && <FollowCamera frames={moment} timeRef={playback.timeRef} videoW={videoW} videoH={videoH} />}
              {mode === 'orbit' && (
                <>
                  <OrbitControls makeDefault target={orbitAt} enableDamping minDistance={0.02} maxDistance={60} />
                  <PivotMarker />
                </>
              )}
              {mode === 'fly' && <FlyControls goalActive={goalActive} onSteeringChange={setSteering} />}
              {interactive && <PickHandler onPick={onPick} />}
              <CameraTween goal={goal} active={goalActive} onDone={() => setGoal(null)} />
            </Canvas>
          ) : (
            <div className="viewer-empty">No room cloud to show. {capture.errors.find((e) => e.startsWith('room.bin')) ?? ''}</div>
          )}

          <div className="viewer-modes">
            <ModeButton on={mode === 'orbit'} onClick={() => switchMode('orbit')} label="Orbit" />
            {interactive && (
              <ModeButton on={mode === 'fly'} onClick={() => switchMode('fly')} label="Fly" title="Drone: move freely in 3D" />
            )}
            <ModeButton on={mode === 'follow'} onClick={() => switchMode('follow')} label="Camera view" disabled={!canFollow} title={canFollow ? 'Follow the recording camera' : 'No camera poses in this capture'} />
          </div>

          {mode === 'fly' && steering && <div className="viewer-crosshair" />}

          {overlay?.({ selection, playback, duration, mode, switchMode, setSpeed, canFollow, video: videoEl })}

          {interactive && selection && <SelectionPanel selection={selection} onGoTo={goToSelection} onClear={clearSelection} onSeek={playback.seek} />}

          {showVideo && (
            <div className={`viewer-video-float${videoOpen ? ' open' : ''}`} aria-hidden={!videoOpen}>
              <div className="viewer-video">
                {capture.videoUrl && !videoError ? (
                  <VideoPanel
                    src={capture.videoUrl}
                    videoRef={attachVideo}
                    quarterTurns={videoTurns}
                    videoW={videoW}
                    videoH={videoH}
                    onError={setVideoError}
                    onDuration={setVideoDuration}
                  />
                ) : (
                  <div className="viewer-empty">{videoError ?? 'No video in this capture.'}</div>
                )}
              </div>
            </div>
          )}

          <div className="viewer-foot">
            {cloud && <span>{cloud.count.toLocaleString()} points</span>}
            {interactive && indexState.status === 'building' && <span>Indexing room for selection…</span>}
            {indexState.status === 'failed' && <span className="err">Selection unavailable: {indexState.message}</span>}
            {pickMiss && <span>Nothing scanned there</span>}
            {interactive && (
              <span className="help">{HELP[mode]}</span>
            )}
          </div>
        </div>

      </div>

      {/* Drawn in the system pointer's style: Windows white, macOS and Linux black. */}
      <div ref={virtualCursor.ref} className={`virtual-cursor${IS_WINDOWS ? ' win' : ''}`} aria-hidden />

      <div className="viewer-timeline">
        <button className="play" onClick={playback.playing ? playback.pause : playback.play} disabled={duration <= 0}>
          {playback.playing ? 'Pause' : 'Play'}
        </button>
        <div className="track">
          {selection &&
            duration > 0 &&
            selection.seen.map((iv) => (
              <button
                key={iv.tStart}
                className="seen"
                style={{ left: `${(iv.tStart / duration) * 100}%`, width: `max(3px, ${((iv.tEnd - iv.tStart) / duration) * 100}%)` }}
                title={`On camera ${fmt(iv.tStart)}–${fmt(iv.tEnd)}`}
                onClick={() => playback.seek(iv.tStart)}
              />
            ))}
          <input type="range" min={0} max={duration || 0} step={0.01} value={Math.min(playback.time, duration)} onChange={(e) => playback.seek(Number(e.target.value))} disabled={duration <= 0} />
        </div>
        <span className="time">
          {fmt(playback.time)} / {fmt(duration)}
        </span>
        <div className="layers">
          <Layer label="Path" on={showPath} disabled={!canFollow} set={setShowPath} />
        </div>
        {showVideo && (
          <button className={`video-toggle${videoOpen ? ' on' : ''}`} onClick={() => setVideoOpen((o) => !o)} title="Show or hide the video (V)">
            {videoOpen ? 'Hide video' : 'Video'}
          </button>
        )}
      </div>
    </div>
  )
}

/** Objects pivot on their center; floor and wall patches on the clicked spot. */
function pivotOf(sel: Selection): Vec3 {
  return sel.kind === 'object' ? sel.bounds.center : sel.hit
}

function Layer({ label, on, set, disabled }: { label: string; on: boolean; set: (on: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`layer${disabled ? ' disabled' : ''}`}>
      <input type="checkbox" checked={on && !disabled} disabled={disabled} onChange={(e) => set(e.target.checked)} />
      {label}
    </label>
  )
}

function ModeButton({ on, onClick, label, disabled, title }: { on: boolean; onClick: () => void; label: string; disabled?: boolean; title?: string }) {
  return (
    <button className={on ? 'on' : ''} onClick={onClick} disabled={disabled} title={title}>
      {label}
    </button>
  )
}

function SelectionBox({ selection }: { selection: Selection }) {
  const geo = useMemo(() => {
    const s = selection.bounds.size
    return new THREE.EdgesGeometry(new THREE.BoxGeometry(Math.max(s[0], 0.01), Math.max(s[1], 0.01), Math.max(s[2], 0.01)))
  }, [selection])
  useEffect(() => () => geo.dispose(), [geo])
  return (
    <lineSegments geometry={geo} position={selection.bounds.center}>
      <lineBasicMaterial color={ACCENT} transparent opacity={0.7} />
    </lineSegments>
  )
}

const KIND_LABEL: Record<Selection['kind'], string> = { object: 'Object', floor: 'Floor patch', wall: 'Wall patch', ceiling: 'Ceiling patch' }

function SelectionPanel({ selection, onGoTo, onClear, onSeek }: { selection: Selection; onGoTo: () => void; onClear: () => void; onSeek: (t: number) => void }) {
  const [w, h, d] = selection.bounds.size
  const totalSeen = selection.seen.reduce((a, iv) => a + (iv.tEnd - iv.tStart), 0)
  return (
    <div className="viewer-selection">
      <div className="sel-head">
        <strong>{KIND_LABEL[selection.kind]}</strong>
        <button onClick={onClear} title="Clear selection (Esc)">
          ×
        </button>
      </div>
      <div className="sel-row">
        {w.toFixed(2)} × {h.toFixed(2)} × {d.toFixed(2)} m
      </div>
      <div className="sel-row muted">
        {selection.pointCount.toLocaleString()} points{selection.truncated ? ' · may continue past the selection' : ''}
      </div>
      <div className="sel-sub">On camera during the visit</div>
      {selection.seen.length === 0 ? (
        <div className="sel-row muted">Never in view of the recording camera.</div>
      ) : (
        <>
          <div className="sel-row muted">
            {fmt(totalSeen)} total, {selection.seen.length} {selection.seen.length === 1 ? 'stretch' : 'stretches'}
          </div>
          <div className="sel-seen">
            {selection.seen.slice(0, 8).map((iv) => (
              <button key={iv.tStart} onClick={() => onSeek(iv.tStart)}>
                {fmt(iv.tStart)}–{fmt(iv.tEnd)}
              </button>
            ))}
          </div>
        </>
      )}
      <button className="sel-go" onClick={onGoTo}>
        Go to it (F)
      </button>
    </div>
  )
}

function VideoPanel({
  src,
  videoRef,
  quarterTurns,
  videoW,
  videoH,
  onError,
  onDuration,
}: {
  src: string
  videoRef: (el: HTMLVideoElement | null) => void
  quarterTurns: number
  videoW: number
  videoH: number
  onError: (msg: string) => void
  onDuration: (d: number) => void
}) {
  // The stored frame may be sensor-landscape. Rotate it upright with the same quarter
  // turns the camera path uses; for odd turns the box is portrait.
  const odd = quarterTurns % 2 === 1
  const boxAspect = odd ? `${videoH} / ${videoW}` : `${videoW} / ${videoH}`
  return (
    <div className="video-box" style={{ aspectRatio: boxAspect }}>
      <video
        ref={videoRef}
        src={src}
        crossOrigin="anonymous"
        playsInline
        preload="auto"
        style={{
          width: odd ? `${(100 * videoW) / videoH}%` : '100%',
          transform: `translate(-50%, -50%) rotate(${quarterTurns * 90}deg)`,
        }}
        onLoadedMetadata={(e) => onDuration(e.currentTarget.duration)}
        onError={(e) => {
          const err = e.currentTarget.error
          onError(`This browser can't play the video (${err?.message || `code ${err?.code ?? '?'}`}). Older captures are HEVC (video.mov): try Safari.`)
        }}
      />
    </div>
  )
}

function fmt(t: number): string {
  if (!Number.isFinite(t)) return '0:00.0'
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}
