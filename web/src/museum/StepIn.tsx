import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CaptureAssets } from '../data/assets'
import { VisitDock } from '../views/VisitDock'
import type { Artwork } from './exhibitions'
import { REPAINT_MS, UNPAINT_MS } from './paint'
import { Painted, PaintedStill } from './Painted'
// TEMPORARY: from '../data' and '../scene' once they exist.
import { useCaptureAssets } from '../data'
import { SceneViewer, useCaptureScene } from '../scene'
import { ARRIVE_MS, LEAVE_MS } from './warp'

/** Where the visitor is with a picture: diving toward it, inside it, or on the way back out. */
export type Stage = 'diving' | 'here' | 'leaving'

/** A visit's room draws for this long behind its picture before the picture gives way to it (ms),
 * counted from the arrival or from when it loaded, whichever is later. */
const ROOM_SETTLE_MS = 900

const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

// Coming out of the warp: from a bright, swollen smear to the world, sharp and still.
const ARRIVE: Keyframe[] = [
  { opacity: 0, transform: 'scale(1.45)', filter: 'blur(28px) brightness(2.4) saturate(1.5)' },
  { opacity: 1, transform: 'scale(1.26)', filter: 'blur(16px) brightness(1.7) saturate(1.3)', offset: 0.18 },
  { opacity: 1, transform: 'scale(1)', filter: 'blur(0px) brightness(1) saturate(1)' },
]
// And back into it, the same way reversed.
const LEAVE: Keyframe[] = [
  { opacity: 1, transform: 'scale(1)', filter: 'blur(0px) brightness(1) saturate(1)' },
  { opacity: 1, transform: 'scale(1.26)', filter: 'blur(16px) brightness(1.7) saturate(1.3)', offset: 0.82 },
  { opacity: 0, transform: 'scale(1.45)', filter: 'blur(28px) brightness(2.4) saturate(1.5)' },
]

/** Fades a video's own sound to `to` (0–1) over `ms`, then calls `done`. */
function fadeVolume(v: HTMLVideoElement, to: number, ms: number, done?: () => void): () => void {
  const from = v.volume
  const start = performance.now()
  let frame = 0
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / ms)
    // Equal-power feel: quick to be heard, gentle to arrive.
    v.volume = Math.max(0, Math.min(1, from + (to - from) * Math.sin((t * Math.PI) / 2)))
    if (t < 1) frame = requestAnimationFrame(step)
    else done?.()
  }
  frame = requestAnimationFrame(step)
  return () => cancelAnimationFrame(frame)
}

/**
 * The world inside a picture, which the visitor reaches by diving into its frame (the museum
 * does the dive; this is the far side).
 * - A visit's picture opens onto the visit's own 3D room, seen from where the phone was at that
 *   moment, so the picture and the room line up; the visitor can look around, replay the visit
 *   and talk about it there. The room loads during the dive; until it's ready the picture
 *   itself stands in for it.
 * - Any other photo fills the view and drifts slowly; a video plays, its own sound rising
 *   gently as the visitor arrives.
 * It's mounted hidden while the visitor dives toward it, emerges from the warp at `here`, and
 * smears back into it at `leaving`, calling `onGone` at the moment of crossing back.
 * `onCovered` says when it fills the screen (so the museum behind can stop drawing).
 */
export function StepIn({
  art,
  stage,
  onBack,
  onCovered,
  onGone,
  paint: paintProp,
  canLeave = true,
}: {
  art: Artwork
  stage: Stage
  onBack: () => void
  onCovered?: (covered: boolean) => void
  onGone: () => void
  /** Paints a photo as the museum shows it (the museum's own renderer); without it, no painted overlay. */
  paint?: (src: string, maxW: number, maxH: number) => Promise<HTMLCanvasElement>
  /** False for family following her in a live visit: they come back out when she does. */
  canLeave?: boolean
}) {
  const world = useRef<HTMLDivElement>(null)
  const cover = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const hasRoom = Boolean(art.captureId)
  // The visit's files (prefetched when the visitor arrived at the picture), then its room.
  const assets = useCaptureAssets(art.captureId ?? null)
  const [roomSince, setRoomSince] = useState(0)
  const [sceneError, setSceneError] = useState<string | null>(null)
  const roomError = assets.status === 'error' ? assets.message : assets.status === 'missing' && hasRoom ? "This visit isn't here any more." : sceneError
  const ready = assets.status === 'ready' ? assets.assets : null
  const [roomLive, setRoomLive] = useState(false)
  const [settled, setSettled] = useState(false)
  // The museum's painted look stays on through the dive and the arrival, then lifts away.
  const [paint, setPaint] = useState(true)
  const paintPhoto = paintProp
  const [unpainted, setUnpainted] = useState(false)
  const [source, setSource] = useState<HTMLVideoElement | null>(null)
  const stopFade = useRef<() => void>(() => {})
  useEffect(() => () => stopFade.current(), [])
  const still = art.kind === 'photo' ? art.src : (art.poster ?? '')

  const onRoomReady = useCallback(() => setRoomSince(performance.now()), [])

  // Arriving and leaving.
  useLayoutEffect(() => {
    const el = world.current
    if (!el || stage === 'diving') return
    const v = video.current
    if (stage === 'here') {
      const a = el.animate(reducedMotion() ? [{ opacity: 0 }, { opacity: 1 }] : ARRIVE, { duration: reducedMotion() ? 300 : ARRIVE_MS, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'both' })
      // Once through, the paint lifts away and, at the same time, the picture's own sound rises.
      a.onfinish = () => {
        setSettled(true)
        onCovered?.(true)
        setPaint(false)
        if (v && !hasRoom) stopFade.current = fadeVolume(v, 1, UNPAINT_MS)
      }
      if (v && !hasRoom) {
        v.volume = 0
        void v.play().catch(() => {})
      }
      return
    }
    setSettled(false)
    onCovered?.(false)
    // On the way out it becomes a painting again, as it hangs in the museum.
    setPaint(true)
    setUnpainted(false)
    stopFade.current()
    el.getAnimations().forEach((a) => a.cancel())
    el.animate(reducedMotion() ? [{ opacity: 1 }, { opacity: 0 }] : LEAVE, { duration: reducedMotion() ? 300 : LEAVE_MS, easing: 'cubic-bezier(0.64, 0, 0.78, 0)', fill: 'both' }).onfinish = onGone
    // The room hands back to its picture on the way out, so the far side of the crossing matches.
    if (cover.current && roomLive) cover.current.animate([{ opacity: 0 }, { opacity: 1 }], { duration: LEAVE_MS * 0.45, easing: 'ease-out', fill: 'both' })
    if (v && !hasRoom) stopFade.current = fadeVolume(v, 0, 900, () => v.pause())
    // Only when the stage changes.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [stage])

  // On the far side, once the paint has lifted and the room has drawn for a moment, the picture
  // gives way to it.
  useEffect(() => {
    if (stage !== 'here' || !roomSince || roomLive || !unpainted) return
    const wait = Math.max(0, roomSince + ROOM_SETTLE_MS - performance.now())
    const t = setTimeout(() => {
      const a = cover.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 900, easing: 'ease-in-out', fill: 'both' })
      if (a) a.onfinish = () => setRoomLive(true)
    }, wait)
    return () => clearTimeout(t)
  }, [stage, roomSince, roomLive, unpainted])

  // Escape steps back out.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape' && stage === 'here' && canLeave) onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [stage, onBack, canLeave])

  const onPaintSettled = useCallback(() => setUnpainted(!paint), [paint])
  // Nothing to paint (no picture, it didn't load, or no painter): nothing to wait for either.
  const paintable = art.kind === 'video' && !hasRoom ? Boolean(source) : Boolean(still && paintPhoto)
  useEffect(() => {
    if (!paint && !paintable) setUnpainted(true)
  }, [paint, paintable])
  const fit = hasRoom ? 'cover' : 'contain'
  const ms = paint ? REPAINT_MS : UNPAINT_MS
  // A photo's painting is made during the dive (one pass on the museum's renderer) and shown
  // from the arrival on; a video is painted live, from the arrival on, so the dive stays smooth.
  const painted =
    art.kind === 'video' && !hasRoom
      ? stage !== 'diving' && <Painted source={source} fit={fit} painted={paint} ms={ms} onSettled={onPaintSettled} />
      : still && paintPhoto && <PaintedStill src={still} paint={paintPhoto} fit={fit} painted={paint} ms={ms} onSettled={onPaintSettled} />

  const showUi = stage === 'here' && settled && (!hasRoom || roomLive || Boolean(roomError))
  return (
    <div className={`stepin${hasRoom ? ' stepin-room' : ''}${stage === 'diving' ? ' waiting' : ''}`} role="dialog" aria-label={art.title || 'Picture'}>
      <div ref={world} className="stepin-world">
        {hasRoom ? (
          <>
            {/* Drawn from the arrival on, so the dive itself stays smooth. */}
            {ready && stage !== 'diving' && (
              <div className={`stepin-3d${roomLive ? ' live' : ''}`}>
                <Room assets={ready} startAt={art.t ?? 0} onReady={onRoomReady} onError={setSceneError} />
              </div>
            )}
            {/* The picture itself, standing in for the room until the room is ready. */}
            <div ref={cover} className={`stepin-cover${roomLive ? ' gone' : ''}`}>
              {still && <img src={still} alt="" draggable={false} />}
              {painted}
            </div>
          </>
        ) : (
          <>
            <div className="stepin-backdrop" style={still ? { backgroundImage: `url("${still}")` } : undefined} />
            <div className={`stepin-picture${art.kind === 'photo' ? ' drift' : ''}`}>
              {art.kind === 'photo' ? (
                <img className="stepin-full" src={art.src} alt={art.title ?? ''} draggable={false} />
              ) : (
                <video
                  ref={video}
                  className="stepin-full"
                  src={art.src}
                  poster={art.poster}
                  playsInline
                  loop
                  preload="auto"
                  onLoadedData={(e) => setSource(e.currentTarget)}
                  onClick={(e) => (e.currentTarget.paused ? void e.currentTarget.play() : e.currentTarget.pause())}
                />
              )}
              {painted}
            </div>
          </>
        )}
      </div>
      <div className={`stepin-ui${showUi ? ' shown' : ''}`}>
        {canLeave && (
          <button className="stepin-back" onClick={onBack}>
            <span aria-hidden="true">‹</span> Museum
          </button>
        )}
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

/**
 * A visit's 3D room behind its picture: says when it's ready to be seen (or why it can't be),
 * so the picture can give way to it.
 */
function Room({ assets, startAt, onReady, onError }: { assets: CaptureAssets; startAt: number; onReady: () => void; onError: (message: string) => void }) {
  const scene = useCaptureScene(assets)
  const status = scene.status as string
  const message = scene.status === 'error' ? scene.message : status === 'processing' ? 'This visit is still being prepared. Its room will be here soon.' : null
  useEffect(() => {
    if (status === 'ready') onReady()
    else if (message) onError(message)
  }, [status, message, onReady, onError])
  if (status !== 'ready') return null
  return (
    <SceneViewer assets={assets} initialMode="follow" startAt={startAt} showVideo={false} overlay={(controls) => <VisitDock captureId={assets.id} controls={controls} />} />
  )
}
