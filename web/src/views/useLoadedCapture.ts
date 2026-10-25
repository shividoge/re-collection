import { useEffect, useState } from 'react'
import { useCaptureAssets, type CaptureAssets } from '../data'
import { loadFromAssets, type LoadedCapture } from '../scene/loadCapture'

/**
 * Adapter while the render worker moves SceneViewer to `assets`: loads the old LoadedCapture
 * from the capture's assets (again only when the assets change, e.g. a bake finished).
 */
export function useLoadedCapture(id: string, opts: { public?: boolean } = {}): { capture: LoadedCapture | null; assets: CaptureAssets | null; error: string | null } {
  const state = useCaptureAssets(id, opts)
  const assets = state.status === 'ready' ? state.assets : null
  const [loaded, setLoaded] = useState<{ for: CaptureAssets; capture: LoadedCapture | null; error: string | null } | null>(null)
  useEffect(() => {
    if (!assets) return
    let cancelled = false
    loadFromAssets(assets)
      .then((capture) => !cancelled && setLoaded({ for: assets, capture, error: null }))
      .catch((e: Error) => !cancelled && setLoaded({ for: assets, capture: null, error: e.message }))
    return () => {
      cancelled = true
    }
  }, [assets])
  if (state.status === 'missing') return { capture: null, assets: null, error: 'This visit isn’t here any more, or it isn’t shared.' }
  if (state.status === 'error') return { capture: null, assets: null, error: state.message }
  // Keep showing the previous load while new assets load, so a finished bake doesn't blank the view.
  return { capture: loaded?.capture ?? null, assets, error: loaded?.for === assets ? loaded.error : null }
}
