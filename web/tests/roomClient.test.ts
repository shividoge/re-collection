import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GuideError, type Room, type RoomChange, type RoomState, type RoomWho } from '../src/api'
import { KEEP_MS, POLL_MS, RETRY_MS, RoomClient, STREAM_GRACE_MS, acquireRoom, type RoomEvents, type RoomTransport } from '../src/museum/roomClient'
import { follow, sendFailed, shown } from '../src/museum/roomSync'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const state = (rev: number, p: Partial<RoomState> = {}): RoomState => ({ at: 0, atId: null, window: null, by: 'helper', name: 'Priya', rev, updatedAt: '', ...p })

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

class FakeEvents implements RoomEvents {
  readonly listeners = new Map<string, ((e: { data?: unknown }) => void)[]>()
  closed = false
  addEventListener(type: string, listener: (e: { data?: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  close() {
    this.closed = true
  }
  emit(type: string, data?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data: data === undefined ? undefined : JSON.stringify(data) })
  }
}

/** A guide whose answers the test hands out one by one. */
function fakeGuide() {
  const posts: { change: RoomChange; answer: Deferred<{ state: RoomState }> }[] = []
  const polls: { since: number | null; answer: Deferred<Room | null> }[] = []
  const streams: FakeEvents[] = []
  const transport: RoomTransport = {
    setState: (_code, change) => {
      const answer = deferred<{ state: RoomState }>()
      posts.push({ change, answer })
      return answer.promise
    },
    poll: (_code, _who, since) => {
      const answer = deferred<Room | null>()
      polls.push({ since, answer })
      return answer.promise
    },
    events: () => {
      const events = new FakeEvents()
      streams.push(events)
      return events
    },
  }
  return { transport, posts, polls, streams }
}

const patient: RoomWho = { as: 'patient', name: null, client: 'ipad-tab-1' }
const helper: RoomWho = { as: 'helper', name: 'Priya', client: 'phone-tab-1' }
const settle = () => vi.advanceTimersByTimeAsync(0)

function connect(who: RoomWho, first: RoomState) {
  const guide = fakeGuide()
  const client = new RoomClient('KTRB', who, guide.transport)
  client.start()
  guide.streams[0].emit('state', first)
  return { guide, client, sync: () => client.getSnapshot().sync }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('RoomClient', () => {
  it('goes live on the first state from the stream', () => {
    const { client } = connect(helper, state(0, { by: 'patient', name: null }))
    expect(client.getSnapshot().status).toBe('live')
    expect(shown(client.getSnapshot().sync)).toEqual({ at: 0, atId: null, window: null })
    client.stop()
  })

  it('finding 1: the iPad follows a helper Back that came in while its own step-in was unconfirmed', async () => {
    const { guide, client, sync } = connect(patient, state(0, { by: 'patient', name: null }))
    client.change(() => ({ at: 0, atId: A, window: A }))
    guide.streams[0].emit('state', state(1, { by: 'patient', name: null, window: A, atId: A }))
    guide.streams[0].emit('state', state(2, { window: null, atId: A }))
    expect(follow(sync(), 0, A)).toBe(null)
    guide.posts[0].answer.resolve({ state: state(1, { by: 'patient', name: null, window: A, atId: A }) })
    await settle()
    expect(follow(sync(), 0, A)).toEqual({ mark: 2, go: null })
    client.stop()
  })

  it('finding 2: a failed iPad change never covers a newer helper move', async () => {
    const { guide, client, sync } = connect(patient, state(0, { by: 'patient', name: null }))
    client.change(() => ({ at: 1, atId: null, window: null }))
    guide.streams[0].emit('state', state(1, { at: 2 }))
    guide.posts[0].answer.reject(new GuideError(500, 'boom'))
    await settle()
    expect(sync().confirmed?.rev).toBe(1)
    expect(shown(sync())?.at).toBe(2)
    await vi.advanceTimersByTimeAsync(RETRY_MS * 2)
    expect(guide.posts).toHaveLength(1)
    client.stop()
  })

  it('the iPad walks alone when the guide misses a change, and sends it again', async () => {
    const { guide, client, sync } = connect(patient, state(0, { by: 'patient', name: null }))
    client.change(() => ({ at: 1, atId: null, window: null }))
    guide.posts[0].answer.reject(new GuideError(0, "Can't reach the guide server."))
    await settle()
    expect(shown(sync())?.at).toBe(1)
    expect(client.getSnapshot().status).toBe('live')
    await vi.advanceTimersByTimeAsync(RETRY_MS)
    expect(guide.posts).toHaveLength(2)
    expect(guide.posts[1].change).toMatchObject({ at: 1, by: 'patient', name: null })
    guide.posts[1].answer.resolve({ state: state(1, { at: 1, by: 'patient', name: null }) })
    await settle()
    expect(sync().intents).toEqual([])
    client.stop()
  })

  it('finding 3: a helper Next right after stepping in keeps the moment open', async () => {
    const { guide, client } = connect(helper, state(0, { by: 'patient', name: null }))
    client.change(() => ({ at: 0, atId: A, window: A }))
    client.change((now) => ({ at: 1, atId: B, window: now?.window ?? null }))
    expect(guide.posts).toHaveLength(1)
    guide.posts[0].answer.resolve({ state: state(1, { atId: A, window: A }) })
    await settle()
    expect(guide.posts[1].change).toMatchObject({ at: 1, atId: B, window: A, by: 'helper', name: 'Priya' })
    client.stop()
  })

  it('finding 3: move, step in, Back sends the frame that was chosen', async () => {
    const { guide, client } = connect(helper, state(0, { by: 'patient', name: null }))
    client.change(() => ({ at: 1, atId: A, window: null }))
    client.change(() => ({ at: 2, atId: B, window: B }))
    client.change((now) => ({ at: now?.at ?? -1, atId: now?.atId ?? null, window: null }))
    guide.posts[0].answer.resolve({ state: state(1, { at: 1, atId: A }) })
    await settle()
    expect(guide.posts).toHaveLength(2)
    expect(guide.posts[1].change).toMatchObject({ at: 2, atId: B, window: null })
    client.stop()
  })

  it("finding 4: a helper change that fails is shown on the helper's phone, and can be sent again", async () => {
    const { guide, client, sync } = connect(helper, state(0, { by: 'patient', name: null }))
    client.change(() => ({ at: 1, atId: null, window: null }))
    guide.posts[0].answer.reject(new GuideError(500, 'boom'))
    await settle()
    expect(sendFailed(sync())).toBe(true)
    expect(shown(sync())?.at).toBe(0)
    // Never retried behind the helper's back.
    await vi.advanceTimersByTimeAsync(RETRY_MS * 2)
    expect(guide.posts).toHaveLength(1)
    client.retry()
    expect(guide.posts[1].change).toMatchObject({ at: 1 })
    guide.posts[1].answer.resolve({ state: state(1, { at: 1 }) })
    await settle()
    expect(sendFailed(sync())).toBe(false)
    expect(shown(sync())?.at).toBe(1)
    client.stop()
  })

  it('polls when the stream sends nothing, sends back the version, and ignores older states', async () => {
    const guide = fakeGuide()
    const client = new RoomClient('KTRB', helper, guide.transport)
    client.start()
    await vi.advanceTimersByTimeAsync(STREAM_GRACE_MS)
    expect(guide.streams[0].closed).toBe(true)
    expect(guide.polls[0].since).toBe(null)
    guide.polls[0].answer.resolve({ code: 'KTRB', state: state(5, { at: 5 }), peers: { patient: 1, helpers: ['Priya'] }, version: 9 })
    await settle()
    expect(client.getSnapshot()).toMatchObject({ status: 'live', peers: { patient: 1, helpers: ['Priya'] } })
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(guide.polls[1].since).toBe(9)
    guide.polls[1].answer.resolve(null)
    await vi.advanceTimersByTimeAsync(POLL_MS)
    guide.polls[2].answer.resolve({ code: 'KTRB', state: state(4, { at: 4 }), peers: { patient: 1, helpers: ['Priya'] }, version: 10 })
    await settle()
    expect(shown(client.getSnapshot().sync)?.at).toBe(5)
    client.stop()
  })

  it('a stream error switches to polling at once, and a 404 means the room is gone', async () => {
    const guide = fakeGuide()
    const client = new RoomClient('KTRB', helper, guide.transport)
    client.start()
    guide.streams[0].emit('error')
    expect(guide.polls).toHaveLength(1)
    guide.polls[0].answer.reject(new GuideError(404, 'No such room.'))
    await settle()
    expect(client.getSnapshot().status).toBe('gone')
    expect(client.closed).toBe(true)
  })

  it('a 404 on a change means the room is gone', async () => {
    const { guide, client } = connect(patient, state(0, { by: 'patient', name: null }))
    client.change(() => ({ at: 1, atId: null, window: null }))
    guide.posts[0].answer.reject(new GuideError(404, 'No such room.'))
    await settle()
    expect(client.getSnapshot().status).toBe('gone')
  })
})

describe('acquireRoom', () => {
  it("keeps the iPad's room, and its unsent change, across the switch from museum to window", async () => {
    const guide = fakeGuide()
    const museum = acquireRoom('KTRB', patient, guide.transport)
    guide.streams[0].emit('state', state(0, { by: 'patient', name: null }))
    museum.client.change(() => ({ at: 0, atId: A, window: A }))
    museum.release()
    const window = acquireRoom('KTRB', patient, guide.transport)
    expect(window.client).toBe(museum.client)
    expect(guide.streams).toHaveLength(1)
    expect(shown(window.client.getSnapshot().sync)?.window).toBe(A)
    window.release()
    await vi.advanceTimersByTimeAsync(KEEP_MS)
    expect(window.client.closed).toBe(true)
    const again = acquireRoom('KTRB', patient, guide.transport)
    expect(again.client).not.toBe(window.client)
    again.client.stop()
  })
})
