import { useEffect, useState } from 'react';

import { guide, publicGuide } from '../api';
import type { CaptureDetail, Moment, Progress, PublicCapture, PublicSession } from '../api';
import { RecallChart } from './Dashboard';

type Featured = {
  capture: PublicCapture;
  detail: CaptureDetail;
  moment: Moment | null;
  progress: Progress | null;
  session: PublicSession | null;
};

/**
 * The public front page: no key, read-only. Everything on it comes from
 * captures the family marked public, so it shows real data or nothing.
 */
export function Showcase() {
  const [captures, setCaptures] = useState<PublicCapture[] | null>(null);
  const [featured, setFeatured] = useState<Featured | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await publicGuide.captures();
      if (cancelled) return;
      setCaptures(list);
      if (list.length === 0) return;
      const capture = list[0];
      const [detail, moment, progress] = await Promise.all([
        guide.capture(capture.id),
        publicGuide.moment(capture.id).catch(() => null),
        publicGuide.progress(capture.id).catch(() => null),
      ]);
      const latest = progress?.sessions.at(-1);
      const session = latest ? await publicGuide.session(latest.sessionId).catch(() => null) : null;
      if (!cancelled) setFeatured({ capture, detail, moment, progress, session });
    })().catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

  const lead = captures?.[0];
  return (
    <div className="showcase">
      <nav className="show-nav">
        <a href="#/" className="brand"><span className="mark">◉</span> Braindance</a>
        <div>
          <a href="#how">How it works</a>
          {captures && captures.length > 0 && <a href="#moments">Moments</a>}
          <a href="#research">Research</a>
        </div>
      </nav>

      <header className="hero">
        <p className="eyebrow">For families of people living with Alzheimer's</p>
        <h1>A visit she can step back into.</h1>
        <p className="lede">
          Film a visit with an iPhone. Braindance rebuilds the room and the people in it, then lets Claude walk your
          loved one through it again over the following days, using only what you approved, and shows you which details she held on to.
        </p>
        {lead && (
          <div className="hero-actions">
            <a className="cta" href={`#/p/${lead.id}`}>Walk into a moment</a>
            <a className="ghost" href="#how">See how it works</a>
          </div>
        )}
      </header>

      {error && <p className="error show-note">{error}</p>}
      {!error && captures === null && <p className="show-note muted">Loading…</p>}
      {captures && captures.length === 0 && (
        <p className="show-note muted">
          No moment has been shared publicly yet. A family has to choose to publish one; until then there is nothing to show here.
        </p>
      )}

      {featured && <FeaturedClip featured={featured} />}

      <section id="how" className="steps">
        <h2>How it works</h2>
        <Step n="1" title="Film the visit" text="An iPhone with LiDAR scans the room, then records the visit: video, sound, depth and where the camera was, all in one session. Speech is transcribed on the phone.">
          {featured && <Stats detail={featured.detail} />}
        </Step>
        <Step n="2" title="Claude finds the facts, and shows its evidence" text="Claude reads the keyframes and transcript and proposes small, checkable details. Each one points at the frame or the words that support it. A fact with no evidence is thrown away by code.">
          {featured?.moment && <Facts moment={featured.moment} captureId={featured.capture.id} />}
        </Step>
        <Step n="3" title="The family decides what is said" text="Nothing reaches your loved one until a family member approves it. Anything can be marked 'don't bring this up', for someone who has since died, and it is never mentioned.">
          {featured?.moment && <Approved moment={featured.moment} />}
        </Step>
        <Step n="4" title="A revisit, spoken gently" text="She watches the moment again, with the people replayed in 3D from depth. Claude narrates and talks with her, offering details instead of quizzing. Every sentence is checked by code against the approved facts before she hears it.">
          {featured?.session && <Transcript session={featured.session} />}
        </Step>
        <Step n="5" title="The family sees what stayed" text="After each session Claude notes which details she brought up on her own, which only after a hint, and any older memory the moment stirred. Times are the real times of the sessions.">
          {featured?.progress && featured.progress.sessions.length > 0 && <Recall progress={featured.progress} />}
        </Step>
      </section>

      {captures && captures.length > 0 && (
        <section id="moments" className="moments">
          <h2>Moments you can walk into</h2>
          <p className="muted">Shared by the families who filmed them. Orbit the room, or ride the camera and watch the people replay.</p>
          <div className="moment-grid">
            {captures.map((c) => (
              <a key={c.id} className="moment-card" href={`#/p/${c.id}`}>
                {c.thumb ? <img src={publicGuide.file(c.id, 'thumb.jpg')} alt="" loading="lazy" /> : <div className="thumb-missing" />}
                <div>
                  <strong>{c.title || 'A visit'}</strong>
                  <span className="muted small">
                    {c.durationSec ? `${Math.round(c.durationSec)} s` : ''} · {c.facts} approved facts
                  </span>
                </div>
              </a>
            ))}
          </div>
        </section>
      )}

      <section id="research" className="research">
        <h2>Why this, and what it can't claim</h2>
        <p>
          Reviewing a recording of a recent event with a wearable camera helped people with memory impairment remember it better
          (Woodberry et al., 2015, <em>Memory</em>). Reminiscence work is widely used in dementia care, and spaced retrieval helps people keep new information.
          Braindance turns those ideas into a moment you can walk into again.
        </p>
        <p className="muted">
          A hackathon can't prove clinical benefit. The sessions you see here are real sessions run on the dates shown, nothing is simulated, and the pilot
          we'd run is the same visit reviewed with Braindance versus a written diary, recalled at two weeks and three months.
        </p>
        <p className="muted small">
          Built at Cal Hacks 13.0 with the Claude API. Prior reference: the HackMIT Rumi project and Déjà View, for which APIs worked and how a guide server is shaped; no code was copied.
        </p>
      </section>

      <footer className="show-footer">
        <span>Braindance · Cal Hacks 13.0</span>
        <a href="#/captures">Family tools</a>
      </footer>
    </div>
  );
}

function FeaturedClip({ featured }: { featured: Featured }) {
  const { capture, detail } = featured;
  const video = detail.manifest.video;
  return (
    <section className="clip">
      <video
        src={publicGuide.file(capture.id, video.file)}
        poster={capture.thumb ? publicGuide.file(capture.id, 'thumb.jpg') : undefined}
        controls
        muted
        loop
        playsInline
        preload="metadata"
      />
      <div>
        <p className="eyebrow">The visit, as filmed</p>
        <h2>{capture.title || 'A visit'}</h2>
        {capture.summary && <p>{capture.summary}</p>}
        <a className="cta" href={`#/p/${capture.id}`}>Walk into it</a>
      </div>
    </section>
  );
}

function Step({ n, title, text, children }: { n: string; title: string; text: string; children?: React.ReactNode }) {
  return (
    <article className="step">
      <div className="step-text">
        <span className="step-n">{n}</span>
        <h3>{title}</h3>
        <p>{text}</p>
      </div>
      {children && <div className="step-demo">{children}</div>}
    </article>
  );
}

function Stats({ detail }: { detail: CaptureDetail }) {
  const m = detail.manifest;
  const rows: [string, string][] = [
    ['Length', `${Math.round(m.video.durationSec)} s of video`],
    ['Room', m.room ? `${m.room.points.toLocaleString()} points` : 'no room scan'],
    ['Depth', `${m.depth.count} frames at ${m.depth.rateHz} Hz`],
    ['Keyframes', m.keyframes ? `${m.keyframes.count}` : 'none'],
    ['Transcript', m.transcript ? 'on the phone' : 'none'],
  ];
  return (
    <dl className="stats">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Facts({ moment, captureId }: { moment: Moment; captureId: string }) {
  const shown = moment.facts.slice(0, 4);
  return (
    <ul className="fact-demo">
      {shown.map((f) => {
        const frame = f.evidence.find((e) => e.type === 'frame');
        const quote = f.evidence.find((e) => e.type === 'transcript');
        return (
          <li key={f.id}>
            {frame && frame.type === 'frame' && <img src={publicGuide.file(captureId, frame.keyframe)} alt="" loading="lazy" />}
            <div>
              <p>{f.text}</p>
              <span className="muted small">
                {quote && quote.type === 'transcript' ? `“${quote.quote}”` : frame && frame.type === 'frame' ? `seen at ${Math.round(frame.t)} s` : ''}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Approved({ moment }: { moment: Moment }) {
  return (
    <p className="approved">
      <strong>{moment.facts.length}</strong> facts approved by the family. Facts that were rejected, still unchecked, or marked
      "don't bring this up" are not published and never spoken.
    </p>
  );
}

function Transcript({ session }: { session: PublicSession }) {
  const turns = session.turns.filter((t) => t.kind !== 'welcome').slice(0, 8);
  return (
    <div className="transcript">
      <p className="muted small">
        A real session, {new Date(session.startedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
      </p>
      {turns.map((t, i) => (
        <p key={i} className={t.speaker === 'patient' ? 'her' : 'claude'}>
          <span>{t.speaker === 'patient' ? 'Loved one' : 'Claude'}</span> {t.text}
        </p>
      ))}
      {session.dropped.length > 0 ? (
        <div className="held-back">
          <strong>Held back by the grounding check ({session.dropped.length}):</strong>
          {session.dropped.slice(0, 3).map((d, i) => (
            <p key={i}>
              <s>{d.sentence}</s> <span className="muted small">{d.reason}</span>
            </p>
          ))}
        </div>
      ) : (
        <p className="muted small">The grounding check held nothing back in this session: every sentence was backed by an approved fact.</p>
      )}
    </div>
  );
}

function Recall({ progress }: { progress: Progress }) {
  const latest = progress.sessions.at(-1)!;
  return (
    <div>
      <RecallChart sessions={progress.sessions} total={progress.facts.length} />
      {latest.note && <p className="muted small">{latest.note}</p>}
      {latest.branches.length > 0 && <p className="branch">An older memory came up: “{latest.branches[0].quote}”</p>}
    </div>
  );
}
