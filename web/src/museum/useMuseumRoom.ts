import { useCallback, useEffect, useRef, useState } from 'react'
import { GuideError, museumRooms, type RoomChange, type RoomPeers, type RoomRole, type RoomState } from '../api'

const ROOM_KEY = 'braindance.museum.room'
const NAME_KEY = 'braindance.museum.helperName'
const RETRY_MS = 3000
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
  setAt: (at: number) => void
  /** Opens a moment in the Memory Window on the iPad. Resolves once the guide has it (or after a short wait). */
  enter: (id: string, at: number) => Promise<void>
  /** Back to the museum on both screens. */
  leave: () => Promise<void>
}

const NO_PEERS: RoomPeers = { patient: 0, helpers: [] }

/**
 * One shared museum walk between the patient's iPad and a helper's phone. The iPad opens the
 * room and keeps its code for this tab (so the Memory Window joins the same room); the helper
 * joins with the code from the link. State comes from the guide's event stream; changes are
 * shown at once and sent with a POST.
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
  const [retry, setRetry] = useState(0)

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
    let timer = 0
    setStatus((s) => (s === 'live' || s === 'reconnecting' ? 'reconnecting' : 'connecting'))
    const events = new EventSource(museumRooms.eventsUrl(code, role, name))

    events.addEventListener('open', () => setStatus('live'))
    events.addEventListener('state', (e) => {
      const next = JSON.parse((e as MessageEvent<string>).data) as RoomState
      if (latest.current && next.rev <= latest.current.rev) return
      latest.current = next
      // Our own change echoing back while others are still in flight would make the screen jump.
      if (pending.current > 0 && next.by === role) return
      setState(next)
    })
    events.addEventListener('peers', (e) => setPeers(JSON.parse((e as MessageEvent<string>).data) as RoomPeers))
    events.addEventListener('error', () => {
      if (stopped) return
      if (events.readyState !== EventSource.CLOSED) {
        setStatus('reconnecting')
        return
      }
      // The browser gave up (for example a 404, or the tunnel answering 502). Find out which.
      museumRooms
        .get(code)
        .then(() => {
          if (!stopped) timer = window.setTimeout(() => setRetry((n) => n + 1), RETRY_MS)
        })
        .catch((error: unknown) => {
          if (stopped) return
          if (error instanceof GuideError && error.status === 404) {
            setStatus('gone')
            forget()
          } else {
            setStatus('reconnecting')
            timer = window.setTimeout(() => setRetry((n) => n + 1), RETRY_MS)
          }
        })
    })
    return () => {
      stopped = true
      window.clearTimeout(timer)
      events.close()
    }
  }, [code, connectable, role, name, retry, forget])

  const send = useCallback(
    async (change: Omit<RoomChange, 'by' | 'name'>) => {
      if (!code || !connectable) return
      const full: RoomChange = { ...change, by: role, name: role === 'helper' ? name : null }
      const base = latest.current
      const optimistic: RoomState | null = base ? { ...base, ...full, name: full.name ?? null } : null
      if (optimistic) setState(optimistic)
      pending.current += 1
      try {
        const { state: confirmed } = await museumRooms.setState(code, full)
        if (!latest.current || confirmed.rev > latest.current.rev) latest.current = confirmed
      } catch (error) {
        if (error instanceof GuideError && error.status === 404) {
          setStatus('gone')
          forget()
        }
        // The iPad keeps what was tapped even if the guide missed it: it just walks alone.
        if (role === 'patient' && optimistic) latest.current = optimistic
      } finally {
        pending.current -= 1
        if (pending.current === 0 && latest.current) setState(latest.current)
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
    (at: number) => {
      void send({ at, window: latest.current?.window ?? null })
    },
    [send],
  )

  const waitBriefly = (p: Promise<void>) => Promise.race([p, new Promise<void>((done) => window.setTimeout(done, NAVIGATE_WAIT_MS))])
  const enter = useCallback((id: string, at: number) => waitBriefly(send({ at, window: id })), [send])
  const leave = useCallback(() => waitBriefly(send({ at: latest.current?.at ?? -1, window: null })), [send])

  return { role, code, state, peers, status, name, setName, open, close: forget, setAt, enter, leave }
}
