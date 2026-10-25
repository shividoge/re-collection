import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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

const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** Where the picture settles inside: as large as fits, above the caption, keeping its shape. */
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

/**
 * Stepping into a picture: it lifts out of its frame (from `from`, its box on screen) and grows to
 * fill the view over a soft backdrop of its own colours, while the museum behind recedes (the
 * page dims and shrinks it). Photos show still; videos play with their sound. `leaving` runs it
 * all backwards, into the frame again, then calls `onClosed`.
 */
export function StepIn({
  art,
  from,
  leaving,
  onBack,
  onClosed,
}: {
  art: Artwork
  from: Box
  leaving: boolean
  onBack: () => void
  onClosed: () => void
}) {
  const media = useRef<HTMLDivElement>(null)
  const backdrop = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const [to] = useState(() => settled(from.width / Math.max(1, from.height)))
  const [ready, setReady] = useState(false)
  const image = art.kind === 'photo' ? art.src : (art.poster ?? '')

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
    if (!leaving) {
      el.animate(
        reducedMotion()
          ? [{ opacity: 0 }, { opacity: 1 }]
          : [
              { transform: inFrame(), borderRadius: '3px', boxShadow: '0 0 0 rgba(0,0,0,0)' },
              { transform: 'none', borderRadius: '22px', boxShadow: '0 40px 120px rgba(0,0,0,0.55)' },
            ],
        { duration: ms, easing: EASE, fill: 'both' },
      ).onfinish = () => setReady(true)
      bg.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms * 0.8, easing: 'ease-out', fill: 'both' })
    } else {
      setReady(false)
      video.current?.pause()
      el.animate(
        reducedMotion()
          ? [{ opacity: 1 }, { opacity: 0 }]
          : [
              { transform: 'none', borderRadius: '22px', boxShadow: '0 40px 120px rgba(0,0,0,0.55)' },
              { transform: inFrame(), borderRadius: '3px', boxShadow: '0 0 0 rgba(0,0,0,0)' },
            ],
        { duration: ms, easing: EASE, fill: 'both' },
      ).onfinish = onClosed
      bg.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms * 0.7, easing: 'ease-in', fill: 'both' })
    }
    // Runs once when stepping in and once when leaving.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [leaving])

  // Escape steps back out.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape' && !leaving) onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [leaving, onBack])

  return (
    <div className="stepin" role="dialog" aria-label={art.title || 'Picture'}>
      <div ref={backdrop} className="stepin-backdrop" style={image ? { backgroundImage: `url("${image}")` } : undefined} />
      <div ref={media} className="stepin-media" style={{ left: to.left, top: to.top, width: to.width, height: to.height }}>
        {art.kind === 'photo' ? (
          <img src={art.src} alt={art.title ?? ''} draggable={false} />
        ) : (
          <video
            ref={video}
            src={art.src}
            poster={art.poster}
            autoPlay
            playsInline
            loop
            onClick={(e) => (e.currentTarget.paused ? void e.currentTarget.play() : e.currentTarget.pause())}
          />
        )}
      </div>
      <div className={`stepin-ui${ready ? ' shown' : ''}`}>
        <button className="stepin-back" onClick={onBack}>
          <span aria-hidden="true">‹</span> Museum
        </button>
        <div className="stepin-caption">
          <strong>{art.title || 'Untitled'}</strong>
          {art.date && <span>{art.date}</span>}
          {art.caption && <p>{art.caption}</p>}
          {art.captureId && (
            <a className="stepin-action" href={`#/capture/${art.captureId}`}>
              Walk around this visit in 3D
            </a>
          )}
        </div>
      </div>
    </div>
  )
}
