import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type * as THREE from 'three'
import { addFiles, followIndex, kindOf, loadExhibitions, MY_EXHIBITION, removeLocal, type Exhibition } from './exhibitions'
import { planMuseum } from './layout'
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
import type { WalkerHandle } from './Walker'
import { IN_MS, LEAVE_MS, OUT_MS, type Dive } from './warp'
import './museum.css'

/**
 * The museum: walk through an exhibition of photos and videos hung in real-looking rooms.
 * `#/museum` opens the first exhibition, `#/museum/<id>` a given one. Drop photos or videos on
 * the page (or use "Add photos or videos") to hang them in the exhibition that's open.
 *
 * Visit together: the iPad opens a room; a helper who opens `#/museum?join=CODE` on their phone
 * walks with them (`join` is set only on the helper's phone). Either can open a visit's Memory
 * Window on the iPad.
 */
export function MuseumPage({ id, join }: { id?: string; join?: string }) {
  const helper = join !== undefined
  const together = dataMode === 'live'
  const room = useMuseumRoom(helper ? 'helper' : 'patient', { join, enabled: together })
  const [exhibitions, setExhibitions] = useState<Exhibition[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [focus, setFocus] = useState(-1)
  const [arrived, setArrived] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [hint, setHint] = useState(true)
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

  const refresh = useCallback(() => {
    loadExhibitions()
      .then(setExhibitions)
      .catch((e: Error) => setError(e.message))
  }, [])
  useEffect(refresh, [refresh])

  const exhibition = exhibitions?.find((e) => e.id === id) ?? exhibitions?.[0] ?? null
  useEffect(() => {
    setFocus(-1)
    // Only when another exhibition opens, not when its items change.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [exhibition?.id])

  // Rooms are planned for the number of pictures; adding one may add a room.
  const count = Math.max(1, exhibition?.items.length ?? 1)
  const plan = useMemo(() => planMuseum(count), [count])

  useEffect(() => {
    const t = setTimeout(() => setHint(false), 9000)
    return () => clearTimeout(t)
  }, [])

  /** Walks to piece `i` (−1: back to the entrance); `share` tells the other screen too. */
  const walkTo = useCallback(
    (i: number, share: boolean) => {
      if (!exhibition || i < -1 || i >= exhibition.items.length) return
      setFocus(i)
      setArrived(false)
      setHint(false)
      if (i < 0) walker.current?.walkTo(plan.start)
      else walker.current?.walkTo(plan.slots[i].view, plan.slots[i].center)
      if (share) room.setAt(i, i >= 0 ? (exhibition.items[i].captureId ?? null) : null)
    },
    [exhibition, plan, room],
  )
  const goTo = useCallback((i: number) => walkTo(i, true), [walkTo])

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
      setHint(false)
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

  const add = useCallback(
    async (files: File[]) => {
      if (!exhibition) return
      const usable = files.filter((f) => kindOf(f))
      if (usable.length === 0) {
        setBusy('Only photos and videos can be hung here.')
        setTimeout(() => setBusy(null), 2500)
        return
      }
      setBusy(`Hanging ${usable.length} ${usable.length === 1 ? 'piece' : 'pieces'}…`)
      try {
        const added = await addFiles(exhibition.id, usable)
        setExhibitions((all) => all?.map((e) => (e.id === exhibition.id ? { ...e, items: [...e.items, ...added] } : e)) ?? all)
        setBusy(null)
      } catch (e) {
        setBusy(`Couldn't keep them on this device: ${(e as Error).message}`)
      }
    },
    [exhibition],
  )

  const remove = useCallback(
    async (artId: string) => {
      await removeLocal(artId).catch(() => {})
      setExhibitions((all) => all?.map((e) => ({ ...e, items: e.items.filter((a) => a.id !== artId) })) ?? all)
      setFocus(-1)
    },
    [],
  )

  // Keys for the guided tour: N / P or Page Down / Page Up; Escape steps back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT')) return
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
  if (!exhibitions || !exhibition) return <div className="museum-message">Opening the museum…</div>

  // The label shows once the visitor has arrived at a piece or is looking at one.
  const current = focus >= 0 && arrived ? exhibition.items[focus] : null
  const total = exhibition.items.length

  return (
    <div
      className={`museum${inside ? ' inside' : ''}`}
      // Sound can only start after a click or tap.
      onPointerDown={() => sound.wake()}
      onDragOver={(e) => {
        if ([...e.dataTransfer.items].some((i) => i.kind === 'file')) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        void add([...e.dataTransfer.files])
      }}
    >
      <div className="museum-stage">
        {total > 0 || exhibition.id === MY_EXHIBITION ? (
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
            onRenderer={onRenderer}
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
        />
      )}
      {warp && <Streaks key={`${warp.dir}${warp.cross}`} dir={warp.dir} cross={warp.cross} />}

      <header className="museum-top">
        <a className="museum-chip" href="#/">
          ← Back
        </a>
        <label className="museum-chip museum-select">
          <span className="sr-only">Exhibition</span>
          <select value={exhibition.id} onChange={(e) => (location.hash = `#/museum/${e.target.value}`)}>
            {exhibitions.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title} ({e.items.length})
              </option>
            ))}
          </select>
        </label>
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
        <label className="museum-chip museum-add">
          Add photos or videos
          <input type="file" accept="image/*,video/*" multiple hidden onChange={(e) => void add([...(e.target.files ?? [])])} />
        </label>
      </header>

      {hint && total > 0 && (
        <p className="museum-hint">
          Drag to look around · W A S D or arrows to walk · tap a picture or the floor to go there
        </p>
      )}

      {total === 0 && (
        <div className="museum-empty">
          <h2>{exhibition.title}</h2>
          <p>Nothing is hanging here yet. Drop photos or videos anywhere on this page, or press “Add photos or videos”.</p>
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
                {current.estimated && <span className="estimated-badge">Estimated from a video</span>}
                {current.caption && <p>{current.caption}</p>}
                <div className="museum-actions">
                  <button className="museum-stepin" onClick={() => stepIn(focus)}>
                    Step in
                  </button>
                  {current.captureId && (
                    <button onClick={() => openWindow(focus)} title={helper ? 'Open this visit on the iPad, to look into with your head' : 'Look into this visit with your head'}>
                      {helper ? 'Open on the iPad' : 'Memory Window'}
                    </button>
                  )}
                  {current.local && <button onClick={() => void remove(current.id)}>Take down</button>}
                </div>
              </div>
            ) : (
              <div key="title" className="museum-caption-body">
                <strong>{exhibition.title}</strong>
                <span className="museum-date">
                  {total} {total === 1 ? 'piece' : 'pieces'} · press → to begin, or look at a picture
                </span>
              </div>
            )}
          </div>
          <button className="museum-nav" onClick={() => goTo(focus + 1)} disabled={focus >= total - 1} aria-label="Next">
            →
          </button>
        </footer>
      )}

      {dragging && (
        <div className="museum-drop">
          <p>Drop to hang them in “{exhibition.title}”</p>
        </div>
      )}
      {busy && <div className="museum-toast">{busy}</div>}
      {together &&
        (helper ? (
          <HelperTogether room={room} join={join} openTitle={room.state?.window ? (exhibition.items.find((a) => a.captureId === room.state?.window)?.title ?? null) : null} />
        ) : (
          !inside && <PatientTogether room={room} at={focus} />
        ))}
    </div>
  )
}
