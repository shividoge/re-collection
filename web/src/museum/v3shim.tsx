// TEMPORARY (museum worker, until the v3 data layer and render exports land): stands in for
// `web/src/data/index.ts` (loadCaptureAssets, useCaptureAssets) and `web/src/scene/index.ts`
// (SceneViewer, useCaptureScene, SceneRoom, SceneReplay, usePlayback, usePlaybackState,
// PlaybackDriver) with the agreed names and shapes, built on today's guide loader. When those
// files exist, import from '../data' and '../scene' instead and delete this file.
/* oxlint-disable react-refresh/only-export-components */

import { useEffect, useRef, useState, type ComponentProps, type MutableRefObject } from 'react'
import { captureFileUrl, guide, publicGuide, STATIC, type Arrangement } from '../api'
import type { CaptureAssets } from '../data/assets'
import { DepthReplay } from '../scene/DepthReplay'
import type { FrameRecord } from '../scene/formats'
import { HoleFill } from '../scene/HoleFill'
import { loadGuideCapture, type LoadedCapture } from '../scene/loadCapture'
import { SceneViewer as GuideSceneViewer } from '../scene/SceneViewer'
import { StaticCloud } from '../scene/StaticCloud'
import { usePlayback as useGuidePlayback } from '../scene/usePlayback'
import { useSplatSizes } from '../scene/useSplatSizes'

// ---- data layer ------------------------------------------------------------------------------

export type AssetsState = { status: 'loading' } | { status: 'ready'; assets: CaptureAssets } | { status: 'missing' } | { status: 'error'; message: string }

const assetsCache = new Map<string, Promise<CaptureAssets>>()

export function loadCaptureAssets(id: string): Promise<CaptureAssets> {
  let p = assetsCache.get(id)
  if (!p) {
    p = guide.capture(id).then(({ manifest }) => ({
      id,
      manifest,
      status: null,
      derived: null,
      rawUrl: (name: string) => captureFileUrl(id, name),
      derivedUrl: () => null,
    }))
    p.catch(() => assetsCache.delete(id))
    assetsCache.set(id, p)
  }
  return p
}

export function useCaptureAssets(id: string | null): AssetsState {
  const [state, setState] = useState<{ id: string | null; value: AssetsState }>({ id, value: { status: 'loading' } })
  useEffect(() => {
    if (!id) return
    let cancelled = false
    loadCaptureAssets(id).then(
      (assets) => !cancelled && setState({ id, value: { status: 'ready', assets } }),
      (e: Error) => !cancelled && setState({ id, value: { status: 'error', message: e.message } }),
    )
    return () => {
      cancelled = true
    }
  }, [id])
  if (!id) return { status: 'missing' }
  return state.id === id ? state.value : { status: 'loading' }
}

// ---- render exports --------------------------------------------------------------------------

const loaded = new Map<string, Promise<LoadedCapture>>()
function loadScene(id: string): Promise<LoadedCapture> {
  let p = loaded.get(id)
  if (!p) {
    p = loadGuideCapture(id)
    p.catch(() => loaded.delete(id))
    loaded.set(id, p)
  }
  return p
}

function useLoaded(id: string): { capture: LoadedCapture | null; error: string | null } {
  const [state, setState] = useState<{ id: string; capture: LoadedCapture | null; error: string | null }>({ id, capture: null, error: null })
  useEffect(() => {
    let cancelled = false
    loadScene(id).then(
      (capture) => !cancelled && setState({ id, capture, error: null }),
      (e: Error) => !cancelled && setState({ id, capture: null, error: e.message }),
    )
    return () => {
      cancelled = true
    }
  }, [id])
  return state.id === id ? state : { capture: null, error: null }
}

type GuideViewerProps = ComponentProps<typeof GuideSceneViewer>

export function SceneViewer({ assets, ...rest }: Omit<GuideViewerProps, 'capture'> & { assets: CaptureAssets }) {
  const { capture, error } = useLoaded(assets.id)
  if (error) return <div className="window-message">{error}</div>
  if (!capture) return null
  return <GuideSceneViewer capture={capture} {...rest} />
}

export interface CaptureScene {
  id: string
  label: string
  manifest: CaptureAssets['manifest']
  moment: FrameRecord[]
  videoUrl: string | null
  canReplay: boolean
  capture: LoadedCapture
}

export type CaptureSceneState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; scene: CaptureScene }

const NO_FRAMES: FrameRecord[] = []

export function useCaptureScene(assets: CaptureAssets): CaptureSceneState {
  const { capture, error } = useLoaded(assets.id)
  if (error) return { status: 'error', message: error }
  if (!capture) return { status: 'loading' }
  if (!capture.cloud) return { status: 'error', message: 'This visit has no room scan to look into.' }
  const moment = capture.frames?.moment ?? NO_FRAMES
  return {
    status: 'ready',
    scene: {
      id: assets.id,
      label: capture.label,
      manifest: assets.manifest,
      moment,
      videoUrl: capture.videoUrl,
      canReplay: assets.manifest.depth?.count > 0 && moment.length > 0 && Boolean(capture.videoUrl),
      capture,
    },
  }
}

export function SceneRoom({ scene, dim = 1 }: { scene: CaptureScene; dim?: number }) {
  const sizes = useSplatSizes(scene.capture.cloud)
  if (!scene.capture.cloud) return null
  return (
    <>
      <HoleFill />
      <StaticCloud cloud={scene.capture.cloud} sizes={sizes} dim={dim} />
    </>
  )
}

export function SceneReplay({ scene, video, timeRef }: { scene: CaptureScene; video: HTMLVideoElement; timeRef: MutableRefObject<number> }) {
  if (!scene.capture.manifest) return null
  return <DepthReplay captureId={scene.id} manifest={scene.capture.manifest} frames={scene.moment} video={video} timeRef={timeRef} />
}

export type Playback = ReturnType<typeof useGuidePlayback> & { toggle: () => void }

export function usePlayback(video: HTMLVideoElement | null, duration: number, rate = 1): Playback {
  const ref = useRef<HTMLVideoElement | null>(video)
  useEffect(() => {
    ref.current = video
  }, [video])
  const p = useGuidePlayback(ref, Boolean(video), duration, rate)
  return { ...p, toggle: () => (p.playing ? p.pause() : p.play()) }
}

export function usePlaybackState(playback: Playback): { time: number; playing: boolean } {
  return { time: playback.time, playing: playback.playing }
}

/** The guide's playback clock runs itself; the real one ticks from R3F's loop. */
export function PlaybackDriver(_: { playback: Playback }) {
  return null
}

// ---- museum data (data/museum.ts) ------------------------------------------------------------

/** A finished visit and its files. */
export type VisitSource = { id: string; title: string; createdAt: string; hasThumb: boolean; assets: CaptureAssets }

export async function loadVisitSources(): Promise<VisitSource[]> {
  const list = STATIC ? (await publicGuide.captures()).map((c) => ({ ...c, status: { upload: 'done' } })) : await guide.captures()
  const done = list.filter((c) => c.status.upload === 'done').sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  const loaded = await Promise.all(
    done.map(async (c) => {
      try {
        return { id: c.id, title: c.title, createdAt: c.createdAt, hasThumb: Boolean(c.thumb), assets: await loadCaptureAssets(c.id) }
      } catch {
        return null
      }
    }),
  )
  return loaded.filter((v): v is VisitSource => v !== null)
}

const LOCAL_ARRANGEMENT = 'braindance.museum.arrangement'

export const arrangements = {
  async load(): Promise<Arrangement | null> {
    if (!STATIC) return guide.arrangement().catch(() => null)
    try {
      const local = localStorage.getItem(LOCAL_ARRANGEMENT)
      if (local) return JSON.parse(local) as Arrangement
    } catch {
      /* no storage: fall through to the published one */
    }
    return publicGuide.arrangement()
  },
  async save(a: Omit<Arrangement, 'updatedAt'>): Promise<Arrangement> {
    if (!STATIC) return guide.saveArrangement(a)
    const saved = { ...a, updatedAt: new Date().toISOString() }
    localStorage.setItem(LOCAL_ARRANGEMENT, JSON.stringify(saved))
    return saved
  },
  async clear(): Promise<void> {
    if (!STATIC) {
      await guide.resetArrangement()
      return
    }
    try {
      localStorage.removeItem(LOCAL_ARRANGEMENT)
    } catch {
      /* nothing saved */
    }
  },
}

/** data/mode.ts: live (Convex) or the static public site. */
export const dataMode: 'live' | 'static' = STATIC ? 'static' : 'live'
