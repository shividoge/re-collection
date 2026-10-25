import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react'
import type * as THREE from 'three'
import { followIndex, visits, type Exhibition } from './exhibitions'
import { planMuseum, walkTarget } from './layout'
import { MuseumScene } from './MuseumScene'
import { paintToCanvas } from './painter'
import { roomHash } from './roomSync'
import { MuseumSound } from './sound'
import { StepIn, type Stage } from './StepIn'
import { Streaks } from './Streaks'
import { HelperTogether, PatientTogether } from './Together'
import { useMuseumRoom } from './useMuseumRoom'
// TEMPORARY: from '../data' once it exists.
import { dataMode, loadCaptureAssets } from '../data'
import { Presence, useLiveVisit, WhoIsVisiting } from './live/LiveUi'
import { currentVisitKey, forgetVisitKey } from './live/visitKey'
import type { Pose, WalkerHandle } from './Walker'
import { IN_MS, LEAVE_MS, OUT_MS, type Dive } from './warp'
import './museum.css'

/** What the editor can do with the palace it shows: walk to a picture. */
export interface MuseumHandle {
  goTo: (i: number) => void
}

/**
 * Her museum: walk through the pictures the caretaker hung, in real-looking rooms, and step into
 * any of them. This is the patient's page, so it changes nothing: no adding, no taking down, no
 * other exhibitions and no way out to the rest of the site. The caretaker arranges it at
 * `#/museum/edit` (MuseumEditor). `#/museum/<id>` links from before land here too.
 *
 * Visit together: the iPad opens a room; a helper who opens `#/museum?join=CODE` on their phone
 * walks with them (`join` is set only on the helper's phone). Either can open a visit's Memory
 * Window on the iPad.
 *
 * Live visit: with the palace's visit key (`#/palace?visit=<key>`, then remembered on the device),
 * the page asks who's visiting each time it opens. She leads; family follow her walk, step in and
 * out with her, and everyone talks (live/).
 *
 * The editor shows this same palace as its preview: `preview` is the arrangement being edited
 * (instead of the saved one, and with no visits or rooms), `onFocus` says which picture the visitor
 * is at, and `ref` walks to one.
 */
export function MuseumPage({
  join,
  preview,
  onFocus,
  ref,
}: {
  id?: string
  join?: string
  preview?: Exhibition
  onFocus?: (i: number) => void
  ref?: Ref<MuseumHandle>
}) {
  const helper = join !== undefined
  const together = dataMode === 'live' && !preview
  const room = useMuseumRoom(helper ? 'helper' : 'patient', { join, enabled: together })
  const [loaded, setExhibition] = useState<Exhibition | null | undefined>(undefined)
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
  // The museum's renderer paints a photo for stepping into it (painter.ts).
  const renderer = useRef<THREE.WebGLRenderer | null>(null)
  const onRenderer = useCallback((gl: THREE.WebGLRenderer) => {
    renderer.current = gl
  }, [])
  const paint = useCallback(
    (src: string, maxW: number, maxH: number) => (renderer.current ? paintToCanvas(renderer.current, src, maxW, maxH) : Promise.reject(new Error('The museum is not drawn yet.'))),
    [],
  )
  const sound = useMemo(() => new MuseumSound(), [])
  // Leaving the museum stops its music and lets its audio engine go.
  useEffect(() => () => sound.dispose(), [sound])
  const [musicOn, setMusicOn] = useState(sound.musicOn)
  const musicOnRef = useRef(musicOn)
  useEffect(() => {
    musicOnRef.current = musicOn
  }, [musicOn])

  // The live visit (live mode, not a helper's phone, and only with the visit key).
  const [visitKey, setVisitKey] = useState(() => (together && !helper ? currentVisitKey() : null))
  const onBadKey = useCallback(() => {
    forgetVisitKey()
    setVisitKey(null)
  }, [])
  const { session, snapshot, join: joinVisit } = useLiveVisit(visitKey, onBadKey)
  const [chosen, setChosen] = useState(visitKey === null)
  const inVisit = session !== null && snapshot.status !== 'ended'
  const family = inVisit && snapshot.role === 'family'
  // Family follow while she's in the visit (her view is there); otherwise they look around.
  const led = family && snapshot.view !== null
  const follow = useRef<Pose | null>(null)
  const othersHere = inVisit && snapshot.members.some((m) => m.id !== snapshot.me)
  // Pictures measured so far: family can only dive into one once its size is known.
  const [measured, setMeasured] = useState(0)

  useEffect(() => {
    if (preview) return
    visits()
      .then(setExhibition)
      .catch((e: Error) => setError(e.message))
  }, [preview])

  // Rooms are planned for the number of pictures; adding one may add a room.
  const count = Math.max(1, exhibition?.items.length ?? 1)
  const plan = useMemo(() => planMuseum(count), [count])


  // The last guided walk asked for in this exhibition. The walker may not be there yet (the
  // shared walk can arrive before the museum is drawn) or may start again at the entrance (a new
  // plan), so it's kept and given again when the walker is ready.
  const destination = useRef<{ exhibition: string; index: number } | null>(null)
  const walkToDestination = useCallback(() => {
    const d = destination.current
    const w = walker.current
    const target = d && d.exhibition === exhibition?.id ? walkTarget(plan, d.index) : null
    if (w && target) w.walkTo(target.to, target.look)
  }, [exhibition?.id, plan])

  /** Walks to piece `i` (−1: back to the entrance); `share` tells the other screen too. */
  const walkTo = useCallback(
    (i: number, share: boolean) => {
      if (!exhibition || i < -1 || i >= exhibition.items.length) return
      setFocus(i)
      setArrived(false)
      destination.current = { exhibition: exhibition.id, index: i }
      walkToDestination()
      if (share) room.setAt(i, i >= 0 ? (exhibition.items[i].captureId ?? null) : null)
    },
    [exhibition, room, walkToDestination],
  )
  const goTo = useCallback((i: number) => walkTo(i, true), [walkTo])
  useImperativeHandle(ref, () => ({ goTo }), [goTo])
  useEffect(() => onFocus?.(focus), [focus, onFocus])

  // Visit together: both screens follow the shared walk.
  const items = exhibition?.items
  const followTo = room.state && items ? followIndex(items, room.state.at, room.state.atId) : null
  const focusNow = useRef(focus)
  useEffect(() => {
    focusNow.current = focus
  }, [focus])
  useEffect(() => {
    if (followTo !== null && followTo !== focusNow.current) walkTo(followTo, false)
    // Only when the shared walk moves.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [followTo])

  // Arriving at a visit's picture: fetch its files now, so stepping in (or the Memory Window) opens at once.
  const arrivedAt = arrived && focus >= 0 ? exhibition?.items[focus]?.captureId : undefined
  useEffect(() => {
    if (arrivedAt) loadCaptureAssets(arrivedAt).catch(() => {})
  }, [arrivedAt])

  /** Opens piece `i`'s visit in the Memory Window on the iPad (from the iPad itself, or from the helper's phone). */
  const openWindow = useCallback(
    (i: number) => {
      const captureId = exhibition?.items[i]?.captureId
      if (!captureId) return
      room.enter(captureId, i)
      if (!helper) location.hash = roomHash(captureId)
    },
    [exhibition, room, helper],
  )

  const onMeasure = useCallback((slot: number, w: number, h: number) => {
    sizes.current.set(slot, { w, h })
    setMeasured(sizes.current.size)
  }, [])

  /**
   * Steps into piece `i`: from where the visitor stands if they're at it, else after walking there.
   * `now` dives in from wherever they are (family following her in).
   */
  const stepIn = useCallback(
    (i: number, now = false) => {
      if (!exhibition || inside) return
      const slot = plan.slots[i]
      const size = sizes.current.get(i)
      const at = walker.current?.position()
      if (!slot || !size || !at) return
      if (!now && Math.hypot(at[0] - slot.view[0], at[1] - slot.view[1]) > 0.35) {
        // Walk up to it first, then step in on arrival.
        pendingStep.current = i
        setFocus(i)
        setArrived(false)
        destination.current = { exhibition: exhibition.id, index: i }
        walker.current?.walkTo(slot.view, slot.center)
        return
      }
      // Dive into the frame. The museum's music fades right away (every picture has its own
      // sound), the rush builds as the view picks up speed, and at the crossing the picture's
      // own world takes over.
      const t = performance.now()
      dive.current = {
        dir: 'in',
        target: { center: slot.center, normal: slot.normal, w: size.w, h: size.h },
        start: t,
        ms: IN_MS,
        done: () => setInside((s) => (s && s.stage === 'diving' ? { ...s, stage: 'here' } : s)),
      }
      sound.wake()
      sound.musicTo(0, 1.6)
      sound.warp('in', IN_MS / 1000)
      setWarp({ dir: 'in', cross: t + IN_MS })
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
    setTimeout(() => sound.musicTo(sound.level, 4), LEAVE_MS + 300)
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
      // Family following her go where she goes.
      if (led) return
      if (i === focus && arrived) stepIn(i)
      else goTo(i)
    },
    [focus, arrived, stepIn, goTo, led],
  )

  // Her screen tells the visit where she is, a few times a second (sent only when it changed).
  const leading = inVisit && snapshot.role === 'patient'
  useEffect(() => {
    if (!session || !leading) return
    const t = setInterval(() => {
      const pose = walker.current?.pose()
      if (!pose) return
      const ins = insideRef.current
      session.visit.sendView({ ...pose, inside: ins && ins.stage !== 'surfacing' ? { index: ins.index, stage: ins.stage } : null, music: musicOnRef.current })
    }, 200)
    return () => clearInterval(t)
  }, [session, leading])

  // Family: follow her walk, step in and out with her, and hear the music she chose.
  const view = snapshot.view
  useEffect(() => {
    follow.current = led && view ? { x: view.x, z: view.z, yaw: view.yaw, pitch: view.pitch } : null
  }, [led, view])
  const theirs = led ? (view?.inside ?? null) : null
  useEffect(() => {
    if (!led) return
    const mine = insideRef.current
    if (theirs && theirs.stage !== 'leaving' && !mine) stepIn(theirs.index, true)
    else if ((!theirs || theirs.stage === 'leaving') && mine?.stage === 'here') stepOut()
    // Only when her step or ours changes (or a picture's size arrives), not on every view.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [led, theirs?.index, theirs?.stage, inside?.stage, measured, stepIn, stepOut])
  useEffect(() => {
    if (!led || !view || view.music === musicOnRef.current) return
    sound.setMusic(view.music)
    setMusicOn(view.music)
  }, [led, view, sound])
  // With others here, the music steps back so voices come through (inside a memory it's already off).
  useEffect(() => {
    sound.setBase(othersHere ? 0.4 : 1, Boolean(insideRef.current))
  }, [othersHere, sound])
  // Walking and looking around freely: the piece in view becomes the current one (its label shows,
  // and Next / Previous carry on from it); looking away from every piece hides the label.
  const onLook = useCallback((slot: number) => {
    if (slot >= 0) setFocus(slot)
    setArrived(slot >= 0)
  }, [])

  // Keys for the guided tour: N / P or Page Down / Page Up; Escape steps back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      // Not while typing (in the editor's labels, say).
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (inside || led) return
      if (e.code === 'KeyN' || e.code === 'PageDown') goTo(focus + 1)
      if (e.code === 'KeyP' || e.code === 'PageUp') goTo(Math.max(0, focus - 1))
      if (e.code === 'Enter' && focus >= 0 && arrived) stepIn(focus)
      if (e.code === 'Escape') setFocus(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focus, arrived, inside, goTo, stepIn, led])

  if (error) return <div className="museum-message">{error}</div>
  if (exhibition === undefined) return <div className="museum-message">Opening your Memory Palace…</div>
  if (exhibition === null) return <div className="museum-message">Your family is still getting this ready.</div>

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
            onWalkerReady={walkToDestination}
            frozen={Boolean(inside)}
            paused={covered}
            dive={dive}
            onRenderer={onRenderer}
            follow={follow}
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
          paint={paint}
          onGone={() => setInside((s) => (s ? { ...s, stage: 'surfacing' } : s))}
          canLeave={!led}
        />
      )}
      {warp && <Streaks key={`${warp.dir}${warp.cross}`} dir={warp.dir} cross={warp.cross} />}

      <header className="museum-top">
        <button
          className={`museum-chip${musicOn ? ' on' : ''}`}
          disabled={led}
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
          <button className="museum-nav" onClick={() => goTo(focus <= 0 ? 0 : focus - 1)} disabled={focus <= 0 || led} aria-label="Previous">
            ←
          </button>
          <div className="museum-caption">
            {/* Keyed by piece, so each new label fades in instead of snapping. */}
            {current ? (
              <div key={current.id} className="museum-caption-body">
                <strong>{current.title || 'Untitled'}</strong>
                {current.date && <span className="museum-date">{current.date}</span>}
                {current.estimated && <span className="estimated-badge">Estimated from a video</span>}
                {current.caption && <p>{current.caption}</p>}
                {!led && (
                  <div className="museum-actions">
                    <button className="museum-stepin" onClick={() => stepIn(focus)}>
                      Step in
                    </button>
                    {/* The Memory Window leaves the palace, which ends the live visit on this screen: not while others are with her. */}
                    {current.captureId && !family && !othersHere && (
                      <button onClick={() => openWindow(focus)} title={helper ? 'Open this visit on the iPad, to look into with your head' : 'Look into this visit with your head'}>
                        {helper ? 'Open on the iPad' : 'Memory Window'}
                      </button>
                    )}
                  </div>
                )}
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
          <button className="museum-nav" onClick={() => goTo(focus + 1)} disabled={focus >= total - 1 || led} aria-label="Next">
            →
          </button>
        </footer>
      )}

      {together &&
        (helper ? (
          <HelperTogether room={room} join={join} openTitle={room.state?.window ? (exhibition.items.find((a) => a.captureId === room.state?.window)?.title ?? null) : null} />
        ) : (
          !inside && !family && <PatientTogether room={room} at={focus} />
        ))}

      {session && <Presence session={session} snapshot={snapshot} />}
      {!chosen && (
        <WhoIsVisiting
          title={exhibition.title}
          onChoose={(role, name) => {
            setChosen(true)
            sound.wake()
            void joinVisit(role, name)
          }}
        />
      )}
    </div>
  )
}
