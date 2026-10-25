import { useCallback, useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react'
import type { LiveRole } from '../../api'
import { LiveVisit, type LiveSnapshot } from './liveClient'
import { Voice } from './voice'
import './live.css'

export type LiveSession = { visit: LiveVisit; voice: Voice }

const OFF: LiveSnapshot = { status: 'joining', me: null, role: 'patient', members: [], view: null }
const noop = () => () => {}

/**
 * The live visit on this screen, once someone has chosen who they are: the visit itself (polling
 * the guide), the voice, and a snapshot of who's here and where the patient is.
 */
export function useLive() {
  const [session, setSession] = useState<LiveSession | null>(null)
  const snapshot = useSyncExternalStore(session?.visit.subscribe ?? noop, session?.visit.snapshot ?? (() => OFF))

  /** Call from the tap that chooses: the microphone prompt and sound need a tap. */
  const join = useCallback(async (role: LiveRole, name?: string) => {
    const visit = new LiveVisit(role, name)
    const voice = new Voice(visit)
    setSession({ visit, voice })
    visit.start()
    await voice.start()
  }, [])

  useEffect(() => {
    if (!session) return
    return () => {
      session.visit.stop()
      session.voice.stop()
    }
  }, [session])

  // Call whoever is here; hang up on whoever left.
  useEffect(() => {
    session?.voice.sync(snapshot.members)
  }, [session, snapshot.members])

  return { session, snapshot, join }
}

/** Member ids speaking right now ("me" for this screen), checked a few times a second. */
export function useSpeaking(session: LiveSession | null): Set<string> {
  const [speaking, setSpeaking] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (!session) return
    const t = setInterval(() => {
      const now = session.voice.speaking()
      setSpeaking((was) => (was.size === now.size && [...now].every((id) => was.has(id)) ? was : now))
    }, 250)
    return () => clearInterval(t)
  }, [session])
  return speaking
}

/**
 * "Who's visiting?", each time the palace opens: one big button for the person it's for, and a
 * smaller way in for family, who give their name. Choosing is the tap that lets sound and the
 * microphone start.
 */
export function WhoIsVisiting({ title, onChoose }: { title: string; onChoose: (role: LiveRole, name?: string) => void }) {
  const [family, setFamily] = useState(false)
  const [name, setName] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (name.trim()) onChoose('family', name.trim())
  }
  return (
    <div className="live-who" role="dialog" aria-label="Who's visiting?">
      <div className="live-who-card">
        <h1>{title}</h1>
        <button className="live-enter" onClick={() => onChoose('patient')} autoFocus>
          Enter the Memory Palace
        </button>
        {family ? (
          <form className="live-family" onSubmit={submit}>
            <label>
              <span>Your name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoFocus placeholder="So they know who's with them" />
            </label>
            <button type="submit" disabled={!name.trim()}>
              Join the visit
            </button>
          </form>
        ) : (
          <button className="live-family-toggle" onClick={() => setFamily(true)}>
            Family joining to visit together? Tap here
          </button>
        )}
      </div>
    </div>
  )
}

const listNames = (names: string[]) => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)

/**
 * Who's here, quietly, at the top of the screen. The patient sees "Sam is here with you" while
 * family are in the visit; family see whom they're following. A name glows while that person speaks.
 */
export function Presence({ session, snapshot }: { session: LiveSession; snapshot: LiveSnapshot }) {
  const speaking = useSpeaking(session)
  const me = snapshot.me
  const others = snapshot.members.filter((m) => m.id !== me)
  const patient = snapshot.members.find((m) => m.role === 'patient' && m.id !== me)
  const talking = others.filter((m) => speaking.has(m.id))
  const name = (id: string, text: string) => (
    <span key={id} className={speaking.has(id) ? 'live-name speaking' : 'live-name'}>
      {text}
    </span>
  )

  let line: ReactNode = null
  if (snapshot.role === 'patient') {
    const family = others.filter((m) => m.role === 'family')
    if (family.length > 0)
      line = (
        <>
          {family.length === 1 ? name(family[0].id, family[0].name) : name('all', listNames(family.map((m) => m.name)))}{' '}
          {family.length === 1 ? 'is' : 'are'} here with you
        </>
      )
  } else {
    line = patient ? <>Following {name(patient.id, patient.name)}</> : <>Waiting for the visit to start · look around meanwhile</>
  }

  return (
    <div className="live-presence" aria-live="polite">
      {line && <div className={`live-chip${talking.length > 0 ? ' talking' : ''}`}>{line}</div>}
      {snapshot.status === 'reconnecting' && <div className="live-chip quiet">Reconnecting…</div>}
      {session.voice.micAllowed === false && <div className="live-chip quiet">Microphone off · allow it in the browser to talk</div>}
    </div>
  )
}
