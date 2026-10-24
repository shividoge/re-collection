import { useCallback, useEffect, useRef, useState } from 'react'
import { GuideError, museumRooms, type RoomChange, type RoomPeers, type RoomRole, type RoomState } from '../api'

const ROOM_KEY = 'braindance.museum.room'
const NAME_KEY = 'braindance.museum.helperName'
/** The newest change any iPad screen has acted on: { code, rev }. Survives the museum ↔ window switch. */
const FOLLOWED_KEY = 'braindance.museum.followed'
/** One id per browser tab, so the iPad's museum and Memory Window count as one screen. */
const CLIENT_KEY = 'braindance.museum.client'
/** How long the event stream gets to deliver its first state before the hook polls instead. */
const STREAM_GRACE_MS = 3000
const POLL_MS = 1000
/** A poll stuck in the tunnel longer than this is given up and tried again. */
const POLL_TIMEOUT_MS = 5000
/** How long stepping in or out waits for the guide before going anyway. */
const NAVIGATE_WAIT_MS = 1500
const CODE_PATTERN = /^[BCDFGHJKLMNPQRSTVWXZ]{4}$/

/**
 * live: connected. connecting / reconnecting: trying. gone: no room with this code (wrong code,
 * expired, or the guide restarted). Only the helper's screen ever shows these.
 */
export type RoomStatus = 'off' | 'connecting' | 'live' | 'reconnecting' | 'gone'

export function normalizeRoomCode(code: string | null | undefined): string | null {
  const upper = (code ?? '').trim().toUpperCase()
  return CODE_PATTERN.test(upper) ? upper : null
}

function readStorage(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key)
  } catch {
    return null
  }
}

function writeStorage(storage: () => Storage, key: string, value: string | null) {
  try {
    if (value === null) storage().removeItem(key)
    else storage().setItem(key, value)
  } catch {
    /* private mode: it lasts for this page only */
  }
}

const session = () => sessionStorage
const local = () => localStorage

function clientId(): string {
  const kept = readStorage(session, CLIENT_KEY)
  if (kept && /^[A-Za-z0-9_-]{8,64}$/.test(kept)) return kept
  // getRandomValues works on plain http too (randomUUID needs a secure context).
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  writeStorage(session, CLIENT_KEY, id)
  return id
}

function followedRev(code: string): number {
  try {
    const mark = JSON.parse(readStorage(session, FOLLOWED_KEY) ?? 'null') as { code?: unknown; rev?: unknown } | null
    return mark?.code === code && typeof mark.rev === 'number' ? mark.rev : -1
  } catch {
    return -1
  }
}

function markFollowed(code: string, rev: number) {
  writeStorage(session, FOLLOWED_KEY, JSON.stringify({ code, rev: Math.max(rev, followedRev(code)) }))
}

export type MuseumRoom = {
  role: RoomRole
  code: string | null
  state: RoomState | null
  peers: RoomPeers
  status: RoomStatus
  /** The helper's name (helper only; asked once, kept in localStorage). */
  name: string | null
  setName: (name: string) => void
  /** Patient: open a room starting at this frame. */
  open: (at: number) => Promise<void>
  /** Patient: stop visiting together. */
  close: () => void
  /** Walk to a frame (`atId`: its capture id, null at the entrance). */
  setAt: (at: number, atId: string | null) => void
  /** Opens a moment in the Memory Window on the iPad. Resolves once the guide has it (or after a short wait). */
  enter: (id: string, at: number) => Promise<void>
  /** Back to the museum on both screens. */
  leave: () => Promise<void>
  /**
   * iPad only: the helper's newest change that no iPad screen has acted on yet (stepping in or
   * out). Kept across the museum ↔ window switch, so a quick in-and-out by the helper isn't lost.
   */
  fresh: RoomState | null
  /** iPad only: call before acting on `fresh`. */
  followed: (rev: number) => void
}

const NO_PEERS: RoomPeers = { patient: 0, helpers: [] }

/**
 * One shared museum walk between the patient's iPad and a helper's phone. The iPad opens the
 * room and keeps its code for this tab (so the Memory Window joins the same room); the helper
 * joins with the code from the link. State comes from the guide's event stream, or from polling
 * once a second when the stream doesn't get through (a cloudflared quick tunnel holds back the
 * stream's body). Changes are shown at once and sent with a POST.
 *
 * `enabled: false` keeps the hook idle (the Memory Window opened from somewhere else).
 */
export function useMuseumRoom(role: RoomRole, { join = null, enabled = true }: { join?: string | null; enabled?: boolean } = {}): MuseumRoom {
  const [patientCode, setPatientCode] = useState<string | null>(() => (role === 'patient' ? normalizeRoomCode(readStorage(session, ROOM_KEY)) : null))
  const [name, setNameState] = useState<string | null>(() => (role === 'helper' ? readStorage(local, NAME_KEY)?.trim() || null : null))
  const code = !enabled ? null : role === 'patient' ? patientCode : normalizeRoomCode(join)
  // The helper connects once they've said who they are.
  const connectable = code !== null && (role === 'patient' || name !== null)

  const [state, setState] = useState<RoomState | null>(null)
  const [peers, setPeers] = useState<RoomPeers>(NO_PEERS)
  const [status, setStatus] = useState<RoomStatus>('off')
  const [client] = useState(clientId)

  /** The newest state the guide has confirmed (by rev), and how many of our own changes are in flight. */
  const latest = useRef<RoomState | null>(null)
  const pending = useRef(0)

  const forget = useCallback(() => {
    if (role === 'patient') {
      writeStorage(session, ROOM_KEY, null)
      setPatientCode(null)
    }
  }, [role])

  /** Which room `state` belongs to: a reconnect to the same room keeps what's on screen. */
  const stateCode = useRef<string | null>(null)

  useEffect(() => {
    if (stateCode.current !== code) {
      stateCode.current = code
      latest.current = null
      pending.current = 0
      setState(null)
      setPeers(NO_PEERS)
    }
    if (!connectable || !code) {
      setStatus('off')
      return
    }
    let stopped = false
    let polling = false
    let pollTimer = 0
    let graceTimer = 0
    let version: number | null = null
    let inflight: AbortController | null = null
    const who = { as: role, name, client }
    setStatus((s) => (s === 'live' || s === 'reconnecting' ? 'reconnecting' : 'connecting'))
    const events = new EventSource(museumRooms.eventsUrl(code, who))

    const apply = (next: RoomState) => {
      if (latest.current && next.rev <= latest.current.rev) return
      latest.current = next
      // Our own change echoing back while others are still in flight would make the screen jump.
      if (pending.current > 0 && next.by === role) return
      setState(next)
    }

    const poll = async () => {
      const aborter = new AbortController()
      inflight = aborter
      const timeout = window.setTimeout(() => aborter.abort(), POLL_TIMEOUT_MS)
      try {
        const room = await museumRooms.poll(code, who, version, aborter.signal)
        if (stopped) return
        if (room) {
          version = room.version
          apply(room.state)
          setPeers(room.peers)
        }
        setStatus('live')
      } catch (error) {
        if (stopped) return
        if (error instanceof GuideError && error.status === 404) {
          stopped = true
          setStatus('gone')
          forget()
          return
        }
        setStatus((s) => (s === 'connecting' ? s : 'reconnecting'))
      } finally {
        window.clearTimeout(timeout)
      }
      pollTimer = window.setTimeout(() => void poll(), POLL_MS)
    }
    /** Quietly switch to polling for as long as this room stays open. */
    const fallBack = () => {
      if (polling || stopped) return
      polling = true
      window.clearTimeout(graceTimer)
      events.close()
      void poll()
    }
    // Headers can arrive with no body behind them (a quick tunnel), so only a first state counts.
    graceTimer = window.setTimeout(fallBack, STREAM_GRACE_MS)

    events.addEventListener('state', (e) => {
      if (polling) return
      window.clearTimeout(graceTimer)
      setStatus('live')
      apply(JSON.parse((e as MessageEvent<string>).data) as RoomState)
    })
    events.addEventListener('peers', (e) => {
      if (!polling) setPeers(JSON.parse((e as MessageEvent<string>).data) as RoomPeers)
    })
    // A dropped stream, a 404 or a tunnel's 502: polling finds out which, and carries on if it can.
    events.addEventListener('error', fallBack)
    return () => {
      stopped = true
      window.clearTimeout(graceTimer)
      window.clearTimeout(pollTimer)
      inflight?.abort()
      events.close()
    }
  }, [code, connectable, role, name, client, forget])

  const send = useCallback(
    async (change: Omit<RoomChange, 'by' | 'name'>) => {
      if (!code || !connectable) return
      const full: RoomChange = { ...change, by: role, name: role === 'helper' ? name : null }
      const base = latest.current
      const optimistic: RoomState | null = base ? { ...base, ...full, name: full.name ?? null } : null
      if (optimistic) setState(optimistic)
      pending.current += 1
      // Answers that arrive after switching rooms belong to the old room.
      const sameRoom = () => stateCode.current === code
      try {
        const { state: confirmed } = await museumRooms.setState(code, full)
        if (sameRoom() && (!latest.current || confirmed.rev > latest.current.rev)) latest.current = confirmed
      } catch (error) {
        if (!sameRoom()) return
        if (error instanceof GuideError && error.status === 404) {
          setStatus('gone')
          forget()
        }
        // The iPad keeps what was tapped even if the guide missed it: it just walks alone.
        if (role === 'patient' && optimistic) latest.current = optimistic
      } finally {
        if (sameRoom()) {
          pending.current = Math.max(0, pending.current - 1)
          if (pending.current === 0 && latest.current) setState(latest.current)
        }
      }
    },
    [code, connectable, role, name, forget],
  )

  const open = useCallback(async (at: number) => {
    const room = await museumRooms.create(at)
    writeStorage(session, ROOM_KEY, room.code)
    setPatientCode(room.code)
  }, [])

  const setName = useCallback((value: string) => {
    const clean = value.trim().replace(/\s+/g, ' ').slice(0, 40)
    if (!clean) return
    writeStorage(local, NAME_KEY, clean)
    setNameState(clean)
  }, [])

  const setAt = useCallback(
    (at: number, atId: string | null) => {
      // The iPad's hall has nothing open; the helper's phone keeps whatever the iPad has open.
      void send({ at, atId, window: role === 'patient' ? null : (latest.current?.window ?? null) })
    },
    [send, role],
  )

  /**
   * The iPad switches screens after its own step in or out; whatever the room says by then is
   * where it already is, so the next screen only acts on newer changes.
   */
  const navigate = useCallback(
    async (change: Omit<RoomChange, 'by' | 'name'>) => {
      await Promise.race([send(change), new Promise<void>((done) => window.setTimeout(done, NAVIGATE_WAIT_MS))])
      if (role === 'patient' && code && latest.current) markFollowed(code, latest.current.rev)
    },
    [send, role, code],
  )
  const enter = useCallback((id: string, at: number) => navigate({ at, atId: id, window: id }), [navigate])
  const leave = useCallback(
    () => navigate({ at: latest.current?.at ?? -1, atId: latest.current?.atId ?? null, window: null }),
    [navigate],
  )

  const fresh = role === 'patient' && code && state && state.by === 'helper' && state.rev > followedRev(code) ? state : null
  const followed = useCallback((rev: number) => {
    if (code) markFollowed(code, rev)
  }, [code])

  return { role, code, state, peers, status, name, setName, open, close: forget, setAt, enter, leave, fresh, followed }
}
