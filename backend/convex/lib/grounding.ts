/**
 * The grounding check (CLAUDE.md 6.4): code, not prompt, decides what the person with dementia
 * hears. Every sentence Claude wants to say must cite facts the family approved, or be a short
 * purely social sentence with no name, number, date or place in it. Everything else is dropped
 * and logged. Ported unchanged from guide/src/grounding.mjs.
 */
import type { Evidence, Fact, Moment } from '../validators'

/**
 * At most this many free (social) sentences per reply. Two are allowed when the person is
 * distressed (reassurance) or just shared an older memory (a warm reply plus one open question).
 */
export const MAX_FREE = 1
export const MAX_FREE_EXTENDED = 2

// Words a purely social sentence never needs. Single words, matched whole.
const NUMBER_WORDS = new Set('zero one two three four five six seven eight nine ten eleven twelve twenty thirty forty fifty hundred thousand first second third half dozen'.split(' '))
const DATE_WORDS = new Set('monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december yesterday tomorrow tonight week weekend month year birthday christmas easter thanksgiving anniversary'.split(' '))
const PLACE_WORDS = new Set('kitchen house apartment hospital church park garden school office restaurant store shop beach lake city town village street room backyard farm airport station hall lab workshop'.split(' '))
const PERSON_WORDS = new Set('grandson granddaughter grandchild grandchildren grandkids son daughter brother sister husband wife mother father mom dad mum aunt uncle cousin nephew niece friend neighbor neighbour baby kids children family doctor nurse'.split(' '))

export type AllowedFact = { id: string; text: string; cue: string; evidence: Evidence[] }
export type ProposedSentence = { sentence?: string; factIds?: string[]; free?: boolean }
export type GroundedSentence = { sentence: string; factIds: string[]; free?: boolean }
export type DroppedSentence = { sentence: string; reason: string }
export type Grounded = { sentences: GroundedSentence[]; dropped: DroppedSentence[] }

type FactsOnly = { facts: Fact[] } | Pick<Moment, 'facts'> | null | undefined

/** Which facts Claude may use: approved, not "don't bring this up", in the family's wording. */
export function allowedFacts(moment: FactsOnly): Map<string, AllowedFact> {
  const allowed = new Map<string, AllowedFact>()
  for (const fact of moment?.facts ?? []) {
    if (fact.status === 'approved' && !fact.doNotRaise) {
      allowed.set(fact.id, { id: fact.id, text: fact.editedText ?? fact.text, cue: fact.cue, evidence: fact.evidence })
    }
  }
  return allowed
}

/**
 * Names a free sentence must not contain: the people the family listed, plus capitalized words
 * inside any fact (approved or not), which are mostly names. The person's own form of address
 * ("Mom") is allowed, so "It's nice to see you, Mom." stays.
 */
export function namesToGuard(moment: FactsOnly, attendees: readonly string[] = [], preferredAddress = ''): Set<string> {
  const names = new Set<string>()
  for (const name of attendees) {
    for (const part of String(name).split(/\s+/)) if (part.length > 1) names.add(part.toLowerCase())
  }
  for (const fact of moment?.facts ?? []) {
    const ws = String(fact.editedText ?? fact.text).split(/\s+/).slice(1) // skip the sentence's first word
    for (const word of ws) {
      const clean = word.replace(/[^\p{L}'-]/gu, '')
      if (/^\p{Lu}\p{Ll}+/u.test(clean) && clean.length > 1) names.add(clean.toLowerCase())
    }
  }
  for (const part of String(preferredAddress).toLowerCase().split(/\s+/)) names.delete(part)
  return names
}

/** Lowercase words of a sentence, keeping apostrophes inside words ("father's" -> "father's", "father"). */
export function words(text: string): Set<string> {
  const out = new Set<string>()
  for (const word of String(text).toLowerCase().split(/[^\p{L}\p{N}']+/u)) {
    if (!word) continue
    out.add(word)
    out.add(word.replace(/'s$/, ''))
  }
  return out
}

/**
 * Why a free sentence isn't safe to say, or null if it is. Words the person just said themselves
 * (`echo`) are allowed, so Claude can follow their lead.
 */
export function freeSentenceProblem(sentence: string, names: Set<string>, echo: Set<string> = new Set()): string | null {
  if (/\d/.test(sentence)) return 'free sentence contains a number'
  for (const word of words(sentence)) {
    if (echo.has(word)) continue
    if (NUMBER_WORDS.has(word)) return `free sentence contains a number ("${word}")`
    if (DATE_WORDS.has(word)) return `free sentence contains a date or day ("${word}")`
    if (PLACE_WORDS.has(word)) return `free sentence names a place ("${word}")`
    if (PERSON_WORDS.has(word)) return `free sentence mentions a person ("${word}")`
    if (names.has(word)) return `free sentence contains the name "${word}"`
  }
  return null
}

export type GroundContext = {
  allowed: Map<string, AllowedFact>
  moment: FactsOnly
  names: Set<string>
  /** Distress or a new branch, which allow two free sentences. */
  extended?: boolean
  /** Words the person just said, which free sentences may repeat. */
  echo?: Set<string>
  /** Words always allowed: how the person likes to be addressed ("Mom"). */
  allow?: Set<string>
  /**
   * The facts (id → wording) Claude was given for this reply. When set, a sentence citing a fact
   * whose wording isn't the same now (the family edited it meanwhile) is dropped.
   */
  seen?: Map<string, string>
}

/**
 * A sentence that cites no fact is treated as a free sentence whether or not Claude marked it so:
 * it's kept only if it passes the free-sentence rules.
 */
export function groundReply(sentences: readonly ProposedSentence[] | null | undefined, ctx: GroundContext): Grounded {
  const { allowed, moment, names, extended = false, echo = new Set<string>(), allow = new Set<string>(), seen } = ctx
  const exempt = new Set([...echo, ...allow])
  const known = new Map((moment?.facts ?? []).map((f) => [f.id, f]))
  const maxFree = extended ? MAX_FREE_EXTENDED : MAX_FREE
  const kept: GroundedSentence[] = []
  const dropped: DroppedSentence[] = []
  let free = 0

  for (const item of sentences ?? []) {
    const sentence = String(item.sentence ?? '').trim()
    if (!sentence) continue
    const factIds = [...new Set((item.factIds ?? []).map(String))]

    if (factIds.length === 0) {
      const problem = freeSentenceProblem(sentence, names, exempt)
      if (problem) dropped.push({ sentence, reason: problem })
      else if (free >= maxFree) dropped.push({ sentence, reason: `more than ${maxFree} free sentence${maxFree === 1 ? '' : 's'} in one reply` })
      else {
        free += 1
        kept.push({ sentence, factIds: [], free: true })
      }
      continue
    }

    const problem = factIds
      .map((id) => {
        const fact = known.get(id)
        if (!fact) return `cites unknown fact ${id}`
        if (fact.doNotRaise) return `cites ${id}, which the family marked "don't bring this up"`
        const now = allowed.get(id)
        if (!now) return `cites ${id}, which the family hasn't approved`
        if (seen && !seen.has(id)) return `cites ${id}, which wasn't among the facts Claude was given`
        if (seen && seen.get(id) !== now.text) return `cites ${id}, whose wording the family changed while Claude was answering`
        return null
      })
      .find(Boolean)
    if (problem) dropped.push({ sentence, reason: problem })
    else kept.push({ sentence, factIds })
  }
  return { sentences: kept, dropped }
}

/** Words that mean the person is frightened or lost; a code-level backstop to Claude's own judgment. */
const DISTRESS = [
  /\bwant to go home\b/i,
  /\bwhere is everyone\b/i,
  /\bwhere am i\b/i,
  /\bwho are you\b/i,
  /\b(i'?m|i am) (scared|frightened|afraid|lost|confused)\b/i,
  /\bhelp me\b/i,
  /\bleave me alone\b/i,
  /\bstop (it|this)\b/i,
  /\bi don'?t (like|want) (this|it)\b/i,
]

export function soundsDistressed(text: string): boolean {
  return DISTRESS.some((pattern) => pattern.test(text))
}
