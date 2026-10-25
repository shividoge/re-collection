// The live visit through the Convex functions (ported from the guide's live.test.mjs, PR #57).
import { afterEach, describe, expect, test, vi } from 'vitest'
import { encodeKey, iceServersFrom, parseView, sameKey, type View } from './lib/palace'
import { api, internal, setup, type T } from './test.helpers'

const VIEW: View = { x: 0, z: -2, yaw: 0.5, pitch: -0.02, inside: null, music: true }

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

async function opened(t: T) {
  const { key } = await t.action(api.palace.makeVisitKey, {})
  return key
}

describe('live visit rules', () => {
  test('a view needs finite numbers and a sensible memory to be inside', () => {
    expect(parseView(VIEW)).toEqual({ ok: true, value: VIEW })
    expect(parseView({ ...VIEW, inside: { index: 3, stage: 'here' } })).toMatchObject({ ok: true, value: { inside: { index: 3, stage: 'here' } } })
    expect(parseView({ ...VIEW, yaw: Infinity }).ok).toBe(false)
    expect(parseView({ ...VIEW, x: NaN }).ok).toBe(false)
    expect(parseView({ ...VIEW, inside: { index: -1, stage: 'here' } }).ok).toBe(false)
    expect(parseView({ ...VIEW, inside: { index: 1.5, stage: 'here' } }).ok).toBe(false)
  })

  test('ICE servers come from the environment, else a public STUN server', () => {
    expect(iceServersFrom(undefined)).toHaveLength(1)
    expect(iceServersFrom('[{"urls":"turn:t.example:3478","username":"u","credential":"c"}]')).toEqual([{ urls: 'turn:t.example:3478', username: 'u', credential: 'c' }])
    expect(String(iceServersFrom('not json')[0].urls)).toMatch(/^stun:/)
    expect(String(iceServersFrom('[{"nope":1}]')[0].urls)).toMatch(/^stun:/)
  })

  test('keys are 32 base64url characters', () => {
    const key = encodeKey(new Uint8Array(24).fill(255))
    expect(key).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(sameKey(key, key)).toBe(true)
    expect(sameKey(key, key.slice(0, 31) + 'A')).toBe(false)
    expect(() => encodeKey(new Uint8Array(3))).toThrow()
  })
})

describe('the visit key', () => {
  test('made once, kept, and replaced on request; a new key ends the visit', async () => {
    const t = setup()
    expect(await t.query(api.palace.visitKey, {})).toEqual({ key: null })
    const key = await opened(t)
    expect(key).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(await opened(t)).toBe(key)
    const { token } = await t.mutation(api.palace.join, { key, role: 'family', name: 'Sam' })

    const { key: next } = await t.action(api.palace.makeVisitKey, { replace: true })
    expect(next).not.toBe(key)
    expect(await t.query(api.palace.visitKey, {})).toEqual({ key: next })
    await expect(t.mutation(api.palace.join, { key, role: 'patient' })).rejects.toThrow(/no longer works/)
    await expect(t.query(api.palace.members, { key, token })).rejects.toThrow(/no longer works/)
    expect(await t.query(api.palace.members, { key: next, token })).toEqual({ here: false, members: [] })
  })

  test('nothing works without the right key', async () => {
    const t = setup()
    await expect(t.mutation(api.palace.join, { key: 'A'.repeat(32), role: 'patient' })).rejects.toThrow(/no longer works/)
    await opened(t)
    await expect(t.mutation(api.palace.join, { key: 'A'.repeat(32), role: 'patient' })).rejects.toThrow(/no longer works/)
    await expect(t.query(api.palace.view, { key: 'short', token: 'x'.repeat(32) })).rejects.toThrow(/no longer works/)
  })
})

describe('the live visit', () => {
  test('she leads; family see who is here and where she is', async () => {
    const t = setup()
    const key = await opened(t)
    const patient = await t.mutation(api.palace.join, { key, role: 'patient' })
    expect(patient.iceServers.length).toBeGreaterThan(0)
    await expect(t.mutation(api.palace.join, { key, role: 'family', name: '   ' })).rejects.toThrow(/with a name/)
    const sam = await t.mutation(api.palace.join, { key, role: 'family', name: '  Sam  ' })

    const seen = await t.query(api.palace.members, { key, token: sam.token })
    expect(seen.here).toBe(true)
    // No name given: the person the palace is for (people.displayName), else "Grandma".
    expect(seen.members.map((m) => [m.role, m.name])).toEqual([
      ['patient', 'Grandma'],
      ['family', 'Sam'],
    ])

    expect(await t.query(api.palace.view, { key, token: sam.token })).toBeNull()
    await expect(t.mutation(api.palace.setView, { key, token: sam.token, view: VIEW })).rejects.toThrow(/leads the visit/)
    await expect(t.mutation(api.palace.setView, { key, token: patient.token, view: { ...VIEW, inside: { index: 1000, stage: 'here' } } })).rejects.toThrow(/0 to 999/)
    expect(await t.mutation(api.palace.setView, { key, token: patient.token, view: { ...VIEW, inside: { index: 2, stage: 'diving' } } })).toEqual({ rev: 1 })
    expect(await t.mutation(api.palace.setView, { key, token: patient.token, view: { ...VIEW, inside: { index: 2, stage: 'here' } } })).toEqual({ rev: 2 })
    expect(await t.query(api.palace.view, { key, token: sam.token })).toMatchObject({ inside: { index: 2, stage: 'here' }, rev: 2, music: true })

    // She leaves: the view goes, and Sam is alone.
    await t.mutation(api.palace.leave, { key, token: patient.token })
    expect(await t.query(api.palace.view, { key, token: sam.token })).toBeNull()
    expect((await t.query(api.palace.members, { key, token: sam.token })).members.map((m) => m.name)).toEqual(['Sam'])
    await t.mutation(api.palace.leave, { key, token: sam.token })
    await t.mutation(api.palace.leave, { key, token: sam.token }) // twice is fine
    expect(await t.query(api.palace.members, { key, token: sam.token })).toEqual({ here: false, members: [] })
    await expect(t.mutation(api.palace.heartbeat, { key, token: sam.token })).rejects.toThrow(/Join again/)
  })

  test('a screen not heard from for 10 s is gone, and so is her view', async () => {
    vi.useFakeTimers()
    const t = setup()
    const key = await opened(t)
    const patient = await t.mutation(api.palace.join, { key, role: 'patient', name: 'Mom' })
    const sam = await t.mutation(api.palace.join, { key, role: 'family', name: 'Sam' })
    await t.mutation(api.palace.setView, { key, token: patient.token, view: VIEW })

    vi.advanceTimersByTime(6_000)
    await t.mutation(api.palace.heartbeat, { key, token: sam.token })
    vi.advanceTimersByTime(6_000)
    // Sam kept beating; she didn't.
    expect(await t.query(api.palace.members, { key, token: sam.token })).toMatchObject({ here: true, members: [{ name: 'Sam' }] })
    expect((await t.query(api.palace.members, { key, token: patient.token })).here).toBe(false)
    expect(await t.query(api.palace.view, { key, token: sam.token })).toBeNull()

    // Sam's next heartbeat deletes her row and her view, so every query sees her go (queries only
    // re-run when rows they read change).
    await t.mutation(api.palace.heartbeat, { key, token: sam.token })
    expect(await t.run(async (ctx) => [(await ctx.db.query('palaceMembers').collect()).length, (await ctx.db.query('palaceView').collect()).length])).toEqual([1, 0])
    await expect(t.mutation(api.palace.heartbeat, { key, token: patient.token })).rejects.toThrow(/Join again/)

    // With nobody left to beat, the cron does it.
    vi.advanceTimersByTime(11_000)
    await t.mutation(internal.palace.sweep, {})
    expect(await t.run(async (ctx) => (await ctx.db.query('palaceMembers').collect()).length)).toBe(0)
  })

  test('the visit holds at most 8 screens', async () => {
    const t = setup()
    const key = await opened(t)
    for (let i = 0; i < 8; i++) await t.mutation(api.palace.join, { key, role: 'family', name: `F${i}` })
    await expect(t.mutation(api.palace.join, { key, role: 'family', name: 'One more' })).rejects.toThrow(/full/)
  })

  test('call setup messages reach one member, and are deleted once handled', async () => {
    const t = setup()
    const key = await opened(t)
    const a = await t.mutation(api.palace.join, { key, role: 'family', name: 'A' })
    const b = await t.mutation(api.palace.join, { key, role: 'family', name: 'B' })
    await t.mutation(api.palace.signal, { key, token: a.token, to: b.me, data: '{"type":"offer","sdp":"x"}' })
    const got = await t.query(api.palace.signals, { key, token: b.token })
    expect(got.map((s) => [s.from, s.data])).toEqual([[a.me, '{"type":"offer","sdp":"x"}']])
    expect(await t.query(api.palace.signals, { key, token: a.token })).toEqual([])

    // Only the recipient can delete its messages.
    await t.mutation(api.palace.ackSignals, { key, token: a.token, ids: got.map((s) => s.id) })
    expect(await t.query(api.palace.signals, { key, token: b.token })).toHaveLength(1)
    await t.mutation(api.palace.ackSignals, { key, token: b.token, ids: [...got.map((s) => s.id), 'junk'] })
    expect(await t.query(api.palace.signals, { key, token: b.token })).toEqual([])

    await expect(t.mutation(api.palace.signal, { key, token: a.token, to: 'nobody', data: '{}' })).rejects.toThrow(/has left/)
    await expect(t.mutation(api.palace.signal, { key, token: a.token, to: b.me, data: 'x'.repeat(16 * 1024 + 1) })).rejects.toThrow(/16 KB/)
    // Leaving drops what was waiting for you.
    await t.mutation(api.palace.signal, { key, token: a.token, to: b.me, data: '{}' })
    await t.mutation(api.palace.leave, { key, token: b.token })
    expect(await t.run(async (ctx) => (await ctx.db.query('palaceSignals').collect()).length)).toBe(0)
    await expect(t.query(api.palace.signals, { key, token: b.token })).rejects.toThrow(/Join again/)
  })

  test('relayed voice goes to everyone else, in order, never back to you', async () => {
    const t = setup()
    const key = await opened(t)
    const a = await t.mutation(api.palace.join, { key, role: 'patient' })
    const b = await t.mutation(api.palace.join, { key, role: 'family', name: 'B' })
    const bytes = (...n: number[]) => new Uint8Array(n).buffer
    expect(await t.mutation(api.palace.sendAudio, { key, token: a.token, data: bytes(1, 2, 3) })).toEqual({ seq: 1 })
    await t.mutation(api.palace.sendAudio, { key, token: a.token, data: bytes(4, 5) })
    await t.mutation(api.palace.sendAudio, { key, token: b.token, data: bytes(9) })

    const heard = await t.query(api.palace.audio, { key, token: b.token })
    expect(heard.latest).toBe(3)
    expect(heard.chunks.map((c) => [c.seq, c.from, [...new Uint8Array(c.data)]])).toEqual([
      [1, a.me, [1, 2, 3]],
      [2, a.me, [4, 5]],
    ])
    expect((await t.query(api.palace.audio, { key, token: a.token })).chunks.map((c) => c.seq)).toEqual([3])

    await expect(t.mutation(api.palace.sendAudio, { key, token: a.token, data: bytes() })).rejects.toThrow(/Empty/)
    await expect(t.mutation(api.palace.sendAudio, { key, token: a.token, data: new Uint8Array(64 * 1024 + 1).buffer })).rejects.toThrow(/64 KB/)
  })

  test('only the last few chunks are handed out, and old voice is swept', async () => {
    vi.useFakeTimers()
    const t = setup()
    const key = await opened(t)
    const a = await t.mutation(api.palace.join, { key, role: 'patient' })
    const b = await t.mutation(api.palace.join, { key, role: 'family', name: 'B' })
    for (let i = 0; i < 12; i++) await t.mutation(api.palace.sendAudio, { key, token: a.token, data: new Uint8Array([i]).buffer })
    expect((await t.query(api.palace.audio, { key, token: b.token })).chunks.map((c) => c.seq)).toEqual([5, 6, 7, 8, 9, 10, 11, 12])

    for (const wait of [6_000, 5_000]) {
      vi.advanceTimersByTime(wait)
      await t.mutation(api.palace.heartbeat, { key, token: a.token })
      await t.mutation(api.palace.heartbeat, { key, token: b.token })
    }
    await t.mutation(internal.palace.sweep, {})
    // The newest chunk stays, so after a quiet minute the count carries on instead of starting over
    // (listeners skip anything at or below the last number they played).
    expect((await t.query(api.palace.audio, { key, token: b.token })).chunks.map((c) => c.seq)).toEqual([12])
    expect(await t.mutation(api.palace.sendAudio, { key, token: a.token, data: new Uint8Array([1]).buffer })).toEqual({ seq: 13 })
  })

  test('ICE_SERVERS reaches the screens', async () => {
    vi.stubEnv('ICE_SERVERS', '[{"urls":["turn:t.example:3478"],"username":"u","credential":"c"}]')
    const t = setup()
    const key = await opened(t)
    const { iceServers } = await t.mutation(api.palace.join, { key, role: 'patient' })
    expect(iceServers).toEqual([{ urls: ['turn:t.example:3478'], username: 'u', credential: 'c' }])
  })

  test('only members can listen, read call setup or follow her; public ids open nothing', async () => {
    const t = setup()
    const key = await opened(t)
    const patient = await t.mutation(api.palace.join, { key, role: 'patient' })
    const sam = await t.mutation(api.palace.join, { key, role: 'family', name: 'Sam' })
    const listed = await t.query(api.palace.members, { key, token: sam.token })
    // Others are listed by public id only.
    expect(listed.members.map((m) => Object.keys(m).sort())).toEqual([
      ['id', 'name', 'role'],
      ['id', 'name', 'role'],
    ])
    expect(listed.members[0].id).toBe(patient.me)
    // Someone with the key who never joined (or uses her public id as a token) gets nothing.
    for (const token of ['x'.repeat(32), patient.me]) {
      await expect(t.query(api.palace.audio, { key, token })).rejects.toThrow(/Join again/)
      await expect(t.query(api.palace.view, { key, token })).rejects.toThrow(/Join again/)
      await expect(t.query(api.palace.signals, { key, token })).rejects.toThrow(/Join again/)
      await expect(t.mutation(api.palace.setView, { key, token, view: VIEW })).rejects.toThrow(/Join again/)
      await t.mutation(api.palace.leave, { key, token })
    }
    expect((await t.query(api.palace.members, { key, token: sam.token })).members).toHaveLength(2)
  })
})
