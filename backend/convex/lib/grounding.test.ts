// Ported from guide/test/session.test.mjs "grounding check".
import { describe, expect, test } from 'vitest'
import { allowedFacts, freeSentenceProblem, groundReply, namesToGuard, soundsDistressed } from './grounding'
import { moment } from './grounding.fixture'

const attendees = ['Priya Shah', 'Dev']

describe('grounding check', () => {
  const allowed = allowedFacts(moment)
  const names = namesToGuard(moment, attendees, 'Mom')
  const allow = new Set(['mom']) // how she likes to be addressed
  const ground = (sentences: { sentence: string; factIds: string[]; free?: boolean }[], extended = false) =>
    groundReply(sentences, { allowed, moment, names, extended, allow })

  test("only approved facts the family allows are usable, in the family's wording", () => {
    expect([...allowed.keys()]).toEqual(['f1', 'f4'])
    expect(allowed.get('f4')?.text).toBe('Dev wore his red sweater.')
  })

  test('a sentence citing an approved fact is kept', () => {
    const { sentences, dropped } = ground([{ sentence: 'Priya brought the mango cake you love.', factIds: ['f1'], free: false }])
    expect(sentences.length).toBe(1)
    expect(dropped).toEqual([])
  })

  test('an invented sentence with no fact behind it is dropped and logged', () => {
    const { sentences, dropped } = ground([
      { sentence: 'Your grandson played the piano for you.', factIds: [], free: false },
      { sentence: 'Everyone sang happy birthday.', factIds: ['f99'], free: false },
    ])
    expect(sentences.length).toBe(0)
    expect(dropped.map((d) => d.reason)).toEqual(['free sentence mentions a person ("grandson")', 'cites unknown fact f99'])
  })

  test('a "don\'t bring this up" fact never gets through, even when cited', () => {
    const { sentences, dropped } = ground([{ sentence: 'Raj told you about the war.', factIds: ['f2'], free: false }])
    expect(sentences.length).toBe(0)
    expect(dropped[0].reason).toMatch(/don't bring this up/)
  })

  test('unapproved facts are dropped', () => {
    const { dropped } = ground([{ sentence: 'There were yellow flowers.', factIds: ['f3'], free: false }])
    expect(dropped[0].reason).toMatch(/hasn't approved/)
  })

  test('one free sentence per reply, and never with a name, number, date or place', () => {
    const { sentences, dropped } = ground([
      { sentence: "It's lovely to see you, Mom.", factIds: [], free: true },
      { sentence: 'Take your time.', factIds: [], free: true },
    ])
    expect(sentences.map((s) => s.sentence)).toEqual(["It's lovely to see you, Mom."])
    expect(dropped[0].reason).toMatch(/more than 1 free sentence/)

    expect(freeSentenceProblem('Your grandson played the piano.', names)).toMatch(/person \("grandson"\)/)
    expect(freeSentenceProblem('Priya says hello.', names)).toMatch(/name "priya"/)
    expect(freeSentenceProblem('Dev is here.', names)).toMatch(/name "dev"/)
    expect(freeSentenceProblem('That was 3 weeks ago.', names)).toMatch(/number/)
    expect(freeSentenceProblem('It was a lovely Sunday.', names)).toMatch(/date/)
    expect(freeSentenceProblem('Your kitchen is so bright.', names)).toMatch(/place/)
    // Following their lead: words they just said may be echoed back.
    const echo = new Set(['my', 'father', 'had', 'a', 'workshop'])
    expect(freeSentenceProblem("What was your father's workshop like?", names, echo)).toBeNull()
    expect(freeSentenceProblem("What was your father's workshop like?", names)).toMatch(/person|place/)
    expect(freeSentenceProblem("It's nice to see you, Mom.", names, allow)).toBeNull()
  })

  test('a reassurance Claude forgot to mark free is still allowed', () => {
    const { sentences } = ground([{ sentence: "You're safe, Mom, and I'm right here with you.", factIds: [], free: false }], true)
    expect(sentences.length).toBe(1)
  })

  test('reassurance after distress, or a question about a shared memory, may use two free sentences', () => {
    const { sentences } = ground([
      { sentence: "You're safe.", factIds: [], free: true },
      { sentence: "I'm right here with you.", factIds: [], free: true },
    ], true)
    expect(sentences.length).toBe(2)
  })

  test('distress phrases are caught in code', () => {
    expect(soundsDistressed('I want to go home, where is everyone')).toBe(true)
    expect(soundsDistressed("I'm scared")).toBe(true)
    expect(soundsDistressed('Oh, I love mango cake')).toBe(false)
  })
})
