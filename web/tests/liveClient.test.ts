import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveAudio, LiveSignal } from '../src/data/palace'
import type { LiveMember, LiveRole, LiveView, LiveViewState } from '../src/data/types'
import { HEARTBEAT_MS, LiveVisit, type LiveTransport } from '../src/museum/live/liveClient'

const KEY = 'k'.repeat(32)
const VIEW: LiveView = { x: 1, z: 2, yaw: 0.3, pitch: 0, inside: null, music: true }

type Watch<T> = { on: (v: T) => void; err: (e: unknown) => void; stopped: boolean }

/** A Convex palace whose answers the test hands out. */
function fakeServer() {
  let next = 1
  const joins: { role: LiveRole; name?: string }[] = []
  const calls: { fn: string; args: unknown[] }[] = []
  const members: Watch<{ here: boolean; members: LiveMember[] }>[] = []
  const views: Watch<LiveViewState | null>[] = []
  const signals: Watch<LiveSignal[]>[] = []
  const audio: Watch<LiveAudio>[] = []
  let joinError: unknown = null
  let heartbeatError: unknown = null
  const watch =
    <T>(list: Watch<T>[]) =>
    (...args: unknown[]) => {
      const w: Watch<T> = { on: args[args.length - 2] as (v: T) => void, err: args[args.length - 1] as (e: unknown) => void, stopped: false }
      list.push(w)
      return () => void (w.stopped = true)
    }
  const record =
    (fn: string) =>
    async (...args: unknown[]) => {
      calls.push({ fn, args })
      return null as never
    }
  const transport: LiveTransport = {
    join: async (_key, role, name) => {
      joins.push({ role, name })
      if (joinError) throw joinError
      return { me: `m${next++}`, iceServers: [{ urls: 'stun:x' }] }
    },
    heartbeat: async (...args) => {
      calls.push({ fn: 'heartbeat', args })
      if (heartbeatError) throw heartbeatError
      return { ok: true as const }
    },
    leave: record('leave'),
    setView: record('setView'),
    signal: record('signal'),
    ackSignals: record('ackSignals'),
    sendAudio: record('sendAudio'),
    watchMembers: watch(members),
    watchView: watch(views),
    watchSignals: watch(signals),
    watchAudio: watch(audio),
    connection: () => () => {},
  }
  const live = <T>(list: Watch<T>[]) => list.filter((w) => !w.stopped)
  return {
    transport,
    joins,
    calls,
    members: () => live(members),
    views: () => live(views),
    signals: () => live(signals),
    audio: () => live(audio),
    failJoin: (e: unknown) => (joinError = e),
    failHeartbeat: (e: unknown) => (heartbeatError = e),
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the live visit on one screen', () => {
  it('joins, shows who is here, and family follow her view', async () => {
    const s = fakeServer()
    const visit = new LiveVisit(KEY, 'family', 'Sam', s.transport)
    visit.start()
    await flush()
    expect(s.joins).toEqual([{ role: 'family', name: 'Sam' }])
    expect(visit.snapshot()).toMatchObject({ status: 'live', me: 'm1' })
    expect(visit.iceServers).toEqual([{ urls: 'stun:x' }])

    s.members()[0].on({ here: true, members: [{ id: 'p', role: 'patient', name: 'Mom' }, { id: 'm1', role: 'family', name: 'Sam' }] })
    expect(visit.snapshot().members).toHaveLength(2)
    s.views()[0].on({ ...VIEW, rev: 3, updatedAt: '' })
    expect(visit.snapshot().view?.rev).toBe(3)
    visit.stop()
    expect(s.calls.some((c) => c.fn === 'leave')).toBe(true)
    expect(s.members()).toHaveLength(0)
  })

  it("her own screen doesn't watch her view, and only she sends it, at most 5 times a second", async () => {
    vi.useFakeTimers()
    const s = fakeServer()
    const patient = new LiveVisit(KEY, 'patient', undefined, s.transport)
    patient.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.views()).toHaveLength(0)
    patient.sendView(VIEW)
    patient.sendView({ ...VIEW, x: 1.5 })
    await vi.advanceTimersByTimeAsync(250)
    patient.sendView({ ...VIEW, x: 1.5001 }) // too small a change to send
    await vi.advanceTimersByTimeAsync(250)
    const sent = s.calls.filter((c) => c.fn === 'setView').map((c) => (c.args[2] as LiveView).x)
    expect(sent).toEqual([1.5])

    const family = new LiveVisit(KEY, 'family', 'Sam', s.transport)
    family.start()
    await vi.advanceTimersByTimeAsync(0)
    family.sendView(VIEW)
    await vi.advanceTimersByTimeAsync(250)
    expect(s.calls.filter((c) => c.fn === 'setView')).toHaveLength(1)
  })

  it('hands on each call setup message once, and deletes it on the server', async () => {
    const s = fakeServer()
    const visit = new LiveVisit(KEY, 'family', 'Sam', s.transport)
    const got: [string, unknown][] = []
    visit.onSignal = (from, data) => got.push([from, data])
    visit.start()
    await flush()
    const a = { id: 's1', from: 'p', data: '{"type":"offer","sdp":"x"}' }
    s.signals()[0].on([a])
    // The same message again (before the delete lands) is skipped; broken JSON too.
    s.signals()[0].on([a, { id: 's2', from: 'p', data: 'not json' }])
    expect(got).toEqual([['p', { type: 'offer', sdp: 'x' }]])
    expect(s.calls.filter((c) => c.fn === 'ackSignals').map((c) => c.args[2])).toEqual([['s1'], ['s2']])
  })

  it('plays relayed voice in order, never the backlog from before it joined', async () => {
    const s = fakeServer()
    const visit = new LiveVisit(KEY, 'family', 'Sam', s.transport)
    const heard: number[] = []
    visit.onAudio = (_from, bytes) => heard.push(bytes[0])
    visit.start()
    await flush()
    const chunk = (seq: number) => ({ seq, from: 'p', data: new Uint8Array([seq]).buffer })
    s.audio()[0].on({ latest: 4, chunks: [chunk(3), chunk(4)] })
    s.audio()[0].on({ latest: 6, chunks: [chunk(4), chunk(5), chunk(6)] })
    s.audio()[0].on({ latest: 6, chunks: [chunk(5), chunk(6)] })
    expect(heard).toEqual([5, 6])
  })

  it('joins again when the server dropped it', async () => {
    vi.useFakeTimers()
    const s = fakeServer()
    const visit = new LiveVisit(KEY, 'family', 'Sam', s.transport)
    visit.start()
    await vi.advanceTimersByTimeAsync(0)
    s.members()[0].on({ here: false, members: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(visit.snapshot()).toMatchObject({ status: 'live', me: 'm2' })
    expect(s.members()).toHaveLength(1)

    s.failHeartbeat(new ConvexError({ code: 'not_found', message: 'Not in the visit any more. Join again.' }))
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    s.failHeartbeat(null)
    await vi.advanceTimersByTimeAsync(0)
    expect(visit.me).toBe('m3')
  })

  it('an old link ends the visit here and forgets the key', async () => {
    const s = fakeServer()
    s.failJoin(new ConvexError({ code: 'bad_key', message: 'This visit link no longer works. Ask the family for the new link.' }))
    const visit = new LiveVisit(KEY, 'patient', undefined, s.transport)
    let forgot = false
    visit.onBadKey = () => (forgot = true)
    visit.start()
    await flush()
    expect(visit.snapshot()).toMatchObject({ status: 'ended', error: 'This visit link no longer works. Ask the family for the new link.' })
    expect(forgot).toBe(true)
  })

  it('a key replaced during the visit ends it too', async () => {
    const s = fakeServer()
    const visit = new LiveVisit(KEY, 'family', 'Sam', s.transport)
    visit.start()
    await flush()
    s.members()[0].err(new ConvexError({ code: 'bad_key', message: 'This visit link no longer works.' }))
    expect(visit.snapshot().status).toBe('ended')
    expect(s.members()).toHaveLength(0)
  })

  it('a full visit says so; being offline tries again', async () => {
    vi.useFakeTimers()
    const s = fakeServer()
    s.failJoin(new ConvexError({ code: 'invalid', message: 'The visit is full (8 screens).' }))
    const full = new LiveVisit(KEY, 'family', 'Sam', s.transport)
    full.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(full.snapshot()).toMatchObject({ status: 'ended', error: 'The visit is full (8 screens).' })

    s.failJoin(new Error('offline'))
    const offline = new LiveVisit(KEY, 'family', 'Ana', s.transport)
    offline.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(offline.snapshot().status).toBe('reconnecting')
    s.failJoin(null)
    await vi.advanceTimersByTimeAsync(2000)
    expect(offline.snapshot().status).toBe('live')
  })
})
