import { OrbitControls } from '@react-three/drei'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { publicGuide } from '../api'
import { cloudBounds } from '../scene/cloudBounds'
import { CameraPath } from '../scene/CameraPath'
import { DepthReplay } from '../scene/DepthReplay'
import type { FrameRecord } from '../scene/formats'
import { HoleFill } from '../scene/HoleFill'
import { loadGuideCapture, type LoadedCapture } from '../scene/loadCapture'
import { StaticCloud } from '../scene/StaticCloud'
import { usePlayback } from '../scene/usePlayback'
import { useSplatSizes } from '../scene/useSplatSizes'

const NO_FRAMES: FrameRecord[] = []
const cache = new Map<string, Promise<LoadedCapture>>()

/** A capture's room cloud and camera log, loaded once and shared by every scene on the page. */
function loadOnce(id: string): Promise<LoadedCapture> {
  let found = cache.get(id)
  if (!found) {
    found = loadGuideCapture(id)
    found.catch(() => cache.delete(id))
    cache.set(id, found)
  }
  return found
}

function useCapture(id: string) {
  const [capture, setCapture] = useState<LoadedCapture | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    setCapture(null)
    setFailed(false)
    loadOnce(id)
      .then((c) => !cancelled && setCapture(c))
      .catch(() => !cancelled && setFailed(true))
    return () => {
      cancelled = true
    }
  }, [id])
  return { capture, failed }
}

/** Slowly circles the scanned room, like a dolly shot. */
function AutoOrbit({ center, radius }: { center: [number, number, number]; radius: number }) {
  const camera = useThree((s) => s.camera)
  useFrame(({ clock }) => {
    const t = clock.elapsedTime * 0.07 + 0.6
    camera.position.set(center[0] + Math.sin(t) * radius * 0.9, center[1] + radius * 0.45, center[2] + Math.cos(t) * radius * 0.9)
    camera.lookAt(center[0], center[1] - radius * 0.1, center[2])
  })
  return null
}

/** The hero's backdrop: a real scan of a real room, turning slowly. */
export function HeroCloud({ id }: { id: string }) {
  const { capture } = useCapture(id)
  const cloud = capture?.cloud ?? null
  const sizes = useSplatSizes(cloud)
  const bounds = useMemo(() => (cloud ? cloudBounds(cloud) : null), [cloud])
  return (
    <div className={`hero-cloud ${cloud ? 'ready' : ''}`} aria-hidden>
      {cloud && bounds && (
        <Canvas flat dpr={[1, 1.5]} camera={{ fov: 52, near: 0.05, far: 100 }}>
          <color attach="background" args={['#07080a']} />
          <HoleFill />
          <AutoOrbit center={[bounds.center.x, bounds.center.y, bounds.center.z]} radius={bounds.radius} />
          <StaticCloud cloud={cloud} sizes={sizes} dim={1} />
        </Canvas>
      )}
    </div>
  )
}

export type Layers = { room: boolean; path: boolean; people: boolean; video: boolean }

/**
 * A compact scene for the page: which layers show is decided by the story next to it. Zoom is
 * off so the page keeps scrolling. The full viewer (orbit, fly, select) lives at #/p/<id>.
 */
export function MiniViewer({ id, layers, label }: { id: string; layers: Layers; label: string }) {
  const { capture, failed } = useCapture(id)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null)
  const attachVideo = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el
    setVideoEl(el)
  }, [])
  const [explore, setExplore] = useState(() => !window.matchMedia('(pointer: coarse)').matches)

  const manifest = capture?.manifest ?? null
  const moment = capture?.frames?.moment ?? NO_FRAMES
  const cloud = capture?.cloud ?? null
  const sizes = useSplatSizes(cloud)
  const bounds = useMemo(() => (cloud ? cloudBounds(cloud) : null), [cloud])
  const duration = manifest?.video.durationSec ?? 0
  const hasVideo = Boolean(capture?.videoUrl)
  const playback = usePlayback(videoRef, hasVideo, duration, 1)
  const canReplay = Boolean(capture?.id && manifest && manifest.depth.count > 0 && moment.length > 0 && videoEl && hasVideo)

  // The clip plays whenever a layer needs it, muted and looping.
  const needsVideo = layers.video || layers.people
  const { play, pause } = playback
  useEffect(() => {
    if (!videoEl) return
    if (needsVideo) play()
    else pause()
  }, [videoEl, needsVideo, play, pause])

  if (failed) return <div className="mini-viewer note">This scene couldn't load.</div>
  if (!capture || !cloud || !bounds || !manifest) return <div className="mini-viewer note">Loading the scan…</div>

  const start: [number, number, number] = [bounds.center.x + bounds.radius * 0.6, bounds.center.y + bounds.radius * 1.3, bounds.center.z + bounds.radius * 1.0]
  return (
    <div className="mini-viewer">
      <Canvas flat dpr={[1, 1.5]} camera={{ position: start, fov: 60, near: 0.02, far: 200 }} key={id}>
        <color attach="background" args={['#07080a']} />
        <HoleFill />
        {layers.room && <StaticCloud cloud={cloud} sizes={sizes} dim={layers.people && playback.playing ? 0.5 : 1} />}
        {layers.path && moment.length > 0 && <CameraPath frames={moment} timeRef={playback.timeRef} color="#ff7a57" />}
        {canReplay && layers.people && videoEl && (
          <DepthReplay captureId={id} manifest={manifest} frames={moment} video={videoEl} timeRef={playback.timeRef} />
        )}
        <OrbitControls makeDefault target={[bounds.center.x, bounds.center.y, bounds.center.z]} enableZoom={false} enabled={explore} enableDamping />
      </Canvas>
      <video
        ref={attachVideo}
        className={layers.video ? 'pip show' : 'pip'}
        src={publicGuide.file(id, manifest.video.file)}
        crossOrigin="anonymous"
        muted
        loop
        playsInline
        preload="metadata"
      />
      <div className="mini-label">{label}</div>
      {!explore && (
        <button className="mini-explore" onClick={() => setExplore(true)}>
          Tap to explore
        </button>
      )}
      <a className="mini-open" href={`#/p/${id}`}>
        Open full viewer →
      </a>
    </div>
  )
}
