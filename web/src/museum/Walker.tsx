import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import * as THREE from 'three'
import { route, slide, walkable, type MuseumPlan } from './layout'

/** Eye height of a visitor (m). */
export const EYE = 1.62
const WALK = 1.5
const RUN = 3.2
/**
 * Guided walks glide: they speed up gently, keep an unhurried pace (m/s), and slow down well
 * before the stop (accelerations in m/s²), and the view turns softly (a rate per second; higher
 * is quicker).
 */
const GUIDED_PACE = 1.15
const ACCEL = 0.8
const DECEL = 0.6
const TURN = 1.8
/** Within this distance of the stop, the view turns from the way ahead to the picture (m). */
const TURN_IN = 2.4

export interface WalkerHandle {
  /** Walks to (x, z), through doorways as needed; then looks at `look` if given. */
  walkTo: (to: [number, number], look?: [number, number, number]) => void
  /** Where the visitor stands now (x, z). */
  position: () => [number, number]
}

const euler = new THREE.Euler()

/** Shortest signed angle from a to b. */
const turnBy = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a))
const smoothstep = (t: number) => {
  const k = Math.min(1, Math.max(0, t))
  return k * k * (3 - 2 * k)
}

/**
 * Walking through the museum on foot, at eye height, never through a wall.
 * - Drag (mouse or finger) to look around.
 * - W A S D or the arrow keys to walk (Shift to walk faster).
 * - Guided walks (tap a picture or the floor, or Next / Previous) follow a route through the
 *   doorways and end facing the picture.
 * Whenever the visitor isn't on a guided walk, `onLook` reports which of the first `hung` slots
 * they're looking at (−1: none), so its label can show without pressing anything.
 */
export function Walker({
  plan,
  onArrive,
  onLook,
  onReady,
  hung = 0,
  ref,
  frozen = false,
}: {
  frozen?: boolean
  plan: MuseumPlan
  onArrive?: () => void
  onLook?: (slot: number) => void
  /**
   * The walker stands at the entrance, ready to take walks: once mounted, and again after every
   * new plan. A walk asked for before then (`ref` not set yet) is given again here.
   */
  onReady?: () => void
  hung?: number
  ref?: Ref<WalkerHandle>
}) {
  const { camera, gl, invalidate } = useThree()
  const pos = useRef<[number, number]>([plan.start[0], plan.start[1]])
  const yaw = useRef(0)
  const pitch = useRef(-0.02)
  const path = useRef<[number, number][]>([])
  const lookGoal = useRef<{ yaw: number; pitch: number } | null>(null)
  const keys = useRef(new Set<string>())
  const speed = useRef(0)
  const arrive = useRef(onArrive)
  const look = useRef(onLook)
  const ready = useRef(onReady)
  useEffect(() => {
    arrive.current = onArrive
    look.current = onLook
    ready.current = onReady
  }, [onArrive, onLook, onReady])
  const lookedAt = useRef(-2)
  const frozenRef = useRef(frozen)
  useEffect(() => {
    frozenRef.current = frozen
    if (frozen) keys.current.clear()
  }, [frozen])
  const lookTimer = useRef(0)

  // A new museum (another exhibition or style): start again at the entrance.
  useEffect(() => {
    pos.current = [plan.start[0], plan.start[1]]
    yaw.current = 0
    pitch.current = -0.02
    path.current = []
    lookGoal.current = null
    speed.current = 0
    lookedAt.current = -2
    ready.current?.()
  }, [plan])

  useImperativeHandle(ref, () => ({
    walkTo(to, target) {
      path.current = route(plan, pos.current, to)
      invalidate()
      if (target) {
        const dx = target[0] - to[0]
        const dz = target[2] - to[1]
        lookGoal.current = { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(target[1] - EYE, Math.hypot(dx, dz)) }
      } else lookGoal.current = null
    },
    position: () => [pos.current[0], pos.current[1]],
  }))
  // The museum draws on demand: a new route needs a first frame to start walking.
  useEffect(() => invalidate(), [plan, invalidate])

  // Drag to look.
  useEffect(() => {
    const el = gl.domElement
    let last: { x: number; y: number } | null = null
    const down = (e: PointerEvent) => {
      last = { x: e.clientX, y: e.clientY }
    }
    const move = (e: PointerEvent) => {
      if (!last) return
      const dx = e.clientX - last.x
      const dy = e.clientY - last.y
      last = { x: e.clientX, y: e.clientY }
      // Finger and mouse both "grab" the view: drag left, the room turns left.
      const k = e.pointerType === 'touch' ? 0.006 : 0.0045
      yaw.current += dx * k
      pitch.current = Math.max(-0.7, Math.min(0.6, pitch.current + dy * k))
      // Looking around by hand takes over from a guided turn.
      if (Math.abs(dx) + Math.abs(dy) > 2) lookGoal.current = null
      invalidate()
    }
    const up = () => {
      last = null
    }
    el.addEventListener('pointerdown', down)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      el.removeEventListener('pointerdown', down)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [gl, invalidate])

  useEffect(() => {
    const typing = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')
    }
    const down = (e: KeyboardEvent) => {
      if (typing(e) || frozenRef.current) return
      keys.current.add(e.code)
      if (e.code.startsWith('Arrow')) e.preventDefault()
      invalidate()
    }
    const up = (e: KeyboardEvent) => keys.current.delete(e.code)
    const blur = () => keys.current.clear()
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [invalidate])

  useFrame((_, dt) => {
    // Stepped into a picture: the dive has the camera.
    if (frozenRef.current) return
    const step = Math.min(dt, 0.05)
    const k = keys.current
    const fwd = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0)
    const strafe = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0)
    const turn = (k.has('ArrowLeft') ? 1 : 0) - (k.has('ArrowRight') ? 1 : 0)
    if (fwd || strafe || turn) {
      // Walking by hand cancels a guided walk.
      path.current = []
      lookGoal.current = null
      yaw.current += turn * 1.8 * step
      const speed = (k.has('ShiftLeft') || k.has('ShiftRight') ? RUN : WALK) * step
      const sin = Math.sin(yaw.current)
      const cos = Math.cos(yaw.current)
      // Forward is −z when yaw is 0.
      const dx = (-sin * fwd + cos * strafe) * speed
      const dz = (-cos * fwd - sin * strafe) * speed
      pos.current = slide(plan, pos.current, [pos.current[0] + dx, pos.current[1] + dz])
    } else if (path.current.length > 0) {
      // Speed: build up gently, and start slowing early enough to come to rest at the stop.
      let remaining = 0
      let from = pos.current
      for (const p of path.current) {
        remaining += Math.hypot(p[0] - from[0], p[1] - from[1])
        from = p
      }
      const pace = GUIDED_PACE
      const target = Math.min(pace, Math.sqrt(2 * DECEL * remaining) + 0.05)
      speed.current += Math.max(-DECEL * 2 * step, Math.min(ACCEL * step, target - speed.current))
      let travel = speed.current * step
      let heading = yaw.current
      while (travel > 0 && path.current.length > 0) {
        const [tx, tz] = path.current[0]
        const dx = tx - pos.current[0]
        const dz = tz - pos.current[1]
        const dist = Math.hypot(dx, dz)
        if (dist > 1e-4) heading = Math.atan2(-dx, -dz)
        if (dist <= travel) {
          pos.current = [tx, tz]
          path.current.shift()
          travel -= dist
        } else {
          pos.current = [pos.current[0] + (dx / dist) * travel, pos.current[1] + (dz / dist) * travel]
          travel = 0
        }
      }
      // Look the way you're walking, turning toward the picture over the last few meters.
      let wantYaw = heading
      let wantPitch = -0.02
      if (lookGoal.current) {
        const w = smoothstep((TURN_IN - remaining) / (TURN_IN - 0.3))
        wantYaw = heading + turnBy(heading, lookGoal.current.yaw) * w
        wantPitch = lookGoal.current.pitch * w
      }
      const ease = 1 - Math.exp(-TURN * step)
      yaw.current += turnBy(yaw.current, wantYaw) * ease
      pitch.current += (wantPitch - pitch.current) * ease
      if (path.current.length === 0) {
        speed.current = 0
        if (!lookGoal.current) arrive.current?.()
      }
    } else if (lookGoal.current) {
      // At the stop: finish turning to the picture, softly.
      const g = lookGoal.current
      const ease = 1 - Math.exp(-TURN * step)
      const dy = turnBy(yaw.current, g.yaw)
      const dp = g.pitch - pitch.current
      yaw.current += dy * ease
      pitch.current += dp * ease
      if (Math.abs(dy) < 0.02 && Math.abs(dp) < 0.02) {
        lookGoal.current = null
        arrive.current?.()
      }
    }
    // What the visitor is looking at, a few times a second, when not on a guided walk.
    lookTimer.current += step
    if (lookTimer.current > 0.2 && path.current.length === 0 && !lookGoal.current && look.current) {
      lookTimer.current = 0
      const seen = facing(plan, hung, pos.current, yaw.current, pitch.current)
      if (seen !== lookedAt.current) {
        lookedAt.current = seen
        look.current(seen)
      }
    }
    // Stay out of the walls even if something went wrong.
    if (!walkable(plan, pos.current[0], pos.current[1])) pos.current = [plan.start[0], plan.start[1]]
    camera.position.set(pos.current[0], EYE, pos.current[1])
    camera.quaternion.setFromEuler(euler.set(pitch.current, yaw.current, 0, 'YXZ'))
    // Keep drawing while walking or turning; otherwise the museum rests until something changes.
    if (k.size > 0 || path.current.length > 0 || lookGoal.current) invalidate()
  })

  return null
}

/**
 * The hung slot the visitor is looking at from (x, z) with this yaw and pitch: the nearest one
 * within 6 m, in front of its wall, closest to the middle of the view (within about 18°). −1 if
 * none.
 */
export function facing(plan: MuseumPlan, hung: number, at: [number, number], yaw: number, pitch: number): number {
  const fx = -Math.sin(yaw) * Math.cos(pitch)
  const fy = Math.sin(pitch)
  const fz = -Math.cos(yaw) * Math.cos(pitch)
  let best = -1
  let bestAngle = 0.32
  for (const s of plan.slots.slice(0, hung)) {
    const vx = s.center[0] - at[0]
    const vy = s.center[1] - EYE
    const vz = s.center[2] - at[1]
    const dist = Math.hypot(vx, vy, vz)
    if (dist > 6 || dist < 0.3) continue
    // On the room side of the picture's wall.
    if (-(vx * s.normal[0] + vz * s.normal[1]) < 0.3) continue
    const angle = Math.acos(Math.min(1, (vx * fx + vy * fy + vz * fz) / dist))
    if (angle < bestAngle) {
      bestAngle = angle
      best = s.index
    }
  }
  return best
}
