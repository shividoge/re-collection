import { rooms, type Room, type RoomChange, type RoomPeers, type RoomState, type RoomWho } from '../data'
import { failed, intend, received, retry, sent, shown, startSync, takeNext, type RoomSpot, type RoomSync } from './roomSync'

/** Each screen says it's there this often; peers count heartbeats newer than 12 s (§6.6). */
export const HEARTBEAT_MS = 5000
/** The iPad sends a change Convex didn't take again after this long. */
export const RETRY_MS = 2000
/** A room nobody on this tab uses any more is closed after this long (the iPad switching screens reuses it). */
export const KEEP_MS = 2000

/**
 * live: connected. connecting / reconnecting: trying. gone: no room with this code (wrong code
 * or expired). Only the helper's screen ever shows these.
 */
export type RoomStatus = 'off' | 'connecting' | 'live' | 'reconnecting' | 'gone'

export type RoomSnapshot = { sync: RoomSync; peers: RoomPeers; status: RoomStatus }

/** How the client reaches Convex (swapped out in tests). */
export type RoomTransport = {
  setState(code: string, change: RoomChange): Promise<{ state: RoomState }>
  /** `onRoom` now and on every change (null: no such room). Returns stop. */
  watch(code: string, onRoom: (room: Room | null) => void, onError: (error: unknown) => void): () => void
  heartbeat(code: string, who: RoomWho): Promise<void>
  /** `onChange(connected)` when the connection drops or comes back. Returns stop. */
  connection(onChange: (connected: boolean) => void): () => void
}

export const convexTransport: RoomTransport = rooms

const NO_PEERS: RoomPeers = { patient: 0, helpers: [] }

/**
 * One screen's connection to a museum room: a reactive Convex query for the room's state and
 * peers, a heartbeat every 5 s so the others see this screen, and this screen's own changes, sent
 * one at a time in order. One per browser tab and room, shared by the iPad's museum and its Memory
 * Window, so a change made just before switching screens isn't lost.
 */
export class RoomClient {
  private snapshot: RoomSnapshot
  private readonly listeners = new Set<() => void>()
  private stopped = false
  private readonly stops: (() => void)[] = []
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private readonly code: string
  private readonly who: RoomWho
  private readonly transport: RoomTransport

  constructor(code: string, who: RoomWho, transport: RoomTransport = convexTransport) {
    this.code = code
    this.who = who
    this.transport = transport
    this.snapshot = { sync: startSync(who.as), peers: NO_PEERS, status: 'connecting' }
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  readonly getSnapshot = () => this.snapshot

  get closed() {
    return this.stopped
  }

  private set(next: Partial<RoomSnapshot>) {
    this.snapshot = { ...this.snapshot, ...next }
    for (const listener of this.listeners) listener()
  }

  private later(fn: () => void, ms: number) {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (!this.stopped) fn()
    }, ms)
    this.timers.add(timer)
    return timer
  }

  private apply(state: RoomState) {
    const sync = received(this.snapshot.sync, state)
    if (sync !== this.snapshot.sync) this.set({ sync })
  }

  start() {
    this.stops.push(
      this.transport.watch(
        this.code,
        (room) => {
          if (this.stopped) return
          if (!room) return this.gone()
          this.apply(room.state)
          this.set({ peers: room.peers, status: 'live' })
        },
        () => {
          if (!this.stopped && this.snapshot.status === 'live') this.set({ status: 'reconnecting' })
        },
      ),
      this.transport.connection((connected) => {
        if (this.stopped || this.snapshot.status === 'gone') return
        if (!connected && this.snapshot.status === 'live') this.set({ status: 'reconnecting' })
        // The query re-delivers on reconnect; a quiet room still counts as live again.
        if (connected && this.snapshot.status === 'reconnecting') this.set({ status: 'live' })
      }),
    )
    this.beat()
  }

  /** Says this screen is here, now and every HEARTBEAT_MS. A missed beat is just tried next time. */
  private beat() {
    this.transport.heartbeat(this.code, this.who).catch(() => {})
    this.later(() => this.beat(), HEARTBEAT_MS)
  }

  /** The room no longer exists: stop, and say so (the helper's screen shows it; the iPad forgets the code). */
  private gone() {
    this.stop()
    this.set({ status: 'gone' })
  }

  /** A change made on this screen: shown at once, and sent after any change still on its way. */
  change(make: (current: RoomSpot | null) => RoomSpot) {
    if (this.stopped) return
    this.set({ sync: intend(this.snapshot.sync, make(shown(this.snapshot.sync))) })
    this.pump()
  }

  /** Send a change Convex didn't take again. */
  retry() {
    if (this.stopped) return
    this.set({ sync: retry(this.snapshot.sync) })
    this.pump()
  }

  private pump() {
    const [sync, intent] = takeNext(this.snapshot.sync)
    if (!intent) return
    this.set({ sync })
    const { as, name } = this.who
    this.transport.setState(this.code, { ...intent.spot, by: as, name: as === 'helper' ? name : null }).then(
      ({ state }) => {
        if (this.stopped) return
        this.set({ sync: sent(this.snapshot.sync, intent.seq, state) })
        this.pump()
      },
      () => {
        if (this.stopped) return
        this.set({ sync: failed(this.snapshot.sync, intent.seq) })
        // The iPad never shows a problem: it keeps walking and tries again. The helper is told.
        if (this.who.as === 'patient') this.later(() => this.retry(), RETRY_MS)
        this.pump()
      },
    )
  }

  stop() {
    if (this.stopped) return
    this.stopped = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    for (const stop of this.stops.splice(0)) stop()
  }
}

type Entry = { client: RoomClient; users: number; closing: ReturnType<typeof setTimeout> | null }
const open = new Map<string, Entry>()

/**
 * The tab's client for this room and screen, started if needed. Call `release` when done; the
 * client stays open for a moment in case the next screen wants it.
 */
export function acquireRoom(code: string, who: RoomWho, transport: RoomTransport = convexTransport): { client: RoomClient; release: () => void } {
  const key = JSON.stringify([code, who.as, who.name, who.client])
  let entry = open.get(key)
  if (!entry || entry.client.closed) {
    const client = new RoomClient(code, who, transport)
    client.start()
    entry = { client, users: 0, closing: null }
    open.set(key, entry)
  }
  const kept = entry
  if (kept.closing !== null) clearTimeout(kept.closing)
  kept.closing = null
  kept.users += 1
  let released = false
  return {
    client: kept.client,
    release: () => {
      if (released) return
      released = true
      kept.users -= 1
      if (kept.users > 0) return
      kept.closing = setTimeout(() => {
        kept.client.stop()
        if (open.get(key) === kept) open.delete(key)
      }, KEEP_MS)
    },
  }
}
