import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { addFiles, kindOf, loadExhibitions, MY_EXHIBITION, removeLocal, type Exhibition } from './exhibitions'
import { planMuseum, STYLES, type RoomStyle } from './layout'
import { LOOKS } from './looks'
import { MuseumScene } from './MuseumScene'
import { MuseumSound } from './sound'
import { StepIn, STEP_MS, type Box } from './StepIn'
import type { WalkerHandle } from './Walker'
import './museum.css'

// v3: the classic gallery became everyone's default; earlier choices made while trying styles are dropped.
const STYLE_KEY = 'relive.museum.style.v3'

/** The room style chosen for an exhibition on this device, else the exhibition's own. */
function savedStyle(ex: Exhibition): RoomStyle {
  try {
    const all = JSON.parse(localStorage.getItem(STYLE_KEY) ?? '{}') as Record<string, RoomStyle>
    return all[ex.id] && all[ex.id] in STYLES ? all[ex.id] : ex.style
  } catch {
    return ex.style
  }
}
function saveStyle(ex: Exhibition, style: RoomStyle) {
  try {
    const all = JSON.parse(localStorage.getItem(STYLE_KEY) ?? '{}') as Record<string, RoomStyle>
    localStorage.setItem(STYLE_KEY, JSON.stringify({ ...all, [ex.id]: style }))
  } catch {
    // Private mode: the choice lasts for this visit only.
  }
}

/**
 * The museum: walk through an exhibition of photos and videos hung in real-looking rooms.
 * `#/museum` opens the first exhibition, `#/museum/<id>` a given one. Drop photos or videos on
 * the page (or use "Add photos or videos") to hang them in the exhibition that's open.
 */
export function MuseumPage({ id }: { id?: string }) {
  const [exhibitions, setExhibitions] = useState<Exhibition[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [style, setStyle] = useState<RoomStyle>('classic')
  const [focus, setFocus] = useState(-1)
  const [arrived, setArrived] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [hint, setHint] = useState(true)
  const walker = useRef<WalkerHandle>(null)
  // Stepping into a picture: which one, the box it lifted out of, and whether it's on its way back.
  const [inside, setInside] = useState<{ index: number; from: Box; leaving: boolean } | null>(null)
  // Inside a visit's 3D room, which covers the whole screen.
  const [inRoom, setInRoom] = useState(false)
  const pendingStep = useRef(-1)
  const sizes = useRef(new Map<number, { w: number; h: number }>())
  const sound = useMemo(() => new MuseumSound(), [])
  const [musicOn, setMusicOn] = useState(sound.musicOn)

  const refresh = useCallback(() => {
    loadExhibitions()
      .then(setExhibitions)
      .catch((e: Error) => setError(e.message))
  }, [])
  useEffect(refresh, [refresh])

  const exhibition = exhibitions?.find((e) => e.id === id) ?? exhibitions?.[0] ?? null
  useEffect(() => {
    if (exhibition) setStyle(savedStyle(exhibition))
    setFocus(-1)
    // Only when another exhibition opens, not when its items change.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [exhibition?.id])

  // Rooms are planned for the number of pictures; adding one may add a room.
  const count = Math.max(1, exhibition?.items.length ?? 1)
  const plan = useMemo(() => planMuseum(count, style), [count, style])

  useEffect(() => {
    const t = setTimeout(() => setHint(false), 9000)
    return () => clearTimeout(t)
  }, [])

  const goTo = useCallback(
    (i: number) => {
      if (!exhibition || i < 0 || i >= exhibition.items.length) return
      const slot = plan.slots[i]
      setFocus(i)
      setArrived(false)
      setHint(false)
      walker.current?.walkTo(slot.view, slot.center)
    },
    [exhibition, plan],
  )

  const onMeasure = useCallback((slot: number, w: number, h: number) => sizes.current.set(slot, { w, h }), [])

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
      // The picture's corners on the wall, a touch in front of it, as the camera sees them.
      const [nx, nz] = slot.normal
      const rx = nz
      const rz = -nx
      const [cx, cy, cz] = slot.center
      const out = 0.03
      const corners: [number, number, number][] = [-1, 1].flatMap((sx) =>
        [-1, 1].map((sy) => [cx + rx * sx * (size.w / 2) + nx * out, cy + sy * (size.h / 2), cz + rz * sx * (size.w / 2) + nz * out] as [number, number, number]),
      )
      const from = walker.current!.screenBox(corners)
      sound.wake()
      sound.enter()
      // The music steps back: well under a photo, out of the way of a video's own sound.
      sound.musicTo(exhibition.items[i].kind === 'video' ? 0 : 0.18, 1.2)
      setHint(false)
      setInside({ index: i, from, leaving: false })
    },
    [exhibition, inside, plan, sound],
  )

  const stepOut = useCallback(() => {
    setInside((s) => (s && !s.leaving ? { ...s, leaving: true } : s))
    sound.exit()
    // The music comes back slowly once the museum is in view again.
    setTimeout(() => sound.musicTo(1, 3.5), STEP_MS * 0.6)
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
      className={`museum museum-${style}${inside && !inside.leaving ? ' inside' : ''}`}
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
            paused={inRoom}
          />
        ) : null}
      </div>

      {inside && exhibition.items[inside.index] && (
        <StepIn
          key={inside.index}
          art={exhibition.items[inside.index]}
          from={inside.from}
          leaving={inside.leaving}
          onBack={stepOut}
          onRoom={setInRoom}
          onClosed={() => setInside(null)}
        />
      )}

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
        <div className="museum-styles" role="group" aria-label="Room">
          {(Object.keys(LOOKS) as RoomStyle[]).map((s) => (
            <button
              key={s}
              className={`museum-chip${s === style ? ' on' : ''}`}
              onClick={() => {
                setStyle(s)
                saveStyle(exhibition, s)
                setFocus(-1)
              }}
            >
              {LOOKS[s].label}
            </button>
          ))}
        </div>
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
          {LOOKS[style].guided
            ? 'Tap a picture, or the arrow, to go to it · drag gently to look around'
            : 'Drag to look around · W A S D or arrows to walk · tap a picture or the floor to go there'}
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
                {current.caption && <p>{current.caption}</p>}
                <div className="museum-actions">
                  <button className="museum-stepin" onClick={() => stepIn(focus)}>
                    Step in
                  </button>
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
    </div>
  )
}
