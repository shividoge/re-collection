// Ported from guide/test/museum.test.mjs and arrangement.test.mjs (pure parts).
import { describe, expect, test } from 'vitest'
import {
  CAPTION_MAX,
  CODE_LETTERS,
  MAX_ITEMS,
  PEER_TTL_MS,
  ROOM_TTL_MS,
  countPeers,
  isExpired,
  makeCode,
  normalizeCode,
  parseState,
  publicArrangement,
  validateArrangement,
  type Presence,
} from './museum'

const CAPTURE_ID = '11111111-2222-4333-8444-555555555555'
const OTHER_ID = '99999999-2222-4333-8444-555555555555'

describe('museum rooms', () => {
  test('codes are 4 consonants and skip codes in use', () => {
    expect(CODE_LETTERS).toMatch(/^[^AEIOUY]+$/)
    const picks = [0, 0, 0, 0, 0, 0, 0, 1]
    expect(makeCode((c) => c === 'BBBB', () => picks.shift() ?? 0)).toBe('BBBC')
    expect(makeCode((c) => c === 'BBBB', () => 0)).toBeNull()
    for (let i = 0; i < 200; i += 1) expect(makeCode(() => false, (n) => Math.floor(Math.random() * n))).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}$/)
  })

  test('normalizeCode accepts lower case and rejects anything else', () => {
    expect(normalizeCode(' ktrb ')).toBe('KTRB')
    expect(normalizeCode('KATB')).toBeNull()
    expect(normalizeCode('KTR')).toBeNull()
    expect(normalizeCode('KTRBX')).toBeNull()
    expect(normalizeCode(undefined)).toBeNull()
  })

  test('parseState checks every field', () => {
    expect(parseState({ at: 2, window: null, by: 'helper', name: '  Priya ' })).toEqual({ ok: true, value: { at: 2, atId: null, window: null, by: 'helper', name: 'Priya' } })
    const upper = parseState({ at: -1, window: CAPTURE_ID.toUpperCase(), by: 'patient' })
    expect(upper.ok && upper.value.window).toBe(CAPTURE_ID)
    for (const bad of [
      { at: undefined, window: null, by: 'patient' },
      { at: 1.5, window: null, by: 'patient' },
      { at: -2, window: null, by: 'patient' },
      { at: '1', window: null, by: 'patient' },
      { at: 10000, window: null, by: 'patient' },
      { at: 0, window: '../x', by: 'patient' },
      { at: 0, window: null, by: 'nurse' },
      { at: 0, window: null, by: 'helper', name: 7 },
      { at: 0, window: null, by: 'helper', name: 'x'.repeat(41) },
      { at: 0, atId: 'cake', window: null, by: 'helper' },
    ]) {
      expect(parseState(bad).ok, JSON.stringify(bad)).toBe(false)
    }
  })

  const p = (client: string, as: Presence['as'], name: string | null, lastSeen: number): Presence => ({ client, as, name, lastSeen })

  test('a room expires 3 hours after its last change, only once no screen is live', () => {
    expect(isExpired(0, [], ROOM_TTL_MS - 1)).toBe(false)
    expect(isExpired(0, [], ROOM_TTL_MS)).toBe(true)
    const t = ROOM_TTL_MS * 2
    expect(isExpired(0, [p('ipad-0001', 'patient', null, t - PEER_TTL_MS + 1)], t)).toBe(false)
    expect(isExpired(0, [p('ipad-0001', 'patient', null, t - PEER_TTL_MS)], t)).toBe(true)
  })

  test('peers count live screens once each, helpers by name', () => {
    const now = 100_000
    const presence = [
      p('ipad-0001', 'patient', null, now - 1000),
      p('phone-0001', 'helper', 'Priya', now - 2000),
      p('phone-0002', 'helper', null, now - 3000),
      p('phone-0003', 'helper', 'Gone', now - PEER_TTL_MS),
    ]
    expect(countPeers(presence, now)).toEqual({ patient: 1, helpers: ['Someone', 'Priya'] })
  })
})

describe('arrangement', () => {
  const ids = new Set([CAPTURE_ID, OTHER_ID])

  test('keeps the order, cleans the text and fills a default title', () => {
    const result = validateArrangement({ items: [{ capture: OTHER_ID, piece: 'k0012', title: '  Her 70th  ', caption: 'The whole   family came.' }, { capture: CAPTURE_ID, piece: 'video' }] }, ids)
    expect('value' in result && result.value).toEqual({
      title: 'Our visits',
      subtitle: '',
      items: [
        { capture: OTHER_ID, piece: 'k0012', title: 'Her 70th', caption: 'The whole family came.' },
        { capture: CAPTURE_ID, piece: 'video', title: '', caption: '' },
      ],
    })
  })

  test('cuts a long caption to the limit', () => {
    const result = validateArrangement({ items: [{ capture: CAPTURE_ID, piece: 'thumb', caption: 'x'.repeat(500) }] }, ids)
    expect('value' in result && result.value.items[0].caption.length).toBe(CAPTION_MAX)
  })

  test('rejects unknown captures, odd pieces and too many pictures', () => {
    const error = (body: Parameters<typeof validateArrangement>[0]) => {
      const r = validateArrangement(body, ids)
      return 'error' in r ? r.error : ''
    }
    expect(error({ items: [{ capture: '00000000-0000-4000-8000-000000000000', piece: 'video' }] })).toMatch(/doesn't exist/)
    expect(error({ items: [{ capture: CAPTURE_ID, piece: '../room.bin' }] })).toMatch(/piece/)
    expect(error({ items: [{ capture: CAPTURE_ID, piece: 'k12' }] })).toMatch(/piece/)
    expect(error({ items: Array.from({ length: MAX_ITEMS + 1 }, () => ({ capture: CAPTURE_ID, piece: 'video' })) })).toMatch(/At most/)
  })

  test('a visitor only sees pictures from public captures', () => {
    const arrangement = { title: 'T', subtitle: '', items: [{ capture: CAPTURE_ID, piece: 'video', title: '', caption: '' }, { capture: OTHER_ID, piece: 'thumb', title: '', caption: '' }] }
    expect(publicArrangement(arrangement, [OTHER_ID])?.items.map((i) => i.capture)).toEqual([OTHER_ID])
    expect(publicArrangement(null, [OTHER_ID])).toBeNull()
  })
})
