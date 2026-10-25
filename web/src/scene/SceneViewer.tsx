import { OrbitControls } from '@react-three/drei'
import { Canvas } from '@react-three/fiber'
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, type ReactNode } from 'react'
import * as THREE from 'three'
import type { CaptureAssets } from '../data/assets'
import { CameraPath, FollowCamera } from './CameraPath'
import { cloudBounds } from './cloudBounds'
import type { FrameRecord, PointCloud } from './formats'
import { HoleFill } from './HoleFill'
import { CameraTween, FlyControls, PickHandler, PivotMarker, type CameraGoal, type NavMode } from './Navigation'
import { PlaybackDriver, usePlayback, usePlaybackState, type Playback } from './playback'
import type { SceneBounds } from './packs'
import { dominantQuarterTurns, type Vec3 } from './pose'
import { ProcessingStatus } from './ProcessingStatus'
import { SceneReplay, SceneRoom, shownRoom, type RoomView } from './SceneRoom'
import { useSelectionTint } from './selectionTint'
import type { SplatStatus } from './SplatRoom'
import { StaticCloud } from './StaticCloud'
import { useCaptureScene, useSceneNotes, type CaptureScene, type SceneNote } from './useCaptureScene'
import { useRoomQuery, type RoomSource, type Selection, type SelectionGrid } from './useRoomIndex'
import { useVirtualCursor } from './useVirtualCursor'
import './viewer.css'

const NO_FRAMES: FrameRecord[] = []
const SPLAT_SOURCE: Record<string, string> = {
  'trained-from-video': "trained on the video's frames",
  'trained-from-lidar-capture': "trained on the capture's frames",
}
const ACCENT = '#ff5c3a'
const IS_WINDOWS = typeof navigator !== 'undefined' && /win/i.test(navigator.platform)

export type { NavMode }

/** The clock as an overlay sees it (a Playback). `playing` is live, read it when needed. */
export interface PlaybackControls {
  timeRef: { current: number }
  readonly playing: boolean
  play: () => void
  pause: () => void
  seek: (t: number) => void
}

/** What an overlay (the visit dock) can see and drive in the viewer. */
export interface ViewerControls {
  selection: Selection | null
  playback: PlaybackControls
  duration: number
  mode: NavMode
  switchMode: (next: NavMode) => void
  /** Playback speed, e.g. 0.75 for the narrated tour. */
  setSpeed: (speed: number) => void
  /** True when the capture has camera poses to follow. */
  canFollow: boolean
  video: HTMLVideoElement | null
}

interface ViewerOptions {
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

/**
 * The shared scene viewer (CLAUDE.md 7.2) for a capture: the room as a surface, points or splat
 * you can orbit and fly through, the recorder's path, object selection, the people replayed in
 * 3D and the recorded video in a synced panel. Reads only the baked files; until the bake is
 * done it shows the capture's processing status. Areas without data stay empty.
 */
export function SceneViewer({ assets, ...options }: ViewerOptions & { assets: CaptureAssets }) {
  // A splat capture shows its splat; its points load only when asked for (Points, or a click).
  const [pointsWanted, setPointsWanted] = useState(false)
  const hasSplat = Boolean(assets.manifest.room?.splat)
  const state = useCaptureScene(assets, { points: !hasSplat || pointsWanted })
  const requestPoints = useCallback(() => setPointsWanted(true), [])
  const room = useMemo<ViewerRoom | null>(() => (state.status === 'ready' ? { kind: 'capture', scene: state.scene, requestPoints } : null), [state, requestPoints])
  if (state.status === 'processing') return <ViewerMessage>{<ProcessingStatus status={state.captureStatus} />}</ViewerMessage>
  if (state.status === 'loading') return <ViewerMessage>Loading the capture…</ViewerMessage>
  if (state.status === 'error') return <ViewerMessage error>{state.message}</ViewerMessage>
  return <Viewer room={room!} {...options} />
}

/**
 * A room.bin opened from this computer: there is no bake, so the points are parsed here and their
 * splat sizes and selection index are worked out in a worker. Orbit, fly and select; no recording.
 */
export function RoomFileViewer({ cloud }: { cloud: PointCloud }) {
  const room = useMemo<ViewerRoom>(() => ({ kind: 'file', cloud }), [cloud])
  return <Viewer room={room} showVideo={false} />
}

function ViewerMessage({ children, error }: { children: ReactNode; error?: boolean }) {
  return (
    <div className="viewer">
      <div className={`viewer-empty${error ? ' err' : ''}`}>{children}</div>
    </div>
  )
}

type ViewerRoom = { kind: 'capture'; scene: CaptureScene; requestPoints: () => void } | { kind: 'file'; cloud: PointCloud }

const HELP: Record<NavMode, string> = {
  orbit: 'Drag to view the pivot from any angle · scroll to get closer · right-drag to pan · click something to orbit it · Esc back to room center · V video',
  fly: 'Drag rotates the room around you · hold WASD to fly and steer with the mouse, no click needed · E up · Q/C down · Shift faster · Alt slower · click to select · V video',
  follow: 'Following the recording camera · click to select · V video',
}

function Viewer({ room, initialMode = 'orbit', rate = 1, showVideo = true, interactive = true, startAt, overlay }: ViewerOptions & { room: ViewerRoom }) {
  const scene = room.kind === 'capture' ? room.scene : null
  const manifest = scene?.manifest ?? null
  const moment = scene?.moment ?? NO_FRAMES
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null)
  const [showPath, setShowPath] = useState(true)
  // The room as one connected surface (fused from the scan's depth frames), or as raw points.
  const [showSurface, setShowSurface] = useState(true)
  // The splat when there is one; the points (what was measured or estimated) are always a click away.
  const [chosenView, setRoomView] = useState<'splat' | 'points'>('splat')
  const [splatStatus, setSplatStatus] = useState<SplatStatus>({ state: 'loading' })
  // Problems the room and the replay report while drawing (photos, depth frames).
  const [liveNotes, onNote] = useSceneNotes()
  // A splat that fails says so, and the measured points take its place.
  const splatFailed = splatStatus.state === 'failed'
  const roomView = splatFailed ? 'points' : chosenView
  useEffect(() => {
    if (splatFailed && room.kind === 'capture') room.requestPoints()
  }, [splatFailed, room])
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

  const videoUrl = showVideo ? (scene?.videoUrl ?? null) : null
  const hasVideo = Boolean(videoUrl) && !videoError
  const duration = videoDuration ?? manifest?.video?.durationSec ?? (moment.length ? moment[moment.length - 1].t : 0)
  const [speed, setSpeed] = useState(rate)
  const playback = usePlayback(hasVideo ? videoEl : null, duration, speed)

  const videoW = manifest?.video?.width ?? 1920
  const videoH = manifest?.video?.height ?? 1440
  // Stored frames are sensor-landscape; turn them upright the same way the camera path does.
  const videoTurns = useMemo(() => (moment.length ? dominantQuarterTurns(moment) : 0), [moment])
  // Jump to `startAt` once the clock knows how long the visit is.
  const startedAt = useRef(false)
  useEffect(() => {
    if (startAt === undefined || startedAt.current || (hasVideo && videoDuration === null) || duration <= 0) return
    startedAt.current = true
    playback.seek(startAt)
  }, [startAt, hasVideo, videoDuration, duration, playback])

  // The room as drawn now, and the points behind selection.
  const view: RoomView = scene?.splat && roomView === 'splat' ? 'splat' : showSurface ? 'surface' : 'points'
  const shown = scene ? shownRoom(scene, view, splatStatus) : 'points'
  const points = scene?.points?.status === 'ready' ? scene.points.data : null
  const fileCloud = room.kind === 'file' ? room.cloud : null
  const roomSource = useMemo<RoomSource | null>(() => {
    if (fileCloud) return { kind: 'cloud', cloud: fileCloud }
    return interactive && points ? { kind: 'pack', points } : null
  }, [interactive, fileCloud, points])
  const query = useRoomQuery(roomSource, moment, videoW, videoH)
  const grid = query.state.status === 'ready' ? query.state.grid : null
  const bounds = useMemo<SceneBounds>(() => {
    if (!fileCloud) return scene!.bounds
    const b = cloudBounds(fileCloud)
    return { center: [b.center.x, b.center.y, b.center.z], radius: b.radius }
  }, [scene, fileCloud])
  const canFollow = moment.length > 0
  const roomCenter = bounds.center
  const startCam: Vec3 = [bounds.center[0] + bounds.radius * 0.6, bounds.center[1] + bounds.radius * 1.3, bounds.center[2] + bounds.radius * 1.0]

  // The canvas mounts once something can be drawn, so the camera starts framed on the room.
  const roomFailed = scene && shown === null && !scene.splat && scene.points?.status !== 'loading' && scene.surface?.status !== 'loading'
  const canDraw = !scene || shown !== null || Boolean(scene.splat)

  /** Turn the camera in place to face `p`; in orbit mode `p` becomes the fixed pivot. */
  const faceTowards = useCallback((p: Vec3) => {
    const cam = cameraRef.current
    if (!cam) return
    setGoal({ position: [cam.position.x, cam.position.y, cam.position.z], lookAt: p })
  }, [])

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

  // Only the latest click counts; a splat capture's first click also loads the points it needs.
  const pickSeq = useRef(0)
  const pendingRay = useRef<[Vec3, Vec3] | null>(null)
  const { pick } = query
  const runPick = useCallback(
    (origin: Vec3, dir: Vec3) => {
      const seq = ++pickSeq.current
      void pick(origin, dir).then((sel) => {
        if (seq !== pickSeq.current) return
        setSelection(sel)
        setPickMiss(!sel)
        // In orbit, whatever you click becomes the point you circle around; clicking empty space
        // deselects, and the pivot goes back to the room center like Esc.
        if (mode === 'orbit') faceTowards(sel ? pivotOf(sel) : roomCenter)
      })
    },
    [pick, mode, faceTowards, roomCenter],
  )
  const onPick = useCallback(
    (origin: Vec3, dir: Vec3) => {
      if (query.state.status === 'failed') return
      if (!roomSource && room.kind === 'capture' && interactive) {
        pendingRay.current = [origin, dir]
        room.requestPoints()
        return
      }
      runPick(origin, dir)
    },
    [query.state.status, roomSource, room, interactive, runPick],
  )
  useEffect(() => {
    if (!roomSource || !pendingRay.current) return
    const [o, d] = pendingRay.current
    pendingRay.current = null
    runPick(o, d)
  }, [roomSource, runPick])

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

  // Bound once; reads the latest state through the effect event.
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
    if (e.code === 'Escape') clearSelection()
    if (e.code === 'KeyF') goToSelection()
    if (e.code === 'KeyV' && showVideo) setVideoOpen((o) => !o)
    if (e.code === 'Space' && duration > 0) {
      e.preventDefault()
      playback.toggle()
    }
  })
  useEffect(() => {
    const handler = (e: KeyboardEvent) => onKey(e)
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Only read when OrbitControls mounts; afterwards the pivot moves through CameraTween.
  const orbitAt = orbitTarget ?? roomCenter
  const fileSizes = room.kind === 'file' ? query.sizes : null

  return (
    <div className="viewer">
      <div className="viewer-stage">
        <div className="viewer-canvas" ref={canvasBoxRef}>
          {canDraw ? (
            <Canvas
              flat
              frameloop="demand"
              dpr={[1, 2]}
              camera={{ position: startCam, fov: 60, near: 0.005, far: 200 }}
              gl={{ antialias: true }}
              onCreated={(s) => {
                cameraRef.current = s.camera
                // Dev-only handle for inspecting the camera from the browser console.
                if (import.meta.env.DEV) Object.assign(window, { __bdCamera: s.camera, __bdState: s.get })
              }}
            >
              <color attach="background" args={['#07080a']} />
              <PlaybackDriver playback={playback} />
              <ViewerScene
                room={room}
                view={view}
                shown={shown}
                fileSizes={fileSizes}
                grid={grid}
                selection={selection}
                video={hasVideo ? videoEl : null}
                playback={playback}
                showPath={showPath && canFollow}
                onSplatStatus={setSplatStatus}
                onNote={onNote}
              />
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
            <div className="viewer-empty">{roomFailed ? <span className="err">The room didn't load.</span> : 'Loading the room…'}</div>
          )}

          <div className="viewer-modes">
            <ModeButton on={mode === 'orbit'} onClick={() => switchMode('orbit')} label="Orbit" />
            {interactive && <ModeButton on={mode === 'fly'} onClick={() => switchMode('fly')} label="Fly" title="Drone: move freely in 3D" />}
            <ModeButton on={mode === 'follow'} onClick={() => switchMode('follow')} label="Camera view" disabled={!canFollow} title={canFollow ? 'Follow the recording camera' : 'No camera poses in this capture'} />
          </div>

          {mode === 'fly' && steering && <div className="viewer-crosshair" />}

          {overlay?.({ selection, playback, duration, mode, switchMode, setSpeed, canFollow, video: videoEl })}

          {interactive && selection && <SelectionPanel selection={selection} onGoTo={goToSelection} onClear={clearSelection} onSeek={playback.seek} />}

          {showVideo && (
            <div className={`viewer-video-float${videoOpen ? ' open' : ''}`} aria-hidden={!videoOpen}>
              <div className="viewer-video">
                {videoUrl && !videoError ? (
                  <VideoPanel src={videoUrl} videoRef={setVideoEl} quarterTurns={videoTurns} videoW={videoW} videoH={videoH} onError={setVideoError} onDuration={setVideoDuration} />
                ) : (
                  <div className="viewer-empty">{videoError ?? 'No video in this capture.'}</div>
                )}
              </div>
            </div>
          )}

          <div className="viewer-foot">
            <FootNotes room={room} shown={shown} splatStatus={splatStatus} roomView={roomView} />
            {liveNotes.map((n) => (
              <span key={n} className="err">
                {n}
              </span>
            ))}
            {interactive && query.state.status === 'building' && <span>Indexing room for selection…</span>}
            {query.state.status === 'failed' && <span className="err">Selection unavailable: {query.state.message}</span>}
            {pickMiss && <span>Nothing scanned there</span>}
            {interactive && <span className="help">{HELP[mode]}</span>}
          </div>
        </div>
      </div>

      {/* Drawn in the system pointer's style: Windows white, macOS and Linux black. */}
      <div ref={virtualCursor.ref} className={`virtual-cursor${IS_WINDOWS ? ' win' : ''}`} aria-hidden />

      <div className="viewer-timeline">
        <PlayBar playback={playback} duration={duration} selection={selection} />
        {scene?.splat && (
          <div className="room-view" role="group" aria-label="How to draw the room">
            <button
              className={roomView === 'splat' ? 'on' : ''}
              onClick={() => setRoomView('splat')}
              disabled={splatFailed}
              title={splatFailed ? "The splat didn't load" : 'The room as 3D Gaussians, fitted to the recording'}
            >
              Splat
            </button>
            <button
              className={roomView === 'points' ? 'on' : ''}
              onClick={() => {
                setRoomView('points')
                if (room.kind === 'capture') room.requestPoints()
              }}
              title="The room as it came out of the capture: the surface, or the raw points"
            >
              Points
            </button>
          </div>
        )}
        <div className="layers">
          <Layer label="Surface" on={showSurface} disabled={scene?.surface?.status !== 'ready'} set={setShowSurface} />
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

/** Everything inside the canvas: the room, the selection, the path and the people replay. */
function ViewerScene({
  room,
  view,
  shown,
  fileSizes,
  grid,
  selection,
  video,
  playback,
  showPath,
  onSplatStatus,
  onNote,
}: {
  room: ViewerRoom
  view: RoomView
  shown: ReturnType<typeof shownRoom>
  fileSizes: Float32Array | null
  grid: SelectionGrid | null
  selection: Selection | null
  video: HTMLVideoElement | null
  playback: Playback
  showPath: boolean
  onSplatStatus: (s: SplatStatus) => void
  onNote: SceneNote
}) {
  // The selected object, tinted on the surface and in the video replay.
  const tint = useSelectionTint(grid, selection?.voxelCoords ?? null)
  const scene = room.kind === 'capture' ? room.scene : null
  return (
    <>
      {scene ? (
        <SceneRoom scene={scene} view={view} selection={tint} onSplatStatus={onSplatStatus} onNote={onNote} />
      ) : (
        <>
          <HoleFill />
          <StaticCloud cloud={(room as { cloud: PointCloud }).cloud} sizes={fileSizes} />
        </>
      )}
      {selection && (
        <>
          {shown !== 'surface' && <StaticCloud cloud={selection.cloud} sizes={selection.sizes} pointSize={1.2} tint={ACCENT} tintMix={0.35} renderOrder={1} />}
          <SelectionBox selection={selection} />
        </>
      )}
      {scene && showPath && <CameraPath frames={scene.moment} timeRef={playback.timeRef} />}
      {scene && video && <SceneReplay scene={scene} video={video} timeRef={playback.timeRef} masked={shown === 'surface'} selection={tint} onNote={onNote} />}
    </>
  )
}

/** The footer's notes about the room: what's drawn and what's still loading or failed. */
function FootNotes({ room, shown, splatStatus, roomView }: { room: ViewerRoom; shown: ReturnType<typeof shownRoom>; splatStatus: SplatStatus; roomView: 'splat' | 'points' }) {
  if (room.kind === 'file') return <span>{room.cloud.count.toLocaleString()} points</span>
  const { scene } = room
  const part = (a: CaptureScene['points'] | CaptureScene['surface'] | CaptureScene['timeline'], what: string) =>
    a?.status === 'loading' ? <span>Loading the {what}…</span> : a?.status === 'failed' ? <span className="err">The {what} didn't load: {a.message}</span> : null
  return (
    <>
      {shown === 'points' && scene.points?.status === 'ready' && <span>{scene.points.data.count.toLocaleString()} points</span>}
      {shown === 'splat' && scene.splat && (
        <span>
          {scene.splat.count.toLocaleString()} Gaussians, {SPLAT_SOURCE[scene.splat.source] ?? scene.splat.source}
        </span>
      )}
      {scene.splat && roomView === 'splat' && splatStatus.state === 'loading' && <span>Loading the splat…</span>}
      {splatStatus.state === 'failed' && <span className="err">The splat didn't load ({splatStatus.message}), so the room is drawn from its points.</span>}
      {part(scene.points, "room's points")}
      {part(scene.surface, "room's surface")}
      {part(scene.timeline, "visit's timeline")}
      {scene.notes.map((n) => (
        <span key={n} className="err">
          {n}
        </span>
      ))}
    </>
  )
}

/** Play button, scrubber and time; the only part of the viewer that follows the clock. */
function PlayBar({ playback, duration, selection }: { playback: Playback; duration: number; selection: Selection | null }) {
  const { time, playing } = usePlaybackState(playback)
  return (
    <>
      <button className="play" onClick={playback.toggle} disabled={duration <= 0}>
        {playing ? 'Pause' : 'Play'}
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
        <input type="range" min={0} max={duration || 0} step={0.01} value={Math.min(time, duration)} onChange={(e) => playback.seek(Number(e.target.value))} disabled={duration <= 0} />
      </div>
      <span className="time">
        {fmt(time)} / {fmt(duration)}
      </span>
    </>
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
    const box = new THREE.BoxGeometry(Math.max(s[0], 0.01), Math.max(s[1], 0.01), Math.max(s[2], 0.01))
    const edges = new THREE.EdgesGeometry(box)
    box.dispose()
    return edges
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
