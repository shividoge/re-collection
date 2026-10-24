import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { allowedFacts, groundReply, namesToGuard, soundsDistressed, words } from './grounding.mjs';
import {
  COMPANION_SYSTEM,
  NARRATION_SCHEMA,
  REPLY_SCHEMA,
  SCORING_SCHEMA,
  SCORING_SYSTEM,
  factsList,
  narrationContent,
  scoringContent,
  turnContent,
} from './prompts.mjs';

export class SessionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const END_REASONS = new Set(['complete', 'caregiver', 'distress', 'timeout']);

/** Said when everything Claude proposed was dropped, so the person never meets silence. */
const SAFE_FALLBACK = { sentence: "I'm right here with you.", factIds: [], free: true };
const SAFE_DISTRESS = { sentence: "You're safe. I'm right here with you.", factIds: [], free: true };

/**
 * Revisit sessions (docs/guide-api.md "Revisit sessions"): narration and
 * conversation from approved facts only, every reply through the grounding
 * check, distress handling, and recall scoring when the session ends.
 */
export function createSessions({ store, claude, models, dataDir }) {
  const sessionsDir = join(dataDir, 'sessions');
  const peopleFile = join(dataDir, 'people.json');

  // ---- storage ----

  async function save(session) {
    await mkdir(sessionsDir, { recursive: true });
    const path = join(sessionsDir, `${session.id}.json`);
    await writeFile(`${path}.tmp`, JSON.stringify(session, null, 2));
    await rename(`${path}.tmp`, path);
  }

  async function load(sessionId) {
    if (!SESSION_ID.test(sessionId)) throw new SessionError(400, `"${sessionId}" isn't a session id.`);
    try {
      return JSON.parse(await readFile(join(sessionsDir, `${sessionId}.json`), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') throw new SessionError(404, `No session ${sessionId}.`);
      throw error;
    }
  }

  async function person() {
    try {
      return JSON.parse(await readFile(peopleFile, 'utf8'));
    } catch {
      return { displayName: '', preferredAddress: '' };
    }
  }

  async function setPerson(body) {
    const next = {
      displayName: String(body.displayName ?? '').trim().slice(0, 80),
      preferredAddress: String(body.preferredAddress ?? '').trim().slice(0, 40),
    };
    await mkdir(dataDir, { recursive: true });
    await writeFile(peopleFile, JSON.stringify(next, null, 2));
    return next;
  }

  /** The moment, its manifest, the facts Claude may use, and the names free sentences must avoid. */
  async function context(momentId, address) {
    const moment = await store.readJson(momentId, 'moment.json');
    if (!moment) throw new SessionError(409, 'This capture has no facts yet. Extract and review them first.');
    const manifest = await store.readJson(momentId, 'manifest.json');
    const allowed = allowedFacts(moment);
    return { moment, manifest, allowed, names: namesToGuard(moment, manifest, address), allow: words(address) };
  }

  function reply(data, ctx, { distress = false, branch = false, echo } = {}) {
    const grounded = groundReply(data.sentences, { ...ctx, extended: distress || branch, echo });
    if (grounded.sentences.length === 0) grounded.sentences.push(distress ? SAFE_DISTRESS : SAFE_FALLBACK);
    return grounded;
  }

  function record(session, speaker, text, extra = {}) {
    session.turns.push({ t: new Date().toISOString(), speaker, text, ...extra });
  }

  function remember(session, grounded) {
    for (const s of grounded.sentences) for (const id of s.factIds) if (!session.said.includes(id)) session.said.push(id);
    for (const d of grounded.dropped) session.dropped.push({ t: new Date().toISOString(), ...d });
  }

  function requireActive(session) {
    if (session.endedAt) throw new SessionError(409, 'This session has ended.');
  }

  // ---- routes ----

  async function start({ momentId }) {
    if (!momentId) throw new SessionError(400, 'momentId is required.');
    if (!(await store.exists(momentId))) throw new SessionError(404, `No capture ${momentId}.`);
    const who = await person();
    const ctx = await context(momentId, who.preferredAddress);
    if (ctx.allowed.size === 0) {
      throw new SessionError(409, 'No facts are approved yet. Approve some in the review screen before starting a session.');
    }

    // The welcome is ours, not Claude's: nothing in it can be wrong.
    const greeting = `Hello${who.preferredAddress ? `, ${who.preferredAddress}` : ''}. Let's look back at a visit together.`;
    const welcome = { sentences: [{ sentence: greeting, factIds: [], free: true }], dropped: [] };
    const session = {
      id: randomUUID(),
      momentId,
      person: who,
      startedAt: new Date().toISOString(),
      endedAt: null,
      endReason: null,
      allowedFactIds: [...ctx.allowed.keys()],
      turns: [],
      said: [],
      dropped: [],
      branches: [],
      alerts: [],
      scores: null,
      note: null,
    };
    record(session, 'claude', greeting, { kind: 'welcome', factIds: [] });
    await save(session);
    return { sessionId: session.id, welcome };
  }

  async function narrate(sessionId, { chapterIndex }) {
    const session = await load(sessionId);
    requireActive(session);
    const ctx = await context(session.momentId, session.person.preferredAddress);
    const chapter = Number.isInteger(chapterIndex) ? ctx.moment.chapters[chapterIndex] : null;
    if (Number.isInteger(chapterIndex) && !chapter) throw new SessionError(400, `This moment has no chapter ${chapterIndex}.`);

    const chapterFacts = chapter
      ? [...ctx.allowed.values()]
          .filter((f) => f.evidence.some((e) => {
            const t = e.type === 'frame' ? e.t : e.tStart;
            return t >= chapter.tStart && t < chapter.tEnd;
          }))
          .map((f) => f.id)
      : [];

    const { data } = await claude.json({
      model: models.live,
      system: COMPANION_SYSTEM,
      content: [{ type: 'text', text: narrationContent({ address: session.person.preferredAddress, facts: factsList(ctx.allowed), chapter: chapter && { ...chapter, factIds: chapterFacts }, said: session.said }) }],
      schema: NARRATION_SCHEMA,
      effort: 'low',
      maxTokens: 4000,
      mock: () => mockSentences(ctx.allowed),
    });
    const grounded = reply(data, ctx);
    remember(session, grounded);
    record(session, 'claude', grounded.sentences.map((s) => s.sentence).join(' '), {
      kind: 'narration',
      chapterIndex: chapter ? chapterIndex : null,
      factIds: grounded.sentences.flatMap((s) => s.factIds),
    });
    await save(session);
    return { reply: grounded };
  }

  async function turn(sessionId, { text }) {
    const said = String(text ?? '').trim();
    if (!said) throw new SessionError(400, 'text is required: what the person said.');
    const session = await load(sessionId);
    requireActive(session);
    const ctx = await context(session.momentId, session.person.preferredAddress);
    const history = session.turns.slice(-16);
    record(session, 'patient', said);

    const flagged = soundsDistressed(said);
    const { data } = await claude.json({
      model: models.live,
      system: COMPANION_SYSTEM,
      content: [{ type: 'text', text: turnContent({ address: session.person.preferredAddress, facts: factsList(ctx.allowed), history, latest: said }) }],
      schema: REPLY_SCHEMA,
      effort: 'low',
      maxTokens: 4000,
      mock: () => ({ ...mockSentences(ctx.allowed), branch: null, distress: false }),
    });

    const distress = flagged || Boolean(data.distress);
    const branch = typeof data.branch === 'string' && data.branch.trim() ? data.branch.trim() : null;
    const grounded = reply(data, ctx, { distress, branch: Boolean(branch), echo: words(said) });
    remember(session, grounded);
    record(session, 'claude', grounded.sentences.map((s) => s.sentence).join(' '), {
      kind: 'reply',
      factIds: grounded.sentences.flatMap((s) => s.factIds),
    });

    if (branch) session.branches.push({ t: new Date().toISOString(), quote: branch, note: '' });
    if (distress) {
      session.alerts.push({
        t: new Date().toISOString(),
        kind: 'distress',
        note: `They said: "${said}"${flagged ? ' (matched a distress phrase)' : ''}.`,
      });
    }
    await save(session);
    return { reply: grounded, branch, distress };
  }

  async function end(sessionId, { reason }) {
    const session = await load(sessionId);
    if (session.endedAt) return summary(session);
    if (!END_REASONS.has(reason)) throw new SessionError(400, 'reason must be complete, caregiver, distress or timeout.');
    const ctx = await context(session.momentId, session.person.preferredAddress);
    const allowedIds = session.allowedFactIds.filter((id) => ctx.moment.facts.some((f) => f.id === id));

    session.endedAt = new Date().toISOString();
    session.endReason = reason;
    const scored = await score(session, ctx, allowedIds);
    session.scores = scored.scores;
    session.note = scored.note;
    for (const b of scored.branches) {
      if (!session.branches.some((existing) => existing.quote === b.quote)) session.branches.push({ t: session.endedAt, ...b });
    }
    await save(session);
    return summary(session);
  }

  /**
   * Scoring: Claude decides which of the person's lines carries each fact;
   * code decides whether that counts as unprompted or after a cue, from what
   * the companion had actually said before that line.
   */
  async function score(session, ctx, allowedIds) {
    const notMentioned = allowedIds.map((factId) => ({ factId, result: 'not_mentioned' }));
    const patientLines = new Map();   // line number -> index in turns
    const lines = [];
    session.turns.forEach((turn, index) => {
      const n = lines.length + 1;
      if (turn.speaker === 'patient') {
        patientLines.set(n, index);
        lines.push(`${n}. Person: ${turn.text}`);
      } else {
        lines.push(`${n}. Companion${turn.factIds?.length ? ` [${turn.factIds.join(', ')}]` : ''}: ${turn.text}`);
      }
    });
    if (patientLines.size === 0) {
      return { scores: notMentioned, branches: [], note: 'They didn\'t say anything during this session.' };
    }

    const facts = allowedIds.map((id) => {
      const fact = ctx.moment.facts.find((f) => f.id === id);
      return `${id}: ${fact.editedText ?? fact.text}`;
    }).join('\n');
    const { data } = await claude.json({
      model: models.offline,
      system: SCORING_SYSTEM,
      content: [{ type: 'text', text: scoringContent({ facts, lines }) }],
      schema: SCORING_SCHEMA,
      effort: 'high',
      maxTokens: 16000,
      mock: () => ({ scores: [], branches: [], note: '[mock] Mock mode is on; this session wasn\'t really scored.' }),
    });

    const byFact = new Map((data.scores ?? []).map((s) => [s.factId, s]));
    const scores = allowedIds.map((factId) => {
      const claimed = byFact.get(factId);
      const turnIndex = claimed && claimed.result !== 'not_mentioned' ? patientLines.get(claimed.line) : undefined;
      if (turnIndex === undefined) return { factId, result: 'not_mentioned' };
      const saidBefore = session.turns.slice(0, turnIndex).some((t) => t.speaker === 'claude' && (t.factIds ?? []).includes(factId));
      return { factId, result: saidBefore ? 'after_cue' : 'unprompted', line: claimed.line };
    });
    const branches = (data.branches ?? [])
      .map((b) => ({ quote: String(b.quote ?? '').trim(), note: String(b.note ?? '').trim() }))
      .filter((b) => b.quote);
    return { scores, branches, note: String(data.note ?? '') };
  }

  function summary(session) {
    return { scores: session.scores ?? [], branches: session.branches, note: session.note ?? '', alerts: session.alerts };
  }

  async function get(sessionId) {
    return load(sessionId);
  }

  /** Recall per session for the dashboard, with real times. */
  async function progress({ momentId }) {
    if (!momentId) throw new SessionError(400, 'momentId is required.');
    const moment = await store.readJson(momentId, 'moment.json');
    const manifest = await store.readJson(momentId, 'manifest.json');
    if (!moment || !manifest) throw new SessionError(404, `No facts for capture ${momentId}.`);

    const sessions = [];
    if (existsSync(sessionsDir)) {
      for (const name of await readdir(sessionsDir)) {
        if (!name.endsWith('.json')) continue;
        const session = JSON.parse(await readFile(join(sessionsDir, name), 'utf8'));
        if (session.momentId !== momentId || !session.endedAt) continue;
        const count = (result) => (session.scores ?? []).filter((s) => s.result === result).length;
        sessions.push({
          sessionId: session.id,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          endReason: session.endReason,
          unprompted: count('unprompted'),
          afterCue: count('after_cue'),
          notMentioned: count('not_mentioned'),
          scores: session.scores ?? [],
          branches: session.branches,
          alerts: session.alerts,
          note: session.note ?? '',
        });
      }
    }
    sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

    const visit = new Date(manifest.createdAt);
    const nextRevisit = [1, 3, 7, 14].map((days) => new Date(visit.getTime() + days * 86_400_000).toISOString());
    const facts = [...allowedFacts(moment).values()].map((f) => ({ id: f.id, text: f.text }));
    return { momentId, facts, sessions, nextRevisit };
  }

  return { start, narrate, turn, end, get, progress, person, setPerson };
}

/** Canned [mock] narration from the first approved fact, for UI work without a key. */
function mockSentences(allowed) {
  const first = [...allowed.values()][0];
  return {
    sentences: first ? [{ sentence: `[mock] ${first.text}`, factIds: [first.id], free: false }] : [],
  };
}
