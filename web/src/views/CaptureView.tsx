import { useCaptureAssets } from '../data'
import { SceneViewer } from '../scene'
import { PublicSwitch } from './PublicSwitch'
import { EstimatedBadge } from './EstimatedBadge'
import { VisitDock } from './VisitDock'

/**
 * One capture from the guide: the 3D room and the visit, where the person revisits it: a narrated
 * tour they can pause to look around, point at things and ask. `startAt` opens it at that second.
 */
export function CaptureView({ id, startAt }: { id: string; startAt?: number }) {
  const state = useCaptureAssets(id)
  if (state.status === 'error') return <div className="center-message error">{state.message}</div>
  if (state.status === 'missing') return <div className="center-message error">This visit isn't here any more.</div>
  if (state.status !== 'ready') return <div className="center-message">Loading the capture…</div>

  const { assets } = state
  const { manifest } = assets
  return (
    <div className="page">
      <header className="bar">
        <a href="#/captures" className="back">
          ← Captures
        </a>
        <div className="bar-title">
          <strong>{manifest.title || 'Untitled visit'}</strong> <EstimatedBadge manifest={manifest} />
          {manifest && (
            <span className="meta">
              {new Date(manifest.createdAt).toLocaleString()} · {Math.round(manifest.video.durationSec)} s
              {manifest.attendees.length > 0 && ` · ${manifest.attendees.join(', ')}`}
            </span>
          )}
        </div>
        <nav className="bar-links">
          <a href={`#/window/${id}`}>Memory Window</a>
          <a href={`#/facts/${id}`}>Facts</a>
          <a href={`#/dashboard/${id}`}>Dashboard</a>
          <PublicSwitch id={id} initial={false} />
        </nav>
      </header>
      <main className="main">
        <div className="viewer-wrap">
          <SceneViewer assets={assets} startAt={startAt} overlay={(controls) => <VisitDock captureId={id} controls={controls} />} />
        </div>
      </main>
    </div>
  )
}
