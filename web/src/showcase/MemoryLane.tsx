import { Environment, Lightformer } from '@react-three/drei'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { EffectComposer, SMAA, ToneMapping, Vignette } from '@react-three/postprocessing'
import { ToneMappingMode } from 'postprocessing'
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import * as THREE from 'three'
import type { PublicCapture } from '../api'
import { Artwork } from '../museum/Artwork'
import { Furniture, Sconces, Window } from '../museum/Classic'
import type { Artwork as Art } from '../museum/exhibitions'
import { fitPicture, planMuseum, route, type MuseumPlan } from '../museum/layout'
import { LOOK } from '../museum/looks'
import { Rooms } from '../museum/Rooms'
import { EYE } from '../museum/Walker'
import { coverDistance } from '../museum/warp'
import { HeroCloud } from './Scenes'

const FOV = 58
/** Of each stretch of scroll between two pictures: the walk, then a pause in front of the picture. */
const WALK = 0.62
/** Seconds per picture when the tour plays by itself (for a smooth screen recording). */
const TOUR_SECONDS_PER_STOP = 3.6
/** Scroll kept after the dive, in picture-stretches: time inside the scan before the page moves on. */
const HOLD = 1.2

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const clamp01 = (t: number) => Math.min(1, Math.max(0, t))

type Stop = { path: [number, number][]; lengths: number[]; total: number; pos: THREE.Vector3; quat: THREE.Quaternion }

const aim = new THREE.PerspectiveCamera()
function lookQuat(from: THREE.Vector3, at: THREE.Vector3): THREE.Quaternion {
  aim.position.copy(from)
  aim.lookAt(at)
  return aim.quaternion.clone()
}

/**
 * The camera's route: from the entrance to each picture in turn (around furniture, through
 * doorways), then a last push right up to the final picture, close enough that it fills the view.
 */
function planStops(plan: MuseumPlan, count: number, sizes: { w: number; h: number }[], aspect: number): Stop[] {
  const stops: Stop[] = []
  let from: [number, number] = plan.start
  let lastPos = new THREE.Vector3(plan.start[0], EYE, plan.start[1])
  const firstLook = new THREE.Vector3(plan.start[0], EYE, plan.start[1] - 6)
  stops.push({ path: [from, from], lengths: [0, 0], total: 0, pos: lastPos, quat: lookQuat(lastPos, firstLook) })
  for (let i = 0; i < count; i++) {
    const slot = plan.slots[i]
    const to = slot.view
    const path = route(plan, from, to)
    const pts: [number, number][] = [from, ...path.filter((p, k) => k > 0 || p[0] !== from[0] || p[1] !== from[1])]
    if (pts[pts.length - 1][0] !== to[0] || pts[pts.length - 1][1] !== to[1]) pts.push(to)
    const lengths = [0]
    for (let k = 1; k < pts.length; k++) lengths.push(lengths[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]))
    const pos = new THREE.Vector3(to[0], EYE, to[1])
    const center = new THREE.Vector3(...slot.center)
    stops.push({ path: pts, lengths, total: lengths[lengths.length - 1], pos, quat: lookQuat(pos, center) })
    from = to
    lastPos = pos
  }
  // The push into the last picture.
  const last = plan.slots[count - 1]
  if (last) {
    const { w, h } = sizes[count - 1] ?? fitPicture(last, 4 / 3)
    const d = coverDistance(w, h, aspect, FOV) * 0.92
    const center = new THREE.Vector3(...last.center)
    const pos = new THREE.Vector3(last.center[0] + last.normal[0] * d, last.center[1], last.center[2] + last.normal[1] * d)
    const a: [number, number] = [lastPos.x, lastPos.z]
    const b: [number, number] = [pos.x, pos.z]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    stops.push({ path: [a, b], lengths: [0, len], total: len, pos, quat: lookQuat(pos, center) })
  }
  return stops
}

function along(stop: Stop, u: number): [number, number] {
  if (stop.total === 0) return stop.path[stop.path.length - 1]
  const s = u * stop.total
  let k = 1
  while (k < stop.lengths.length - 1 && stop.lengths[k] < s) k++
  const seg = stop.lengths[k] - stop.lengths[k - 1] || 1
  const f = clamp01((s - stop.lengths[k - 1]) / seg)
  const a = stop.path[k - 1]
  const b = stop.path[k]
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]
}

/** Where the scroll puts the camera: progress 0 is the entrance, 1 is inside the last picture. */
function ScrollCamera({ stops, progress }: { stops: Stop[]; progress: MutableRefObject<number> }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const smoothed = useRef(0)
  const q = useMemo(() => new THREE.Quaternion(), [])
  useFrame((_, dt) => {
    // A little inertia so a mouse wheel's steps still read as walking.
    smoothed.current += (progress.current - smoothed.current) * (1 - Math.exp(-Math.min(dt, 0.1) * 6))
    const segments = stops.length - 1
    if (segments <= 0) return
    const x = clamp01(smoothed.current) * segments
    const k = Math.min(segments - 1, Math.floor(x))
    const local = x - k
    const final = k === segments - 1
    const u = final ? ease(local) : ease(clamp01(local / WALK))
    const target = stops[k + 1]
    const [px, pz] = along(target, u)
    const y = final ? stops[k].pos.y + (target.pos.y - stops[k].pos.y) * u : EYE
    camera.position.set(px, y, pz)
    // Turn toward the next picture early in the walk, so it reads as looking for it.
    q.copy(stops[k].quat).slerp(target.quat, ease(clamp01(u * 1.6)))
    camera.quaternion.copy(q)
  })
  return null
}

/** The element that scrolls this page (the app's body pane, or the window). */
function scrollerOf(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight) return p
  }
  return null
}
const viewTop = (s: HTMLElement | null) => (s ? s.getBoundingClientRect().top : 0)
const viewHeight = (s: HTMLElement | null) => (s ? s.clientHeight : window.innerHeight)
const scrollTop = (s: HTMLElement | null) => (s ? s.scrollTop : window.scrollY)
const scrollToY = (s: HTMLElement | null, y: number) => (s ? (s.scrollTop = y) : window.scrollTo({ top: y, behavior: 'auto' }))

function hallItems(captures: PublicCapture[]): Art[] {
  return captures.map((c) => ({
    id: c.id,
    kind: 'photo' as const,
    src: c.thumbUrl ?? '',
    title: c.title || 'A visit',
    date: c.createdAt ? new Date(c.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '',
    captureId: c.id,
  }))
}

/**
 * "Scroll through her life": the front page's museum. Each public moment hangs as a framed
 * picture in the classic gallery, oldest first. Scrolling walks the camera down the hall from
 * picture to picture, and at the end it pushes into the last picture until the picture becomes
 * that visit's real 3D scan. "Play the tour" scrolls it by itself at an even pace, so the walk
 * can be screen-recorded in one smooth take.
 */
export default function MemoryLane({ captures, diveId }: { captures: PublicCapture[]; diveId?: string }) {
  // Oldest first; the visit the page goes on to explain hangs last, so the walk ends by diving into it.
  const moments = useMemo(() => {
    const sorted = captures.filter((c) => c.thumbUrl).sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
    const k = sorted.findIndex((c) => c.id === diveId)
    return k >= 0 ? [...sorted.slice(0, k), ...sorted.slice(k + 1), sorted[k]] : sorted
  }, [captures, diveId])
  const items = useMemo(() => hallItems(moments), [moments])
  const plan = useMemo(() => planMuseum(items.length), [items.length])
  const look = LOOK
  const [sizes, setSizes] = useState<{ w: number; h: number }[]>([])
  const onMeasure = useCallback((slot: number, w: number, h: number) => {
    setSizes((prev) => {
      if (prev[slot]?.w === w && prev[slot]?.h === h) return prev
      const next = prev.slice()
      next[slot] = { w, h }
      return next
    })
  }, [])

  const sectionRef = useRef<HTMLElement | null>(null)
  const progress = useRef(0)
  const [shown, setShown] = useState(0)
  const [visible, setVisible] = useState(false)
  const [aspect, setAspect] = useState(16 / 9)
  const stops = useMemo(() => planStops(plan, items.length, sizes, aspect), [plan, items.length, sizes, aspect])
  const segments = stops.length - 1
  const segmentsRef = useRef(segments)
  segmentsRef.current = segments

  // Scroll position → progress through the hall.
  useEffect(() => {
    let frame = 0
    const scroller = scrollerOf(sectionRef.current)
    const target: HTMLElement | Window = scroller ?? window
    const read = () => {
      frame = 0
      const el = sectionRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const p = clamp01(-(rect.top - viewTop(scroller)) / Math.max(1, rect.height - viewHeight(scroller)))
      // The camera reaches the inside of the picture before the end; the rest is time inside the scan.
      const n = Math.max(1, segmentsRef.current)
      progress.current = clamp01((p * (n + HOLD)) / n)
      setShown(p)
      // Only draw while the hall is on screen (with a margin, so it's ready as it scrolls in).
      const top = viewTop(scroller)
      setVisible(rect.bottom > top - 300 && rect.top < top + viewHeight(scroller) + 300)
      setAspect(window.innerWidth / Math.max(1, window.innerHeight))
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read)
    }
    read()
    target.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      target.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])

  // The tour: scroll through the section at an even pace; any wheel, touch or key stops it.
  const [touring, setTouring] = useState(false)
  const tour = useRef<{ stop: () => void } | null>(null)
  const playTour = useCallback(() => {
    const el = sectionRef.current
    if (!el) return
    const scroller = scrollerOf(el)
    const top = el.getBoundingClientRect().top - viewTop(scroller) + scrollTop(scroller)
    const span = el.offsetHeight - viewHeight(scroller)
    const duration = Math.max(8, segments * TOUR_SECONDS_PER_STOP) * 1000
    scrollToY(scroller, top)
    let raf = 0
    const start = performance.now() + 900 // a beat at the entrance first
    const step = (now: number) => {
      const t = clamp01((now - start) / duration)
      scrollToY(scroller, top + span * t)
      if (t < 1) raf = requestAnimationFrame(step)
      else raf = requestAnimationFrame(onward)
    }
    // Then carry on, gently, into "How it works", so one recording runs from the hall to the explanation.
    const end = top + span
    const onwardFrom = performance.now() + duration + 900
    const onward = (now: number) => {
      const t = clamp01((now - onwardFrom) / 2600)
      scrollToY(scroller, end + viewHeight(scroller) * ease(t))
      if (t < 1) raf = requestAnimationFrame(onward)
      else stop()
    }
    const stop = () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('wheel', stop)
      window.removeEventListener('touchstart', stop)
      window.removeEventListener('keydown', stop)
      tour.current = null
      setTouring(false)
    }
    tour.current?.stop()
    tour.current = { stop }
    setTouring(true)
    raf = requestAnimationFrame(step)
    window.addEventListener('wheel', stop, { passive: true })
    window.addEventListener('touchstart', stop, { passive: true })
    window.addEventListener('keydown', stop)
  }, [segments])
  useEffect(() => () => tour.current?.stop(), [])

  if (items.length === 0) return null

  // Which picture the visitor is standing at, and how far into the last push they are.
  const x = shown * (segments + HOLD)
  const at = Math.min(items.length - 1, Math.max(-1, Math.floor(x + (1 - WALK)) - 1))
  const arrived = at >= 0 && x - (at + 1) + 1 >= WALK - 0.05
  const push = clamp01(x - (segments - 1))
  const reveal = clamp01((push - 0.55) / 0.35)
  const after = clamp01(x - segments) // 0 → 1 while staying inside the scan
  const last = moments[moments.length - 1]
  const current = at >= 0 ? moments[at] : null

  return (
    <section id="lane" ref={sectionRef} className="lane" style={{ height: `${(segments + HOLD + 1) * 85 + 40}vh` }}>
      <div className="lane-sticky">
        <Canvas
          className="lane-canvas"
          frameloop={visible ? 'always' : 'never'}
          dpr={[1, 1.5]}
          camera={{ fov: FOV, near: 0.05, far: 120, position: [plan.start[0], EYE, plan.start[1]] }}
          gl={{ antialias: false, powerPreference: 'high-performance', stencil: false }}
        >
          <color attach="background" args={[look.background]} />
          <Environment resolution={128} frames={1} environmentIntensity={0.55}>
            <color attach="background" args={[look.background]} />
            {plan.rooms.map((r, i) => (
              <Lightformer key={i} form="rect" intensity={2.4} color={look.light} position={[0, plan.spec.height, (r.zFront + r.zBack) / 2]} rotation-x={Math.PI / 2} scale={[plan.spec.width * 0.5, plan.spec.depth * 0.6, 1]} />
            ))}
          </Environment>
          <Rooms plan={plan} look={look} title="Her life, in moments" subtitle="Oldest first" reflections={512} />
          {plan.features.length > 0 && (
            <>
              <Furniture plan={plan} />
              <Sconces plan={plan} count={items.length} />
              <Window plan={plan} />
            </>
          )}
          {items.map((art, i) => (plan.slots[i] ? <Artwork key={art.id} art={art} slot={plan.slots[i]} look={look} focused={i === at} onSelect={() => {}} onMeasure={onMeasure} /> : null))}
          <ScrollCamera stops={stops} progress={progress} />
          <EffectComposer multisampling={0} enableNormalPass={false}>
            <SMAA />
            <Vignette offset={0.32} darkness={0.42} />
            <ToneMapping mode={ToneMappingMode.NEUTRAL} />
          </EffectComposer>
        </Canvas>

        <div className="lane-copy" style={{ opacity: 1 - clamp01(shown * segments * 1.5) }}>
          <p className="eyebrow">The Memory Museum</p>
          <h2>Scroll through her life.</h2>
          <p className="muted">Every visit the family shares hangs here as a picture, oldest first. Keep scrolling to walk the hall, and step into the last one.</p>
        </div>

        {current && push < 0.4 && (
          <div className={`lane-label ${arrived ? 'on' : ''}`} key={current.id}>
            <span className="lane-n">
              {at + 1} / {moments.length}
            </span>
            <strong>{current.title || 'A visit'}</strong>
            {current.createdAt && <span className="muted">{new Date(current.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}</span>}
          </div>
        )}

        {last && push > 0.4 && (
          <div className="lane-end" style={{ opacity: reveal, pointerEvents: reveal > 0.9 ? 'auto' : 'none' }}>
            {reveal > 0 && <HeroCloud id={last.id} />}
            <div className="lane-end-copy" style={{ opacity: clamp01(reveal * 2 - 1 + after), transform: `translateY(${(1 - Math.min(1, reveal + after)) * 16}px)` }}>
              <p className="eyebrow">You just stepped inside</p>
              <h2>{last.title || 'A visit'}</h2>
              <p className="muted">That picture was a doorway. This is the real room it came from, rebuilt in 3D from one visit. Here's how it gets here.</p>
              <div className="lane-end-actions">
                <a className="cta" href="#how">
                  How it works ↓
                </a>
                <a className="ghost" href={`#/p/${last.id}`}>
                  Walk around in it
                </a>
              </div>
            </div>
          </div>
        )}

        <button className="lane-tour" onClick={() => (touring ? tour.current?.stop() : playTour())}>
          {touring ? 'Stop the tour' : '▶ Play the tour'}
        </button>
        <div className="lane-progress" aria-hidden>
          <span style={{ transform: `scaleX(${shown})` }} />
        </div>
      </div>
    </section>
  )
}
