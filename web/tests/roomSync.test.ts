import { describe, expect, it } from 'vitest'
import type { RoomState } from '../src/api'
import { failed, follow, intend, received, retry, roomHash, roomHere, sendFailed, sent, shown, startSync, takeNext, type RoomSync } from '../src/museum/roomSync'

const A = '11111111-1111-4111-8111-111111111111'
const state = (rev: number, p: Partial<RoomState> = {}): RoomState => ({ at: 0, atId: null, window: null, by: 'helper', name: 'Priya', rev, updatedAt: '', ...p })

/** Takes the next change to send and returns it with the new sync. */
function send(s: RoomSync) {
  const [next, intent] = takeNext(s)
  if (!intent) throw new Error('nothing to send')
  return { s: next, intent }
}

describe('received', () => {
  it('only moves forward by rev', () => {
    let s = received(startSync('helper'), state(3, { at: 3 }))
    s = received(s, state(2, { at: 2 }))
    s = received(s, state(3, { at: 9 }))
    expect(s.confirmed?.at).toBe(3)
    expect(received(s, state(4, { at: 4 })).confirmed?.at).toBe(4)
  })
})

describe('intend and takeNext', () => {
  it('sends one change at a time, and only the newest unsent one', () => {
    let s = received(startSync('helper'), state(0))
    s = intend(s, { at: 1, atId: null, window: null })
    const first = send(s)
    s = intend(first.s, { at: 2, atId: null, window: null })
    s = intend(s, { at: 3, atId: null, window: null })
    expect(takeNext(s)[1]).toBe(null)
    expect(shown(s)?.at).toBe(3)
    s = sent(s, first.intent.seq, state(1, { at: 1 }))
    expect(shown(s)?.at).toBe(3)
    const second = send(s)
    expect(second.intent.spot.at).toBe(3)
    s = sent(second.s, second.intent.seq, state(2, { at: 3 }))
    expect(s.intents).toEqual([])
    expect(shown(s)?.at).toBe(3)
  })

  it("shows this screen's newest change over a newer state from the guide until it's confirmed", () => {
    let s = received(startSync('patient'), state(0, { by: 'patient' }))
    const pending = send(intend(s, { at: 1, atId: null, window: null }))
    s = received(pending.s, state(1, { at: 2 }))
    expect(shown(s)?.at).toBe(1)
    // The guide put our change after the helper's: ours is the room's state now.
    s = sent(s, pending.intent.seq, state(2, { at: 1, by: 'patient' }))
    expect(shown(s)?.at).toBe(1)
  })
})

describe('failed', () => {
  it('finding 2: never puts an older change back over a newer confirmed state', () => {
    let s = received(startSync('patient'), state(0, { by: 'patient' }))
    const pending = send(intend(s, { at: 1, atId: null, window: null }))
    s = received(pending.s, state(1, { at: 2 }))
    s = failed(s, pending.intent.seq)
    expect(s.intents).toEqual([])
    expect(s.confirmed?.rev).toBe(1)
    expect(shown(s)?.at).toBe(2)
  })

  it('keeps an iPad change the guide missed on screen, and sends it again', () => {
    let s = received(startSync('patient'), state(0, { by: 'patient' }))
    const pending = send(intend(s, { at: 1, atId: null, window: null }))
    s = failed(pending.s, pending.intent.seq)
    expect(shown(s)?.at).toBe(1)
    expect(sendFailed(s)).toBe(false)
    expect(send(retry(s)).intent.spot.at).toBe(1)
  })

  it('drops a missed iPad change once the room moves on without it', () => {
    let s = received(startSync('patient'), state(0, { by: 'patient' }))
    const pending = send(intend(s, { at: 1, atId: null, window: null }))
    s = failed(pending.s, pending.intent.seq)
    s = received(s, state(1, { at: 5 }))
    expect(s.intents).toEqual([])
    expect(shown(s)?.at).toBe(5)
  })

  it("finding 4: the helper's phone goes back to the confirmed state and says it failed", () => {
    let s = received(startSync('helper'), state(0))
    const pending = send(intend(s, { at: 1, atId: null, window: null }))
    s = failed(pending.s, pending.intent.seq)
    expect(sendFailed(s)).toBe(true)
    expect(shown(s)?.at).toBe(0)
    s = retry(s)
    expect(sendFailed(s)).toBe(false)
    expect(shown(s)?.at).toBe(1)
  })

  it('drops a failed change that a later one replaced', () => {
    let s = received(startSync('patient'), state(0, { by: 'patient' }))
    const pending = send(intend(s, { at: 1, atId: null, window: null }))
    s = intend(pending.s, { at: 2, atId: null, window: null })
    s = failed(s, pending.intent.seq)
    expect(s.intents.map((i) => i.spot.at)).toEqual([2])
  })
})

describe('follow (the iPad)', () => {
  it("finding 1: waits for the iPad's own change, then follows a newer helper change", () => {
    let s = received(startSync('patient'), state(0, { by: 'patient' }))
    const enter = send(intend(s, { at: 0, atId: A, window: A }))
    // The guide took the step-in as rev 1, then the helper's Back as rev 2; our answer is late.
    s = received(enter.s, state(1, { by: 'patient', window: A }))
    s = received(s, state(2, { window: null }))
    expect(follow(s, 0, A)).toBe(null)
    s = sent(s, enter.intent.seq, state(1, { by: 'patient', window: A }))
    expect(follow(s, 0, A)).toEqual({ mark: 2, go: null })
  })

  it("counts the iPad's own change as followed without moving", () => {
    let s = received(startSync('patient'), state(0, { by: 'patient' }))
    const enter = send(intend(s, { at: 0, atId: A, window: A }))
    s = received(enter.s, state(1, { window: null }))
    s = sent(s, enter.intent.seq, state(2, { by: 'patient', window: A }))
    expect(follow(s, 0, A)).toEqual({ mark: 2 })
  })

  it("marks a helper's walk in the hall without moving, and ignores what it already followed", () => {
    const s = received(startSync('patient'), state(4, { at: 3 }))
    expect(follow(s, 3, null)).toEqual({ mark: 4 })
    expect(follow(s, 4, A)).toBe(null)
  })

  it('reads where the iPad is from the address', () => {
    expect(roomHere('#/memories')).toBe(null)
    expect(roomHere('#/museum')).toBe(null)
    expect(roomHere('#/museum?join=KTRB')).toBe(undefined)
    expect(roomHere(roomHash(A))).toBe(A)
    expect(roomHere(`#/window/${A}`)).toBe(undefined)
    expect(roomHere('#/memories?join=KTRB')).toBe(undefined)
    expect(roomHash(null)).toBe('#/museum')
  })
})
