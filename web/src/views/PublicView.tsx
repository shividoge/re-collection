import { EstimatedBadge } from './EstimatedBadge'
import { useEffect, useState } from 'react'
import { publicData, useCaptureAssets, type CaptureAssets, type Fact, type Moment } from '../data'
import { SceneViewer, type ViewerControls } from '../scene'
import './public.css'

const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`

/**
 * A public capture for visitors (#/p/<id>): the same viewer family members use (orbit, fly,
 * camera view, select), with the facts the family approved beside it. Read-only: no review
 * buttons, no visit, nothing that can change. Everything comes from the public routes.
 */
export function PublicView({ id }: { id: string }) {
  const state = useCaptureAssets(id, { public: true })
  const [moment, setMoment] = useState<Moment | null>(null)

  useEffect(() => {
    let cancelled = false
    publicData
      .moment(id)
      .then((m) => !cancelled && setMoment(m))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [id])

  if (state.status === 'error') return <div className="center-message error">{state.message}</div>
  if (state.status === 'missing') return <div className="center-message error">This visit isn't public, or isn't here any more.</div>
  if (state.status !== 'ready') return <div className="center-message">Loading the capture…</div>

  const { assets } = state
  const { manifest } = assets
  return (
    <div className="page">
      <header className="bar">
        <a href="#/" className="back">
          ← Re:Collection
        </a>
        <div className="bar-title">
          <strong>{moment?.moment.title || manifest.title || 'Untitled visit'}</strong> <EstimatedBadge manifest={manifest} />
          {manifest && (
            <span className="meta">
              {new Date(manifest.createdAt).toLocaleString()} · {Math.round(manifest.video.durationSec)} s
            </span>
          )}
        </div>
      </header>
      <main className="main">
        <div className="viewer-wrap">
          <SceneViewer assets={assets} overlay={(controls) => <PublicFacts assets={assets} moment={moment} controls={controls} />} />
        </div>
      </main>
    </div>
  )
}

function PublicFacts({ assets, moment, controls }: { assets: CaptureAssets; moment: Moment | null; controls: ViewerControls }) {
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
              <PublicFact key={f.id} assets={assets} fact={f} seek={seek} />
            ))}
          </ul>
        </div>
      )}
    </aside>
  )
}

function PublicFact({ assets, fact, seek }: { assets: CaptureAssets; fact: Fact; seek: (t: number) => void }) {
  return (
    <li>
      <p>{fact.text}</p>
      <div className="pub-evidence">
        {fact.evidence.map((e, k) =>
          e.type === 'frame' ? (
            <button key={k} className="frame" onClick={() => seek(e.t)} title={`Show ${fmt(e.t)}`}>
              {assets.rawUrl(e.keyframe) ? <img src={assets.rawUrl(e.keyframe)!} alt={`Keyframe at ${fmt(e.t)}`} loading="lazy" /> : null}
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
