import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { SceneViewer } from '../scene/SceneViewer'
import { loadGuideCapture, type LoadedCapture } from '../scene/loadCapture'
import { VisitDock } from '../views/VisitDock'
import type { Artwork } from './exhibitions'

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** Apple's own easing for zoom transitions: quick to start, a long soft settle. */
const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'
export const STEP_MS = 950
/** After the room appears behind the picture, how long before the picture dissolves into it (ms). */
const ROOM_SETTLE_MS = 1100
const DISSOLVE_MS = 900

const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** A picture without a 3D room settles as large as fits, above the caption, keeping its shape. */
function settled(aspect: number): Box {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const maxW = vw * 0.88
  const maxH = vh * 0.74
  let width = maxW
  let height = width / aspect
  if (height > maxH) {
    height = maxH
    width = height * aspect
  }
  return { left: (vw - width) / 2, top: Math.max(24, (vh - height) / 2 - vh * 0.05), width, height }
}

/** A visit's picture grows to cover the whole screen, keeping its shape (the edges overflow). */
function covering(aspect: number): Box {
  const vw = window.innerWidth
  const vh = window.innerHeight
  let width = vw
  let height = vw / aspect
  if (height < vh) {
    height = vh
    width = vh * aspect
  }
  return { left: (vw - width) / 2, top: (vh - height) / 2, width, height }
}

/**
 * Stepping into a picture: it lifts out of its frame (from `from`, its box on screen) while the
 * museum behind recedes (the page dims and shrinks it).
 * - A visit's picture grows to fill the screen; its 3D room loads behind it, starting from the
 *   phone's own view at the moment the picture was taken, and the picture dissolves into it: the
 *   visitor steps through the photo into the place, and can look around, walk and talk there.
 * - A photo or video with no 3D room settles large over a soft blur of its own colours; a video
 *   plays with its sound.
 * `leaving` runs it all backwards, into the frame again, then calls `onClosed`.
 */
export function StepIn({
  art,
  from,
  leaving,
  onBack,
  onRoom,
  onClosed,
}: {
  art: Artwork
  from: Box
  leaving: boolean
  onBack: () => void
  /** True once the visitor is in the visit's 3D room (it covers the museum), false on the way out. */
  onRoom?: (inRoom: boolean) => void
  onClosed: () => void
}) {
  const media = useRef<HTMLDivElement>(null)
  const backdrop = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const dissolve = useRef<Animation | null>(null)
  const hasRoom = Boolean(art.captureId)
  const aspect = from.width / Math.max(1, from.height)
  const [to] = useState(() => (hasRoom ? covering(aspect) : settled(aspect)))
  const [lifted, setLifted] = useState(false)
  const [capture, setCapture] = useState<LoadedCapture | null>(null)
  const [roomError, setRoomError] = useState<string | null>(null)
  const [inRoom, setInRoom] = useState(false)
  const image = art.kind === 'photo' ? art.src : (art.poster ?? '')
  const radius = hasRoom ? '0px' : '22px'

  // Start loading the room right away, while the picture is still lifting.
  useEffect(() => {
    if (!art.captureId) return
    let cancelled = false
    loadGuideCapture(art.captureId)
      .then((c) => !cancelled && setCapture(c))
      .catch((e: Error) => !cancelled && setRoomError(e.message))
    return () => {
      cancelled = true
    }
  }, [art.captureId])

  // Once the picture fills the screen and the room is there, give the room a moment to draw, then
  // dissolve the picture into it.
  useEffect(() => {
    if (!lifted || !capture || leaving || inRoom) return
    const t = setTimeout(() => {
      const a = media.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: DISSOLVE_MS, easing: 'ease-in-out', fill: 'both' })
      if (!a) return
      dissolve.current = a
      a.onfinish = () => setInRoom(true)
    }, ROOM_SETTLE_MS)
    return () => clearTimeout(t)
  }, [lifted, capture, leaving, inRoom])

  // The transform that puts the settled box exactly over the frame.
  const inFrame = () => {
    const s = from.width / to.width
    return `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${s})`
  }

  useLayoutEffect(() => {
    const el = media.current
    const bg = backdrop.current
    if (!el || !bg) return
    const ms = reducedMotion() ? 250 : STEP_MS
    const open = { transform: 'none', borderRadius: radius, boxShadow: '0 40px 120px rgba(0,0,0,0.55)' }
    const shut = { transform: inFrame(), borderRadius: '3px', boxShadow: '0 0 0 rgba(0,0,0,0)' }
    if (!leaving) {
      el.animate(reducedMotion() ? [{ opacity: 0 }, { opacity: 1 }] : [shut, open], { duration: ms, easing: EASE, fill: 'both' }).onfinish = () => setLifted(true)
      bg.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms * 0.8, easing: 'ease-out', fill: 'both' })
      return
    }
    video.current?.pause()
    const shrink = () => {
      el.animate(reducedMotion() ? [{ opacity: 1 }, { opacity: 0 }] : [open, shut], { duration: ms, easing: EASE, fill: 'both' }).onfinish = onClosed
      bg.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms * 0.7, easing: 'ease-in', fill: 'both' })
    }
    // Out of the room (or while dissolving into it): the picture comes back over it first, then
    // shrinks into its frame.
    if (dissolve.current) {
      const opacity = Number(getComputedStyle(el).opacity)
      dissolve.current.onfinish = null
      dissolve.current = null
      el.getAnimations().forEach((a) => a.cancel())
      el.style.transform = 'none'
      el.style.borderRadius = radius
      el.animate([{ opacity }, { opacity: 1 }], { duration: 450, easing: 'ease-out', fill: 'both' }).onfinish = () => {
        setInRoom(false)
        setCapture(null)
        shrink()
      }
    } else shrink()
    // Runs once when stepping in and once when leaving.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [leaving])

  useEffect(() => onRoom?.(inRoom), [inRoom, onRoom])

  // Escape steps back out.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape' && !leaving) onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [leaving, onBack])

  const showUi = (hasRoom ? inRoom || Boolean(roomError) : lifted) && !leaving
  return (
    <div className={`stepin${hasRoom ? ' stepin-room' : ''}`} role="dialog" aria-label={art.title || 'Picture'}>
      <div ref={backdrop} className="stepin-backdrop" style={image ? { backgroundImage: `url("${image}")` } : undefined} />
      {/* The visit's room, behind the picture until the picture dissolves into it. */}
      {hasRoom && capture && lifted && (
        <div className={`stepin-3d${inRoom ? ' live' : ''}`}>
          <SceneViewer
            capture={capture}
            initialMode="follow"
            startAt={art.t ?? 0}
            showVideo={false}
            overlay={(controls) => <VisitDock captureId={art.captureId!} controls={controls} />}
          />
        </div>
      )}
      <div ref={media} className={`stepin-media${inRoom ? ' gone' : ''}`} style={{ left: to.left, top: to.top, width: to.width, height: to.height }}>
        {art.kind === 'photo' ? (
          <img src={art.src} alt={art.title ?? ''} draggable={false} />
        ) : (
          <video
            ref={video}
            src={art.src}
            poster={art.poster}
            autoPlay={!hasRoom}
            muted={hasRoom}
            playsInline
            loop
            onClick={(e) => (e.currentTarget.paused ? void e.currentTarget.play() : e.currentTarget.pause())}
          />
        )}
      </div>
      <div className={`stepin-ui${showUi ? ' shown' : ''}`}>
        <button className="stepin-back" onClick={onBack}>
          <span aria-hidden="true">‹</span> Museum
        </button>
        {hasRoom ? (
          roomError && <div className="stepin-caption">Couldn't open this room: {roomError}</div>
        ) : (
          <div className="stepin-caption">
            <strong>{art.title || 'Untitled'}</strong>
            {art.date && <span>{art.date}</span>}
            {art.caption && <p>{art.caption}</p>}
          </div>
        )}
      </div>
    </div>
  )
}
