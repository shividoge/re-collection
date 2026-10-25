// Museum rooms and arrangement, and the public (visitor) surface, through the Convex functions.
// Ported from guide/test/museum.test.mjs, arrangement.test.mjs and public.test.mjs.
import { afterEach, describe, expect, test, vi } from 'vitest'
import { moment } from './lib/grounding.fixture'
import { PEER_TTL_MS, ROOM_TTL_MS } from './lib/museum'
import { CAPTURE_ID, api, internal, putMoment, setup, tinyCapture, uploadCapture, type T } from './test.helpers'

const OTHER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('museum rooms', () => {
  test('create, heartbeat, peers and a shared state; codes are case-insensitive', async () => {
    const t = setup()
    await t.mutation(api.captures.begin, { manifestJson: tinyCapture().manifestJson })
    const { code } = await t.mutation(api.museum.createRoom, { at: 1 })
    expect(code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}$/)
    expect((await t.query(api.museum.room, { code }))).toMatchObject({ state: { at: 1, window: null, rev: 0 }, peers: { patient: 0, helpers: [] } })

    await t.mutation(api.museum.heartbeat, { code, client: 'ipad-0001', as: 'patient' })
    await t.mutation(api.museum.heartbeat, { code: code.toLowerCase(), client: 'phone-0001', as: 'helper', name: '  Priya ' })
    await t.mutation(api.museum.heartbeat, { code, client: 'phone-0001', as: 'helper', name: 'Priya' }) // counted once
    expect((await t.query(api.museum.room, { code }))?.peers).toEqual({ patient: 1, helpers: ['Priya'] })

    const { state } = await t.mutation(api.museum.setState, { code, at: 0, atId: CAPTURE_ID.toUpperCase(), window: CAPTURE_ID, by: 'helper', name: 'Priya' })
    expect(state).toMatchObject({ at: 0, atId: CAPTURE_ID, window: CAPTURE_ID, by: 'helper', name: 'Priya', rev: 1 })
    expect((await t.query(api.museum.room, { code }))?.state.rev).toBe(1)
  })

  test('bad codes, bodies and unknown captures say why', async () => {
    const t = setup()
    const { code } = await t.mutation(api.museum.createRoom, {})
    for (const bad of ['KATB', 'AB', 'ZZZZZ']) expect(await t.query(api.museum.room, { code: bad })).toBeNull()
    await expect(t.mutation(api.museum.setState, { code: 'ZZZZ', at: 0, window: null, by: 'patient' })).rejects.toThrow(/No visit with that code/)
    await expect(t.mutation(api.museum.setState, { code, at: 1.5, window: null, by: 'patient' })).rejects.toThrow(/whole number/)
    await expect(t.mutation(api.museum.setState, { code, at: 0, window: '99999999-2222-4333-8444-555555555555', by: 'patient' })).rejects.toThrow(/No capture/)
    await expect(t.mutation(api.museum.setState, { code, at: 0, window: null, by: 'helper', name: 'x'.repeat(41) })).rejects.toThrow(/at most 40/)
    await expect(t.mutation(api.museum.heartbeat, { code, client: 'short', as: 'patient' })).rejects.toThrow(/client must be/)
    await expect(t.mutation(api.museum.createRoom, { at: -5 })).rejects.toThrow(/whole number/)
  })

  test('a helper who stops heartbeating leaves after 12 s; a quiet room expires after 3 hours', async () => {
    const t = setup()
    vi.useFakeTimers({ toFake: ['Date'] })
    let now = Date.parse('2026-10-24T20:00:00Z')
    vi.setSystemTime(now)
    const { code } = await t.mutation(api.museum.createRoom, {})
    await t.mutation(api.museum.heartbeat, { code, client: 'phone-0002', as: 'helper', name: 'Priya' })
    now += PEER_TTL_MS - 1
    vi.setSystemTime(now)
    expect((await t.query(api.museum.room, { code }))?.peers.helpers).toEqual(['Priya'])
    now += 1
    vi.setSystemTime(now)
    expect((await t.query(api.museum.room, { code }))?.peers.helpers).toEqual([])

    // A live screen keeps a room past 3 hours; once it's quiet, the room goes.
    now += ROOM_TTL_MS
    vi.setSystemTime(now)
    expect(await t.query(api.museum.room, { code })).toBeNull()
    const second = await t.mutation(api.museum.createRoom, {})
    await t.mutation(api.museum.heartbeat, { code: second.code, client: 'ipad-0003', as: 'patient' })
    now += ROOM_TTL_MS + 1000
    vi.setSystemTime(now)
    await t.mutation(api.museum.heartbeat, { code: second.code, client: 'ipad-0003', as: 'patient' }).catch(() => undefined)
    expect(await t.query(api.museum.room, { code: second.code })).toBeNull() // 3 h quiet before this heartbeat
    await t.mutation(internal.museum.sweep, {})
    expect(await t.run(async (ctx) => (await ctx.db.query('museumRooms').collect()).length)).toBe(0)
  })
})

describe('arrangement', () => {
  test('none until saved; validated against captures; cleared', async () => {
    const t = setup()
    await t.mutation(api.captures.begin, { manifestJson: tinyCapture().manifestJson })
    await t.mutation(api.captures.begin, { manifestJson: tinyCapture({ id: OTHER_ID }).manifestJson })
    expect(await t.query(api.museum.getArrangement, {})).toBeNull()
    const saved = await t.mutation(api.museum.setArrangement, {
      title: 'Mom’s museum',
      subtitle: '',
      items: [{ capture: OTHER_ID, piece: 'thumb', title: '', caption: 'Sunday lunch' }, { capture: CAPTURE_ID, piece: 'video', title: '', caption: '' }],
    })
    expect(saved.items.map((i) => i.capture)).toEqual([OTHER_ID, CAPTURE_ID])
    expect(saved.updatedAt).toBeTruthy()
    await expect(t.mutation(api.museum.setArrangement, { title: '', subtitle: '', items: [{ capture: CAPTURE_ID, piece: 'nope', title: '', caption: '' }] })).rejects.toThrow(/piece/)
    await expect(t.mutation(api.museum.setArrangement, { title: '', subtitle: '', items: [{ capture: '00000000-0000-4000-8000-000000000000', piece: 'video', title: '', caption: '' }] })).rejects.toThrow(/doesn't exist/)
    await t.mutation(api.museum.clearArrangement, {})
    expect(await t.query(api.museum.getArrangement, {})).toBeNull()
  })
})

describe('public surface', () => {
  const SESSION_ID = '99999999-8888-4777-8666-555555555555'
  const OPEN_SESSION_ID = '99999999-8888-4777-8666-555555555556'

  async function world(): Promise<T> {
    const t = setup()
    await uploadCapture(t, tinyCapture({ keyframes: 0, transcript: false }))
    await t.mutation(api.captures.begin, { manifestJson: tinyCapture({ id: OTHER_ID }).manifestJson })
    await putMoment(t, {
      ...moment,
      moment: { ...moment.moment, summary: 'A short visit.' },
      facts: [...moment.facts, { ...moment.facts[0], id: 'f5', text: 'A blue vase stood by the window.', status: 'rejected' }],
      dropped: [{ text: 'A claim with no evidence.', reason: 'no evidence' }],
    })
    const session = (sessionId: string, endedAt: string | null) => ({
      sessionId, captureId: CAPTURE_ID, person: { displayName: 'Grandma', preferredAddress: 'Mom' },
      startedAt: '2026-10-24T20:00:00.000Z', endedAt, endReason: endedAt ? ('complete' as const) : null,
      allowedFactIds: ['f1', 'f4'], said: ['f1'],
      turns: [{ t: '2026-10-24T20:00:01.000Z', speaker: 'claude' as const, text: 'Hello, Mom.', kind: 'welcome' as const, factIds: [] }, { t: '2026-10-24T20:00:02.000Z', speaker: 'patient' as const, text: 'This one?', focus: { label: 'a chair', factIds: [] } }],
      dropped: [{ t: '2026-10-24T20:00:02.000Z', sentence: 'Your grandson visited.', reason: 'mentions a person' }],
      branches: [], alerts: [{ t: '2026-10-24T20:00:03.000Z', kind: 'distress' as const, note: 'private' }], scores: [{ factId: 'f1', result: 'after_cue' as const, line: 1 }], note: 'A calm session.',
    })
    await t.run(async (ctx) => {
      await ctx.db.insert('sessions', session(SESSION_ID, '2026-10-24T20:05:00.000Z'))
      await ctx.db.insert('sessions', session(OPEN_SESSION_ID, null))
    })
    await t.mutation(api.museum.setArrangement, { title: 'M', subtitle: '', items: [{ capture: CAPTURE_ID, piece: 'video', title: '', caption: '' }, { capture: OTHER_ID, piece: 'thumb', title: '', caption: '' }] })
    return t
  }

  test('nothing is visible until the family marks a capture public, and private looks like missing', async () => {
    const t = await world()
    expect(await t.query(api.public.captures, {})).toEqual([])
    expect(await t.query(api.public.capture, { captureId: CAPTURE_ID })).toBeNull()
    expect(await t.query(api.public.moment, { captureId: CAPTURE_ID })).toBeNull()
    expect(await t.query(api.public.progress, { captureId: CAPTURE_ID })).toBeNull()
    expect(await t.query(api.public.session, { sessionId: SESSION_ID })).toBeNull()
    expect(await t.query(api.public.capture, { captureId: '00000000-0000-4000-8000-000000000000' })).toBeNull()
    expect((await t.query(api.public.arrangement, {}))?.items).toEqual([])
  })

  test('a public capture: listed, files without room.ply, only approved raisable facts in family wording', async () => {
    const t = await world()
    expect(await t.mutation(api.captures.setPublic, { captureId: CAPTURE_ID, public: true })).toEqual({ ok: true, public: true })
    const list = await t.query(api.public.captures, {})
    expect(list.map((c) => [c.id, c.title, c.summary, c.facts])).toEqual([[CAPTURE_ID, 'Cake visit', 'A short visit.', 2]])
    expect(list[0].thumbUrl).toMatch(new RegExp(`/captures/${CAPTURE_ID}/raw/thumb\\.jpg\\?`))

    const detail = await t.query(api.public.capture, { captureId: CAPTURE_ID })
    expect(JSON.parse(detail!.manifestJson).title).toBe('Test visit')
    const names = detail!.files.map((f) => f.name)
    expect(names).toContain('room.bin')
    expect(names).not.toContain('room.ply')

    const shown = await t.query(api.public.moment, { captureId: CAPTURE_ID })
    expect(shown?.facts.map((f) => f.id)).toEqual(['f1', 'f4'])
    expect(shown?.facts[1].text).toBe('Dev wore his red sweater.')
    expect(shown?.dropped).toEqual([])
    const raw = JSON.stringify(shown)
    for (const secret of ['Raj', 'yellow flowers', 'blue vase', 'no evidence']) expect(raw.includes(secret), secret).toBe(false)

    const done = await t.query(api.public.session, { sessionId: SESSION_ID })
    expect(done?.turns[0].text).toBe('Hello, Mom.')
    expect(done?.dropped[0].sentence).toBe('Your grandson visited.')
    const doneRaw = JSON.stringify(done)
    for (const secret of ['Grandma', 'a chair', 'private']) expect(doneRaw.includes(secret), secret).toBe(false)
    expect(Object.keys(done ?? {})).not.toContain('person')
    expect(Object.keys(done ?? {})).not.toContain('alerts')
    expect(await t.query(api.public.session, { sessionId: OPEN_SESSION_ID })).toBeNull() // still running

    const progress = await t.query(api.public.progress, { captureId: CAPTURE_ID })
    expect(progress?.facts.map((f) => f.id)).toEqual(['f1', 'f4'])
    expect(progress?.sessions.length).toBe(1)
    expect((await t.query(api.public.arrangement, {}))?.items.map((i) => i.capture)).toEqual([CAPTURE_ID])
    expect(await t.query(api.public.capture, { captureId: OTHER_ID })).toBeNull()

    await t.mutation(api.captures.setPublic, { captureId: CAPTURE_ID, public: false })
    expect(await t.query(api.public.captures, {})).toEqual([])
    expect(await t.query(api.public.moment, { captureId: CAPTURE_ID })).toBeNull()
  })
})
