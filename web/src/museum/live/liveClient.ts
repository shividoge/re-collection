import { GuideError, palaceLive, type Live, type LiveMember, type LiveRole, type LiveView } from '../../api'

/** How often a screen asks the guide what's new (ms). Event streams don't get through the tunnel. */
export const POLL_MS = 200
/** A poll stuck in the tunnel longer than this is dropped and tried again (ms). */
const POLL_TIMEOUT_MS = 5000
/** The patient's view is sent at most this often (ms), and only when it changed. */
const VIEW_MS = 200

export type LiveStatus = 'joining' | 'live' | 'reconnecting'
export type LiveSnapshot = { status: LiveStatus; me: string | null; role: LiveRole; members: LiveMember[]; view: Live['view'] }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
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
 * One screen in the live visit: joins, keeps polling the guide, and hands on what arrives (who's
 * here, the patient's view, call-setup messages, relayed voice). Rejoins by itself if the guide
 * forgot it (a restart). React reads it with `useSyncExternalStore(visit.subscribe, visit.snapshot)`.
 */
export class LiveVisit {
  readonly role: LiveRole
  readonly name: string | undefined
  iceServers: RTCIceServer[] = []
  onSignal: (from: string, data: unknown) => void = () => {}
  onAudio: (from: string, bytes: Uint8Array) => void = () => {}

  private state: LiveSnapshot
  private listeners = new Set<() => void>()
  private since: number | null = null
  private shown = -1
  private audioAfter: number | null = null
  private stopped = false
  private sentView: LiveView | null = null
  private nextView: LiveView | null = null
  private viewTimer: ReturnType<typeof setTimeout> | null = null

  constructor(role: LiveRole, name?: string) {
    this.role = role
    this.name = name
    this.state = { status: 'joining', me: null, role, members: [], view: null }
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
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
    void this.run()
    // Closing the tab leaves the visit, so the others see it at once.
    window.addEventListener('pagehide', this.leaveNow)
  }

  stop() {
    this.stopped = true
    window.removeEventListener('pagehide', this.leaveNow)
    if (this.viewTimer) clearTimeout(this.viewTimer)
    this.leaveNow()
  }

  private leaveNow = () => {
    if (this.state.me) void palaceLive.leave(this.state.me, true).catch(() => {})
  }

  private async join() {
    const joined = await palaceLive.join(this.role, this.name)
    this.iceServers = joined.iceServers
    this.since = joined.live.version
    this.audioAfter = null
    this.sentView = null
    this.set({ status: 'live', me: joined.me.id, members: joined.live.members, view: joined.live.view })
  }

  private async run() {
    while (!this.stopped) {
      try {
        if (!this.state.me) await this.join()
        const abort = new AbortController()
        const timer = setTimeout(() => abort.abort(), POLL_TIMEOUT_MS)
        const got = await palaceLive.poll(this.state.me!, this.since, this.audioAfter, abort.signal).finally(() => clearTimeout(timer))
        if (this.stopped) return
        if (got) {
          this.since = got.version
          // The first answer only says where the voice relay is up to: no replaying the last seconds.
          if (this.audioAfter === null) this.audioAfter = got.audioSeq
          else {
            for (const chunk of got.audio) {
              this.audioAfter = Math.max(this.audioAfter, chunk.seq)
              this.onAudio(chunk.from, Uint8Array.from(atob(chunk.data), (c) => c.charCodeAt(0)))
            }
          }
          for (const s of got.signals) this.onSignal(s.from, s.data)
          // An answer can carry only voice; the screen redraws only when who's here or the view changed.
          if (got.version !== this.shown || this.state.status !== 'live') {
            this.shown = got.version
            this.set({ status: 'live', members: got.members, view: got.view })
          }
        } else if (this.state.status !== 'live') this.set({ status: 'live' })
      } catch (e) {
        if (this.stopped) return
        // Forgotten by the guide (it restarted): join again.
        if (e instanceof GuideError && e.status === 404) this.set({ me: null })
        if (this.state.status === 'live') this.set({ status: 'reconnecting' })
        await sleep(1000)
        continue
      }
      await sleep(POLL_MS)
    }
  }

  /** The patient's screen: where they are now. Sent a few times a second, only when it changed. */
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
      void palaceLive.view(me, v).catch(() => (this.sentView = null))
    }, VIEW_MS)
  }

  signal(to: string, data: unknown) {
    const me = this.state.me
    if (me) void palaceLive.signal(me, to, data).catch(() => {})
  }

  sendAudio(bytes: Uint8Array) {
    const me = this.state.me
    if (me) void palaceLive.audio(me, bytes).catch(() => {})
  }
}
