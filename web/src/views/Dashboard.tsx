import { useEffect, useState } from 'react'
import { guide } from '../api'
import type { Progress } from '../api'

/** The family's view of recall over time (CLAUDE.md 7.5). Real session times only. */
export function Dashboard({ id }: { id: string }) {
  const [data, setData] = useState<Progress | null>(null)
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    guide
      .progress(id)
      .then(setData)
      .catch((e: Error) => setError(e.message))
    guide
      .moment(id)
      .then((m) => setTitle(m.moment.title))
      .catch(() => {})
  }, [id])

  if (error) return <div className="center-message error">{error}</div>
  if (!data) return <div className="center-message">Loading…</div>

  const factText = new Map(data.facts.map((f) => [f.id, f.text]))
  const sessions = data.sessions
  const branches = sessions.flatMap((s) => s.branches)
  const alerts = sessions.flatMap((s) => s.alerts ?? [])

  return (
    <div className="dashboard">
      <a href={`#/capture/${id}`} className="back">
        ← Back to the visit
      </a>
      <h1>{title || 'Recall'}</h1>
      <p className="meta">
        {plural(sessions.length, 'revisit')} · {plural(data.facts.length, 'approved fact')}
      </p>

      <section>
        <h2>Recall over time</h2>
        {sessions.length === 0 ? <p className="muted">No revisit sessions yet.</p> : <RecallChart sessions={sessions} total={data.facts.length} />}
      </section>

      <section>
        <h2>Sessions</h2>
        <ul className="session-list">
          {sessions.map((s) => (
            <li key={s.sessionId}>
              <div className="session-head">
                <strong>{fmt(s.startedAt)}</strong>
                <span className="meta">
                  {s.unprompted} unprompted · {s.afterCue} after a cue · {s.notMentioned} not mentioned · ended: {s.endReason}
                </span>
              </div>
              {s.note && <p>{s.note}</p>}
              <details>
                <summary>Per fact</summary>
                <ul>
                  {s.scores.map((sc) => (
                    <li key={sc.factId}>
                      <span className={`pill ${sc.result}`}>{sc.result.replace('_', ' ')}</span> {factText.get(sc.factId) ?? sc.factId}
                    </li>
                  ))}
                </ul>
              </details>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Older memories it brought up</h2>
        {branches.length === 0 ? (
          <p className="muted">None yet.</p>
        ) : (
          <ul className="branches">
            {branches.map((b, i) => (
              <li key={i}>
                <blockquote>“{b.quote}”</blockquote>
                <span className="meta">
                  {fmt(b.t)} · {b.note}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {alerts.length > 0 && (
        <section>
          <h2>Distress alerts</h2>
          <ul className="alerts">
            {alerts.map((a, i) => (
              <li key={i}>
                <strong>{fmt(a.t)}</strong>
                <p className="meta">The session ended early. {a.note}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2>Suggested next revisits</h2>
        <p>{data.nextRevisit.map((d) => new Date(d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })).join(' · ')}</p>
      </section>
    </div>
  )
}

const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** One stacked bar per session, placed by real start time (never relabeled as "day N"). */
function RecallChart({ sessions, total }: { sessions: Progress['sessions']; total: number }) {
  const W = 680
  const H = 230
  const left = 60
  const right = 60
  const top = 28
  const bottom = 34
  const times = sessions.map((s) => new Date(s.startedAt).getTime())
  const min = Math.min(...times)
  const max = Math.max(...times)
  const x = (t: number) => (max === min ? (left + W - right) / 2 : left + ((t - min) / (max - min)) * (W - left - right))
  const y = (n: number) => H - bottom - (total ? (n / total) * (H - top - bottom) : 0)
  // Label a bar with its time only when it doesn't collide with the previous label.
  let lastLabel = -Infinity
  const labelled = times.map((t) => {
    const show = x(t) - lastLabel >= 90
    if (show) lastLabel = x(t)
    return show
  })
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Facts recalled per session, by session time">
      {[0, total].map((n) => (
        <g key={n}>
          <line x1={left} x2={W - right} y1={y(n)} y2={y(n)} stroke="currentColor" opacity={n === 0 ? 0.35 : 0.12} />
          <text x={left - 8} y={y(n) + 4} textAnchor="end" fontSize="10" fill="currentColor">
            {n}
          </text>
        </g>
      ))}
      {sessions.map((s, i) => {
        const cx = x(times[i])
        const bw = 22
        const cueTop = y(s.unprompted + s.afterCue)
        const unTop = y(s.unprompted)
        return (
          <g key={s.sessionId}>
            <rect x={cx - bw / 2} y={cueTop} width={bw} height={H - bottom - cueTop} fill="var(--bd-warn)" />
            <rect x={cx - bw / 2} y={unTop} width={bw} height={H - bottom - unTop} fill="var(--bd-accent)" />
            {labelled[i] && (
              <text x={cx} y={H - 12} textAnchor="middle" fontSize="10" fill="currentColor">
                {fmt(s.startedAt)}
              </text>
            )}
            <title>{fmt(s.startedAt)}</title>
          </g>
        )
      })}
      <text x={left} y={16} fontSize="11" fill="currentColor">
        facts recalled, of {total} · <tspan fill="var(--bd-accent)">unprompted</tspan> · <tspan fill="var(--bd-warn)">after a cue</tspan>
      </text>
    </svg>
  )
}
