import { useEffect, useState } from 'react'
import { publicGuide } from '../api'
import type { Fact, Moment } from '../api'
import { loadGuideCapture, type LoadedCapture } from '../scene/loadCapture'
import { SceneViewer, type ViewerControls } from '../scene/SceneViewer'
import './public.css'

const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`

/**
 * A public capture for visitors (#/p/<id>): the same viewer family members use (orbit, fly,
 * camera view, select), with the facts the family approved beside it. Read-only: no review
 * buttons, no visit, nothing that can change. Public mode is switched on by App.
 */
export function PublicView({ id }: { id: string }) {
  const [capture, setCapture] = useState<LoadedCapture | null>(null)
  const [moment, setMoment] = useState<Moment | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    loadGuideCapture(id)
      .then((c) => !cancelled && setCapture(c))
      .catch((e: Error) => !cancelled && setError(e.message))
    publicGuide
      .moment(id)
      .then((m) => !cancelled && setMoment(m))
      .catch(() => {})
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
          ← Braindance
        </a>
        <div className="bar-title">
          <strong>{moment?.moment.title || capture.label}</strong>
          {manifest && (
            <span className="meta">
              {new Date(manifest.createdAt).toLocaleString()} · {Math.round(manifest.video.durationSec)} s
            </span>
          )}
        </div>
      </header>
      <main className="main">
        <div className="viewer-wrap">
          <SceneViewer capture={capture} overlay={(controls) => <PublicFacts id={id} moment={moment} controls={controls} />} />
        </div>
      </main>
    </div>
  )
}

function PublicFacts({ id, moment, controls }: { id: string; moment: Moment | null; controls: ViewerControls }) {
  const [open, setOpen] = useState(true)
  if (!moment) return null
  const seek = (t: number) => controls.playback.seek(t)
  return (
    <aside className={`pub-facts${open ? ' open' : ''}`}>
      <button className="pub-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide facts' : `Facts (${moment.facts.length})`}
      </button>
      {open && (
        <div className="pub-body">
          {moment.moment.summary && <p className="pub-summary">{moment.moment.summary}</p>}
          {moment.chapters.length > 0 && (
            <div className="pub-chapters">
              {moment.chapters.map((c) => (
                <button key={c.tStart} onClick={() => seek(c.tStart)}>
                  {fmt(c.tStart)} {c.label}
                </button>
              ))}
            </div>
          )}
          <p className="pub-note">Only facts the family approved are ever said to their loved one.</p>
          <ul>
            {moment.facts.map((f) => (
              <PublicFact key={f.id} id={id} fact={f} seek={seek} />
            ))}
          </ul>
        </div>
      )}
    </aside>
  )
}

function PublicFact({ id, fact, seek }: { id: string; fact: Fact; seek: (t: number) => void }) {
  return (
    <li>
      <p>{fact.text}</p>
      <div className="pub-evidence">
        {fact.evidence.map((e, k) =>
          e.type === 'frame' ? (
            <button key={k} className="frame" onClick={() => seek(e.t)} title={`Show ${fmt(e.t)}`}>
              <img src={publicGuide.file(id, e.keyframe)} alt={`Keyframe at ${fmt(e.t)}`} loading="lazy" />
              <span>{fmt(e.t)}</span>
            </button>
          ) : (
            <button key={k} className="quote" onClick={() => seek(e.tStart)} title="Play this moment">
              “{e.quote}” <span>{fmt(e.tStart)}</span>
            </button>
          ),
        )}
      </div>
    </li>
  )
}
