import { useEffect, useState } from 'react'
import { SceneViewer } from '../scene/SceneViewer'
import { loadGuideCapture, type LoadedCapture } from '../scene/loadCapture'
import { VisitDock } from './VisitDock'

/**
 * One capture from the guide: the 3D room and the visit, where the person revisits it: a narrated
 * tour they can pause to look around, point at things and ask. `startAt` opens it at that second.
 */
export function CaptureView({ id, startAt }: { id: string; startAt?: number }) {
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
          <a href={`#/facts/${id}`}>Facts</a>
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
          <SceneViewer capture={capture} startAt={startAt} overlay={(controls) => <VisitDock captureId={id} controls={controls} />} />
        </div>
      </main>
    </div>
  )
}
