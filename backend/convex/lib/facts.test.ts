// Ported from guide/test/facts.test.mjs (pure parts), plus keyframes near speech.
import { describe, expect, test } from 'vitest'
import { FACTS_SCHEMA, factsContent } from './prompts'
import { chooseKeyframes, groundFacts, mergeFacts, momentHeader } from './facts'
import { goodReply } from './facts.fixture'
import type { Fact } from '../validators'

const kf = (k: number) => `keyframes/k${String(k).padStart(4, '0')}.jpg`

describe('keyframe choice', () => {
  test('keyframes are spread evenly when there are more than 30', () => {
    const names = Array.from({ length: 90 }, (_, k) => kf(k))
    const picked = chooseKeyframes([...names, 'thumb.jpg', 'room.bin'])
    expect(picked.length).toBe(30)
    expect(picked[0]).toBe('keyframes/k0000.jpg')
    expect(picked.at(-1)).toBe('keyframes/k0089.jpg')
    expect(chooseKeyframes(['keyframes/k0001.jpg', 'keyframes/k0000.jpg'])).toEqual(['keyframes/k0000.jpg', 'keyframes/k0001.jpg'])
  })

  test('frames near speech are always included, still capped at 30', () => {
    const names = Array.from({ length: 300 }, (_, k) => kf(k))
    const segments = [{ start: 40.2, end: 41.6, text: 'Mango cake!' }, { start: 201, end: 203, text: 'Look at the garden.' }]
    const picked = chooseKeyframes(names, segments)
    expect(picked.length).toBe(30)
    expect(picked).toContain(kf(41))
    expect(picked).toContain(kf(202))
    expect(picked[0]).toBe(kf(0))
    expect(picked.at(-1)).toBe(kf(299))
    expect([...picked].sort()).toEqual(picked)
  })

  test('lots of speech takes at most half the frames', () => {
    const names = Array.from({ length: 300 }, (_, k) => kf(k))
    const segments = Array.from({ length: 100 }, (_, i) => ({ start: i * 3, end: i * 3 + 1, text: 'x' }))
    const picked = chooseKeyframes(names, segments)
    expect(picked.length).toBe(30)
    expect(picked[0]).toBe(kf(0))
  })
})

describe('grounding facts in the evidence', () => {
  test('facts are only kept with evidence Claude was actually given', () => {
    const segments = [{ start: 0.4, end: 1.6, text: 'Mom, I brought the mango cake!' }]
    const shown = new Set(['keyframes/k0000.jpg', 'keyframes/k0001.jpg'])
    const { facts, dropped, chapters } = groundFacts(goodReply, shown, segments, 2)
    expect(facts.length).toBe(1)
    expect(facts[0].text).toBe('Priya brought a mango cake.')
    expect(facts[0].evidence).toEqual([
      { type: 'transcript', tStart: 0.4, tEnd: 1.6, quote: 'I brought the mango cake' },
      { type: 'frame', t: 1, keyframe: 'keyframes/k0001.jpg' },
    ])
    expect(dropped.length).toBe(1)
    expect(dropped[0].text).toBe('Grandpa played the piano.')
    expect(chapters).toEqual([{ tStart: 0, tEnd: 2, label: 'Arriving' }]) // clipped to the recording
  })

  test('quotes match despite case and punctuation, but not different words', () => {
    const segments = [{ start: 0, end: 2, text: "It's so GOOD to see you, Mom." }]
    const reply = (quote: string) => ({ facts: [{ text: 'x', kind: 'speech', salience: 1, cue: '', evidence: [{ type: 'transcript', tStart: 0, tEnd: 2, quote }] }] })
    expect(groundFacts(reply("it's so good to see you mom"), new Set(), segments, 2).facts.length).toBe(1)
    expect(groundFacts(reply("it's great to see you"), new Set(), segments, 2).facts.length).toBe(0)
  })

  test('the thumbnail counts as a frame only when it was shown', () => {
    const reply = { facts: [{ text: 'A table.', kind: 'object', salience: 1, cue: '', evidence: [{ type: 'frame', keyframe: 'thumb.jpg' }] }] }
    expect(groundFacts(reply, new Set(['thumb.jpg']), null, 2).facts[0].evidence).toEqual([{ type: 'frame', t: 2, keyframe: 'thumb.jpg' }])
    expect(groundFacts(reply, new Set(), null, 2).facts.length).toBe(0)
  })

  test('odd kinds and saliences fall back to safe values', () => {
    const reply = { facts: [{ text: 'A cat.', kind: 'animal', salience: 9, cue: 7, evidence: [{ type: 'frame', keyframe: kf(0) }] }] }
    const [fact] = groundFacts(reply, new Set([kf(0)]), null, 2).facts
    expect(fact).toMatchObject({ kind: 'object', salience: 1, cue: '7' })
  })
})

describe('merging with the review', () => {
  const fact = (id: string, text: string, status: Fact['status'], extra: Partial<Fact> = {}): Fact => ({
    id, text, status, editedText: null, doNotRaise: false, kind: 'object', salience: 1, evidence: [], cue: '', ...extra,
  })

  test('re-extracting keeps what the family already reviewed', () => {
    const previous = [fact('f1', 'A', 'approved'), fact('f2', 'B', 'pending'), fact('f3', 'C', 'rejected')]
    const merged = mergeFacts(previous, [{ text: 'D', kind: 'object', salience: 1, evidence: [], cue: '' }])
    expect(merged.map((f) => [f.id, f.text, f.status])).toEqual([['f1', 'A', 'approved'], ['f3', 'C', 'rejected'], ['f4', 'D', 'pending']])
  })

  test('a pending fact the family reworded or marked counts as reviewed', () => {
    const previous = [fact('f1', 'A', 'pending', { editedText: 'A!' }), fact('f2', 'B', 'pending', { doNotRaise: true }), fact('f3', 'C', 'pending')]
    expect(mergeFacts(previous, []).map((f) => f.id)).toEqual(['f1', 'f2'])
  })

  test('the moment header falls back to the family title', () => {
    expect(momentHeader({}, 'Sunday')).toEqual({ title: 'Sunday', place: '', occasion: '', summary: '' })
    expect(momentHeader(goodReply, 'Sunday').title).toBe('Cake visit')
  })
})

test('the prompt carries names, transcript, labeled keyframes and what was already reviewed', () => {
  const content = factsContent(
    { title: 'Cake visit', attendees: ['Priya'], durationSec: 2 },
    [{ start: 0.4, end: 1.6, text: 'Mom, I brought the mango cake!' }],
    [{ name: kf(1), t: 1, base64: 'AA==' }],
    ['Priya brought Mom a mango cake.'],
  )
  const intro = content[0].type === 'text' ? content[0].text : ''
  expect(intro).toMatch(/People the family says were there: Priya/)
  expect(intro).toMatch(/\[0\.4–1\.6\] Mom, I brought the mango cake!/)
  expect(intro).toMatch(/already reviewed these facts[\s\S]*- Priya brought Mom a mango cake\./)
  expect(content.filter((b) => b.type === 'image').length).toBe(1)
  expect(content.some((b) => b.type === 'text' && b.text === 'keyframes/k0001.jpg (t = 1 s)')).toBe(true)
  expect(FACTS_SCHEMA.required).toEqual(['moment', 'facts', 'chapters'])
  expect(factsContent({ title: '', attendees: [], durationSec: 1 }, null, [])[0]).toMatchObject({ text: expect.stringMatching(/Transcript: none/) })
})
