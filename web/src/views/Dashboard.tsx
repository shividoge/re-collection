import { useEffect, useState } from 'react';

import { guide } from '../api';
import type { Progress } from '../api';

export function Dashboard({ id }: { id: string }) {
  const [data, setData] = useState<Progress | null>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    guide.progress(id).then(setData).catch((e: Error) => setError(e.message));
    guide.moment(id).then((m) => setTitle(m.moment.title)).catch(() => {});
  }, [id]);

  if (error) return <div className="center-message error">{error}</div>;
  if (!data) return <div className="center-message">Loading…</div>;

  const factText = new Map(data.facts.map((f) => [f.id, f.text]));
  const sessions = data.sessions;
  const branches = sessions.flatMap((s) => s.branches.map((b) => ({ ...b, sessionId: s.sessionId })));
  const distress = sessions.filter((s) => s.endReason === 'distress');

  return (
    <div className="dashboard">
      <a href={`#/capture/${id}`} className="back">← Back to the visit</a>
      <h1>{title || 'Recall'}</h1>
      <p className="meta">{sessions.length} revisit{sessions.length === 1 ? '' : 's'} · {data.facts.length} approved facts</p>

      <section>
        <h2>Recall over time</h2>
        {sessions.length === 0 ? (
          <p className="muted">No revisit sessions yet.</p>
        ) : (
          <RecallChart sessions={sessions} total={data.facts.length} />
        )}
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
                <span className="meta">{fmt(b.t)} · {b.note}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {distress.length > 0 && (
        <section>
          <h2>Distress alerts</h2>
          <ul>
            {distress.map((s) => (
              <li key={s.sessionId} className="error">{fmt(s.endedAt)}: session ended early. {s.note}</li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2>Suggested next revisits</h2>
        <p>{data.nextRevisit.map((d) => new Date(d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })).join(' · ')}</p>
      </section>
    </div>
  );
}

const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** One bar per session, placed by real start time (never relabelled as "day N"). */
function RecallChart({ sessions, total }: { sessions: Progress['sessions']; total: number }) {
  const W = 640, H = 220, pad = 36;
  const times = sessions.map((s) => new Date(s.startedAt).getTime());
  const min = Math.min(...times), max = Math.max(...times);
  const x = (t: number) => (max === min ? W / 2 : pad + ((t - min) / (max - min)) * (W - pad * 2));
  const y = (n: number) => H - pad - (total ? (n / total) * (H - pad * 2) : 0);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Facts recalled per session">
      <line x1={pad} x2={W - pad} y1={H - pad} y2={H - pad} stroke="currentColor" opacity=".3" />
      {sessions.map((s, i) => {
        const cx = x(times[i]);
        const bw = 22;
        const cueTop = y(s.unprompted + s.afterCue);
        const unTop = y(s.unprompted);
        return (
          <g key={s.sessionId}>
            <rect x={cx - bw / 2} y={cueTop} width={bw} height={H - pad - cueTop} fill="var(--amber)" />
            <rect x={cx - bw / 2} y={unTop} width={bw} height={H - pad - unTop} fill="var(--accent)" />
            <text x={cx} y={H - 14} textAnchor="middle" fontSize="10" fill="currentColor">{fmt(s.startedAt)}</text>
          </g>
        );
      })}
      <text x={pad} y={14} fontSize="11" fill="currentColor">of {total} facts · <tspan fill="var(--accent)">unprompted</tspan> · <tspan fill="var(--amber)">after a cue</tspan></text>
    </svg>
  );
}
