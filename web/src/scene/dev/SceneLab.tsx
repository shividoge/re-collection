import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { CaptureAssets } from '../../data/assets'
import { SceneViewer } from '../SceneViewer'
import { localAssetsFromQuery } from './localAssets'
import '../../index.css'

/** Development entry point for real local captures, without connecting to a backend. */
export function SceneLab() {
  const [assets, setAssets] = useState<CaptureAssets | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!import.meta.env.DEV) return
    let live = true
    const id = new URLSearchParams(location.search).get('id') ?? ''
    localAssetsFromQuery(id).then((found) => {
      if (!live) return
      if (found) setAssets(found)
      else setError('Supply id, local and baked query parameters for a real capture.')
    }, (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => { live = false }
  }, [])
  if (!import.meta.env.DEV) return <p>This experiment is available only in the development server.</p>
  if (error) return <p role="alert">{error}</p>
  return <main style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
    <p style={{ margin: '8px 16px' }}>Reconstruction experiment · {assets?.manifest.title || 'Real source video'}</p>
    {assets ? <SceneViewer assets={assets} initialMode="follow" /> : <p>Loading capture…</p>}
  </main>
}

createRoot(document.getElementById('root')!).render(<StrictMode><SceneLab /></StrictMode>)
