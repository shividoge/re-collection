// Revisit sessions through the Convex functions (ported from guide/test/session.test.mjs
// "sessions through the API"), plus progress and the race the transactional grounding closes.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { moment } from './lib/grounding.fixture'
import { CAPTURE_ID, api, claude, putMoment, setup, tinyCapture, type T } from './test.helpers'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

async function ready(): Promise<T> {
  const t = setup()
  await t.mutation(api.captures.begin, { manifestJson: tinyCapture({ attendees: ['Priya Shah', 'Dev'] }).manifestJson })
  await putMoment(t, moment)
  await t.mutation(api.people.set, { displayName: 'Grandma', preferredAddress: 'Mom' })
  return t
}

describe('sessions', () => {
  let t: T
  beforeEach(async () => {
    t = await ready()
  })

  test('pointing at an object: only allowed facts reach Claude as its focus, and the turn records it', async () => {
    const { sessionId } = await t.mutation(api.sessions.start, { captureId: CAPTURE_ID })
    claude.next = () => ({ sentences: [{ sentence: 'Dev wore his red sweater.', factIds: ['f4'], free: false }], branch: null, distress: false })
    await t.action(api.sessions.turn, { sessionId, text: 'What is this?', focus: { label: 'an object about 1.2 m wide', factIds: ['f4', 'f2', 'f3', 'f99'] } })
    const prompt = claude.calls.at(-1)?.content[0]
    const text = prompt?.type === 'text' ? prompt.text : ''
    expect(text).toMatch(/pointing at something in the room \(an object about 1\.2 m wide\)\. It was on camera during these facts: f4\./)
    expect(text).not.toMatch(/during these facts: .*(f2|f3|f99)/)
    const session = await t.query(api.sessions.get, { sessionId })
    expect(session?.turns.at(-2)?.focus).toEqual({ label: 'an object about 1.2 m wide', factIds: ['f4'] })

    claude.next = () => ({ sentences: [{ sentence: "I'm not sure what that is.", factIds: [], free: true }], branch: null, distress: false })
    await t.action(api.sessions.turn, { sessionId, text: 'And this?', focus: { label: 'a wall patch', factIds: [] } })
    const second = claude.calls.at(-1)?.content[0]
    expect(second?.type === 'text' && second.text).toMatch(/None of the approved facts are about it\. If they ask what it is, gently say you're not sure; don't guess\./)
  })

  test('a full session: welcome, narration, a recalled detail, a branch, scoring, progress', async () => {
    const started = await t.mutation(api.sessions.start, { captureId: CAPTURE_ID })
    expect(started.welcome.sentences[0].sentence).toBe("Hello, Mom. Let's look back at a visit together.")
    const sessionId = started.sessionId

    // Narration: Claude tries to sneak in the do-not-raise fact; only the grounded line survives.
    claude.next = () => ({ sentences: [{ sentence: 'Dev wore his red sweater.', factIds: ['f4'], free: false }, { sentence: 'Raj told a story.', factIds: ['f2'], free: false }] })
    const narration = await t.action(api.sessions.narrate, { sessionId, chapterIndex: 0 })
    expect(narration.reply.sentences.map((s) => s.sentence)).toEqual(['Dev wore his red sweater.'])
    expect(narration.reply.dropped.length).toBe(1)
    expect(claude.calls.at(-1)?.model).toBe('sonnet')
    const narrationPrompt = claude.calls.at(-1)?.content[0]
    const np = narrationPrompt?.type === 'text' ? narrationPrompt.text : ''
    expect(np).toMatch(/f1: Priya brought a mango cake\./)
    expect(np).toMatch(/"Arriving" \(0–2 s\)\. Facts seen in this part: f1, f4\./)
    expect(np).not.toMatch(/war|yellow flowers/)
    await expect(t.action(api.sessions.narrate, { sessionId, chapterIndex: 5 })).rejects.toThrow(/no chapter 5/)

    // The person brings up the cake on their own, and an older memory.
    claude.next = () => ({
      sentences: [
        { sentence: 'Yes, Priya brought the mango cake.', factIds: ['f1'], free: false },
        { sentence: 'That sounds wonderful.', factIds: [], free: true },
        { sentence: "What was your mother's cake like?", factIds: [], free: true },
      ],
      branch: 'My mother made mango cake every summer',
      distress: false,
    })
    const turn = await t.action(api.sessions.turn, { sessionId, text: 'Was there mango cake? My mother made mango cake every summer.' })
    expect(turn.distress).toBe(false)
    expect(turn.reply.sentences.length).toBe(3) // a shared memory allows a warm reply plus one question
    expect(turn.branch).toBe('My mother made mango cake every summer')

    // Then mentions the sweater after Claude had said it.
    claude.next = () => ({ sentences: [{ sentence: "It's lovely to talk with you.", factIds: [], free: true }], branch: null, distress: false })
    await t.action(api.sessions.turn, { sessionId, text: 'Dev and that red sweater of his.' })

    // Scoring: Claude says both were recalled unprompted; code corrects the sweater to after_cue.
    claude.next = (request) => {
      expect(request.model).toBe('opus')
      return {
        scores: [{ factId: 'f1', result: 'unprompted', line: 3 }, { factId: 'f4', result: 'unprompted', line: 5 }],
        branches: [{ quote: 'My mother made mango cake every summer', note: 'Her mother baked.' }],
        note: 'She talked about the cake and her mother.',
      }
    }
    const ended = await t.action(api.sessions.end, { sessionId, reason: 'complete' })
    expect(ended.scores.map((s) => [s.factId, s.result])).toEqual([['f1', 'unprompted'], ['f4', 'after_cue']])
    expect(ended.branches.length).toBe(1) // the live branch and the scored one are the same quote
    const calls = claude.calls.length
    expect(await t.action(api.sessions.end, { sessionId, reason: 'caregiver' })).toEqual(ended) // idempotent
    expect(claude.calls.length).toBe(calls)

    const progress = await t.query(api.progress.get, { captureId: CAPTURE_ID })
    expect(progress.sessions.length).toBe(1)
    expect(progress.sessions[0]).toMatchObject({ unprompted: 1, afterCue: 1, notMentioned: 0, endReason: 'complete', note: 'She talked about the cake and her mother.' })
    expect(progress.nextRevisit).toEqual(['2026-10-25T13:34:58.000Z', '2026-10-27T13:34:58.000Z', '2026-10-31T13:34:58.000Z', '2026-11-07T13:34:58.000Z'])
    expect(progress.facts.map((f) => f.id)).toEqual(['f1', 'f4'])

    await expect(t.action(api.sessions.turn, { sessionId, text: 'hello?' })).rejects.toThrow(/has ended/)
  })

  test('chapterIndex null narrates the moment as a whole (moments without chapters)', async () => {
    const { sessionId } = await t.mutation(api.sessions.start, { captureId: CAPTURE_ID })
    claude.next = () => ({ sentences: [{ sentence: 'Priya brought a mango cake.', factIds: ['f1'], free: false }] })
    const whole = await t.action(api.sessions.narrate, { sessionId, chapterIndex: null })
    expect(whole.reply.sentences.length).toBe(1)
    const wholePrompt = claude.calls.at(-1)?.content[0]
    expect(wholePrompt?.type === 'text' && wholePrompt.text).toMatch(/The recording is playing from the start\./)
    expect((await t.query(api.sessions.get, { sessionId }))?.turns.at(-1)?.chapterIndex).toBeUndefined()
  })

  test('the distress phrase is caught even if Claude misses it, and logged as an alert', async () => {
    const { sessionId } = await t.mutation(api.sessions.start, { captureId: CAPTURE_ID })
    claude.next = () => ({ sentences: [{ sentence: 'Priya brought cake.', factIds: ['f1'], free: false }], branch: null, distress: false })
    const turn = await t.action(api.sessions.turn, { sessionId, text: 'I want to go home, where is everyone' })
    expect(turn.distress).toBe(true)
    const ended = await t.action(api.sessions.end, { sessionId, reason: 'distress' })
    expect(ended.alerts.length).toBe(1)
    expect(ended.alerts[0].note).toMatch(/want to go home/)
  })

  test('if every sentence is dropped, the person still hears something safe', async () => {
    const { sessionId } = await t.mutation(api.sessions.start, { captureId: CAPTURE_ID })
    claude.next = () => ({ sentences: [{ sentence: 'Your brother flew in on Tuesday.', factIds: [], free: false }], branch: null, distress: false })
    const turn = await t.action(api.sessions.turn, { sessionId, text: 'Who came?' })
    expect(turn.reply.sentences.map((s) => s.sentence)).toEqual(["I'm right here with you."])
    expect(turn.reply.dropped.length).toBe(1)
    expect((await t.query(api.sessions.get, { sessionId }))?.dropped.map((d) => d.sentence)).toEqual(['Your brother flew in on Tuesday.'])
  })

  test('a fact marked "don\'t bring this up" during the Claude call is still never spoken', async () => {
    const { sessionId } = await t.mutation(api.sessions.start, { captureId: CAPTURE_ID })
    claude.next = () => ({ sentences: [{ sentence: 'Priya brought the mango cake.', factIds: ['f1'], free: false }], branch: null, distress: false })
    claude.during = () => t.mutation(api.moments.patchFact, { captureId: CAPTURE_ID, factId: 'f1', doNotRaise: true }).then(() => undefined)
    const turn = await t.action(api.sessions.turn, { sessionId, text: 'Tell me about it.' })
    expect(turn.reply.sentences.map((s) => s.sentence)).toEqual(["I'm right here with you."])
    expect(turn.reply.dropped[0].reason).toMatch(/don't bring this up/)
  })

  test('a session needs approved facts, and bad requests say why', async () => {
    await expect(t.action(api.sessions.turn, { sessionId: 'not-an-id', text: 'hi' })).rejects.toThrow(/No session/)
    const { sessionId } = await t.mutation(api.sessions.start, { captureId: CAPTURE_ID })
    await expect(t.action(api.sessions.turn, { sessionId, text: '  ' })).rejects.toThrow(/text is required/)
    const empty = setup()
    await empty.mutation(api.captures.begin, { manifestJson: tinyCapture().manifestJson })
    await expect(empty.mutation(api.sessions.start, { captureId: CAPTURE_ID })).rejects.toThrow(/no facts yet/)
    await putMoment(empty, { ...moment, facts: moment.facts.map((f) => ({ ...f, status: 'pending' as const })) })
    await expect(empty.mutation(api.sessions.start, { captureId: CAPTURE_ID })).rejects.toThrow(/No facts are approved/)
  })

  test('a session where they said nothing is scored without Claude', async () => {
    const { sessionId } = await t.mutation(api.sessions.start, { captureId: CAPTURE_ID })
    const ended = await t.action(api.sessions.end, { sessionId, reason: 'timeout' })
    expect(ended.note).toBe("They didn't say anything during this session.")
    expect(ended.scores.map((s) => s.result)).toEqual(['not_mentioned', 'not_mentioned'])
    expect(claude.calls.length).toBe(0)
  })

  test('mock mode: canned [mock] replies, never the network', async () => {
    vi.stubEnv('MOCK_CLAUDE', '1')
    const { testing } = await import('./lib/claude')
    const saved = testing.client
    testing.client = null
    try {
      expect((await t.query(api.system.health, {})).mock).toBe(true)
      const { sessionId } = await t.mutation(api.sessions.start, { captureId: CAPTURE_ID })
      const { reply } = await t.action(api.sessions.narrate, { sessionId, chapterIndex: 0 })
      expect(reply.sentences[0].sentence).toBe('[mock] Priya brought a mango cake.')
    } finally {
      testing.client = saved
    }
  })
})

test('people: trimmed and capped; empty by default', async () => {
  const t = setup()
  expect(await t.query(api.people.get, {})).toEqual({ displayName: '', preferredAddress: '' })
  expect(await t.mutation(api.people.set, { displayName: '  Grandma ', preferredAddress: 'M'.repeat(50) })).toEqual({ displayName: 'Grandma', preferredAddress: 'M'.repeat(40) })
})
