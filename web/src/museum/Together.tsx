import { useEffect, useState, type FormEvent } from 'react'
import { normalizeRoomCode, type MuseumRoom } from './useMuseumRoom'
import './together.css'

/** The link a helper opens on their phone. */
function joinLink(code: string): string {
  return `${location.origin}${location.pathname}#/museum?join=${code}`
}

/** "Priya is with you" on the iPad, while a helper is connected. Nothing at all otherwise. */
export function WithYou({ room }: { room: MuseumRoom }) {
  const names = [...new Set(room.peers.helpers)]
  if (names.length === 0) return null
  const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return <div className="together-with">{who} {names.length === 1 ? 'is' : 'are'} with you</div>
}

/**
 * The iPad's "Visit together" button: opens a room and shows its code and link big enough to
 * read across a table. Quiet by design: if the server can't be reached, the button just stays.
 */
export function PatientTogether({ room, at }: { room: MuseumRoom; at: number }) {
  const [showing, setShowing] = useState(false)
  const [busy, setBusy] = useState(false)
  const joined = room.peers.helpers.length > 0

  // Once someone has joined, the code has done its job.
  useEffect(() => {
    if (joined) setShowing(false)
  }, [joined])

  const start = async () => {
    setShowing(true)
    if (room.code) return
    setBusy(true)
    try {
      await room.open(at)
    } catch {
      setShowing(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="together-corner">
        <WithYou room={room} />
        {!(showing && (busy || room.code)) && (
          <button className="together-button" onClick={() => void start()}>
            Visit together
          </button>
        )}
      </div>
      {showing && (busy || room.code) && (
        <div className="together-panel" role="dialog" aria-label="Visit together">
          {busy || !room.code ? (
            <p>Getting a code…</p>
          ) : (
            <>
              <p>On your phone, open</p>
              <div className="together-link">{joinLink(room.code)}</div>
              <p>The code is</p>
              <div className="together-code" aria-label={`Code ${room.code.split('').join(' ')}`}>
                {room.code}
              </div>
              <div className="together-actions">
                <button className="together-button" onClick={() => setShowing(false)}>
                  Done
                </button>
                <button
                  className="together-quiet"
                  onClick={() => {
                    room.close()
                    setShowing(false)
                  }}
                >
                  Stop visiting together
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  )
}

/**
 * Everything the helper's phone adds to the museum: asking their name once, a wrong or old
 * code, connection trouble, and what's open on the iPad. Problems show here, never on the iPad.
 */
export function HelperTogether({ room, join, openTitle }: { room: MuseumRoom; join: string; openTitle: string | null }) {
  if (!room.code) return <CodeForm initial={join} />
  if (!room.name) return <NameForm room={room} />
  if (room.status === 'gone') return <CodeForm initial="" problem={`No visit with the code ${room.code}. Check the code on the iPad.`} />

  const problem =
    room.status === 'connecting'
      ? 'Joining…'
      : room.status === 'reconnecting'
        ? 'Reconnecting to the iPad…'
        : room.peers.patient === 0
          ? "The iPad isn't in the museum right now. It will follow you when it is."
          : null
  return (
    <>
      <div className="together-helper-bar">
        <span>
          Visiting together · <strong>{room.code}</strong>
        </span>
        {problem && <span className="together-problem">{problem}</span>}
        {room.sendFailed && (
          <span className="together-problem">
            That didn't reach the iPad.{' '}
            <button className="together-retry" onClick={room.retry}>
              Try again
            </button>
          </span>
        )}
      </div>
      {room.state?.window && (
        <div className="together-open" role="status">
          <p>Open on the iPad now</p>
          <strong>{openTitle ?? 'A moment'}</strong>
          <button className="together-button" onClick={room.leave}>
            Back to the museum
          </button>
        </div>
      )}
    </>
  )
}

function NameForm({ room }: { room: MuseumRoom }) {
  const [value, setValue] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    room.setName(value)
  }
  return (
    <form className="together-form" onSubmit={submit}>
      <h2>Visit together</h2>
      <label>
        Your name, as they know you
        <input autoFocus value={value} maxLength={40} onChange={(e) => setValue(e.target.value)} placeholder="Priya" />
      </label>
      <p>The iPad will show "{value.trim() || 'Priya'} is with you".</p>
      <button className="together-button" type="submit" disabled={!value.trim()}>
        Join
      </button>
    </form>
  )
}

function CodeForm({ initial, problem }: { initial: string; problem?: string }) {
  const [value, setValue] = useState(initial)
  const code = normalizeRoomCode(value)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (code) location.hash = `#/museum?join=${code}`
  }
  return (
    <form className="together-form" onSubmit={submit}>
      <h2>Visit together</h2>
      {problem && <p className="together-problem">{problem}</p>}
      <label>
        The code on the iPad
        <input
          autoFocus
          value={value}
          maxLength={4}
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setValue(e.target.value.toUpperCase())}
          placeholder="KTRB"
          className="together-code-input"
        />
      </label>
      <button className="together-button" type="submit" disabled={!code}>
        Join
      </button>
    </form>
  )
}
