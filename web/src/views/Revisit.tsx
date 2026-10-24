import { Canvas, useFrame } from '@react-three/fiber'
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { guide } from '../api'
import type { EndReason, Moment, Reply } from '../api'
import { FollowCamera } from '../scene/CameraPath'
import { DepthReplay } from '../scene/DepthReplay'
import { loadGuideCapture, type LoadedCapture } from '../scene/loadCapture'
import { StaticCloud } from '../scene/StaticCloud'

type Phase = 'welcome' | 'replay' | 'conversation' | 'goodbye'
type Loaded = { capture: LoadedCapture; moment: Moment; address: string }

const SESSION_LIMIT_MS = 10 * 60 * 1000
const GOODBYE = "Thank you for sharing this with me. I'll be here whenever you want to look again."

type Recognition = {
  lang: string
  interimResults: boolean
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
  start(): void
  stop(): void
}
const RecognitionCtor: (new () => Recognition) | undefined =
  (window as unknown as { SpeechRecognition?: new () => Recognition }).SpeechRecognition ??
  (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition

/**
 * Speaks each sentence in order; resolves when done or cancelled. Each sentence also has a
 * time limit, because some browsers never report the end of an utterance.
 */
function speak(sentences: string[], cancelled: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis
    if (!synth) return resolve()
    const next = (i: number) => {
      if (i >= sentences.length || cancelled()) return resolve()
      const u = new SpeechSynthesisUtterance(sentences[i])
      u.rate = 0.85
      let done = false
      const advance = () => {
        if (done) return
        done = true
        next(i + 1)
      }
      u.onend = advance
      u.onerror = advance
      setTimeout(advance, 2500 + sentences[i].split(/\s+/).length * 600)
      synth.speak(u)
    }
    next(0)
  })
}

/** The patient's screen (CLAUDE.md 7.4): welcome, replay with narration, conversation, goodbye. */
export function Revisit({ id }: { id: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([loadGuideCapture(id), guide.moment(id), guide.person()])
      .then(([capture, moment, person]) => !cancelled && setLoaded({ capture, moment, address: person.preferredAddress }))
      .catch((e: Error) => !cancelled && setError(e.message))
    return () => {
      cancelled = true
    }
  }, [id])

  if (error) return <div className="center-message error">{error}</div>
  if (!loaded) return <div className="center-message">Getting the moment ready…</div>
  return <Session {...loaded} />
}

/** Keeps the 3D replay on the video's clock. */
function VideoClock({ video, timeRef }: { video: HTMLVideoElement | null; timeRef: MutableRefObject<number> }) {
  useFrame(() => {
    timeRef.current = video?.currentTime ?? 0
  })
  return null
}

function Session({ capture, moment, address }: Loaded) {
  const { manifest, cloud, frames } = capture
  const momentFrames = frames?.moment ?? []
  const [phase, setPhase] = useState<Phase>('welcome')
  const [video, setVideo] = useState<HTMLVideoElement | null>(null)
  const [caption, setCaption] = useState('')
  const [busy, setBusy] = useState(false)
  const [started, setStarted] = useState(false)
  const [listening, setListening] = useState(false)
  const [caregiver, setCaregiver] = useState(false)
  const [typed, setTyped] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const [dropped, setDropped] = useState<{ sentence: string; reason: string }[]>([])
  const sid = useRef<string | null>(null)
  const ended = useRef(false)
  const timeRef = useRef(0)
  const recognition = useRef<Recognition | null>(null)
  const hasPeople = Boolean(manifest && manifest.depth.count > 0 && momentFrames.length > 0)
  const duration = manifest?.video.durationSec ?? 0

  const say = useCallback(async (reply: Reply) => {
    setDropped((d) => [...d, ...reply.dropped])
    for (const s of reply.sentences) {
      setCaption(s.sentence)
      await speak([s.sentence], () => ended.current)
    }
  }, [])

  const finish = useCallback(
    async (reason: EndReason) => {
      if (ended.current) return
      ended.current = true
      window.speechSynthesis?.cancel()
      recognition.current?.stop()
      video?.pause()
      setPhase('goodbye')
      setCaption(GOODBYE)
      void speak([GOODBYE], () => false)
      if (sid.current) {
        try {
          await guide.endSession(sid.current, reason)
        } catch (e) {
          setFailure(`Couldn't save this session: ${(e as Error).message}`)
        }
      }
    },
    [video],
  )

  // Ten minutes after the visit begins (not after the page opens), end gently.
  useEffect(() => {
    if (!started) return
    const timer = setTimeout(() => void finish('timeout'), SESSION_LIMIT_MS)
    return () => clearTimeout(timer)
  }, [started, finish])
  useEffect(() => () => window.speechSynthesis?.cancel(), [])

  /** Plays [from, to) of the visit, with sound, and resolves when it gets there. */
  const playSpan = (from: number, to: number) =>
    new Promise<void>((resolve) => {
      if (!video) return resolve()
      video.currentTime = from
      const check = () => {
        if (ended.current || video.currentTime >= to || video.ended) {
          video.removeEventListener('timeupdate', check)
          video.pause()
          resolve()
        }
      }
      video.addEventListener('timeupdate', check)
      video.play().catch(() => {
        video.removeEventListener('timeupdate', check)
        resolve()
      })
    })

  /**
   * Replays the visit slowly. With chapters, each one is narrated and then played; without
   * any, the whole moment is narrated once and then played start to end.
   */
  const replay = async (sessionId: string) => {
    if (video) video.playbackRate = 0.75
    const chapters = moment.chapters
    const spans = chapters.length
      ? chapters.map((c, i) => ({ index: i as number | null, from: c.tStart, to: i + 1 < chapters.length ? chapters[i + 1].tStart : c.tEnd }))
      : [{ index: null, from: 0, to: duration }]
    for (const span of spans) {
      if (ended.current) return
      if (video) {
        video.currentTime = span.from
        video.pause()
      }
      const { reply } = await guide.narrate(sessionId, span.index)
      await say(reply)
      if (ended.current) return
      await playSpan(span.from, span.to)
    }
    if (ended.current) return
    setPhase('conversation')
    setCaption('')
  }

  const begin = async () => {
    setBusy(true)
    setFailure(null)
    try {
      const { sessionId, welcome } = await guide.startSession(capture.id!)
      sid.current = sessionId
      setStarted(true)
      await say(welcome)
      setPhase('replay')
      await replay(sessionId)
    } catch (e) {
      setFailure((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const send = async (text: string) => {
    if (!sid.current || !text.trim() || busy) return
    setBusy(true)
    setFailure(null)
    try {
      const { reply, distress } = await guide.turn(sid.current, text.trim())
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
    r.onerror = () => setFailure("I couldn't hear that. Please try again, or ask the caregiver to type.")
    r.onend = () => {
      setListening(false)
      if (heard) void send(heard)
    }
    recognition.current = r
    setListening(true)
    r.start()
  }

  return (
    <div className="revisit">
      <Canvas className="revisit-canvas" flat camera={{ fov: 60, near: 0.02, far: 100 }} dpr={[1, 2]}>
        <color attach="background" args={['#0b0d12']} />
        <VideoClock video={video} timeRef={timeRef} />
        {momentFrames.length > 0 && manifest && (
          <FollowCamera frames={momentFrames} timeRef={timeRef} videoW={manifest.video.width} videoH={manifest.video.height} />
        )}
        {cloud && <StaticCloud cloud={cloud} />}
        {video && hasPeople && capture.id && manifest && (
          <DepthReplay captureId={capture.id} manifest={manifest} frames={momentFrames} video={video} timeRef={timeRef} />
        )}
      </Canvas>
      {capture.videoUrl && <video ref={setVideo} src={capture.videoUrl} crossOrigin="anonymous" playsInline preload="auto" style={{ display: 'none' }} />}

      <div className="revisit-panel">
        {phase === 'welcome' && !busy && !started && (
          <>
            <h1>{address ? `Hello, ${address}.` : 'Hello.'}</h1>
            <p className="revisit-sub">{moment.moment.title || 'A visit'}</p>
            <button className="big" onClick={begin}>
              Begin
            </button>
          </>
        )}
        {caption && (
          <p className="revisit-caption" aria-live="polite">
            {caption}
          </p>
        )}
        {phase === 'conversation' && (
          <button className={`big ${listening ? 'live' : ''}`} onClick={talk} disabled={busy || !RecognitionCtor}>
            {busy ? '…' : listening ? "I'm listening" : 'Talk'}
          </button>
        )}
        {phase === 'goodbye' && <p className="revisit-sub">This visit is finished.</p>}
        {failure && <p className="error">{failure}</p>}
        {phase === 'conversation' && !RecognitionCtor && <p className="revisit-sub">Speech isn't available in this browser. Ask the caregiver to type.</p>}
      </div>

      <div className="caregiver-corner">
        <button onClick={() => setCaregiver((c) => !c)}>{caregiver ? 'Hide' : 'Caregiver'}</button>
        {caregiver && (
          <div className="caregiver-box">
            <button onClick={() => void finish('caregiver')} disabled={phase === 'goodbye'}>
              End this visit
            </button>
            {phase === 'conversation' && (
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  void send(typed)
                  setTyped('')
                }}
              >
                <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type what they said" />
                <button disabled={busy}>Send</button>
              </form>
            )}
            {dropped.length > 0 && (
              <details open>
                <summary>{dropped.length} sentence(s) held back by the grounding check</summary>
                <ul>
                  {dropped.map((d, i) => (
                    <li key={i}>
                      “{d.sentence}” — {d.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
