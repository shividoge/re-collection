import { errorCode, errorMessage, palaceLive, rooms, type IceServer, type LiveAudio, type LiveMember, type LiveRole, type LiveSignal, type LiveView, type LiveViewState } from '../../data'

/** Each screen says it's still here this often; the server drops it after 10 s of silence (§6.6). */
export const HEARTBEAT_MS = 3000
/** The patient's view is sent at most this often (ms), and only when it changed. */
const VIEW_MS = 200
/** After a failed join (offline, say), try again this soon (ms). */
const RETRY_MS = 2000

/** ended: this screen is out of the visit for good (an old link, or the visit is full); `error` says why. */
export type LiveStatus = 'joining' | 'live' | 'reconnecting' | 'ended'
export type LiveSnapshot = { status: LiveStatus; error: string | null; me: string | null; role: LiveRole; members: LiveMember[]; view: LiveViewState | null }

/** What the visit needs from the server (palaceLive; a fake in tests). */
export type LiveTransport = Pick<
  typeof palaceLive,
  'join' | 'heartbeat' | 'leave' | 'setView' | 'signal' | 'ackSignals' | 'sendAudio' | 'watchMembers' | 'watchView' | 'watchSignals' | 'watchAudio'
> & { connection: (onChange: (connected: boolean) => void) => () => void }

const convexTransport: LiveTransport = { ...palaceLive, connection: rooms.connection }

/** Views that differ by less than this aren't worth sending again. */
const sameView = (a: LiveView | null, b: LiveView) =>
  a !== null &&
  Math.abs(a.x - b.x) < 0.005 &&
  Math.abs(a.z - b.z) < 0.005 &&
  Math.abs(a.yaw - b.yaw) < 0.003 &&
  Math.abs(a.pitch - b.pitch) < 0.003 &&
  JSON.stringify(a.inside) === JSON.stringify(b.inside) &&
  a.music === b.music

/**
 * One screen in the live visit: joins with the visit key, keeps saying it's here, and hands on
 * what the server's reactive queries send (who's here, her view, call-setup messages, relayed
 * voice). Joins again by itself if the server dropped it. React reads it with
 * `useSyncExternalStore(visit.subscribe, visit.snapshot)`.
 */
export class LiveVisit {
  readonly key: string
  readonly role: LiveRole
  readonly name: string | undefined
  iceServers: IceServer[] = []
  onSignal: (from: string, data: unknown) => void = () => {}
  onAudio: (from: string, bytes: Uint8Array) => void = () => {}
  /** The key no longer works (a new link was made): the page forgets it. */
  onBadKey: () => void = () => {}

  private transport: LiveTransport
  private state: LiveSnapshot
  private listeners = new Set<() => void>()
  private stopped = false
  /** Goes up with every (re)join; answers for an older one are ignored. */
  private epoch = 0
  private unwatch: (() => void)[] = []
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private seenSignals = new Set<string>()
  private audioAfter: number | null = null
  private sentView: LiveView | null = null
  private nextView: LiveView | null = null
  private viewTimer: ReturnType<typeof setTimeout> | null = null
  private stopConnection: (() => void) | null = null

  constructor(key: string, role: LiveRole, name?: string, transport: LiveTransport = convexTransport) {
    this.key = key
    this.role = role
    this.name = name
    this.transport = transport
    this.state = { status: 'joining', error: null, me: null, role, members: [], view: null }
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }
  snapshot = () => this.state

  private set(patch: Partial<LiveSnapshot>) {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l()
  }

  get me() {
    return this.state.me
  }

  start() {
    this.stopConnection = this.transport.connection((connected) => {
      if (this.stopped || this.state.status === 'ended') return
      if (!connected && this.state.status === 'live') this.set({ status: 'reconnecting' })
      if (connected && this.state.status === 'reconnecting' && this.state.me) this.set({ status: 'live' })
    })
    // Closing the tab leaves the visit, so the others see it at once (else after 10 s).
    window.addEventListener('pagehide', this.leaveNow)
    void this.join()
  }

  stop() {
    if (this.stopped) return
    this.leaveNow()
    this.stopped = true
    window.removeEventListener('pagehide', this.leaveNow)
    this.stopConnection?.()
    this.teardown()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.viewTimer) clearTimeout(this.viewTimer)
  }

  private leaveNow = () => {
    const me = this.state.me
    if (me && !this.stopped) void this.transport.leave(this.key, me).catch(() => {})
  }

  /** Stops the subscriptions and the heartbeat of the current join. */
  private teardown() {
    for (const stop of this.unwatch.splice(0)) stop()
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  /** Out of the visit for good, with the reason shown. */
  private end(error: unknown) {
    if (errorCode(error) === 'bad_key') this.onBadKey()
    this.teardown()
    this.set({ status: 'ended', error: errorMessage(error), me: null, members: [], view: null })
  }

  /** Any failure from the server: an old key ends the visit; being dropped joins again. */
  private failed(epoch: number, error: unknown) {
    if (this.stopped || epoch !== this.epoch) return
    const code = errorCode(error)
    if (code === 'bad_key') this.end(error)
    else if (code === 'not_found') void this.join()
  }

  private async join() {
    if (this.stopped) return
    const epoch = ++this.epoch
    this.teardown()
    if (this.state.me) this.set({ status: 'reconnecting', me: null })
    let joined: { me: string; iceServers: IceServer[] }
    try {
      joined = await this.transport.join(this.key, this.role, this.name)
    } catch (error) {
      if (this.stopped || epoch !== this.epoch) return
      const code = errorCode(error)
      // An old link, or the visit is full: nothing to retry.
      if (code === 'bad_key' || code === 'invalid') return this.end(error)
      this.set({ status: 'reconnecting' })
      this.retryTimer = setTimeout(() => void this.join(), RETRY_MS)
      return
    }
    if (this.stopped || epoch !== this.epoch) {
      void this.transport.leave(this.key, joined.me).catch(() => {})
      return
    }
    const { me } = joined
    this.iceServers = joined.iceServers
    this.audioAfter = null
    this.sentView = null
    this.seenSignals.clear()
    this.set({ status: 'live', error: null, me })

    const fail = (e: unknown) => this.failed(epoch, e)
    this.heartbeatTimer = setInterval(() => void this.transport.heartbeat(this.key, me).catch(fail), HEARTBEAT_MS)
    this.unwatch.push(
      this.transport.watchMembers(
        this.key,
        me,
        ({ here, members }) => {
          if (epoch !== this.epoch) return
          // Dropped (asleep too long, say): join again.
          if (!here) return void this.join()
          this.set({ members })
        },
        fail,
      ),
      this.transport.watchSignals(this.key, me, (list) => epoch === this.epoch && this.gotSignals(me, list), fail),
      this.transport.watchAudio(this.key, me, (audio) => epoch === this.epoch && this.gotAudio(audio), fail),
    )
    // Family follow her view; her own screen doesn't need it back.
    if (this.role === 'family') this.unwatch.push(this.transport.watchView(this.key, (view) => epoch === this.epoch && this.set({ view }), fail))
  }

  private gotSignals(me: string, list: LiveSignal[]) {
    const fresh = list.filter((s) => !this.seenSignals.has(s.id))
    if (fresh.length === 0) return
    for (const s of fresh) {
      this.seenSignals.add(s.id)
      let data: unknown
      try {
        data = JSON.parse(s.data)
      } catch {
        continue
      }
      this.onSignal(s.from, data)
    }
    void this.transport.ackSignals(this.key, me, fresh.map((s) => s.id)).catch(() => {})
  }

  private gotAudio({ latest, chunks }: LiveAudio) {
    // The first answer only says where the relay is up to: no replaying the last seconds.
    if (this.audioAfter === null) {
      this.audioAfter = latest
      return
    }
    for (const c of chunks) {
      if (c.seq <= this.audioAfter) continue
      this.audioAfter = c.seq
      this.onAudio(c.from, new Uint8Array(c.data))
    }
  }

  /** The patient's screen: where she is now. Sent a few times a second, only when it changed. */
  sendView(view: LiveView) {
    if (this.role !== 'patient') return
    this.nextView = view
    if (this.viewTimer) return
    this.viewTimer = setTimeout(() => {
      this.viewTimer = null
      const v = this.nextView
      const me = this.state.me
      if (!v || !me || sameView(this.sentView, v)) return
      this.sentView = v
      const epoch = this.epoch
      void this.transport.setView(this.key, me, v).catch((e: unknown) => {
        this.sentView = null
        this.failed(epoch, e)
      })
    }, VIEW_MS)
  }

  signal(to: string, data: unknown) {
    const me = this.state.me
    if (me) void this.transport.signal(this.key, me, to, JSON.stringify(data)).catch(() => {})
  }

  sendAudio(bytes: Uint8Array) {
    const me = this.state.me
    if (!me) return
    const copy = bytes.slice().buffer
    void this.transport.sendAudio(this.key, me, copy).catch(() => {})
  }
}
