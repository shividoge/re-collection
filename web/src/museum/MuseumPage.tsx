import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react'
import { visits, type Exhibition } from './exhibitions'
import { planMuseum } from './layout'
import { MuseumScene } from './MuseumScene'
import { MuseumSound } from './sound'
import { StepIn, type Stage } from './StepIn'
import { Streaks } from './Streaks'
import type { WalkerHandle } from './Walker'
import { IN_MS, LEAVE_MS, OUT_MS, type Dive } from './warp'
import './museum.css'

/** What the editor can do with the museum it shows: walk to a picture. */
export interface MuseumHandle {
  goTo: (i: number) => void
}

/**
 * Her museum: walk through the pictures the caretaker hung, in real-looking rooms, and step into
 * any of them. This is the patient's page, so it changes nothing: no adding, no taking down, no
 * other exhibitions and no way out to the rest of the site. The caretaker arranges it at
 * `#/palace/edit` (MuseumEditor). `#/museum` and `#/museum/<id>` links from before land here too.
 *
 * The editor shows this same museum as its preview: `preview` is the arrangement being edited
 * (instead of the saved one), `onFocus` says which picture the visitor is at, and `ref` walks to one.
 */
export function MuseumPage({ preview, onFocus, ref }: { id?: string; preview?: Exhibition; onFocus?: (i: number) => void; ref?: Ref<MuseumHandle> }) {
  const [loaded, setLoaded] = useState<Exhibition | null | undefined>(undefined)
  const exhibition = preview ?? loaded
  const [error, setError] = useState<string | null>(null)
  const [focus, setFocus] = useState(-1)
  const [arrived, setArrived] = useState(false)
  const walker = useRef<WalkerHandle>(null)
  // Stepping into a picture: which one, and how far: diving in, inside, leaving, or (`surfacing`)
  // back through the frame and pulling out of it to where the visitor stood.
  const [inside, setInside] = useState<{ index: number; stage: Stage | 'surfacing' } | null>(null)
  const insideRef = useRef(inside)
  useEffect(() => {
    insideRef.current = inside
  }, [inside])
  // The picture's world fills the screen, so the museum can stop drawing.
  const [covered, setCovered] = useState(false)
  // The camera's dive into the frame, and the light streaking past on the way through.
  const dive = useRef<Dive | null>(null)
  const [warp, setWarp] = useState<{ dir: 'in' | 'out'; cross: number } | null>(null)
  const pendingStep = useRef(-1)
  const sizes = useRef(new Map<number, { w: number; h: number }>())
  const sound = useMemo(() => new MuseumSound(), [])
  const [musicOn, setMusicOn] = useState(sound.musicOn)

  useEffect(() => {
    if (preview) return
    visits()
      .then(setLoaded)
      .catch((e: Error) => setError(e.message))
  }, [preview])
  // Leaving the page (the editor going back to the front page) stops the music.
  useEffect(() => () => sound.dispose(), [sound])

  // Rooms are planned for the number of pictures; adding one may add a room.
  const count = Math.max(1, exhibition?.items.length ?? 1)
  const plan = useMemo(() => planMuseum(count), [count])

  const goTo = useCallback(
    (i: number) => {
      if (!exhibition || i < 0 || i >= exhibition.items.length) return
      const slot = plan.slots[i]
      setFocus(i)
      setArrived(false)
      walker.current?.walkTo(slot.view, slot.center)
    },
    [exhibition, plan],
  )

  const onMeasure = useCallback((slot: number, w: number, h: number) => {
    sizes.current.set(slot, { w, h })
  }, [])

  /** Steps into piece `i`: from where the visitor stands if they're at it, else after walking there. */
  const stepIn = useCallback(
    (i: number) => {
      if (!exhibition || inside) return
      const slot = plan.slots[i]
      const size = sizes.current.get(i)
      const at = walker.current?.position()
      if (!slot || !size || !at) return
      if (Math.hypot(at[0] - slot.view[0], at[1] - slot.view[1]) > 0.35) {
        // Walk up to it first, then step in on arrival.
        pendingStep.current = i
        setFocus(i)
        setArrived(false)
        walker.current?.walkTo(slot.view, slot.center)
        return
      }
      // Dive into the frame. The museum's music fades right away (every picture has its own
      // sound), the rush builds as the view picks up speed, and at the crossing the picture's
      // own world takes over.
      const now = performance.now()
      dive.current = {
        dir: 'in',
        target: { center: slot.center, normal: slot.normal, w: size.w, h: size.h },
        start: now,
        ms: IN_MS,
        done: () => setInside((s) => (s && s.stage === 'diving' ? { ...s, stage: 'here' } : s)),
      }
      sound.wake()
      sound.musicTo(0, 1.6)
      sound.warp('in', IN_MS / 1000)
      setWarp({ dir: 'in', cross: now + IN_MS })
      setInside({ index: i, stage: 'diving' })
    },
    [exhibition, inside, plan, sound],
  )

  /** Back out through the frame: the picture's world smears away, then the view pulls back out. */
  const stepOut = useCallback(() => {
    if (insideRef.current?.stage !== 'here') return
    const now = performance.now()
    setInside((s) => (s ? { ...s, stage: 'leaving' } : s))
    sound.warp('out', LEAVE_MS / 1000)
    setWarp({ dir: 'out', cross: now + LEAVE_MS })
    const d = dive.current
    if (d) {
      dive.current = {
        ...d,
        dir: 'out',
        start: now + LEAVE_MS,
        ms: OUT_MS,
        finished: false,
        done: () => {
          dive.current = null
          setInside(null)
          setWarp(null)
        },
      }
    }
    // The music comes back slowly once the museum is in view again.
    setTimeout(() => sound.musicTo(1, 4), LEAVE_MS + 300)
  }, [sound])

  const onArrive = useCallback(() => {
    setArrived(true)
    if (pendingStep.current >= 0) {
      const i = pendingStep.current
      pendingStep.current = -1
      // Let the camera settle for a beat, then step in.
      setTimeout(() => stepIn(i), 250)
    }
  }, [stepIn])

  /** A tap on a picture: walk to it, or step into it if already there. */
  const select = useCallback(
    (i: number) => {
      if (i === focus && arrived) stepIn(i)
      else goTo(i)
    },
    [focus, arrived, stepIn, goTo],
  )
  // Walking and looking around freely: the piece in view becomes the current one (its label shows,
  // and Next / Previous carry on from it); looking away from every piece hides the label.
  const onLook = useCallback((slot: number) => {
    if (slot >= 0) setFocus(slot)
    setArrived(slot >= 0)
  }, [])

  useImperativeHandle(ref, () => ({ goTo }), [goTo])
  useEffect(() => onFocus?.(focus), [focus, onFocus])

  // Keys for the guided tour: N / P or Page Down / Page Up; Escape steps back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      // Not while typing (in the editor's labels, say).
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (inside) return
      if (e.code === 'KeyN' || e.code === 'PageDown') goTo(focus + 1)
      if (e.code === 'KeyP' || e.code === 'PageUp') goTo(Math.max(0, focus - 1))
      if (e.code === 'Enter' && focus >= 0 && arrived) stepIn(focus)
      if (e.code === 'Escape') setFocus(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focus, arrived, inside, goTo, stepIn])

  if (error) return <div className="museum-message">{error}</div>
  if (exhibition === undefined) return <div className="museum-message">Opening your Memory Palace…</div>
  if (exhibition === null) return <div className="museum-message">The museum is being set up. Nothing hangs here yet.</div>

  // The label shows once the visitor has arrived at a piece or is looking at one.
  const current = focus >= 0 && arrived ? exhibition.items[focus] : null
  const total = exhibition.items.length

  return (
    <div
      className={`museum${inside ? ' inside' : ''}`}
      // Sound can only start after a click or tap.
      onPointerDown={() => sound.wake()}
    >
      <div className="museum-stage">
        {total > 0 ? (
          <MuseumScene
            exhibition={exhibition}
            plan={plan}
            focus={focus}
            onSelect={select}
            onArrive={onArrive}
            onLook={onLook}
            onMeasure={onMeasure}
            walker={walker}
            frozen={Boolean(inside)}
            paused={covered}
            dive={dive}
          />
        ) : null}
      </div>

      {inside && inside.stage !== 'surfacing' && exhibition.items[inside.index] && (
        <StepIn
          key={inside.index}
          art={exhibition.items[inside.index]}
          stage={inside.stage}
          onBack={stepOut}
          onCovered={setCovered}
          onGone={() => setInside((s) => (s ? { ...s, stage: 'surfacing' } : s))}
        />
      )}
      {warp && <Streaks key={`${warp.dir}${warp.cross}`} dir={warp.dir} cross={warp.cross} />}

      <header className="museum-top">
        <button
          className={`museum-chip${musicOn ? ' on' : ''}`}
          onClick={() => {
            sound.wake()
            sound.setMusic(!musicOn)
            setMusicOn(!musicOn)
          }}
          aria-pressed={musicOn}
          title="Satie, Gymnopédie No. 1"
        >
          {musicOn ? '♪ Music on' : '♪ Music off'}
        </button>
      </header>


      {total === 0 && (
        <div className="museum-empty">
          <h2>{exhibition.title}</h2>
          <p>Nothing is hanging here yet.</p>
        </div>
      )}

      {total > 0 && (
        <footer className="museum-bottom">
          <button className="museum-nav" onClick={() => goTo(focus <= 0 ? 0 : focus - 1)} disabled={focus <= 0} aria-label="Previous">
            ←
          </button>
          <div className="museum-caption">
            {/* Keyed by piece, so each new label fades in instead of snapping. */}
            {current ? (
              <div key={current.id} className="museum-caption-body">
                <strong>{current.title || 'Untitled'}</strong>
                {current.date && <span className="museum-date">{current.date}</span>}
                {current.caption && <p>{current.caption}</p>}
                <div className="museum-actions">
                  <button className="museum-stepin" onClick={() => stepIn(focus)}>
                    Step in
                  </button>
                </div>
              </div>
            ) : (
              <div key="title" className="museum-caption-body">
                <strong>{exhibition.title}</strong>
                <span className="museum-date">
                  {total} {total === 1 ? 'memory' : 'memories'} · tap → to begin
                </span>
              </div>
            )}
          </div>
          <button className="museum-nav" onClick={() => goTo(focus + 1)} disabled={focus >= total - 1} aria-label="Next">
            →
          </button>
        </footer>
      )}

    </div>
  )
}
