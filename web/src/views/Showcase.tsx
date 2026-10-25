import { lazy, Suspense, useEffect, useMemo, useState } from 'react';

import { guide, publicGuide, STATIC } from '../api';
import type { CaptureDetail, Fact, Moment, Progress, PublicCapture, PublicSession } from '../api';
import { HeroCloud, MiniViewer } from '../showcase/Scenes';
import type { Layers } from '../showcase/Scenes';
import '../showcase/showcase.css';

const MemoryLane = lazy(() => import('../showcase/MemoryLane'));

type Entry = {
  capture: PublicCapture;
  detail: CaptureDetail;
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
      const list = await publicGuide.captures();
      const loaded = await Promise.all(
        list.map(async (capture): Promise<Entry> => {
          const [detail, moment, progress] = await Promise.all([
            guide.capture(capture.id),
            publicGuide.moment(capture.id).catch(() => null),
            publicGuide.progress(capture.id).catch(() => null),
          ]);
          const sessions = await Promise.all(
            (progress?.sessions ?? []).map((s) => publicGuide.session(s.sessionId).catch(() => null)),
          );
          return { capture, detail, moment, progress, sessions: sessions.filter((s): s is PublicSession => s !== null) };
        }),
      );
      if (cancelled) return;
      setEntries(loaded);
      setSceneId(loaded[0]?.capture.id ?? null);
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
      captures: entries?.length ?? 0,
      facts: entries?.reduce((n, e) => n + (e.moment?.facts.length ?? 0), 0) ?? 0,
      sessions: entries?.reduce((n, e) => n + e.sessions.length, 0) ?? 0,
    }),
    [entries],
  );

  return (
    <div className="site">
      <nav className="site-nav">
        <a href="#/" className="sn-brand"><span className="mark">◉</span> Braindance</a>
        <div className="links">
          <a href="#lane">Her museum</a>
          <a href="#how">How it works</a>
          <a href="#hood">Under the hood</a>
          {entries && entries.length > 0 && <a href="#moments">Moments</a>}
          <a href="#safety">Safety</a>
          <a href="#research">Research</a>
          <a className="sn-museum" href="#/museum"><span className="sn-long">Enter the museum</span><span className="sn-short">Museum</span> →</a>
        </div>
      </nav>

      <header className="hero">
        {lead && <HeroCloud id={lead.capture.id} />}
        <div className="hero-fade" />
        <div className="hero-copy">
          <p className="eyebrow">For families of people living with Alzheimer's</p>
          <h1>A visit they can step back into.</h1>
          <p className="lede">
            Film a visit with an iPhone. Braindance rebuilds the room and the people in it, then lets Claude walk your loved one
            through it again over the following days, saying only what you approved, and shows you which details they held on to.
          </p>
          <div className="hero-actions">
            {lead && <a className="cta" href={`#/p/${lead.capture.id}`}>Walk into a moment</a>}
            <a className="ghost" href="#how">See how it works</a>
          </div>
          {entries && entries.length > 0 && (
            <dl className="hero-stats">
              <div><dt>{totals.captures}</dt><dd>real scans</dd></div>
              <div><dt>{totals.facts}</dt><dd>facts the family approved</dd></div>
              <div><dt>{totals.sessions}</dt><dd>revisit sessions</dd></div>
            </dl>
          )}
          <p className="hero-credit">The room behind this text is a real scan, turning slowly.</p>
        </div>
      </header>

      {error && <p className="error site-note">{error}</p>}
      {!error && entries === null && <p className="site-note muted">Loading…</p>}
      {entries && entries.length === 0 && (
        <p className="site-note muted">No moment has been shared publicly yet. A family has to choose to publish one; until then there is nothing to show here.</p>
      )}

      <section className="problem reveal">
        <p>
          In Alzheimer's, a visit can be gone by the next morning. The family remembers it; they don't. A photo or a diary entry
          can remind them it happened, but it can't put them back in the room.
        </p>
        <p className="muted">
          Research on reviewing a recording of a recent event suggests that helps (Woodberry et al., 2015). Braindance makes the recording
          something they can walk back into, gently, at their pace, with the family in control of every word.
        </p>
      </section>

      {entries && entries.length > 0 && (
        <Suspense fallback={null}>
          <MemoryLane captures={entries.map((e) => e.capture)} diveId={scene?.capture.id} />
        </Suspense>
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

      <Hood entries={entries} />

      {entries && entries.length > 0 && (
        <section id="moments" className="moments reveal">
          <h2>Moments you can walk into</h2>
          <p className="muted">Shared with the permission of the people who filmed them. Orbit the room, or ride the camera and watch the replay.</p>
          <div className="moment-grid">
            {entries.map((e) => (
              <a key={e.capture.id} className="moment-card" href={`#/p/${e.capture.id}`}>
                {e.capture.thumb ? <img src={publicGuide.file(e.capture.id, 'thumb.jpg')} alt="" loading="lazy" /> : <div className="no-thumb" />}
                <div>
                  <strong>{e.capture.title || 'A visit'}</strong>
                  <span className="muted small">
                    {e.capture.durationSec ? `${Math.round(e.capture.durationSec)} s` : ''} · {e.capture.facts} approved facts
                    {e.detail.manifest.room ? ` · ${(e.detail.manifest.room.points / 1000).toFixed(0)}k room points` : ''}
                  </span>
                  <span className="walk">Walk in →</span>
                </div>
              </a>
            ))}
          </div>
        </section>
      )}

      <section id="safety" className="safety reveal">
        <h2>Safety and dignity are built in, not promised</h2>
        <div className="safety-grid">
          <Safe title="The family decides" text="Nothing reaches your loved one until a family member approves it. Anything can be marked 'don't bring this up', and code makes sure it is never said." />
          <Safe title="No invented details" text="Every sentence Claude speaks is checked against the approved facts before it plays. What fails the check is dropped and logged, never softened." />
          <Safe title="No face recognition" text="Names come from the people who filmed, never from guessing at faces. Speech is transcribed on the phone." />
          <Safe title="Gentle by design" text="Claude offers details instead of quizzing, follows their lead, and never corrects or argues. A sign of distress stops the moment and tells the family." />
          <Safe title="Honest measurement" text="Scores are never shown to them. The family sees real session times, never relabelled, and a hackathon can't claim clinical benefit." />
          <Safe title="Consent" text="Everyone filmed has to agree before a capture is published, and a capture is private until the family turns on sharing." />
        </div>
      </section>

      <section id="research" className="research reveal">
        <h2>The research, and what we can't claim</h2>
        <div className="research-grid">
          <div>
            <h3>Why it should help</h3>
            <ul>
              <li>Reviewing a recording of a recent event with a wearable camera helped people with memory impairment recall it (Woodberry et al., 2015, <em>Memory</em>).</li>
              <li>Reminiscence work is widely used in dementia care (Woods et al., 2018, Cochrane review).</li>
              <li>Spaced retrieval helps people with Alzheimer's keep new information, which is why Braindance suggests revisits at +1, +3, +7 and +14 days.</li>
            </ul>
          </div>
          <div>
            <h3>What we measure</h3>
            <ul>
              <li>Facts recalled unprompted, and after a hint, per session.</li>
              <li>Older memories the moment brought up.</li>
              <li>Session length, and how often a session ends in distress.</li>
            </ul>
          </div>
          <div>
            <h3>The pilot we would run</h3>
            <ul>
              <li>One memory-care facility. The same visit reviewed with Braindance versus a written diary.</li>
              <li>Recall tested at two weeks and at three months.</li>
              <li>This weekend's sessions show the instrument works. They do not show it helps.</li>
            </ul>
          </div>
        </div>
      </section>

      <footer className="site-footer">
        <div>
          <strong>Braindance</strong>
          <p className="muted small">Built at Cal Hacks 13.0 with the Claude API. Prior reference: the HackMIT Rumi project and Déjà View, for which APIs worked and how a guide server is shaped. No code was copied.</p>
        </div>
        <div className="foot-links">
          <a href="#how">How it works</a>
          <a href="#hood">Under the hood</a>
          {!STATIC && <a href="#/captures">Family tools</a>}
        </div>
      </footer>
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
  const m = scene.detail.manifest;
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
          <MiniViewer id={scene.capture.id} layers={current.layers} label={current.label} />
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
              {fr && fr.type === 'frame' && <img src={publicGuide.file(entry.capture.id, fr.keyframe)} alt="" loading="lazy" />}
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

function Hood({ entries }: { entries: Entry[] | null }) {
  return (
    <section id="hood" className="hood reveal">
      <p className="eyebrow">Under the hood</p>
      <h2>Small pieces, one honest loop</h2>
      <svg className="arch" viewBox="0 0 900 300" role="img" aria-label="Architecture: the iPhone app uploads to the guide server, which talks to Claude and serves the website">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill="currentColor" />
          </marker>
        </defs>
        <g className="node">
          <rect x="20" y="105" width="190" height="90" rx="12" />
          <text x="115" y="140" textAnchor="middle" className="t1">iPhone app</text>
          <text x="115" y="162" textAnchor="middle" className="t2">ARKit · LiDAR · Metal</text>
          <text x="115" y="180" textAnchor="middle" className="t2">on-device transcript</text>
        </g>
        <g className="node accent">
          <rect x="350" y="105" width="200" height="90" rx="12" />
          <text x="450" y="140" textAnchor="middle" className="t1">Guide server</text>
          <text x="450" y="162" textAnchor="middle" className="t2">Node · files on disk</text>
          <text x="450" y="180" textAnchor="middle" className="t2">grounding check (code)</text>
        </g>
        <g className="node">
          <rect x="690" y="20" width="190" height="96" rx="12" />
          <text x="785" y="52" textAnchor="middle" className="t1">Claude</text>
          <text x="785" y="74" textAnchor="middle" className="t2">Opus 5.5: facts, scoring</text>
          <text x="785" y="92" textAnchor="middle" className="t2">Sonnet 5.5: narration, talk</text>
        </g>
        <g className="node">
          <rect x="690" y="184" width="190" height="96" rx="12" />
          <text x="785" y="216" textAnchor="middle" className="t1">Website</text>
          <text x="785" y="238" textAnchor="middle" className="t2">family review · Revisit</text>
          <text x="785" y="256" textAnchor="middle" className="t2">dashboard · this page</text>
        </g>
        <g className="edge">
          <line x1="212" y1="150" x2="346" y2="150" markerEnd="url(#arrow)" />
          <line x1="552" y1="130" x2="686" y2="80" markerStart="url(#arrow)" markerEnd="url(#arrow)" />
          <line x1="552" y1="170" x2="686" y2="222" markerStart="url(#arrow)" markerEnd="url(#arrow)" />
          <text x="279" y="138" textAnchor="middle" className="t3">capture package</text>
          <text x="590" y="82" textAnchor="middle" className="t3">facts, replies</text>
          <text x="585" y="232" textAnchor="middle" className="t3">approved facts only</text>
        </g>
      </svg>

      <div className="hood-grid">
        <div>
          <h3>Two contracts, nothing implicit</h3>
          <p className="muted">The phone's capture package and the guide's API are written down. Each side is built against the document, so the pieces fit the first time.</p>
        </div>
        <div>
          <h3>Claude does the judgement, code does the rules</h3>
          <p className="muted">Claude proposes facts, narration and scores. Code decides what may be said: evidence is required, approval is required, never-mention is absolute.</p>
        </div>
        <div>
          <h3>Nothing fake</h3>
          <p className="muted">No sample data stands in for a real capture or a real session. If something is missing, the page says so. Test runs are deleted so they never reach a chart.</p>
        </div>
      </div>

      <div className="honest reveal">
        <h3>Not every scan is clean, and we show that</h3>
        <p>
          LiDAR struggles with glossy floors, bright light and big open halls. In the same hall, the Anthropic booth kept about 70% high-confidence
          depth. A scan of a lit-up sign kept 42%, and only 9% while filming, because of the shiny floor and the light. We keep the confident points and leave
          the rest empty, so you can see how sure the sensor was{entries && entries.length > 1 ? ' (try the scene switcher above)' : ''}.
        </p>
      </div>
    </section>
  );
}

function Safe({ title, text }: { title: string; text: string }) {
  return (
    <div className="safe">
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
