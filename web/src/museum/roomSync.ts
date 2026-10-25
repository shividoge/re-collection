import type { RoomRole, RoomState } from '../data/types'

/**
 * The pure core of "Visit together": what a screen knows about the shared walk, and how it
 * changes. No timers, no network: `roomClient.ts` feeds it and sends what it says to send.
 *
 * - `confirmed` is the newest state Convex has confirmed. It only ever moves forward by `rev`,
 *   whether it came from the room query or the answer to our own setState.
 * - `intents` are this screen's own changes, oldest first, that the server hasn't confirmed yet.
 *   At most one is being sent; a newer one replaces any that are still waiting, so changes reach
 *   the server in order and only the latest unsent one matters.
 * - What the screen shows is the newest intent over `confirmed`, so each new change builds on the
 *   last one the person made, not on a confirmation that hasn't caught up yet.
 */

/** Where the walk is: the part of `RoomState` a screen changes. */
export type RoomSpot = { at: number; atId: string | null; window: string | null }

export type Intent = {
  seq: number
  spot: RoomSpot
  /** waiting: not sent yet. sending: one setState in flight. failed: the server didn't take it. */
  status: 'waiting' | 'sending' | 'failed'
  /** The confirmed rev when it was sent: a failed change is out of date once the room moves past it. */
  base: number
}

export type RoomSync = { role: RoomRole; confirmed: RoomState | null; intents: Intent[]; seq: number }

export const startSync = (role: RoomRole): RoomSync => ({ role, confirmed: null, intents: [], seq: 0 })

const confirmedRev = (s: RoomSync) => s.confirmed?.rev ?? -1

export const spotOf = ({ at, atId, window }: RoomSpot): RoomSpot => ({ at, atId, window })

/** A state from the server (room query or setState answer). Older or repeated revs change nothing. */
export function received(s: RoomSync, state: RoomState): RoomSync {
  if (state.rev <= confirmedRev(s)) return s
  // A change the server refused is out of date now that the room has moved on without it.
  return { ...s, confirmed: state, intents: s.intents.filter((i) => i.status !== 'failed') }
}

/**
 * The person made a change. Anything not yet sent (or refused) is replaced by it; the one in
 * flight stays, and this goes after it.
 */
export function intend(s: RoomSync, spot: RoomSpot): RoomSync {
  const seq = s.seq + 1
  return { ...s, seq, intents: [...s.intents.filter((i) => i.status === 'sending'), { seq, spot: spotOf(spot), status: 'waiting', base: -1 }] }
}

/** The next change to send, if none is in flight. */
export function takeNext(s: RoomSync): [RoomSync, Intent | null] {
  if (s.intents.some((i) => i.status === 'sending')) return [s, null]
  const next = s.intents.find((i) => i.status === 'waiting')
  if (!next) return [s, null]
  const sending: Intent = { ...next, status: 'sending', base: confirmedRev(s) }
  return [{ ...s, intents: s.intents.map((i) => (i.seq === next.seq ? sending : i)) }, sending]
}

/** The server took change `seq` and answered with the room's state after it. */
export function sent(s: RoomSync, seq: number, state: RoomState): RoomSync {
  return received({ ...s, intents: s.intents.filter((i) => i.seq !== seq) }, state)
}

/**
 * The server didn't take change `seq` (a 500 or no network). It's dropped when something newer
 * already replaced it: a later change by this person, or a newer state from the server. Otherwise
 * it's kept as failed: the iPad keeps showing it and walks alone (and tries again); the helper's
 * phone goes back to the confirmed state and offers to try again.
 */
export function failed(s: RoomSync, seq: number): RoomSync {
  const intent = s.intents.find((i) => i.seq === seq)
  if (!intent) return s
  const outdated = confirmedRev(s) > intent.base || s.intents.some((i) => i.seq > seq)
  return {
    ...s,
    intents: outdated ? s.intents.filter((i) => i.seq !== seq) : s.intents.map((i) => (i.seq === seq ? { ...i, status: 'failed' } : i)),
  }
}

/** Send a refused change again. */
export function retry(s: RoomSync): RoomSync {
  if (!s.intents.some((i) => i.status === 'failed')) return s
  return { ...s, intents: s.intents.map((i) => (i.status === 'failed' ? { ...i, status: 'waiting' } : i)) }
}

/** What this screen shows: its own newest change, else the server's. */
export function shown(s: RoomSync): RoomSpot | null {
  const own = s.intents.filter((i) => i.status !== 'failed' || s.role === 'patient').at(-1)
  return own ? own.spot : s.confirmed ? spotOf(s.confirmed) : null
}

/** The helper's last change didn't reach the server (they see it, with a way to try again). */
export const sendFailed = (s: RoomSync): boolean => s.role === 'helper' && s.intents.some((i) => i.status === 'failed')

/**
 * iPad only: should the screen move? `followed` is the newest rev the iPad has acted on; `here`
 * is what's open on it now (a capture id, or null in the hall). While the iPad's own changes are
 * unconfirmed it stays where its person put it. Once they're settled, the newest confirmed state
 * decides: a helper's change it hasn't acted on moves it (`go`: a capture id, or null for the
 * hall); the iPad's own change is where it already is. Either way that rev counts as followed.
 */
export function follow(s: RoomSync, followed: number, here: string | null): { mark: number; go?: string | null } | null {
  const state = s.confirmed
  if (!state || s.intents.length > 0 || state.rev <= followed) return null
  if (state.by === 'helper' && state.window !== here) return { mark: state.rev, go: state.window }
  return { mark: state.rev }
}

/**
 * What's open on the iPad, read from the address: null in the museum's hall, a capture id in a
 * Memory Window opened from the museum, undefined anywhere else (nothing to follow there).
 */
export function roomHere(hash: string): string | null | undefined {
  // #/museum is the hall; #/memories is its old address (old links still land there).
  if (/^#\/(museum|memories)$/i.test(hash)) return null
  const window = /^#\/window\/([0-9a-f-]{36})\?from=museum$/i.exec(hash)
  return window ? window[1] : undefined
}

/** The address for a place on the iPad. */
export const roomHash = (window: string | null): string => (window ? `#/window/${window}?from=museum` : '#/museum')
