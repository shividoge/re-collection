// The AI guide in the Memory Palace: what it may say about each memory, and the checks on what
// it does say. Pure logic, tested without a network.
//
// The caretaker writes notes for each memory in the editor ("Tell the guide about this memory"),
// and may list things never to bring up. The notes (split into short sources) and the facts the
// family approved for that visit are the only things the guide can talk about:
// - Moss indexes them per memory, so a question finds the right few in milliseconds;
// - Claude writes the intro (said while she looks at the frame), the story (said once she steps
//   in) and answers, citing a source for every sentence;
// - code drops any sentence that cites nothing it was given (one gentle free sentence is
//   allowed, under the same rules as the revisit companion), or touches what's off limits.
import { freeSentenceProblem, words } from './grounding'

export const NOTES_MAX = 2000
export const AVOID_MAX = 400
/** One Moss index for the palace; each document is tagged with the memory it belongs to. */
export const MOSS_INDEX = 'braindance-palace'
/** How many sources a question gets from Moss. */
export const ASK_TOP_K = 5

/** A memory is one piece on the wall: a capture and which piece of it hangs. */
export const memoryKey = (item: { capture: string; piece: string }) => `${item.capture}/${item.piece}`

export type Source = { id: string; text: string; kind: 'note' | 'fact' }
export type MemoryContext = {
  key: string
  title: string
  caption: string
  notes: string
  avoid: string
  facts: { id: string; text: string }[]
  /** How the person likes to be addressed ("Mom"): always allowed. */
  address: string
}

const tidy = (s: string) => s.replace(/\s+/g, ' ').trim()

/** The caretaker's notes as short sources: one per sentence or line, tiny bits merged. */
export function splitNotes(notes: string): string[] {
  const parts = notes
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9"“'‘])/)
    .map(tidy)
    .filter(Boolean)
  const out: string[] = []
  for (const p of parts) {
    if (out.length > 0 && p.length < 12) out[out.length - 1] = `${out[out.length - 1]} ${p}`
    else out.push(p)
  }
  return out
}

/** Everything the guide may use for one memory: its notes, then the visit's approved facts. */
export function sourcesOf(ctx: Pick<MemoryContext, 'title' | 'caption' | 'notes' | 'facts'>): Source[] {
  const sources: Source[] = []
  const label = [ctx.title, ctx.caption].map(tidy).filter(Boolean).join('. ')
  if (label) sources.push({ id: 'label', text: label, kind: 'note' })
  splitNotes(ctx.notes).forEach((text, i) => sources.push({ id: `n${i + 1}`, text, kind: 'note' }))
  for (const f of ctx.facts) sources.push({ id: f.id, text: tidy(f.text), kind: 'fact' })
  return sources
}

/** Moss documents for a memory: one per source, tagged with the memory. */
export function mossDocs(key: string, sources: readonly Source[]) {
  return sources.map((s) => ({ id: `${key}#${s.id}`, text: s.text, metadata: { memory: key, source: s.id } }))
}

/** Back from a Moss result to the source it came from. */
export function sourceIdOf(doc: { id: string; metadata?: Record<string, string> }): string {
  return doc.metadata?.source ?? doc.id.slice(doc.id.indexOf('#') + 1)
}

/** A short fingerprint of what the narration was written from, to know when to write it again. */
export function fingerprint(ctx: Pick<MemoryContext, 'title' | 'caption' | 'notes' | 'avoid' | 'facts'>): string {
  const s = JSON.stringify([ctx.title, ctx.caption, ctx.notes, ctx.avoid, ctx.facts.map((f) => [f.id, f.text])])
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

/** Capitalized words (names, places) in a text, lowercased, skipping each sentence's first word. */
export function namesIn(text: string): Set<string> {
  const out = new Set<string>()
  for (const sentence of text.split(/(?<=[.!?\n])\s*/)) {
    const tokens = sentence.match(/[A-Za-zÀ-ÿ'’-]+/g) ?? []
    tokens.forEach((t, i) => {
      if (i > 0 && /^[A-ZÀ-Þ]/.test(t) && t.length > 1) out.add(t.toLowerCase())
    })
  }
  return out
}

export type Proposed = { sentence?: unknown; sources?: unknown }
export type Spoken = { sentences: { sentence: string; sources: string[] }[]; dropped: { sentence: string; reason: string }[] }

/**
 * Keeps a sentence only if every source it cites was given for this memory; a sentence citing
 * nothing passes only the free-sentence rules (no names, numbers or places, except words the
 * person just said, `said`) and only once.
 * Anything touching a word that appears only in "don't bring up" is dropped, cited or not.
 */
export function groundGuide(proposed: readonly Proposed[] | null | undefined, ctx: MemoryContext, given: readonly Source[], said = '', maxFree = 1): Spoken {
  const allowed = new Set(given.map((s) => s.id))
  const known = new Set(sourcesOf(ctx).map((s) => s.text.toLowerCase()).join(' ').match(/[a-zà-ÿ'’-]+/g) ?? [])
  const offLimits = new Set([...words(ctx.avoid)].filter((w) => w.length > 3 && !known.has(w)))
  const names = new Set([...namesIn([ctx.notes, ctx.title, ctx.caption, ...ctx.facts.map((f) => f.text), ctx.avoid].join('\n'))])
  // Their form of address, and words they just said themselves, so the guide can follow their lead.
  const exempt = new Set([...(ctx.address ? words(ctx.address) : []), ...(said ? words(said) : [])])
  const out: Spoken = { sentences: [], dropped: [] }
  let free = 0
  for (const item of proposed ?? []) {
    const sentence = tidy(String(item?.sentence ?? ''))
    if (!sentence) continue
    const cites = [...new Set((Array.isArray(item?.sources) ? item.sources : []).map(String))]
    const touched = [...words(sentence)].find((w) => offLimits.has(w))
    if (touched) {
      out.dropped.push({ sentence, reason: `mentions "${touched}", which the family asked not to bring up` })
      continue
    }
    if (cites.length === 0) {
      const problem = freeSentenceProblem(sentence, names, exempt)
      if (problem) out.dropped.push({ sentence, reason: problem })
      else if (free >= maxFree) out.dropped.push({ sentence, reason: 'more than one free sentence' })
      else {
        free += 1
        out.sentences.push({ sentence, sources: [] })
      }
      continue
    }
    const unknown = cites.find((id) => !allowed.has(id))
    if (unknown) out.dropped.push({ sentence, reason: `cites ${unknown}, which wasn't given for this memory` })
    else out.sentences.push({ sentence, sources: cites })
  }
  return out
}

// ---- prompts ---------------------------------------------------------------------------------

const RULES = `You are a gentle guide in a Memory Palace: a calm gallery where a person living with dementia looks at pictures and videos from their own life, chosen by their family.
- Speak to them warmly and simply, one idea per sentence, short sentences that sound natural read aloud.
- Never quiz or test: never ask "do you remember...?". Offer the detail yourself, then leave room.
- Use ONLY the numbered sources given. Every sentence lists the source ids it relies on in "sources".
- At most one sentence may cite no source, and it must contain no names, places, dates or numbers (e.g. "It looks like a happy day.").
- If the sources don't answer, say kindly that you're not sure, citing no source.
- Never mention anything the family listed under "do not bring up".`

const sourceList = (sources: readonly Source[]) => sources.map((s) => `[${s.id}] ${s.text}`).join('\n')

export function narrationPrompt(ctx: MemoryContext, sources: readonly Source[]) {
  return {
    system: RULES,
    text: `Memory: ${ctx.title || 'untitled'}${ctx.address ? `\nThey like to be called: ${ctx.address}` : ''}
${ctx.avoid ? `Do not bring up: ${ctx.avoid}\n` : ''}
Sources:
${sourceList(sources)}

Write two things:
- "intro": 1 or 2 sentences said while they look at the frame from the gallery: what this memory is.
- "story": 3 or 4 sentences said once they've stepped inside it: the fuller story, the people, what happened.`,
  }
}

export function answerPrompt(ctx: MemoryContext, sources: readonly Source[], question: string) {
  return {
    system: RULES,
    text: `Memory: ${ctx.title || 'untitled'}${ctx.address ? `\nThey like to be called: ${ctx.address}` : ''}
${ctx.avoid ? `Do not bring up: ${ctx.avoid}\n` : ''}
Sources:
${sourceList(sources)}

They just said: "${question.slice(0, 500)}"
Answer in 1 or 2 short sentences. If it isn't a question, respond warmly to what they said, in one sentence.`,
  }
}

const sentenceList = { type: 'array', items: { type: 'object', additionalProperties: false, required: ['sentence', 'sources'], properties: { sentence: { type: 'string' }, sources: { type: 'array', items: { type: 'string' } } } } }

export const NARRATION_SCHEMA = { type: 'object', additionalProperties: false, required: ['intro', 'story'], properties: { intro: sentenceList, story: sentenceList } }
export const ANSWER_SCHEMA = { type: 'object', additionalProperties: false, required: ['sentences'], properties: { sentences: sentenceList } }

// ---- listening and remembering -------------------------------------------------------------

/** Cartesia Ink-2 takes up to 100 key terms, 1200 characters in all. */
export const KEYTERMS_MAX = 100
export const KEYTERMS_CHARS = 1200

/**
 * Names and places in the palace (from the caretaker's notes, titles and the approved facts, plus
 * the person's own name and form of address) as Cartesia key terms, so "Priya" is heard as Priya.
 */
export function keytermsOf(texts: readonly string[], extra: readonly string[] = []): string[] {
  const seen = new Map<string, string>()
  const add = (term: string) => {
    const t = tidy(term)
    if (t.length < 2 || seen.has(t.toLowerCase())) return
    seen.set(t.toLowerCase(), t)
  }
  extra.forEach(add)
  for (const text of texts) {
    for (const sentence of text.split(/(?<=[.!?\n])\s*/)) {
      const tokens = sentence.match(/[A-Za-zÀ-ÿ'’-]+/g) ?? []
      tokens.forEach((t, i) => i > 0 && /^[A-ZÀ-Þ]/.test(t) && add(t.replace(/['’]s$/, '')))
    }
  }
  const out: string[] = []
  let chars = 0
  for (const t of seen.values()) {
    if (out.length >= KEYTERMS_MAX || chars + t.length > KEYTERMS_CHARS) break
    out.push(t)
    chars += t.length
  }
  return out
}

/** What the person said, kept as a source for later in the visit (Moss remembers it). */
export const SAID_PREFIX = 'said-'
export function saidDoc(key: string, said: string, at: number) {
  const id = `${SAID_PREFIX}${at}`
  return { id: `${key}#${id}`, text: `They said: "${tidy(said).slice(0, 400)}"`, metadata: { memory: key, source: id } }
}
/** Worth remembering: more than a word or two. */
export const worthRemembering = (said: string) => tidy(said).split(' ').length >= 4

/** Joins kept sentences into what the voice says. */
export const spoken = (s: Spoken) => s.sentences.map((x) => x.sentence).join(' ')
