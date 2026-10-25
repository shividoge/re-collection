import { useCaptures, useMoment, useProgress, useProgressMany, type CaptureSummary, type Progress } from '../data'

/** Every scan with facts, and its progress (null while it loads or when it has none). Live. */
function useAllProgress() {
  const captures = useCaptures()
  const withFacts = captures.status === 'ready' ? captures.data.filter((c) => c.status.facts === 'done') : []
  const progress = useProgressMany(withFacts.map((c) => c.id))
  const rows = captures.status === 'ready' ? withFacts.map((capture) => ({ capture, progress: progress[capture.id] ?? null })) : null
  return { rows, error: captures.status === 'error' ? captures.message : null }
}

/** All scans side by side: how many revisits each had and how the latest one went. */
export function DashboardOverview() {
  const { rows, error } = useAllProgress()
  if (error) return <div className="center-message error">{error}</div>
  if (!rows) return <div className="center-message">Loading…</div>

  const sessions = rows.flatMap((r) => r.progress?.sessions ?? [])
  const alerts = sessions.flatMap((s) => s.alerts ?? []).length
  const branches = sessions.flatMap((s) => s.branches).length

  return (
    <div className="dashboard">
      <a href="#/" className="back">
        ← All visits
      </a>
      <h1>Recall across visits</h1>
      <p className="meta">
        {plural(rows.length, 'scan')} · {plural(sessions.length, 'revisit')} · {plural(branches, 'older memory', 'older memories')} ·{' '}
        {plural(alerts, 'distress alert')}
      </p>

      {rows.length === 0 ? (
        <p className="muted">No scans with approved facts yet.</p>
      ) : (
        <ul className="scan-list">
          {rows.map(({ capture, progress }) => {
            const last = progress?.sessions.at(-1)
            const total = progress?.facts.length ?? 0
            return (
              <li key={capture.id}>
                <a className="scan-row" href={`#/dashboard/${capture.id}`}>
                  {capture.thumbUrl ? <img src={capture.thumbUrl} alt="" loading="lazy" /> : <div className="thumb-missing" />}
                  <div>
                    <h2>{capture.title || 'Untitled visit'}</h2>
                    <p className="meta">
                      {fmt(capture.createdAt)} · {plural(total, 'approved fact')} ·{' '}
                      {plural(progress?.sessions.length ?? 0, 'revisit')}
                    </p>
                    <p className="meta">
                      {last
                        ? `Latest ${fmt(last.startedAt)}: ${last.unprompted} unprompted, ${last.afterCue} after a cue, of ${total}`
                        : 'No revisit sessions yet.'}
                    </p>
                  </div>
                  {progress && progress.sessions.length > 0 && <Sparkline sessions={progress.sessions} total={total} />}
                </a>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/** A tiny stacked bar per session, in session order. */
function Sparkline({ sessions, total }: { sessions: Progress['sessions']; total: number }) {
  const bw = 8
  const gap = 4
  const H = 40
  const W = sessions.length * (bw + gap)
  const h = (n: number) => (total ? (n / total) * H : 0)
  return (
    <svg className="sparkline" viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-label="Facts recalled per session">
      {sessions.map((s, i) => (
        <g key={s.sessionId}>
          <rect x={i * (bw + gap)} y={0} width={bw} height={H} fill="currentColor" opacity={0.12} />
          <rect x={i * (bw + gap)} y={H - h(s.unprompted + s.afterCue)} width={bw} height={h(s.unprompted + s.afterCue)} fill="var(--bd-warn)" />
          <rect x={i * (bw + gap)} y={H - h(s.unprompted)} width={bw} height={h(s.unprompted)} fill="var(--bd-accent)" />
          <title>{fmt(s.startedAt)}</title>
        </g>
      ))}
    </svg>
  )
}

/** Links to the other scans' dashboards. */
function ScanSwitcher({ id }: { id: string }) {
  const captures = useCaptures()
  const scans: CaptureSummary[] = captures.status === 'ready' ? captures.data.filter((c) => c.status.facts === 'done') : []
  if (scans.length < 2) return null
  return (
    <nav className="scan-switcher">
      {scans.map((capture) => (
        <a key={capture.id} href={`#/dashboard/${capture.id}`} className={capture.id === id ? 'active' : ''}>
          {capture.title || 'Untitled visit'}
        </a>
      ))}
    </nav>
  )
}

/** The family's view of recall over time (CLAUDE.md 7.5). Real session times only. */
export function Dashboard({ id }: { id: string }) {
  const progress = useProgress(id)
  const moment = useMoment(id)
  const title = moment.status === 'ready' ? (moment.data.moment?.moment.title ?? '') : ''

  if (progress.status === 'error') return <div className="center-message error">{progress.message}</div>
  if (progress.status === 'loading') return <div className="center-message">Loading…</div>
  const data: Progress = progress.data

  const factText = new Map(data.facts.map((f) => [f.id, f.text]))
  const sessions = data.sessions
  const branches = sessions.flatMap((s) => s.branches)
  const alerts = sessions.flatMap((s) => s.alerts ?? [])

  return (
    <div className="dashboard">
      <div className="dashboard-links">
        <a href="#/dashboard" className="back">
          ← All scans
        </a>
        <a href={`#/capture/${id}`} className="back">
          Open the visit
        </a>
      </div>
      <ScanSwitcher id={id} />
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
const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`

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
