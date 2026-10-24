import { useCallback, useEffect, useRef, useState } from 'react'
import { guide } from '../api'
import type { EndReason, Fact, Moment, Reply } from '../api'
import type { ViewerControls } from '../scene/SceneViewer'
import type { Selection } from '../scene/useRoomIndex'
import { RecognitionCtor, speak, type Recognition } from '../speech'

const SESSION_LIMIT_MS = 10 * 60 * 1000
const GOODBYE = "Thank you for sharing this with me. I'll be here whenever you want to look again."
const TOUR_SPEED = 0.75

type Span = { index: number | null; from: number; to: number }
type Tour = 'off' | 'running' | 'paused'

/**
 * Revisiting inside the playground (CLAUDE.md 7.4): a narrated tour along the phone's path that
 * the person can pause at any moment to look around, point at things and ask about them. Every
 * reply comes from the guide's grounded companion; ending the visit scores it for the dashboard.
 */
export function VisitDock({ captureId, controls }: { captureId: string; controls: ViewerControls }) {
  const ctl = useRef(controls)
  ctl.current = controls

  const [sid, setSid] = useState<string | null>(null)
  const [ended, setEnded] = useState(false)
  const [tour, setTour] = useState<Tour>('off')
  const [caption, setCaption] = useState('')
  const [busy, setBusy] = useState(false)
  const [listening, setListening] = useState(false)
  const [typing, setTyping] = useState(false)
  const [typed, setTyped] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const sidRef = useRef<string | null>(null)
  const endedRef = useRef(false)
  const tourToken = useRef(0)
  const tourAt = useRef<{ span: number; time: number } | null>(null)
  const moment = useRef<Moment | null>(null)
  const recognition = useRef<Recognition | null>(null)

  const say = useCallback(async (reply: Reply, token?: number) => {
    for (const s of reply.sentences) {
      if (endedRef.current || (token !== undefined && token !== tourToken.current)) return
      setCaption(s.sentence)
      await speak([s.sentence], () => endedRef.current || (token !== undefined && token !== tourToken.current))
    }
  }, [])

  /** Starts a session on first use, with fresh approvals. */
  const ensureSession = async (): Promise<string> => {
    if (sidRef.current) return sidRef.current
    moment.current = await guide.moment(captureId)
    const { sessionId, welcome } = await guide.startSession(captureId)
    sidRef.current = sessionId
    endedRef.current = false
    setSid(sessionId)
    setEnded(false)
    await say(welcome)
    return sessionId
  }

  const finish = useCallback(
    async (reason: EndReason) => {
      const id = sidRef.current
      if (!id || endedRef.current) return
      endedRef.current = true
      tourToken.current++
      setTour('off')
      window.speechSynthesis?.cancel()
      recognition.current?.stop()
      ctl.current.playback.pause()
      ctl.current.setSpeed(1)
      setEnded(true)
      setCaption(GOODBYE)
      void speak([GOODBYE], () => false)
      try {
        await guide.endSession(id, reason)
      } catch (e) {
        setFailure(`Couldn't save this visit: ${(e as Error).message}`)
      }
    },
    [],
  )

  // Ten minutes after the visit starts, end it gently.
  useEffect(() => {
    if (!sid || ended) return
    const timer = setTimeout(() => void finish('timeout'), SESSION_LIMIT_MS)
    return () => clearTimeout(timer)
  }, [sid, ended, finish])

  // Leaving the page (another screen, a reload, closing the tab) ends an open visit, so it still
  // counts on the dashboard.
  useEffect(() => {
    const leave = () => {
      if (sidRef.current && !endedRef.current) {
        endedRef.current = true
        void guide.endSession(sidRef.current, 'complete', true).catch(() => {})
      }
    }
    window.addEventListener('pagehide', leave)
    return () => {
      window.removeEventListener('pagehide', leave)
      window.speechSynthesis?.cancel()
      leave()
    }
  }, [])

  /** The tour's parts: one per chapter, or the whole moment when there are none. */
  const spans = (): Span[] => {
    const chapters = moment.current?.chapters ?? []
    const duration = ctl.current.duration
    if (!chapters.length) return [{ index: null, from: 0, to: duration }]
    return chapters.map((c, i) => ({ index: i, from: c.tStart, to: i + 1 < chapters.length ? chapters[i + 1].tStart : c.tEnd }))
  }

  /** Plays until `to`. False if the person took over: paused, changed view, or asked something. */
  const playUntil = (to: number, token: number) =>
    new Promise<boolean>((resolve) => {
      const c = ctl.current
      c.playback.play()
      let pausedFor = 0
      // Read the video element itself: the viewer's per-frame clock stalls when the tab isn't drawn.
      const timer = setInterval(() => {
        const now = ctl.current
        const v = now.video
        const time = v ? v.currentTime : now.playback.timeRef.current
        if (token !== tourToken.current || endedRef.current) return done(false)
        if (time >= to - 0.05 || v?.ended) {
          now.playback.pause()
          return done(true)
        }
        if (now.mode !== 'follow' && now.canFollow) return done(false)
        pausedFor = (v ? !v.paused : now.playback.playing) ? 0 : pausedFor + 1
        if (pausedFor > 4) done(false)
      }, 100)
      const done = (finished: boolean) => {
        clearInterval(timer)
        resolve(finished)
      }
    })

  const runTour = async (fromSpan: number, resumeAt: number | null) => {
    setFailure(null)
    setTour('running')
    try {
      const id = await ensureSession()
      const token = ++tourToken.current
      const c = ctl.current
      if (c.canFollow && c.mode !== 'follow') c.switchMode('follow')
      c.setSpeed(TOUR_SPEED)
      const parts = spans()
      for (let i = fromSpan; i < parts.length; i++) {
        const part = parts[i]
        if (token !== tourToken.current || endedRef.current) return
        if (i === fromSpan && resumeAt !== null) {
          ctl.current.playback.seek(resumeAt)
        } else {
          ctl.current.playback.pause()
          ctl.current.playback.seek(part.from)
          const { reply } = await guide.narrate(id, part.index)
          await say(reply, token)
          if (token !== tourToken.current || endedRef.current) return
        }
        if (!(await playUntil(part.to, token))) {
          if (token === tourToken.current) pauseTour(i)
          return
        }
      }
      if (token === tourToken.current) {
        setTour('off')
        tourAt.current = null
        ctl.current.setSpeed(1)
      }
    } catch (e) {
      setFailure((e as Error).message)
      setTour('off')
    }
  }

  /** Stops the tour where it is, so "Resume tour" can carry on from here. */
  const pauseTour = (span?: number) => {
    if (tour === 'off' && span === undefined) return
    const at = span ?? tourAt.current?.span ?? 0
    tourToken.current++
    window.speechSynthesis?.cancel()
    ctl.current.playback.pause()
    tourAt.current = { span: at, time: ctl.current.video?.currentTime ?? ctl.current.playback.timeRef.current }
    ctl.current.setSpeed(1)
    setTour('paused')
  }

  const send = async (text: string) => {
    if (!text.trim() || busy) return
    if (tour === 'running') pauseTour()
    setBusy(true)
    setFailure(null)
    try {
      const id = await ensureSession()
      const { reply, distress } = await guide.turn(id, text.trim(), focusFor(ctl.current.selection, moment.current))
      await say(reply)
      if (distress) await finish('distress')
    } catch (e) {
      setFailure((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const talk = () => {
    if (!RecognitionCtor || busy) return
    if (listening) return recognition.current?.stop()
    if (tour === 'running') pauseTour()
    window.speechSynthesis?.cancel()
    const r = new RecognitionCtor()
    r.lang = 'en-US'
    r.interimResults = false
    let heard = ''
    r.onresult = (e) => {
      heard = Array.from(e.results)
        .map((res) => res[0].transcript)
        .join(' ')
    }
    r.onerror = () => setFailure("I couldn't hear that. Please try again, or type it instead.")
    r.onend = () => {
      setListening(false)
      if (heard) void send(heard)
    }
    recognition.current = r
    setListening(true)
    r.start()
  }

  const newVisit = () => {
    sidRef.current = null
    endedRef.current = false
    tourAt.current = null
    setSid(null)
    setEnded(false)
    setCaption('')
    setFailure(null)
  }

  const open = sid && !ended
  const selection = controls.selection

  return (
    <div className="visit">
      {caption && (
        <p className="visit-caption" aria-live="polite">
          {caption}
        </p>
      )}
      <div className="visit-dock">
        {ended ? (
          <button className="visit-main" onClick={newVisit}>
            Start a new visit
          </button>
        ) : (
          <>
            {tour === 'running' ? (
              <button onClick={() => pauseTour()}>Pause tour</button>
            ) : tour === 'paused' && tourAt.current ? (
              <button className="visit-main" onClick={() => void runTour(tourAt.current!.span, tourAt.current!.time)}>
                Resume tour
              </button>
            ) : (
              <button className="visit-main" onClick={() => void runTour(0, null)} disabled={busy || controls.duration <= 0}>
                {sid ? 'Tour again' : 'Begin the visit'}
              </button>
            )}
            <button className={`visit-talk${listening ? ' live' : ''}`} onClick={talk} disabled={busy || !RecognitionCtor} title={RecognitionCtor ? '' : "Speech isn't available in this browser; type instead"}>
              {busy ? '…' : listening ? "I'm listening" : selection ? 'Ask about this' : 'Talk'}
            </button>
            <button className="link" onClick={() => setTyping((t) => !t)}>
              {typing ? 'Hide typing' : 'Type instead'}
            </button>
            {open && <button onClick={() => void finish('complete')}>End visit</button>}
          </>
        )}
      </div>
      {typing && !ended && (
        <form
          className="visit-type"
          onSubmit={(e) => {
            e.preventDefault()
            void send(typed)
            setTyped('')
          }}
        >
          <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={selection ? 'Ask about the selected thing…' : 'Type what they said…'} />
          <button disabled={busy}>Send</button>
        </form>
      )}
      {failure && <p className="visit-error">{failure}</p>}
    </div>
  )
}

/**
 * What the person is pointing at, for the companion: a plain size label (never a name) and the
 * approved facts whose evidence happened while the recording camera had it in view.
 */
function focusFor(selection: Selection | null, moment: Moment | null): { label: string; factIds: string[] } | undefined {
  if (!selection) return undefined
  const [w, h, d] = selection.bounds.size
  const label = selection.kind === 'object' ? `an object about ${w.toFixed(1)} × ${h.toFixed(1)} × ${d.toFixed(1)} m` : `a spot on the ${selection.kind}`
  const near = (a: number, b: number) => selection.seen.some((iv) => b >= iv.tStart - 1 && a <= iv.tEnd + 1)
  const usable = (f: Fact) => f.status === 'approved' && !f.doNotRaise
  const factIds = (moment?.facts ?? [])
    .filter(usable)
    .filter((f) => f.evidence.some((e) => (e.type === 'frame' ? near(e.t, e.t) : near(e.tStart, e.tEnd))))
    .map((f) => f.id)
  return { label, factIds }
}
