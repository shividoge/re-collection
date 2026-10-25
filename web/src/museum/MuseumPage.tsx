import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { addFiles, kindOf, loadExhibitions, MY_EXHIBITION, removeLocal, type Exhibition } from './exhibitions'
import { planMuseum, STYLES, type RoomStyle } from './layout'
import { LOOKS } from './looks'
import { MuseumScene } from './MuseumScene'
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

  const onArrive = useCallback(() => setArrived(true), [])
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
      if (e.code === 'KeyN' || e.code === 'PageDown') goTo(focus + 1)
      if (e.code === 'KeyP' || e.code === 'PageUp') goTo(Math.max(0, focus - 1))
      if (e.code === 'Escape') setFocus(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focus, goTo])

  if (error) return <div className="museum-message">{error}</div>
  if (!exhibitions || !exhibition) return <div className="museum-message">Opening the museum…</div>

  // The label shows once the visitor has arrived at a piece or is looking at one.
  const current = focus >= 0 && arrived ? exhibition.items[focus] : null
  const total = exhibition.items.length

  return (
    <div
      className={`museum museum-${style}`}
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
      {total > 0 || exhibition.id === MY_EXHIBITION ? (
        <MuseumScene exhibition={exhibition} plan={plan} focus={focus} onSelect={goTo} onArrive={onArrive} onLook={onLook} walker={walker} />
      ) : null}

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
                  {current.captureId && <a href={`#/capture/${current.captureId}`}>Step into this visit in 3D</a>}
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
