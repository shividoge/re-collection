import { lazy, Suspense, useEffect, useMemo, useState } from 'react';

import { loadCaptureAssets, publicData, type CaptureAssets, type Fact, type Moment, type Progress, type PublicCapture, type PublicSession } from '../data';
import type { Layers } from '../showcase/Scenes';

// The 3D scenes (three.js) load only once the page has something to show in them, so the front
// page's first download stays small.
const HeroCloud = lazy(() => import('../showcase/Scenes').then((m) => ({ default: m.HeroCloud })));
const MiniViewer = lazy(() => import('../showcase/Scenes').then((m) => ({ default: m.MiniViewer })));
const WithCaptureAssets = lazy(() => import('../showcase/Scenes').then((m) => ({ default: m.WithCaptureAssets })));
import '../showcase/showcase.css';

const MemoryLane = lazy(() => import('../showcase/MemoryLane'));

type Entry = {
  capture: PublicCapture;
  assets: CaptureAssets;
  moment: Moment | null;
  progress: Progress | null;
  sessions: PublicSession[];
};

/**
 * The public front page. Everything on it comes from captures the family
 * marked public and from their real sessions; if there is nothing to show,
 * it says so rather than filling in.
 */
export function Showcase() {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sceneId, setSceneId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await publicData.captures();
      const loaded = await Promise.all(
        list.map(async (capture): Promise<Entry | null> => {
          // A moment that can't be read (e.g. a video still being converted) is left out, not guessed at.
          const assets = await loadCaptureAssets(capture.id, { public: true }).catch(() => null);
          if (!assets) return null;
          const [moment, progress] = await Promise.all([
            publicData.moment(capture.id).catch(() => null),
            publicData.progress(capture.id).catch(() => null),
          ]);
          const sessions = await Promise.all(
            (progress?.sessions ?? []).map((s) => publicData.session(s.sessionId).catch(() => null)),
          );
          return { capture, assets, moment, progress, sessions: sessions.filter((s): s is PublicSession => s !== null) };
        }),
      );
      if (cancelled) return;
      const ready = loaded.filter((e): e is Entry => e !== null);
      setEntries(ready);
      setSceneId(ready[0]?.capture.id ?? null);
    })().catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

  useReveal(entries);
  const lead = entries?.[0];
  const scene = entries?.find((e) => e.capture.id === sceneId) ?? lead;
  const totals = useMemo(
    () => ({
      scans: entries?.filter((e) => !isVideo(e)).length ?? 0,
      videos: entries?.filter(isVideo).length ?? 0,
      facts: entries?.reduce((n, e) => n + (e.moment?.facts.length ?? 0), 0) ?? 0,
    }),
    [entries],
  );

  return (
    <div className="site">
      <nav className="site-nav">
        <a href="#/" className="sn-brand"><SmileArc small /> Re:Collection</a>
        <div className="links">
          <a className="sn-museum" href="#/palace/edit"><span className="sn-long">Set up a Memory Palace</span><span className="sn-short">Palace</span> →</a>
        </div>
      </nav>

      <header className="hero">
        {lead && <Suspense fallback={null}><WithCaptureAssets id={lead.capture.id}>{(assets) => <HeroCloud assets={assets} />}</WithCaptureAssets></Suspense>}
        <div className="hero-fade" />
        <div className="hero-copy">
          <SmileArc />
          <p className="eyebrow">Re:Collection · for families living with Alzheimer's</p>
          <h1>A visit they can <em>step back into.</em></h1>
          <p className="lede">A family visit, or an old home video, rebuilt as a 3D room they can walk back into.</p>
          <div className="hero-actions">
            <a className="cta" href="#/palace">Enter the Memory Palace</a>
          </div>
          {entries && entries.length > 0 && (
            <dl className="hero-stats">
              <div><dt>{totals.scans}</dt><dd>iPhone scans</dd></div>
              <div><dt>{totals.videos}</dt><dd>old videos rebuilt</dd></div>
              <div><dt>{totals.facts}</dt><dd>details the family approved</dd></div>
            </dl>
          )}
        </div>
      </header>

      {error && <p className="error site-note">{error}</p>}
      {!error && entries === null && <p className="site-note muted">Loading…</p>}
      {entries && entries.length === 0 && (
        <p className="site-note muted">No moment has been shared publicly yet. A family has to choose to publish one; until then there is nothing to show here.</p>
      )}

      <section className="problem reveal">
        <p>In Alzheimer's, a visit can be gone by the next morning. A photo reminds them it happened. Re:Collection puts them back in the room.</p>
      </section>

      {entries && entries.length > 0 && (
        <Suspense fallback={null}>
          <MemoryLane captures={entries.map((e) => e.capture)} diveId={scene?.capture.id} />
        </Suspense>
      )}

      {entries && entries.length > 0 && (
        <section id="moments" className="moments reveal">
          <h2>Every room here was rebuilt</h2>
          <RoomGroup
            title="From an iPhone scan"
            how="LiDAR measures the room while the camera films the visit, so the people replay in 3D where they stood."
            entries={entries.filter((e) => !isVideo(e))}
          />
          <RoomGroup
            title="From an old video"
            how="Depth Anything 3 estimates depth in every frame of an ordinary video, and we fuse the frames into one room. Estimated, not measured."
            entries={entries.filter(isVideo)}
          />
        </section>
      )}

      {entries && scene && <Walkthrough entries={entries} scene={scene} setSceneId={setSceneId} />}

      {entries && lead && (
        <>
          <FactsStep entry={lead} />
          <ApprovalStep entry={lead} />
          <GroundingStep entry={lead} />
          <RevisitStep entry={lead} />
        </>
      )}



      <section id="safety" className="safety reveal">
        <h2>Safe by design</h2>
        <div className="safety-grid">
          <Safe title="The family decides" text="Nothing reaches them until a family member approves it, and anything can be marked 'don't bring this up'." />
          <Safe title="Nothing made up" text="Every sentence the guide says must cite an approved detail. Code checks it before it's spoken." />
          <Safe title="Gentle" text="It never quizzes or corrects, waits while they find their words, and stops at any sign of distress." />
        </div>
      </section>

      <footer className="site-footer">
        <div>
          <strong>Re:Collection</strong>
          <p className="muted small">Built at Cal Hacks 13.0 with Claude, Convex, Cartesia and Moss. Research basis: Woodberry et al., 2015 (SenseCam).</p>
        </div>
      </footer>
    </div>
  );
}

/* ---------------------------------------------------------------- mark */

/**
 * The Re:Collection mark: a smile made of LiDAR points, which also reads as a horizon at sunset.
 * The large one draws itself dot by dot (CSS, skipped under reduced motion).
 */
function SmileArc({ small = false }: { small?: boolean }) {
  const n = small ? 13 : 31;
  const w = small ? 26 : 220;
  const h = small ? 10 : 56;
  const dots = Array.from({ length: n }, (_, i) => {
    const a = Math.PI * (0.12 + (0.76 * i) / (n - 1));
    return { x: w / 2 - Math.cos(a) * (w / 2 - 3), y: 3 + Math.sin(a) * (h - 6), i };
  });
  return (
    <svg className={small ? 'smile smile-small' : 'smile'} viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden>
      <defs>
        <linearGradient id={small ? 'smile-g-s' : 'smile-g'} x1="0" x2="1">
          <stop offset="0" stopColor="#ffb35c" />
          <stop offset="1" stopColor="#ff7a8a" />
        </linearGradient>
      </defs>
      {dots.map((d) => (
        <circle key={d.i} cx={d.x} cy={d.y} r={small ? 1.3 : 2.6} fill={`url(#${small ? 'smile-g-s' : 'smile-g'})`} style={{ animationDelay: `${0.25 + d.i * 0.045}s` }} />
      ))}
    </svg>
  );
}

/* ---------------------------------------------------------------- rooms */

/** Rebuilt from an ordinary video (estimated) rather than scanned with LiDAR. */
function isVideo(e: Entry): boolean {
  return e.assets.manifest.source === 'video';
}

/** A video capture's title is its file name ("Old clip IMG_9518"); show what it is instead. */
function roomTitle(e: Entry, n: number): string {
  const t = e.capture.title?.trim();
  if (isVideo(e) && (!t || /^old clip\b/i.test(t))) return `Old home video ${n + 1}`;
  return t || 'A visit';
}

function RoomGroup({ title, how, entries }: { title: string; how: string; entries: Entry[] }) {
  if (entries.length === 0) return null;
  return (
    <div className="room-group">
      <div className="room-group-head">
        <h3>{title}</h3>
        <p className="muted">{how}</p>
      </div>
      <div className="moment-grid">
        {entries.map((e, n) => (
          <a key={e.capture.id} className="moment-card" href={`#/p/${e.capture.id}`}>
            {e.capture.thumbUrl ? <img crossOrigin="anonymous" src={e.capture.thumbUrl} alt="" loading="lazy" /> : <div className="no-thumb" />}
            <div>
              <span className="made">{isVideo(e) ? 'Rebuilt from video' : 'LiDAR scan'}</span>
              <strong>{roomTitle(e, n)}</strong>
              <span className="muted small">
                {e.capture.durationSec ? `${Math.round(e.capture.durationSec)} s` : ''}
                {e.assets.manifest.room ? ` · ${(e.assets.manifest.room.points / 1e6).toFixed(1)} M points` : ''}
              </span>
              <span className="walk">Walk in →</span>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- hooks */

/** Fades sections in as they scroll into view. */
function useReveal(dependency: unknown) {
  useEffect(() => {
    const nodes = document.querySelectorAll('.reveal:not(.in)');
    if (!('IntersectionObserver' in window)) {
      nodes.forEach((n) => n.classList.add('in'));
      return;
    }
    const io = new IntersectionObserver(
      (items) =>
        items.forEach((i) => {
          if (i.isIntersecting) {
            i.target.classList.add('in');
            io.unobserve(i.target);
          }
        }),
      { rootMargin: '0px 0px -8% 0px' },
    );
    nodes.forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, [dependency]);
}

/** Which of the given elements is nearest the middle of the screen. */
function useActiveStep(ids: string[]) {
  const [active, setActive] = useState(ids[0]);
  const key = ids.join(',');
  useEffect(() => {
    const io = new IntersectionObserver(
      (items) => items.forEach((i) => i.isIntersecting && setActive(i.target.id)),
      { rootMargin: '-42% 0px -42% 0px' },
    );
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    });
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return active;
}

/* ----------------------------------------------------- steps 1 to 3: scene */

const SCENES: { id: string; layers: Layers; label: string }[] = [
  { id: 'step-scan', layers: { room: true, path: false, people: false, video: false }, label: 'The room, as the phone measured it' },
  { id: 'step-film', layers: { room: true, path: true, people: false, video: true }, label: "The visit: the phone's path, and what it filmed" },
  { id: 'step-people', layers: { room: true, path: false, people: true, video: true }, label: 'Everything that moved, lifted into 3D from depth' },
];

function Walkthrough({ entries, scene, setSceneId }: { entries: Entry[]; scene: Entry; setSceneId: (id: string) => void }) {
  const active = useActiveStep(SCENES.map((s) => s.id));
  const current = SCENES.find((s) => s.id === active) ?? SCENES[0];
  const m = scene.assets.manifest;
  const files: [string, string][] = [
    ['room.bin', m.room ? `${m.room.points.toLocaleString()} coloured points, 1 cm apart` : 'no room scan'],
    ['video.mp4', `${Math.round(m.video.durationSec)} s, ${m.video.width}×${m.video.height}, with sound`],
    ['frames.jsonl', `the camera's exact pose for all ${m.video.frameCount} frames`],
    ['depth.bin', `${m.depth.count} depth maps, ${m.depth.width}×${m.depth.height}, ${m.depth.rateHz} a second`],
    ['confidence.bin', 'how much the sensor trusts each depth pixel'],
    ['transcript.json', m.transcript ? 'speech, transcribed on the phone' : 'speech (none in this clip)'],
    ['keyframes/', m.keyframes ? `${m.keyframes.count} stills, one a second, for Claude to read` : 'stills'],
  ];

  return (
    <section id="how" className="walk">
      <div className="walk-head reveal">
        <p className="eyebrow">How it works</p>
        <h2>From a phone to a place you can walk into</h2>
      </div>
      <div className="walk-grid">
        <div className="walk-steps">
          <article id="step-scan" className={`step ${active === 'step-scan' ? 'on' : ''}`}>
            <span className="step-n">1</span>
            <h3>Scan the room</h3>
            <p>
              An iPhone with LiDAR walks the room first. Every surface it measures becomes a coloured point, built live on the phone's graphics chip and
              exported at 1 cm. Where the sensor saw nothing, there is nothing: gaps stay empty, we never fill them in.
            </p>
            <p className="muted small">Drag the scene to look around. This is {scene.capture.title || 'a real scan'}.</p>
          </article>
          <article id="step-film" className={`step ${active === 'step-film' ? 'on' : ''}`}>
            <span className="step-n">2</span>
            <h3>Film the visit, in the same session</h3>
            <p>
              Then the visit itself. The phone keeps tracking, so the moment lines up with the room. It records video and sound, the camera's exact pose for
              every frame, and a depth map ten times a second. The orange line is where the phone went.
            </p>
            <details className="package">
              <summary>What one capture contains</summary>
              <ul>
                {files.map(([name, what]) => (
                  <li key={name}><code>{name}</code><span>{what}</span></li>
                ))}
              </ul>
            </details>
          </article>
          <article id="step-people" className={`step ${active === 'step-people' ? 'on' : ''}`}>
            <span className="step-n">3</span>
            <h3>Anything that moved comes back in 3D</h3>
            <p>
              Each video frame is lifted into 3D with its own depth map and camera pose, so people who moved are replayed in place, in time with the sound.
              The room stays still and dims; the moment plays inside it.
            </p>
            <p className="muted small">No photoreal rebuild, no guessing: just what the camera and the depth sensor actually saw.</p>
          </article>
        </div>

        <div className="walk-stage">
          <Suspense fallback={<div className="mini-viewer note">Loading the scene…</div>}><WithCaptureAssets id={scene.capture.id}>{(assets) => <MiniViewer assets={assets} layers={current.layers} label={current.label} />}</WithCaptureAssets></Suspense>
          {entries.length > 1 && (
            <div className="scene-pills" role="group" aria-label="Choose a scan">
              {entries.map((e) => (
                <button key={e.capture.id} className={e.capture.id === scene.capture.id ? 'on' : ''} onClick={() => setSceneId(e.capture.id)}>
                  {e.capture.title || 'A visit'}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------ steps 4 to 8: data */

function StepShell({ n, title, text, id, children }: { n: string; title: string; text: React.ReactNode; id?: string; children?: React.ReactNode }) {
  return (
    <section id={id} className="data-step reveal">
      <div className="data-step-text">
        <span className="step-n">{n}</span>
        <h3>{title}</h3>
        <div className="step-copy">{text}</div>
      </div>
      <div className="data-step-demo">{children}</div>
    </section>
  );
}

function frameOf(fact: Fact) {
  return fact.evidence.find((e) => e.type === 'frame');
}

function FactsStep({ entry }: { entry: Entry }) {
  const facts = (entry.moment?.facts ?? []).filter((f) => frameOf(f)).slice(0, 6);
  return (
    <StepShell
      n="4"
      title="Claude reads the visit, and shows its evidence"
      text={
        <>
          <p>
            Claude (Opus 5.5) looks at up to thirty keyframes and the transcript and proposes small, checkable details. Each one points at the frame or
            the words behind it, so the family can see exactly why Claude said it.
          </p>
          <p>No evidence, no fact: a claim with nothing behind it is thrown away by code before anyone sees it.</p>
          {entry.moment && entry.moment.chapters.length > 0 && (
            <p className="chips">
              {entry.moment.chapters.map((c) => (
                <span key={c.tStart} className="chip static"><span className="mono">{Math.round(c.tStart)}s</span> {c.label}</span>
              ))}
            </p>
          )}
        </>
      }
    >
      <ul className="fact-cards">
        {facts.map((f) => {
          const fr = frameOf(f);
          return (
            <li key={f.id}>
              {fr && fr.type === 'frame' && entry.assets.rawUrl(fr.keyframe) && <img crossOrigin="anonymous" src={entry.assets.rawUrl(fr.keyframe)!} alt="" loading="lazy" />}
              <div>
                <p>{f.text}</p>
                <span className="muted small">{fr && fr.type === 'frame' ? `evidence: frame at ${Math.round(fr.t)} s` : ''} · {f.kind}</span>
              </div>
            </li>
          );
        })}
        {facts.length === 0 && <li className="muted">No facts to show yet.</li>}
      </ul>
    </StepShell>
  );
}

function ApprovalStep({ entry }: { entry: Entry }) {
  const facts = (entry.moment?.facts ?? []).slice(0, 4);
  return (
    <StepShell
      n="5"
      title="The family decides what is said"
      text={
        <>
          <p>
            Nothing reaches your loved one until someone in the family approves it. They can reword a fact, reject it, or mark it
            <strong> don't bring this up</strong>, for someone who has since died or a day that hurts.
          </p>
          <p>Facts that were rejected, still waiting, or marked never-mention aren't just hidden: they are removed from everything Claude is allowed to use, and from this public page.</p>
        </>
      }
    >
      <div className="review">
        <div className="review-head"><strong>Family review</strong><span className="muted small">{entry.moment?.facts.length ?? 0} approved by the family</span></div>
        {facts.map((f) => (
          <div key={f.id} className="review-row">
            <span className="tag-pill ok">✓ Approved</span>
            <p>{f.text}</p>
          </div>
        ))}
        <div className="review-actions" aria-hidden>
          <span>Approve</span><span>Reject</span><span>Edit wording</span><span>Don't bring this up</span>
        </div>
      </div>
    </StepShell>
  );
}

function GroundingStep({ entry }: { entry: Entry }) {
  const session = entry.sessions[0];
  const factText = new Map((entry.moment?.facts ?? []).map((f) => [f.id, f.text]));
  const lines = (session?.turns ?? []).filter((t) => t.speaker === 'claude' && t.kind !== 'welcome').slice(0, 5);
  const held = entry.sessions.reduce((n, s) => n + s.dropped.length, 0);
  return (
    <StepShell
      n="6"
      title="Every sentence is checked by code before they hear it"
      id="grounding"
      text={
        <>
          <p>Claude answers as sentences, each tagged with the facts it relies on. Before anything is spoken, plain code checks every one:</p>
          <ol className="checks">
            <li>It cites a fact that exists.</li>
            <li>That fact is one the family approved.</li>
            <li>It isn't marked <em>don't bring this up</em>.</li>
            <li>A sentence with no fact behind it can't contain a name, number, date, place or relationship word, and there's at most one per reply.</li>
          </ol>
          <p>If it fails, the sentence is dropped and logged. If nothing survives, they hear a fixed, safe line instead of silence.</p>
        </>
      }
    >
      <div className="grounded">
        <p className="muted small">Real sentences from a real session, and the facts each one rests on.</p>
        {lines.map((t, i) => (
          <div key={i} className="g-line">
            <p>{t.text}</p>
            <div className="g-facts">
              {(t.factIds ?? []).map((id) => (
                <span key={id} className="g-fact" title={factText.get(id) ?? id}>
                  fact {id}
                </span>
              ))}
            </div>
          </div>
        ))}
        {lines.length === 0 && <p className="muted">No session yet.</p>}
        <p className="g-held">
          {held > 0
            ? `${held} sentence(s) held back by the check so far.`
            : "Held back by the check so far: 0. When Claude tries something the facts don't support, it appears here, struck through, with the reason."}
        </p>
      </div>
    </StepShell>
  );
}

function RevisitStep({ entry }: { entry: Entry }) {
  const session = entry.sessions[0];
  const talked = entry.sessions.some((s) => s.turns.some((t) => t.speaker === 'patient'));
  const lines = (session?.turns ?? []).filter((t) => t.speaker === 'claude' && t.kind !== 'welcome');
  return (
    <StepShell
      n="7"
      title="A gentle revisit, spoken at their pace"
      text={
        <>
          <p>
            On a tablet they see the room appear and the moment replay at three-quarter speed. At each chapter Claude narrates a few warm sentences, then
            they can talk back with one big button.
          </p>
          <ul className="features">
            <li>Calm, high-contrast screen, large type, one button.</li>
            <li>Claude offers a detail and leaves room, and never quizzes.</li>
            <li>If they connect it to an older memory, Claude shows interest and the family sees it later.</li>
            <li>Confusion or fear stops the moment, reassures them, and alerts the family.</li>
            <li>A caregiver can end it at any time; it ends by itself after ten minutes.</li>
          </ul>
        </>
      }
    >
      <div className="transcript">
        <p className="muted small">
          {session
            ? `Narration from a real session, ${new Date(session.startedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.${
                talked ? '' : ' No loved one has used this capture yet, so only Claude speaks.'
              }`
            : 'No session yet.'}
        </p>
        {lines.map((t, i) => (
          <p key={i} className="claude">
            <span>Claude</span> {t.text}
          </p>
        ))}
        {entry.sessions
          .flatMap((s) => s.turns)
          .filter((t) => t.speaker === 'patient')
          .slice(0, 4)
          .map((t, i) => (
            <p key={`p${i}`} className="her">
              <span>Loved one</span> {t.text}
            </p>
          ))}
      </div>
    </StepShell>
  );
}

/* ------------------------------------------------------------ under the hood */

function Safe({ title, text }: { title: string; text: string }) {
  return (
    <div className="safe">
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
