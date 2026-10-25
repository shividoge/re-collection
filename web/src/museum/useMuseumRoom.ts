import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { rooms, type RoomPeers, type RoomRole } from '../data'
import { acquireRoom, type RoomClient, type RoomSnapshot, type RoomStatus } from './roomClient'
import { follow, roomHash, roomHere, sendFailed, shown, type RoomSpot } from './roomSync'

export type { RoomStatus } from './roomClient'

const ROOM_KEY = 'braindance.museum.room'
const NAME_KEY = 'braindance.museum.helperName'
/** The newest rev the iPad has acted on: { code, rev }. Survives a reload. */
const FOLLOWED_KEY = 'braindance.museum.followed'
/** One id per browser tab, so the iPad's museum and Memory Window count as one screen. */
const CLIENT_KEY = 'braindance.museum.client'
const CODE_PATTERN = /^[BCDFGHJKLMNPQRSTVWXZ]{4}$/

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

/** The iPad's room code for this tab, shared by its museum and Memory Window. */
const patientRoom = (() => {
  const listeners = new Set<() => void>()
  let code: string | null | undefined
  return {
    get: () => (code === undefined ? (code = normalizeRoomCode(readStorage(session, ROOM_KEY))) : code),
    set(next: string | null) {
      code = next
      writeStorage(session, ROOM_KEY, next)
      // A code can come back once its old room has expired: start that room from nothing.
      writeStorage(session, FOLLOWED_KEY, null)
      for (const listener of listeners) listener()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
})()
const noRoom = () => null

const NO_PEERS: RoomPeers = { patient: 0, helpers: [] }
const idle = () => () => {}
const offSnapshot = () => null

export type MuseumRoom = {
  role: RoomRole
  code: string | null
  /** Where the walk is, as this screen shows it (its own newest change first). */
  state: RoomSpot | null
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
  /** Open a moment in the Memory Window on the iPad (the iPad's own screen switches itself). */
  enter: (id: string, at: number) => void
  /** Back to the museum on both screens. */
  leave: () => void
  /** Helper only: their last change didn't reach the server. */
  sendFailed: boolean
  /** Send that change again. */
  retry: () => void
}

/**
 * One shared museum walk between the patient's iPad and a helper's phone (see `roomClient.ts`
 * for the connection, `roomSync.ts` for the rules). The iPad opens the room and keeps its code
 * for this tab, so the Memory Window joins the same room; the helper joins with the code from
 * the link. On the iPad, the hook also moves the screen when the helper steps in or out.
 *
 * `enabled: false` keeps the hook idle (the Memory Window opened from somewhere else).
 */
export function useMuseumRoom(role: RoomRole, { join = null, enabled = true }: { join?: string | null; enabled?: boolean } = {}): MuseumRoom {
  const patientCode = useSyncExternalStore(role === 'patient' ? patientRoom.subscribe : idle, role === 'patient' ? patientRoom.get : noRoom)
  const [name, setNameState] = useState<string | null>(() => (role === 'helper' ? readStorage(local, NAME_KEY)?.trim() || null : null))
  const code = !enabled ? null : role === 'patient' ? patientCode : normalizeRoomCode(join)
  // The helper connects once they've said who they are.
  const connectable = code !== null && (role === 'patient' || name !== null)

  // The client for exactly this room and person (never a previous room's, while switching).
  const key = connectable ? JSON.stringify([code, role, name]) : null
  const [held, setHeld] = useState<{ key: string; client: RoomClient } | null>(null)
  useEffect(() => {
    if (!key || !code) return
    const room = acquireRoom(code, { as: role, name, client: clientId() })
    setHeld({ key, client: room.client })
    return room.release
  }, [key, code, role, name])
  const client = key !== null && held?.key === key ? held.client : null

  const snapshot: RoomSnapshot | null = useSyncExternalStore(client?.subscribe ?? idle, client?.getSnapshot ?? offSnapshot)
  const status: RoomStatus = snapshot?.status ?? 'off'

  // A room that's gone is forgotten on the iPad; the helper's phone says so and asks for a code.
  useEffect(() => {
    if (role === 'patient' && status === 'gone') patientRoom.set(null)
  }, [role, status])

  // The iPad goes where the helper leads (stepping in or out), once its own changes are settled.
  const sync = snapshot?.sync
  useEffect(() => {
    if (role !== 'patient' || !code || !sync) return
    const here = roomHere(location.hash)
    if (here === undefined) return
    const step = follow(sync, followedRev(code), here)
    if (!step) return
    writeStorage(session, FOLLOWED_KEY, JSON.stringify({ code, rev: step.mark }))
    if (step.go !== undefined) location.hash = roomHash(step.go)
  }, [role, code, sync])

  const open = useCallback(async (at: number) => {
    const { code } = await rooms.create(at)
    patientRoom.set(code)
  }, [])
  const close = useCallback(() => patientRoom.set(null), [])

  const setName = useCallback((value: string) => {
    const clean = value.trim().replace(/\s+/g, ' ').slice(0, 40)
    if (!clean) return
    writeStorage(local, NAME_KEY, clean)
    setNameState(clean)
  }, [])

  // Each change builds on the newest one made here, even before the server has confirmed it.
  const setAt = useCallback(
    // The iPad's hall has nothing open; the helper's phone keeps whatever the iPad has open.
    (at: number, atId: string | null) => client?.change((now) => ({ at, atId, window: role === 'patient' ? null : (now?.window ?? null) })),
    [client, role],
  )
  const enter = useCallback((id: string, at: number) => client?.change(() => ({ at, atId: id, window: id })), [client])
  const leave = useCallback(() => client?.change((now) => ({ at: now?.at ?? -1, atId: now?.atId ?? null, window: null })), [client])
  const retry = useCallback(() => client?.retry(), [client])

  return {
    role,
    code,
    state: sync ? shown(sync) : null,
    peers: snapshot?.peers ?? NO_PEERS,
    status,
    name,
    setName,
    open,
    close,
    setAt,
    enter,
    leave,
    sendFailed: sync ? sendFailed(sync) : false,
    retry,
  }
}
