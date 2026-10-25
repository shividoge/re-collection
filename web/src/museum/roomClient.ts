import { GuideError, museumRooms, type Room, type RoomChange, type RoomPeers, type RoomState, type RoomWho } from '../api'
import { failed, intend, received, retry, sent, shown, startSync, takeNext, type RoomSpot, type RoomSync } from './roomSync'

/** How long the event stream gets to deliver its first state before the client polls instead. */
export const STREAM_GRACE_MS = 3000
export const POLL_MS = 1000
/** A poll stuck in the tunnel longer than this is given up and tried again. */
export const POLL_TIMEOUT_MS = 5000
/** The iPad sends a change the guide didn't take again after this long. */
export const RETRY_MS = 2000
/** A room nobody on this tab uses any more is closed after this long (the iPad switching screens reuses it). */
export const KEEP_MS = 2000

/**
 * live: connected. connecting / reconnecting: trying. gone: no room with this code (wrong code,
 * expired, or the guide restarted). Only the helper's screen ever shows these.
 */
export type RoomStatus = 'off' | 'connecting' | 'live' | 'reconnecting' | 'gone'

export type RoomSnapshot = { sync: RoomSync; peers: RoomPeers; status: RoomStatus }

type Listener = (e: { data?: unknown }) => void
/** The part of `EventSource` the client uses. */
export type RoomEvents = { addEventListener(type: string, listener: Listener): void; close(): void }

/** How the client reaches the guide (swapped out in tests). */
export type RoomTransport = {
  setState(code: string, change: RoomChange): Promise<{ state: RoomState }>
  poll(code: string, who: RoomWho, since: number | null, signal: AbortSignal): Promise<Room | null>
  events(code: string, who: RoomWho): RoomEvents
}

export const guideTransport: RoomTransport = {
  setState: (code, change) => museumRooms.setState(code, change),
  poll: (code, who, since, signal) => museumRooms.poll(code, who, since, signal),
  events: (code, who) => new EventSource(museumRooms.eventsUrl(code, who)),
}

const NO_PEERS: RoomPeers = { patient: 0, helpers: [] }
const isGone = (error: unknown) => error instanceof GuideError && error.status === 404

/**
 * One screen's connection to a museum room: the guide's event stream, or polling once a second
 * when the stream doesn't get through (a cloudflared quick tunnel holds back its body), plus this
 * screen's own changes, sent one at a time in order. One per browser tab and room, shared by the
 * iPad's museum and its Memory Window, so a change made just before switching screens isn't lost.
 */
export class RoomClient {
  private snapshot: RoomSnapshot
  private readonly listeners = new Set<() => void>()
  private stopped = false
  private polling = false
  private version: number | null = null
  private events: RoomEvents | null = null
  private inflight: AbortController | null = null
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private readonly code: string
  private readonly who: RoomWho
  private readonly transport: RoomTransport

  constructor(code: string, who: RoomWho, transport: RoomTransport = guideTransport) {
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

  private cancel(timer: ReturnType<typeof setTimeout> | null) {
    if (timer === null) return
    clearTimeout(timer)
    this.timers.delete(timer)
  }

  private apply(state: RoomState) {
    const sync = received(this.snapshot.sync, state)
    if (sync !== this.snapshot.sync) this.set({ sync })
  }

  start() {
    const events = this.transport.events(this.code, this.who)
    this.events = events
    // Headers can arrive with no body behind them (a quick tunnel), so only a first state counts.
    const grace = this.later(() => this.fallBack(), STREAM_GRACE_MS)
    events.addEventListener('state', (e) => {
      if (this.polling || this.stopped) return
      this.cancel(grace)
      if (this.snapshot.status !== 'live') this.set({ status: 'live' })
      this.apply(JSON.parse(String(e.data)) as RoomState)
    })
    events.addEventListener('peers', (e) => {
      if (!this.polling && !this.stopped) this.set({ peers: JSON.parse(String(e.data)) as RoomPeers })
    })
    // A dropped stream, a 404 or a tunnel's 502: polling finds out which, and carries on if it can.
    events.addEventListener('error', () => this.fallBack())
  }

  /** Quietly switch to polling for as long as this room stays open. */
  private fallBack() {
    if (this.polling || this.stopped) return
    this.polling = true
    this.events?.close()
    void this.poll()
  }

  private async poll() {
    const aborter = new AbortController()
    this.inflight = aborter
    const timeout = setTimeout(() => aborter.abort(), POLL_TIMEOUT_MS)
    try {
      const room = await this.transport.poll(this.code, this.who, this.version, aborter.signal)
      if (this.stopped) return
      if (room) {
        this.version = room.version
        this.apply(room.state)
        this.set({ peers: room.peers })
      }
      if (this.snapshot.status !== 'live') this.set({ status: 'live' })
    } catch (error) {
      if (this.stopped) return
      if (isGone(error)) return this.gone()
      if (this.snapshot.status === 'live') this.set({ status: 'reconnecting' })
    } finally {
      clearTimeout(timeout)
    }
    this.later(() => void this.poll(), POLL_MS)
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

  /** Send a change the guide didn't take again. */
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
      (error: unknown) => {
        if (this.stopped) return
        if (isGone(error)) return this.gone()
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
    this.inflight?.abort()
    this.events?.close()
  }
}

type Entry = { client: RoomClient; users: number; closing: ReturnType<typeof setTimeout> | null }
const open = new Map<string, Entry>()

/**
 * The tab's client for this room and screen, started if needed. Call `release` when done; the
 * client stays open for a moment in case the next screen wants it.
 */
export function acquireRoom(code: string, who: RoomWho, transport: RoomTransport = guideTransport): { client: RoomClient; release: () => void } {
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
