// The live visit's pure rules (docs/architecture-v3.md §6.6 "Live visit"), ported from the
// guide's live.mjs (PR #57). No database, no clock: palace.ts does that.

/** A member not heard from for this long has left (screens heartbeat every 3 s). */
export const GONE_MS = 10_000
/** Relayed voice is kept this long. */
export const AUDIO_KEEP_MS = 10_000
/** `palace.audio` hands out at most this many chunks (about 2 s of voice). */
export const AUDIO_RECENT = 8
export const AUDIO_MAX_BYTES = 64 * 1024
export const SIGNAL_MAX_BYTES = 16 * 1024
/** Unread call-setup messages kept per member (older ones are dropped). */
export const SIGNAL_BACKLOG = 200
export const NAME_MAX = 40
export const KEY_PATTERN = /^[A-Za-z0-9_-]{32}$/
export const DEFAULT_ICE: IceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

export type Role = 'patient' | 'family'
export type Stage = 'diving' | 'here' | 'leaving'
export type View = { x: number; z: number; yaw: number; pitch: number; inside: { index: number; stage: Stage } | null; music: boolean }
export type IceServer = { urls: string | string[]; username?: string; credential?: string }

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

/** Whitespace collapsed, at most NAME_MAX characters; '' when there's nothing. */
export function cleanName(name: unknown): string {
  return typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim() : ''
}

/** Checks a view from the patient's screen. */
export function parseView(view: View): { ok: true; value: View } | { ok: false; error: string } {
  const { x, z, yaw, pitch, inside, music } = view
  if (![x, z, yaw, pitch].every(finite)) return { ok: false, error: 'x, z, yaw and pitch must be finite numbers.' }
  if (inside !== null) {
    if (!Number.isInteger(inside.index) || inside.index < 0 || inside.index > 999) return { ok: false, error: 'inside.index must be a whole number from 0 to 999.' }
  }
  return { ok: true, value: { x, z, yaw, pitch, inside: inside && { index: inside.index, stage: inside.stage }, music } }
}

const isUrls = (u: unknown): u is string | string[] => (typeof u === 'string' && u.length > 0) || (Array.isArray(u) && u.length > 0 && u.every((s) => typeof s === 'string' && s.length > 0))

/** `ICE_SERVERS` (a JSON array as RTCPeerConnection takes it); a public STUN server when unset or unreadable. */
export function iceServersFrom(raw: string | undefined): IceServer[] {
  if (!raw) return DEFAULT_ICE
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return DEFAULT_ICE
    const servers: IceServer[] = []
    for (const s of parsed as unknown[]) {
      if (!s || typeof s !== 'object') continue
      const { urls, username, credential } = s as Record<string, unknown>
      if (!isUrls(urls)) continue
      servers.push({ urls, ...(typeof username === 'string' ? { username } : {}), ...(typeof credential === 'string' ? { credential } : {}) })
    }
    return servers.length > 0 ? servers : DEFAULT_ICE
  } catch {
    return DEFAULT_ICE
  }
}

/** 24 random bytes as 32 base64url characters. */
export function encodeKey(bytes: Uint8Array): string {
  if (bytes.length !== 24) throw new Error('A visit key needs 24 random bytes.')
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let out = ''
  for (let i = 0; i < 24; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += abc[(n >> 18) & 63] + abc[(n >> 12) & 63] + abc[(n >> 6) & 63] + abc[n & 63]
  }
  return out
}

/** Same length and characters, compared without stopping at the first difference. */
export function sameKey(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
