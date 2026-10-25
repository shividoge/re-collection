import { onlineWorkers, useCaptureStatus, useHealth, useNow } from '../data'
import { SceneViewer } from '../scene/SceneViewer'
import { PublicSwitch } from './PublicSwitch'
import { EstimatedBadge } from './EstimatedBadge'
import { PipelineStatus } from './Gallery'
import { useLoadedCapture } from './useLoadedCapture'
import { VisitDock } from './VisitDock'

/**
 * One capture: the 3D room and the visit, where the person revisits it: a narrated tour they can
 * pause to look around, point at things and ask. `startAt` opens it at that second.
 */
export function CaptureView({ id, startAt }: { id: string; startAt?: number }) {
  const { capture, assets, error } = useLoadedCapture(id)
  const status = useCaptureStatus(id)
  const health = useHealth()
  const now = useNow()

  const workers = onlineWorkers(health.status === 'ready' ? health.data : null, now)
  const live = status.status === 'ready' ? status.data : null
  // An old video has no 3D (and only a seed manifest) until it's converted: show that instead.
  if (live && live.source === 'video' && live.convert !== 'done') {
    return (
      <div className="center-message">
        <div>
          <p>This video is being turned into a 3D moment. It opens here when it's ready.</p>
          <PipelineStatus capture={{ status: live, durationSec: 0 }} workers={workers} />
          <p>
            <a href="#/captures">← Captures</a>
          </p>
        </div>
      </div>
    )
  }
  if (error) return <div className="center-message error">{error}</div>
  if (!capture || !assets) return <div className="center-message">Loading the capture…</div>

  const { manifest } = capture
  const pending = live && (['facts', 'bake', 'convert', 'splat'] as const).some((k) => live[k] !== 'done' && live[k] !== 'skipped')
  return (
    <div className="page">
      <header className="bar">
        <a href="#/captures" className="back">
          ← Captures
        </a>
        <div className="bar-title">
          <strong>{capture.label}</strong> <EstimatedBadge manifest={manifest} />
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
          <PublicSwitch key={String(assets.public)} id={id} initial={assets.public === true} />
        </nav>
      </header>
      {live && pending && (
        <div className="banner">
          <PipelineStatus capture={{ status: live, durationSec: manifest?.video.durationSec ?? 0 }} workers={workers} />
        </div>
      )}
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
