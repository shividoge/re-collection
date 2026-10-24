import { useCallback, useEffect, useState } from 'react'

import { captureFileUrl, guide, GuideError } from '../api'
import type { CaptureStatus, Fact, FactChange, Moment } from '../api'
import type { Seek } from '../scene/SceneViewer'

/**
 * Family review (CLAUDE.md 6.3): every fact Claude extracted, next to the
 * evidence that backs it. Nothing reaches the patient until it's approved
 * here. Clicking evidence seeks the video to that moment.
 */
export function FactsPanel({ captureId, onSeek }: { captureId: string; onSeek: Seek }) {
  const [moment, setMoment] = useState<Moment | null>(null)
  const [status, setStatus] = useState<CaptureStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showDropped, setShowDropped] = useState(false)

  const load = useCallback(async () => {
    try {
      const detail = await guide.capture(captureId)
      setStatus(detail.status)
      if (detail.status.facts === 'done') {
        setMoment(await guide.moment(captureId))
        setError(null)
      }
    } catch (e) {
      setError((e as GuideError).message)
    }
  }, [captureId])

  useEffect(() => {
    void load()
  }, [load])

  // While Claude is working, check back every few seconds.
  const working = status?.facts === 'queued' || status?.facts === 'running'
  useEffect(() => {
    if (!working) return
    const timer = setInterval(() => void load(), 3000)
    return () => clearInterval(timer)
  }, [working, load])

  async function change(fact: Fact, update: FactChange) {
    try {
      const saved = await guide.updateFact(captureId, fact.id, update)
      setMoment((m) => m && { ...m, facts: m.facts.map((f) => (f.id === saved.id ? saved : f)) })
    } catch (e) {
      setError(`Couldn't save: ${(e as GuideError).message}`)
    }
  }

  async function reextract() {
    try {
      await guide.reextract(captureId)
      setStatus((s) => s && { ...s, facts: 'queued', factsError: null })
    } catch (e) {
      setError((e as GuideError).message)
    }
  }

  if (!status)
    return (
      <section className="facts-panel">
        <p className="muted">Loading facts…</p>
      </section>
    )

  if (status.upload !== 'done') {
    return (
      <section className="facts-panel">
        <p className="muted">Facts are extracted once the whole capture has uploaded.</p>
      </section>
    )
  }

  if (working || status.facts === 'not_started') {
    return (
      <section className="facts-panel">
        <div className="working">
          <span className="pulse" aria-hidden />
          <div>
            <p>{status.facts === 'running' ? 'Claude is reading the keyframes and transcript…' : 'Waiting for Claude…'}</p>
            <p className="muted small">Usually under a minute. Facts appear here for you to check.</p>
          </div>
        </div>
      </section>
    )
  }

  if (status.facts === 'failed') {
    return (
      <section className="facts-panel">
        <p className="error">Fact extraction failed: {status.factsError}</p>
        <button onClick={() => void reextract()}>Try again</button>
      </section>
    )
  }

  if (!moment) return <section className="facts-panel">{error ? <p className="error">{error}</p> : <p className="muted">Loading facts…</p>}</section>

  const approved = moment.facts.filter((f) => f.status === 'approved').length
  const pending = moment.facts.filter((f) => f.status === 'pending').length

  return (
    <section className="facts-panel">
      <header className="facts-header">
        <div className="facts-title">
          <h2>Facts</h2>
          <span className="count">
            {approved} approved · {pending} to check
          </span>
        </div>
        {moment.moment.summary && <p className="summary">{moment.moment.summary}</p>}
        {moment.chapters.length > 0 && (
          <div className="chapters">
            {moment.chapters.map((c) => (
              <button key={c.tStart} onClick={() => onSeek(c.tStart, true)}>
                {formatTime(c.tStart)} {c.label}
              </button>
            ))}
          </div>
        )}
        <p className="muted small">Only facts you approve are ever said to your loved one.</p>
      </header>

      {error && <p className="error small">{error}</p>}

      <ol className="facts">
        {moment.facts.map((fact) => (
          <FactCard key={fact.id} captureId={captureId} fact={fact} onChange={(u) => void change(fact, u)} onSeek={onSeek} />
        ))}
      </ol>

      <footer className="facts-footer">
        {moment.dropped.length > 0 && (
          <div className="dropped">
            <button className="link" onClick={() => setShowDropped((v) => !v)}>
              {showDropped ? '▾' : '▸'} The grounding check removed {moment.dropped.length} {moment.dropped.length === 1 ? 'fact' : 'facts'}
            </button>
            {showDropped && (
              <ul>
                {moment.dropped.map((d, k) => (
                  <li key={k}>
                    <s>{d.text}</s> <span className="muted small">— {d.reason}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <p className="muted small">
          Extracted by {moment.model} from {moment.inputs.keyframes} keyframes
          {moment.inputs.transcriptSegments === null ? ', no transcript' : ` and ${moment.inputs.transcriptSegments} transcript lines`}.
        </p>
        <button className="link" onClick={() => void reextract()}>
          Ask Claude again (keeps what you've reviewed)
        </button>
      </footer>
    </section>
  )
}

function FactCard({ captureId, fact, onChange, onSeek }: { captureId: string; fact: Fact; onChange: (update: FactChange) => void; onSeek: Seek }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(fact.editedText ?? fact.text)
  const shown = fact.editedText ?? fact.text

  return (
    <li className={`fact ${fact.status} ${fact.doNotRaise ? 'do-not-raise' : ''}`}>
      <div className="fact-top">
        <span className={`status-pill ${fact.status}`}>{statusLabel(fact)}</span>
        <span className="kind">{fact.kind}</span>
        <span className="salience" title={`Memorable: ${fact.salience} of 3`}>
          {'●'.repeat(fact.salience)}
          <span className="dim">{'●'.repeat(3 - fact.salience)}</span>
        </span>
      </div>

      {editing ? (
        <form
          className="edit"
          onSubmit={(e) => {
            e.preventDefault()
            const text = draft.trim()
            onChange({ editedText: text && text !== fact.text ? text : null })
            setEditing(false)
          }}
        >
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} autoFocus />
          <div className="row">
            <button type="submit">Save wording</button>
            <button type="button" className="link" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <p className="fact-text">{shown}</p>
      )}
      {fact.editedText && !editing && <p className="muted small">Claude wrote: “{fact.text}”</p>}

      <div className="evidence">
        {fact.evidence.map((e, k) =>
          e.type === 'frame' ? (
            <button key={k} className="frame" onClick={() => onSeek(e.t)} title={`Show ${formatTime(e.t)}`}>
              <img src={captureFileUrl(captureId, e.keyframe)} alt={`Keyframe at ${formatTime(e.t)}`} loading="lazy" />
              <span>{formatTime(e.t)}</span>
            </button>
          ) : (
            <button key={k} className="quote" onClick={() => onSeek(e.tStart, true)} title="Play this moment">
              “{e.quote}” <span className="muted">{formatTime(e.tStart)}</span>
            </button>
          ),
        )}
      </div>
      {fact.cue && <p className="cue">Hint: {fact.cue}</p>}

      <div className="actions">
        <button
          className={fact.status === 'approved' ? 'on approve' : 'approve'}
          onClick={() => onChange({ status: fact.status === 'approved' ? 'pending' : 'approved' })}
        >
          {fact.status === 'approved' ? '✓ Approved' : 'Approve'}
        </button>
        <button
          className={fact.status === 'rejected' ? 'on reject' : 'reject'}
          onClick={() => onChange({ status: fact.status === 'rejected' ? 'pending' : 'rejected' })}
        >
          {fact.status === 'rejected' ? 'Rejected' : 'Reject'}
        </button>
        <button
          onClick={() => {
            setDraft(shown)
            setEditing(true)
          }}
        >
          Edit
        </button>
        <label className="toggle">
          <input type="checkbox" checked={fact.doNotRaise} onChange={(e) => onChange({ doNotRaise: e.target.checked })} />
          Don't bring this up
        </label>
      </div>
    </li>
  )
}

function statusLabel(fact: Fact) {
  if (fact.doNotRaise) return 'Never mention'
  return { pending: 'To check', approved: 'Approved', rejected: 'Rejected' }[fact.status]
}

function formatTime(seconds: number) {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
