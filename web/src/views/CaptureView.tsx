import { useEffect, useState } from 'react'
import { SceneViewer } from '../scene/SceneViewer'
import { loadGuideCapture, type LoadedCapture } from '../scene/loadCapture'
import { FactsPanel } from './FactsPanel'

/** One capture from the guide: the 3D room and the visit, with the family's fact review. */
export function CaptureView({ id }: { id: string }) {
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

  if (error) return <div className="center-message error">{error}</div>
  if (!capture) return <div className="center-message">Loading the capture…</div>

  const { manifest } = capture
  return (
    <div className="page">
      <header className="bar">
        <a href="#/" className="back">
          ← Captures
        </a>
        <div className="bar-title">
          <strong>{capture.label}</strong>
          {manifest && (
            <span className="meta">
              {new Date(manifest.createdAt).toLocaleString()} · {Math.round(manifest.video.durationSec)} s
              {manifest.attendees.length > 0 && ` · ${manifest.attendees.join(', ')}`}
            </span>
          )}
        </div>
        <nav className="bar-links">
          <a href={`#/revisit/${id}`}>Revisit</a>
          <a href={`#/dashboard/${id}`}>Dashboard</a>
        </nav>
      </header>
      {capture.errors.length > 0 && (
        <div className="banner error">
          {capture.errors.map((e) => (
            <div key={e}>{e}</div>
          ))}
        </div>
      )}
      <main className="main">
        <div className="viewer-wrap">
          <SceneViewer capture={capture} side={(seek) => <FactsPanel captureId={id} onSeek={seek} />} />
        </div>
      </main>
    </div>
  )
}
