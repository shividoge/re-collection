// "Visit together" rooms and the caretaker's museum arrangement: the pure rules from
// guide/src/museum.mjs and guide/src/arrangement.mjs (docs/guide-api.md). In v3 a room is a Convex
// row read with a reactive query; screens heartbeat every 5 s instead of SSE + polling.

/** Consonants only (no vowels, no Y), so a code never spells a word. */
export const CODE_LETTERS = 'BCDFGHJKLMNPQRSTVWXZ'
const CODE_PATTERN = new RegExp(`^[${CODE_LETTERS}]{4}$`)
export const ROOM_TTL_MS = 3 * 60 * 60 * 1000
/** A screen counts as present this long after its last heartbeat (it sends one every 5 s). */
export const PEER_TTL_MS = 12_000
export const CLIENT_PATTERN = /^[A-Za-z0-9_-]{8,64}$/
export const MAX_AT = 9999
export const MAX_NAME = 40
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type Who = 'patient' | 'helper'
export type Presence = { client: string; as: Who; name: string | null; lastSeen: number }

/** Upper-cases a typed code; null if it can't be a room code. */
export function normalizeCode(code: string | null | undefined): string | null {
  const upper = String(code ?? '').trim().toUpperCase()
  return CODE_PATTERN.test(upper) ? upper : null
}

/** A fresh code for which `taken` is false, or null if none was found in 50 tries (160,000 codes). */
export function makeCode(taken: (code: string) => boolean, random: (n: number) => number): string | null {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    let code = ''
    for (let i = 0; i < 4; i += 1) code += CODE_LETTERS[random(CODE_LETTERS.length)]
    if (!taken(code)) return code
  }
  return null
}

export function cleanName(name: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (name === undefined || name === null) return { ok: true, value: null }
  if (typeof name !== 'string') return { ok: false, error: 'name must be a string.' }
  const trimmed = name.trim().replace(/\s+/g, ' ')
  if (trimmed.length > MAX_NAME) return { ok: false, error: `name must be at most ${MAX_NAME} characters.` }
  return { ok: true, value: trimmed || null }
}

export function isFrameIndex(at: unknown): at is number {
  return Number.isInteger(at) && (at as number) >= -1 && (at as number) <= MAX_AT
}

export const isCaptureId = (id: unknown): id is string => typeof id === 'string' && UUID.test(id)

export type StateChange = { at: number; atId: string | null; window: string | null; by: Who; name: string | null }

/** Checks a state change. Whether `window` names an existing capture is checked by the caller. */
export function parseState(body: { at: unknown; atId?: unknown; window: unknown; by: unknown; name?: unknown }):
  | { ok: true; value: StateChange }
  | { ok: false; error: string } {
  if (!isFrameIndex(body.at)) return { ok: false, error: `at must be a whole number from -1 to ${MAX_AT}.` }
  if (body.window !== null && !isCaptureId(body.window)) return { ok: false, error: 'window must be null or a capture id.' }
  if (body.by !== 'patient' && body.by !== 'helper') return { ok: false, error: 'by must be "patient" or "helper".' }
  const atId = body.atId ?? null
  if (atId !== null && !isCaptureId(atId)) return { ok: false, error: 'atId must be null or a capture id.' }
  const name = cleanName(body.name)
  if (!name.ok) return name
  return {
    ok: true,
    value: { at: body.at, atId: atId?.toLowerCase() ?? null, window: body.window?.toLowerCase() ?? null, by: body.by, name: name.value },
  }
}

export const isLive = (p: Presence, now: number) => now - p.lastSeen < PEER_TTL_MS

/** Who is here: one entry per screen with a heartbeat in the last 12 s, helpers by name. */
export function countPeers(presence: readonly Presence[], now: number): { patient: number; helpers: string[] } {
  const peers = { patient: 0, helpers: [] as string[] }
  for (const p of [...presence].sort((a, b) => a.lastSeen - b.lastSeen)) {
    if (!isLive(p, now)) continue
    if (p.as === 'helper') peers.helpers.push(p.name ?? 'Someone')
    else peers.patient += 1
  }
  return peers
}

/** A room with no live screen and no change for 3 hours is gone; its code can be reused. */
export function isExpired(lastChange: number, presence: readonly Presence[], now: number): boolean {
  if (presence.some((p) => isLive(p, now))) return false
  return now - lastChange >= ROOM_TTL_MS
}

// ---- arrangement --------------------------------------------------------------------------

export const MAX_ITEMS = 60
export const TITLE_MAX = 80
export const CAPTION_MAX = 240
const PIECE = /^(video|thumb|k\d{4})$/

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '')

export type ArrangementItem = { capture: string; piece: string; title: string; caption: string }
export type Arrangement = { title: string; subtitle: string; items: ArrangementItem[] }

/** Checks the editor's arrangement against the captures that exist; cleaned value or an error. */
export function validateArrangement(
  body: { title?: unknown; subtitle?: unknown; items: readonly { capture: unknown; piece: unknown; title?: unknown; caption?: unknown }[] },
  captureIds: Set<string>,
): { value: Arrangement } | { error: string } {
  if (body.items.length > MAX_ITEMS) return { error: `At most ${MAX_ITEMS} pictures.` }
  const items: ArrangementItem[] = []
  for (const [i, item] of body.items.entries()) {
    if (!isCaptureId(item.capture) || !captureIds.has(item.capture)) return { error: `Item ${i + 1} points at a capture that doesn't exist.` }
    if (typeof item.piece !== 'string' || !PIECE.test(item.piece)) return { error: `Item ${i + 1}: "piece" must be video, thumb or kNNNN.` }
    items.push({ capture: item.capture, piece: item.piece, title: text(item.title, TITLE_MAX), caption: text(item.caption, CAPTION_MAX) })
  }
  return { value: { title: text(body.title, TITLE_MAX) || 'Our visits', subtitle: text(body.subtitle, TITLE_MAX), items } }
}

/** What a visitor may see: only the pictures from captures the family made public. */
export function publicArrangement<A extends Arrangement>(arrangement: A | null, publicIds: Iterable<string>): A | null {
  if (!arrangement) return null
  const visible = new Set(publicIds)
  return { ...arrangement, items: arrangement.items.filter((item) => visible.has(item.capture)) }
}
