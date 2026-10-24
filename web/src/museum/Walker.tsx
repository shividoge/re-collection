import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import * as THREE from 'three'
import { route, slide, walkable, type MuseumPlan } from './layout'

/** Eye height of a visitor (m). */
export const EYE = 1.62
const WALK = 1.5
const RUN = 3.2
/** How fast a guided walk goes (m/s), and how fast the view turns toward its goal. */
const GUIDED = 2.1
const TURN = 3.5

export interface WalkerHandle {
  /** Walks to (x, z), through doorways as needed; then looks at `look` if given. */
  walkTo: (to: [number, number], look?: [number, number, number]) => void
  /** Where the visitor stands now (x, z). */
  position: () => [number, number]
}

/** Shortest signed angle from a to b. */
const turnBy = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a))

/**
 * Walking through the museum on foot, at eye height, never through a wall.
 * - Drag (mouse or finger) to look around.
 * - W A S D or the arrow keys to walk (Shift to walk faster).
 * - Guided walks (tap a picture or the floor, or Next / Previous) follow a route through the
 *   doorways and end facing the picture.
 * With `guided` (the calm room) there is no free walking at all: only slow, gentle guided
 * walks, and a softer drag to look, since sudden or self-steered movement in a 3D view is what
 * makes people dizzy and lost.
 */
export function Walker({ plan, onArrive, ref, guided = false }: { plan: MuseumPlan; onArrive?: () => void; ref?: Ref<WalkerHandle>; guided?: boolean }) {
  const { camera, gl } = useThree()
  const pos = useRef<[number, number]>([plan.start[0], plan.start[1]])
  const yaw = useRef(0)
  const pitch = useRef(-0.02)
  const path = useRef<[number, number][]>([])
  const lookGoal = useRef<{ yaw: number; pitch: number } | null>(null)
  const keys = useRef(new Set<string>())
  const arrive = useRef(onArrive)
  useEffect(() => {
    arrive.current = onArrive
  }, [onArrive])

  // A new museum (another exhibition or style): start again at the entrance.
  useEffect(() => {
    pos.current = [plan.start[0], plan.start[1]]
    yaw.current = 0
    pitch.current = -0.02
    path.current = []
    lookGoal.current = null
  }, [plan])

  useImperativeHandle(ref, () => ({
    walkTo(to, look) {
      path.current = route(plan, pos.current, to)
      if (look) {
        const dx = look[0] - to[0]
        const dz = look[2] - to[1]
        lookGoal.current = { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(look[1] - EYE, Math.hypot(dx, dz)) }
      } else lookGoal.current = null
    },
    position: () => [pos.current[0], pos.current[1]],
  }))

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
      const k = (e.pointerType === 'touch' ? 0.006 : 0.0045) * (guided ? 0.6 : 1)
      yaw.current += dx * k
      pitch.current = Math.max(-0.7, Math.min(0.6, pitch.current + dy * k))
      // Looking around by hand takes over from a guided turn.
      if (Math.abs(dx) + Math.abs(dy) > 2) lookGoal.current = null
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
  }, [gl, guided])

  useEffect(() => {
    const typing = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')
    }
    const down = (e: KeyboardEvent) => {
      if (typing(e) || guided) return
      keys.current.add(e.code)
      if (e.code.startsWith('Arrow')) e.preventDefault()
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
  }, [guided])

  useFrame((_, dt) => {
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
      const [tx, tz] = path.current[0]
      const dx = tx - pos.current[0]
      const dz = tz - pos.current[1]
      const dist = Math.hypot(dx, dz)
      const last = path.current.length === 1
      // Ease in to the last stop; keep pace through doorways. The calm room goes slower.
      const speed = GUIDED * (guided ? 0.55 : 1) * (last ? Math.min(1, 0.35 + dist / 1.2) : 1) * step
      if (dist <= speed) {
        pos.current = [tx, tz]
        path.current.shift()
        if (path.current.length === 0 && !lookGoal.current) arrive.current?.()
      } else {
        pos.current = [pos.current[0] + (dx / dist) * speed, pos.current[1] + (dz / dist) * speed]
        // Face the way you're walking until the last stretch, then the picture.
        if (!last || !lookGoal.current) yaw.current += turnBy(yaw.current, Math.atan2(-dx, -dz)) * Math.min(1, TURN * (guided ? 0.5 : 1) * step)
      }
    }
    if (lookGoal.current && path.current.length <= 1) {
      const g = lookGoal.current
      const dy = turnBy(yaw.current, g.yaw)
      const dp = g.pitch - pitch.current
      const turnRate = TURN * (guided ? 0.5 : 1)
      yaw.current += dy * Math.min(1, turnRate * step)
      pitch.current += dp * Math.min(1, turnRate * step)
      if (path.current.length === 0 && Math.abs(dy) < 0.01 && Math.abs(dp) < 0.01) {
        lookGoal.current = null
        arrive.current?.()
      }
    }
    // Stay out of the walls even if something went wrong.
    if (!walkable(plan, pos.current[0], pos.current[1])) pos.current = [plan.start[0], plan.start[1]]
    camera.position.set(pos.current[0], EYE, pos.current[1])
    camera.quaternion.setFromEuler(new THREE.Euler(pitch.current, yaw.current, 0, 'YXZ'))
  })

  return null
}
