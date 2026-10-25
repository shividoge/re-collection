import { OrbitControls } from '@react-three/drei'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useCaptureAssets } from '../data'
import type { CaptureAssets } from '../data/assets'
import { CameraPath } from '../scene/CameraPath'
import { PlaybackDriver, SceneReplay, SceneRoom, useCaptureScene, usePlayback, usePlaybackState } from '../scene'

/**
 * Whether an element is on screen. Off-screen scenes stop rendering (the canvases render on
 * demand) and pause their clips.
 */
function useOnScreen<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null)
  const [on, setOn] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setOn(e.isIntersecting), { rootMargin: '100px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  return [ref, on]
}

/** Loads a public capture's assets for a scene on the page. */
export function WithCaptureAssets({ id, children }: { id: string; children: (assets: CaptureAssets) => ReactNode }) {
  const state = useCaptureAssets(id, { public: true })
  return state.status === 'ready' ? children(state.assets) : null
}

/** Slowly circles the scanned room, like a dolly shot; only while on screen. */
function AutoOrbit({ center, radius, running }: { center: [number, number, number]; radius: number; running: boolean }) {
  const camera = useThree((s) => s.camera)
  const invalidate = useThree((s) => s.invalidate)
  const t0 = useRef<number | null>(null)
  useEffect(() => {
    if (running) invalidate()
  }, [running, invalidate])
  useFrame(({ clock }) => {
    t0.current ??= clock.elapsedTime
    const t = (clock.elapsedTime - t0.current) * 0.07 + 0.6
    camera.position.set(center[0] + Math.sin(t) * radius * 0.9, center[1] + radius * 0.45, center[2] + Math.cos(t) * radius * 0.9)
    camera.lookAt(center[0], center[1] - radius * 0.1, center[2])
    if (running) invalidate()
  })
  return null
}

/** The hero's backdrop: a real scan of a real room, turning slowly. */
export function HeroCloud({ assets }: { assets: CaptureAssets }) {
  const state = useCaptureScene(assets)
  const [box, onScreen] = useOnScreen<HTMLDivElement>()
  const scene = state.status === 'ready' ? state.scene : null
  const ready = scene?.points?.status === 'ready'
  return (
    <div ref={box} className={`hero-cloud ${ready ? 'ready' : ''}`} aria-hidden>
      {scene && ready && (
        <Canvas flat frameloop="demand" dpr={[1, 1.5]} camera={{ fov: 52, near: 0.05, far: 100 }}>
          <color attach="background" args={['#07080a']} />
          <AutoOrbit center={scene.bounds.center} radius={scene.bounds.radius} running={onScreen} />
          <SceneRoom scene={scene} view="points" />
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
export function MiniViewer({ assets, layers, label }: { assets: CaptureAssets; layers: Layers; label: string }) {
  const state = useCaptureScene(assets)
  const [box, onScreen] = useOnScreen<HTMLDivElement>()
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null)
  const [explore, setExplore] = useState(() => !window.matchMedia('(pointer: coarse)').matches)

  const scene = state.status === 'ready' ? state.scene : null
  const duration = assets.manifest.video.durationSec ?? 0
  const playback = usePlayback(videoEl, duration, 1)
  const { playing } = usePlaybackState(playback)

  // The clip plays whenever a layer needs it and the scene is on screen, muted and looping.
  const needsVideo = (layers.video || layers.people) && onScreen
  useEffect(() => {
    if (!videoEl) return
    if (needsVideo) playback.play()
    else playback.pause()
  }, [videoEl, needsVideo, playback])

  const failed = state.status === 'error' || scene?.points?.status === 'failed'
  const videoUrl = scene?.videoUrl ?? null
  return (
    <div ref={box} className={failed || !scene ? 'mini-viewer note' : 'mini-viewer'}>
      {failed ? (
        "This scene couldn't load."
      ) : !scene ? (
        state.status === 'processing' ? "This scene isn't ready yet." : 'Loading the scan…'
      ) : (
        <>
          <Canvas
            flat
            frameloop="demand"
            dpr={[1, 1.5]}
            camera={{ position: [scene.bounds.center[0] + scene.bounds.radius * 0.6, scene.bounds.center[1] + scene.bounds.radius * 1.3, scene.bounds.center[2] + scene.bounds.radius * 1.0], fov: 60, near: 0.02, far: 200 }}
            key={scene.id}
          >
            <color attach="background" args={['#07080a']} />
            <PlaybackDriver playback={playback} />
            {layers.room && <SceneRoom scene={scene} view="points" dim={layers.people && playing ? 0.5 : 1} />}
            {layers.path && scene.moment.length > 0 && <CameraPath frames={scene.moment} timeRef={playback.timeRef} color="#ff7a57" />}
            {layers.people && videoEl && <SceneReplay scene={scene} video={videoEl} timeRef={playback.timeRef} masked={false} />}
            <OrbitControls makeDefault target={scene.bounds.center} enableZoom={false} enabled={explore} enableDamping />
          </Canvas>
          {videoUrl && <video ref={setVideoEl} className={layers.video ? 'pip show' : 'pip'} src={videoUrl} crossOrigin="anonymous" muted loop playsInline preload="metadata" />}
          <div className="mini-label">{label}</div>
          {!explore && (
            <button className="mini-explore" onClick={() => setExplore(true)}>
              Tap to explore
            </button>
          )}
          <a className="mini-open" href={`#/p/${scene.id}`}>
            Open full viewer →
          </a>
        </>
      )}
    </div>
  )
}
