// Fact extraction (CLAUDE.md 6.2): which keyframes Claude sees, checking its facts against what it
// was shown, and merging a new extraction with the family's review. Pure; the Convex action in
// factsJob.ts does the I/O. Ported from guide/src/facts.mjs, plus frames near speech.
import { list, obj, str } from './claude'
import type { Segment } from './prompts'
import type { Evidence, Fact, Moment } from '../validators'

/** Claude sees at most this many frames per moment (CLAUDE.md 6.2). */
export const MAX_FRAMES = 30
const KINDS = new Set<Fact['kind']>(['person', 'object', 'action', 'speech', 'place', 'feeling'])

export type FreshFact = Omit<Fact, 'id' | 'status' | 'editedText' | 'doNotRaise'>
export type Chapter = Moment['chapters'][number]

/** "keyframes/k0012.jpg" -> 12, anything else -> null. */
export function keyframeSecond(name: string): number | null {
  const match = /^keyframes\/k(\d{4})\.jpg$/.exec(name)
  return match ? Number(match[1]) : null
}

/** Up to `k` items evenly spread over the list, keeping both ends. */
function spread<T>(items: T[], k: number): T[] {
  if (k <= 0) return []
  if (items.length <= k) return items
  if (k === 1) return [items[0]]
  const out = new Set<T>()
  for (let i = 0; i < k; i++) out.add(items[Math.round((i * (items.length - 1)) / (k - 1))])
  return [...out]
}

/**
 * Up to `max` keyframe names in time order: the frame nearest the middle of each stretch of
 * speech first (at most half the budget, so what was said can be matched to what was shown),
 * then evenly spread over the rest of the moment.
 */
export function chooseKeyframes(names: readonly string[], segments: readonly Segment[] | null = null, max = MAX_FRAMES): string[] {
  const frames = names.filter((n) => keyframeSecond(n) !== null).sort()
  if (frames.length <= max) return frames
  const seconds = frames.map((n) => keyframeSecond(n) ?? 0)
  const nearest = (t: number) => frames[seconds.reduce((best, s, i) => (Math.abs(s - t) < Math.abs(seconds[best] - t) ? i : best), 0)]
  const speech = [...new Set((segments ?? []).map((s) => nearest((s.start + s.end) / 2)))].sort()

  const picked = new Set(spread(speech, Math.floor(max / 2)))
  for (const name of spread(frames.filter((n) => !picked.has(n)), max - picked.size)) picked.add(name)
  return [...picked].sort()
}

/** Lowercase, drop punctuation and extra spaces, so quotes can be matched loosely. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Checks Claude's facts against what it was actually shown. Evidence that points at a keyframe it
 * wasn't given, or quotes words that aren't in the transcript, is removed; a fact left with no
 * evidence is dropped. Returns the kept facts and what was dropped and why.
 */
export function groundFacts(
  reply: unknown,
  shownFrames: Set<string>,
  segments: readonly Segment[] | null,
  durationSec: number,
): { facts: FreshFact[]; dropped: { text: string; reason: string }[]; chapters: Chapter[] } {
  const transcript = normalize((segments ?? []).map((s) => s.text).join(' '))
  const kept: FreshFact[] = []
  const dropped: { text: string; reason: string }[] = []

  for (const raw of list(obj(reply).facts)) {
    const fact = obj(raw)
    const text = str(fact.text).trim()
    if (!text) continue
    const evidence: Evidence[] = []
    for (const rawItem of list(fact.evidence)) {
      const item = obj(rawItem)
      if (item.type === 'frame') {
        const keyframe = str(item.keyframe)
        const second = keyframeSecond(keyframe)
        const isThumb = keyframe === 'thumb.jpg' && shownFrames.has('thumb.jpg')
        if ((second !== null && shownFrames.has(keyframe)) || isThumb) {
          evidence.push({ type: 'frame', t: isThumb ? 2 : (second ?? 0), keyframe })
        }
      } else if (item.type === 'transcript') {
        const quote = str(item.quote).trim()
        const start = Number(item.tStart)
        const end = Number(item.tEnd)
        const inRange = Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start && start <= durationSec + 1
        if (quote && inRange && transcript.includes(normalize(quote))) {
          evidence.push({ type: 'transcript', tStart: start, tEnd: end, quote })
        }
      }
    }
    if (evidence.length === 0) {
      dropped.push({ text, reason: 'none of its evidence matched a keyframe Claude was shown or words in the transcript' })
      continue
    }
    const kind = str(fact.kind) as Fact['kind']
    const salience = Number(fact.salience)
    kept.push({
      text,
      kind: KINDS.has(kind) ? kind : 'object',
      salience: salience === 1 || salience === 2 || salience === 3 ? salience : 1,
      evidence,
      cue: str(fact.cue).trim(),
    })
  }

  const chapters = list(obj(reply).chapters)
    .map((raw) => {
      const c = obj(raw)
      return { tStart: Math.max(0, Number(c.tStart)), tEnd: Math.min(durationSec, Number(c.tEnd)), label: str(c.label).trim() }
    })
    .filter((c) => Number.isFinite(c.tStart) && Number.isFinite(c.tEnd) && c.tEnd > c.tStart && c.label)
    .sort((a, b) => a.tStart - b.tStart)

  return { facts: kept, dropped, chapters }
}

/** Facts the family already touched: approved, rejected, reworded or marked "don't bring this up". */
export function reviewedFacts(facts: readonly Fact[] | undefined): Fact[] {
  return (facts ?? []).filter((f) => f.status !== 'pending' || f.editedText !== null || f.doNotRaise)
}

/**
 * New extraction merged with the family's review: facts they already reviewed are kept as they
 * are; pending ones are replaced. New facts get ids after the highest reviewed one. Run inside a
 * mutation against the moment as it is *now*, so review made during the Claude call survives.
 */
export function mergeFacts(previous: readonly Fact[] | undefined, fresh: readonly FreshFact[]): Fact[] {
  const reviewed = reviewedFacts(previous)
  let next = Math.max(0, ...reviewed.map((f) => Number(f.id.replace(/^f/, '')) || 0)) + 1
  const added = fresh.map((f): Fact => ({ id: `f${next++}`, ...f, status: 'pending', editedText: null, doNotRaise: false }))
  return [...reviewed, ...added]
}

/** The moment header from Claude's reply, falling back to the family's title. */
export function momentHeader(reply: unknown, title: string): Moment['moment'] {
  const m = obj(obj(reply).moment)
  return { title: str(m.title, title), place: str(m.place), occasion: str(m.occasion), summary: str(m.summary) }
}

/** Canned reply for MOCK_CLAUDE=1: clearly marked, built only from what exists. */
export function mockFactsReply(frames: readonly { name: string }[]): unknown {
  const first = frames[0]
  return {
    moment: { title: '[mock] Untitled moment', place: '', occasion: '', summary: '[mock] Mock mode is on; no real facts were extracted.' },
    facts: first
      ? [{ text: `[mock] Something is visible in ${first.name}.`, kind: 'object', salience: 1, cue: '[mock] cue', evidence: [{ type: 'frame', keyframe: first.name, tStart: null, tEnd: null, quote: null }] }]
      : [],
    chapters: [],
  }
}

/** Transcript segments from transcript.json (null when the capture has none). */
export function parseSegments(json: unknown): Segment[] {
  return list(obj(json).segments).map((raw) => {
    const s = obj(raw)
    return { start: Number(s.start) || 0, end: Number(s.end) || 0, text: str(s.text) }
  })
}
