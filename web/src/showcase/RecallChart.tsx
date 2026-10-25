import type { Progress } from '../api'

const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/** One bar per session, placed by real start time (never relabelled as "day N"). */
export function RecallChart({ sessions, total }: { sessions: Progress['sessions']; total: number }) {
  const W = 640
  const H = 220
  const pad = 36
  const times = sessions.map((s) => new Date(s.startedAt).getTime())
  const min = Math.min(...times)
  const max = Math.max(...times)
  const x = (t: number) => (max === min ? W / 2 : pad + ((t - min) / (max - min)) * (W - pad * 2))
  const y = (n: number) => H - pad - (total ? (n / total) * (H - pad * 2) : 0)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="recall-svg" role="img" aria-label="Facts recalled per session">
      <line x1={pad} x2={W - pad} y1={H - pad} y2={H - pad} stroke="currentColor" opacity=".3" />
      {sessions.map((s, i) => {
        const cx = x(times[i])
        const bw = 22
        const cueTop = y(s.unprompted + s.afterCue)
        const unTop = y(s.unprompted)
        return (
          <g key={s.sessionId}>
            <rect x={cx - bw / 2} y={cueTop} width={bw} height={H - pad - cueTop} fill="var(--amber)" />
            <rect x={cx - bw / 2} y={unTop} width={bw} height={H - pad - unTop} fill="var(--accent)" />
            <text x={cx} y={H - 14} textAnchor="middle" fontSize="10" fill="currentColor">
              {fmt(s.startedAt)}
            </text>
          </g>
        )
      })}
      <text x={pad} y={14} fontSize="11" fill="currentColor">
        of {total} facts · <tspan fill="var(--accent)">unprompted</tspan> · <tspan fill="var(--amber)">after a cue</tspan>
      </text>
    </svg>
  )
}
