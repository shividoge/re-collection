import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Room, RoomChange, RoomPeers, RoomState, RoomWho } from '../src/data/types'
import { HEARTBEAT_MS, KEEP_MS, RETRY_MS, RoomClient, acquireRoom, type RoomTransport } from '../src/museum/roomClient'
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

/** A Convex room whose answers the test hands out one by one. */
function fakeGuide() {
  const posts: { change: RoomChange; answer: Deferred<{ state: RoomState }> }[] = []
  const watchers: { onRoom: (room: Room | null) => void; onError: (e: unknown) => void; stopped: boolean }[] = []
  const beats: RoomWho[] = []
  const links: ((connected: boolean) => void)[] = []
  let peers: RoomPeers = { patient: 1, helpers: [] }
  const transport: RoomTransport = {
    setState: (_code, change) => {
      const answer = deferred<{ state: RoomState }>()
      posts.push({ change, answer })
      return answer.promise
    },
    watch: (_code, onRoom, onError) => {
      const w = { onRoom, onError, stopped: false }
      watchers.push(w)
      return () => void (w.stopped = true)
    },
    heartbeat: async (_code, who) => void beats.push(who),
    connection: (onChange) => {
      links.push(onChange)
      return () => {}
    },
  }
  /** The query delivers this state (and the current peers). */
  const push = (state: RoomState, nextPeers: RoomPeers = peers) => {
    peers = nextPeers
    for (const w of watchers) if (!w.stopped) w.onRoom({ code: 'KTRB', state, peers })
  }
  const vanish = () => watchers.forEach((w) => !w.stopped && w.onRoom(null))
  const link = (connected: boolean) => links.forEach((f) => f(connected))
  return { transport, posts, watchers, beats, push, vanish, link }
}

const patient: RoomWho = { as: 'patient', name: null, client: 'ipad-tab-1' }
const helper: RoomWho = { as: 'helper', name: 'Priya', client: 'phone-tab-1' }
const settle = () => vi.advanceTimersByTimeAsync(0)

function connect(who: RoomWho, first: RoomState) {
  const guide = fakeGuide()
  const client = new RoomClient('KTRB', who, guide.transport)
  client.start()
  guide.push(first)
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
    guide.push(state(1, { by: 'patient', name: null, window: A, atId: A }))
    guide.push(state(2, { window: null, atId: A }))
    expect(follow(sync(), 0, A)).toBe(null)
    guide.posts[0].answer.resolve({ state: state(1, { by: 'patient', name: null, window: A, atId: A }) })
    await settle()
    expect(follow(sync(), 0, A)).toEqual({ mark: 2, go: null })
    client.stop()
  })

  it('finding 2: a failed iPad change never covers a newer helper move', async () => {
    const { guide, client, sync } = connect(patient, state(0, { by: 'patient', name: null }))
    client.change(() => ({ at: 1, atId: null, window: null }))
    guide.push(state(1, { at: 2 }))
    guide.posts[0].answer.reject(new Error('boom'))
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
    guide.posts[0].answer.reject(new Error('offline'))
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
    guide.posts[0].answer.reject(new Error('boom'))
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

  it('ignores older states from the query', () => {
    const { guide, client } = connect(helper, state(5, { at: 5 }))
    guide.push(state(4, { at: 4 }), { patient: 1, helpers: ['Priya'] })
    expect(shown(client.getSnapshot().sync)?.at).toBe(5)
    expect(client.getSnapshot().peers).toEqual({ patient: 1, helpers: ['Priya'] })
    client.stop()
  })

  it('says it is here every five seconds, and stops when closed', async () => {
    const { guide, client } = connect(helper, state(0))
    expect(guide.beats).toEqual([helper])
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2)
    expect(guide.beats).toHaveLength(3)
    client.stop()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2)
    expect(guide.beats).toHaveLength(3)
    expect(guide.watchers[0].stopped).toBe(true)
  })

  it('shows reconnecting while the connection is down', () => {
    const { guide, client } = connect(helper, state(0))
    guide.link(false)
    expect(client.getSnapshot().status).toBe('reconnecting')
    guide.link(true)
    expect(client.getSnapshot().status).toBe('live')
    client.stop()
  })

  it('a room the query no longer finds is gone', () => {
    const { guide, client } = connect(helper, state(0))
    guide.vanish()
    expect(client.getSnapshot().status).toBe('gone')
    expect(client.closed).toBe(true)
  })
})

describe('acquireRoom', () => {
  it("keeps the iPad's room, and its unsent change, across the switch from museum to window", async () => {
    const guide = fakeGuide()
    const museum = acquireRoom('KTRB', patient, guide.transport)
    guide.push(state(0, { by: 'patient', name: null }))
    museum.client.change(() => ({ at: 0, atId: A, window: A }))
    museum.release()
    const window = acquireRoom('KTRB', patient, guide.transport)
    expect(window.client).toBe(museum.client)
    expect(guide.watchers).toHaveLength(1)
    expect(shown(window.client.getSnapshot().sync)?.window).toBe(A)
    window.release()
    await vi.advanceTimersByTimeAsync(KEEP_MS)
    expect(window.client.closed).toBe(true)
    const again = acquireRoom('KTRB', patient, guide.transport)
    expect(again.client).not.toBe(window.client)
    again.client.stop()
  })
})
