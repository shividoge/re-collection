// Revisit sessions (docs/guide-api.md "Revisit sessions"): narration and conversation from
// approved facts only, every reply through the grounding check, distress handling, recall
// scoring, and the dashboard's progress. Pure; sessions.ts does the I/O. Ported from
// guide/src/session.mjs.
import { list, obj, str, type JsonRequest } from './claude'
import { allowedFacts, groundReply, namesToGuard, words, type AllowedFact, type Grounded, type ProposedSentence } from './grounding'
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
  type Focus,
} from './prompts'
import type { Moment, Session } from '../validators'

type Turn = Session['turns'][number]
type Score = NonNullable<Session['scores']>[number]
type Branch = Session['branches'][number]
type Models = { offline: string; live: string }

/** Said when everything Claude proposed was dropped, so the person never meets silence. */
export const SAFE_FALLBACK = { sentence: "I'm right here with you.", factIds: [], free: true }
export const SAFE_DISTRESS = { sentence: "You're safe. I'm right here with you.", factIds: [], free: true }

/** The welcome is ours, not Claude's: nothing in it can be wrong. */
export function welcomeSentence(address: string): string {
  return `Hello${address ? `, ${address}` : ''}. Let's look back at a visit together.`
}

/** Everything the grounding check needs, from the moment as it is now. */
export function groundingContext(moment: Moment, attendees: readonly string[], address: string) {
  return { moment, allowed: allowedFacts(moment), names: namesToGuard(moment, attendees, address), allow: words(address) }
}
export type GroundingContext = ReturnType<typeof groundingContext>

/** Grounds Claude's sentences; if nothing survives, a fixed safe sentence. */
export function finalReply(
  sentences: readonly ProposedSentence[],
  ctx: GroundingContext,
  { distress = false, branch = false, echo, seen }: { distress?: boolean; branch?: boolean; echo?: Set<string>; seen?: Map<string, string> } = {},
): Grounded {
  const grounded = groundReply(sentences, { ...ctx, extended: distress || branch, echo, seen })
  if (grounded.sentences.length === 0) grounded.sentences.push(distress ? SAFE_DISTRESS : SAFE_FALLBACK)
  return grounded
}

/** Fact ids Claude has now said, added to what the session had already said. */
export function addSaid(said: readonly string[], grounded: Grounded): string[] {
  const out = [...said]
  for (const s of grounded.sentences) for (const id of s.factIds) if (!out.includes(id)) out.push(id)
  return out
}

export function replyText(grounded: Grounded): string {
  return grounded.sentences.map((s) => s.sentence).join(' ')
}

/** Allowed facts with evidence inside a chapter. */
export function chapterFactIds(allowed: Map<string, AllowedFact>, chapter: { tStart: number; tEnd: number }): string[] {
  return [...allowed.values()]
    .filter((f) => f.evidence.some((e) => {
      const t = e.type === 'frame' ? e.t : e.tStart
      return t >= chapter.tStart && t < chapter.tEnd
    }))
    .map((f) => f.id)
}

/**
 * What the person is pointing at in the 3D room: a short label and the approved facts that were
 * on camera with it. Only allowed facts survive, so a "don't bring this up" fact can never get in
 * this way. Null when absent.
 */
export function cleanFocus(focus: Focus | null | undefined, allowed: Map<string, AllowedFact>): Focus | null {
  if (!focus) return null
  const label = String(focus.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
  const factIds = [...new Set(focus.factIds.filter((id) => allowed.has(id)))]
  return { label, factIds }
}

/** The allowed facts, the focused ones first (for mock replies). */
function focusedFacts(allowed: Map<string, AllowedFact>, focus: Focus | null): Map<string, AllowedFact> {
  if (!focus?.factIds.length) return allowed
  return new Map([...focus.factIds.map((id): [string, AllowedFact] => [id, allowed.get(id) as AllowedFact]), ...allowed])
}

/** Canned [mock] narration from the first approved fact, for UI work without a key. */
function mockSentences(allowed: Map<string, AllowedFact>) {
  const first = [...allowed.values()][0]
  return { sentences: first ? [{ sentence: `[mock] ${first.text}`, factIds: [first.id], free: false }] : [] }
}

export function narrationRequest(p: {
  models: Models
  address: string
  allowed: Map<string, AllowedFact>
  chapter: { label: string; tStart: number; tEnd: number } | null
  said: string[]
}): JsonRequest {
  const chapter = p.chapter && { ...p.chapter, factIds: chapterFactIds(p.allowed, p.chapter) }
  return {
    model: p.models.live,
    system: COMPANION_SYSTEM,
    content: [{ type: 'text', text: narrationContent({ address: p.address, facts: factsList(p.allowed), chapter, said: p.said }) }],
    schema: NARRATION_SCHEMA,
    effort: 'low',
    maxTokens: 4000,
    timeoutMs: 60_000,
    maxRetries: 1,
    mock: () => mockSentences(p.allowed),
  }
}

export function turnRequest(p: {
  models: Models
  address: string
  allowed: Map<string, AllowedFact>
  history: Turn[]
  latest: string
  focus: Focus | null
}): JsonRequest {
  return {
    model: p.models.live,
    system: COMPANION_SYSTEM,
    content: [{ type: 'text', text: turnContent({ address: p.address, facts: factsList(p.allowed), history: p.history, latest: p.latest, focus: p.focus }) }],
    schema: REPLY_SCHEMA,
    effort: 'low',
    maxTokens: 4000,
    timeoutMs: 60_000,
    maxRetries: 1,
    mock: () => ({ ...mockSentences(focusedFacts(p.allowed, p.focus)), branch: null, distress: false }),
  }
}

/** Claude's sentences / branch / distress from its JSON reply. */
export function readReply(data: unknown): { sentences: ProposedSentence[]; branch: string | null; distress: boolean } {
  const d = obj(data)
  const sentences = list(d.sentences).map((raw) => {
    const s = obj(raw)
    return { sentence: str(s.sentence), factIds: list(s.factIds).map((id) => str(id)), free: s.free === true }
  })
  const branch = typeof d.branch === 'string' && d.branch.trim() ? d.branch.trim() : null
  return { sentences, branch, distress: d.distress === true }
}

// ---- scoring ----------------------------------------------------------------------------

/** The numbered conversation Claude scores, and which line numbers are the person's (-> turn index). */
export function scoringLines(turns: readonly Turn[]): { lines: string[]; patientLines: Map<number, number> } {
  const patientLines = new Map<number, number>()
  const lines: string[] = []
  turns.forEach((turn, index) => {
    const n = lines.length + 1
    if (turn.speaker === 'patient') {
      patientLines.set(n, index)
      lines.push(`${n}. Person: ${turn.text}`)
    } else {
      lines.push(`${n}. Companion${turn.factIds?.length ? ` [${turn.factIds.join(', ')}]` : ''}: ${turn.text}`)
    }
  })
  return { lines, patientLines }
}

export function scoringRequest(models: Models, moment: Moment, allowedIds: string[], lines: string[]): JsonRequest {
  const facts = allowedIds
    .map((id) => {
      const fact = moment.facts.find((f) => f.id === id)
      return `${id}: ${fact ? (fact.editedText ?? fact.text) : ''}`
    })
    .join('\n')
  return {
    model: models.offline,
    system: SCORING_SYSTEM,
    content: [{ type: 'text', text: scoringContent({ facts, lines }) }],
    schema: SCORING_SCHEMA,
    effort: 'high',
    maxTokens: 16000,
    timeoutMs: 3 * 60_000,
    maxRetries: 1,
    mock: () => ({ scores: [], branches: [], note: "[mock] Mock mode is on; this session wasn't really scored." }),
  }
}

export const NOTHING_SAID_NOTE = "They didn't say anything during this session."

/**
 * Claude decides which of the person's lines carries each fact; code decides whether that counts
 * as unprompted or after a cue, from what the companion had actually said before that line.
 */
export function applyScores(
  data: unknown,
  allowedIds: readonly string[],
  turns: readonly Turn[],
  patientLines: Map<number, number>,
): { scores: Score[]; branches: { quote: string; note: string }[]; note: string } {
  const d = obj(data)
  const byFact = new Map(list(d.scores).map((raw) => {
    const s = obj(raw)
    return [str(s.factId), { result: str(s.result), line: Number(s.line) }] as const
  }))
  const scores = allowedIds.map((factId): Score => {
    const claimed = byFact.get(factId)
    const turnIndex = claimed && claimed.result !== 'not_mentioned' ? patientLines.get(claimed.line) : undefined
    if (claimed === undefined || turnIndex === undefined) return { factId, result: 'not_mentioned' }
    const saidBefore = turns.slice(0, turnIndex).some((t) => t.speaker === 'claude' && (t.factIds ?? []).includes(factId))
    return { factId, result: saidBefore ? 'after_cue' : 'unprompted', line: claimed.line }
  })
  const branches = list(d.branches)
    .map((raw) => {
      const b = obj(raw)
      return { quote: str(b.quote).trim(), note: str(b.note).trim() }
    })
    .filter((b) => b.quote)
  return { scores, branches, note: str(d.note) }
}

/** Live branches plus scored ones whose quote is new. */
export function mergeBranches(existing: readonly Branch[], scored: readonly { quote: string; note: string }[], t: string): Branch[] {
  const out = [...existing]
  for (const b of scored) if (!out.some((e) => e.quote === b.quote)) out.push({ t, ...b })
  return out
}

// ---- dashboard --------------------------------------------------------------------------

/** Visit +1, +3, +7, +14 days, as ISO times. */
export function nextRevisit(createdAt: string): string[] {
  const visit = new Date(createdAt).getTime()
  if (!Number.isFinite(visit)) return []
  return [1, 3, 7, 14].map((days) => new Date(visit + days * 86_400_000).toISOString())
}

/** Recall per finished session for the dashboard, with real times, oldest first. */
export function progressReport(captureId: string, moment: Moment | null, createdAt: string, sessions: readonly Session[]) {
  const rows = sessions
    .filter((s) => s.captureId === captureId && s.endedAt)
    .map((s) => {
      const count = (result: Score['result']) => (s.scores ?? []).filter((x) => x.result === result).length
      return {
        sessionId: s.sessionId,
        startedAt: s.startedAt,
        endedAt: s.endedAt ?? '',
        endReason: s.endReason ?? '',
        unprompted: count('unprompted'),
        afterCue: count('after_cue'),
        notMentioned: count('not_mentioned'),
        scores: s.scores ?? [],
        branches: s.branches,
        alerts: s.alerts,
        note: s.note ?? '',
      }
    })
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const facts = [...allowedFacts(moment).values()].map((f) => ({ id: f.id, text: f.text }))
  return { captureId, facts, sessions: rows, nextRevisit: nextRevisit(createdAt) }
}
