import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject } from 'react'
import * as THREE from 'three'
import type { Vec3 } from './pose'

export type NavMode = 'orbit' | 'fly' | 'follow'

export interface CameraGoal {
  position: Vec3
  lookAt: Vec3
}

const isTyping = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
}

/** Keys currently held, ignoring keystrokes meant for text fields. */
function useHeldKeys() {
  const keys = useRef(new Set<string>())
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey) return
      keys.current.add(e.code)
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault()
    }
    const up = (e: KeyboardEvent) => keys.current.delete(e.code)
    const clear = () => keys.current.clear()
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', clear)
    }
  }, [])
  return keys
}

const STEER_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']
/** Cursor within this many px of the window edge counts as pinned there. */
const EDGE_PX = 2
/** When the cursor leaves the window, edges within this many px of the closest one count too. */
const LEAVE_PX = 40
/** Turn speed range (rad/s) while pinned at an edge. */
const EDGE_MIN_SPEED = 1.2
const EDGE_MAX_SPEED = 8

/**
 * Drone flying with two mouse behaviors.
 * Idle (no movement key held): dragging grabs the room and turns it around you; the scene
 * follows the cursor on both axes.
 * While W/A/S/D (or arrows) is held: the mouse steers your head like CS2, no button needed
 * (right looks right, up looks up), and W flies wherever you're looking.
 * E up, Q/C down, Shift faster, Alt slower, wheel pushes forward. (Space is play/pause.)
 */
export function FlyControls({ goalActive, onSteeringChange }: { goalActive: MutableRefObject<boolean>; onSteeringChange?: (steering: boolean) => void }) {
  const camera = useThree((s) => s.camera)
  const dom = useThree((s) => s.gl.domElement)
  const keys = useHeldKeys()
  const look = useMemo(() => new THREE.Euler(0, 0, 0, 'YXZ'), [])
  const wheel = useRef(0)
  const steering = useRef(false)
  // Where the cursor is pinned while steering without pointer lock: -1/1 = left/right (top/bottom)
  // screen edge, 0 = not at an edge. vx/vy are recent turn speeds (rad/s) to keep turning at.
  const edge = useRef({ x: 0, y: 0, vx: 0, vy: 0, lastT: 0 })

  // Start from wherever the camera is looking. This must run before the first useFrame,
  // which would otherwise overwrite the camera with the zero Euler; a passive effect is too late.
  useLayoutEffect(() => {
    look.setFromQuaternion(camera.quaternion, 'YXZ')
    look.z = 0
  }, [camera, look])

  useEffect(() => {
    // Turn speed in "field of view per pixel": 1 would move the room exactly as far as the
    // cursor; 1:1 felt too slow, so steering and dragging both run faster than the cursor.
    const STEER_GAIN = 3
    const DRAG_GAIN = 2
    const radPerPx = () => THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov || 60) / Math.max(1, dom.clientHeight)
    let dragging = false
    let lastX: number | null = null
    let lastY = 0
    const onDown = (e: PointerEvent) => {
      if (e.button === 0) dragging = true
    }
    const locked = () => document.pointerLockElement === dom
    const onMove = (e: PointerEvent) => {
      let dx: number
      let dy: number
      if (locked()) {
        // The cursor is captured and hidden, so it never hits the screen edge; only the
        // raw motion is available.
        dx = e.movementX
        dy = e.movementY
        lastX = null
      } else {
        // Screen-position deltas; unlocked movementX is scaled inconsistently on HiDPI.
        dx = lastX === null ? 0 : e.clientX - lastX
        dy = lastX === null ? 0 : e.clientY - lastY
        lastX = e.clientX
        lastY = e.clientY
      }
      if (goalActive.current) return
      const k = radPerPx()
      const held = STEER_KEYS.some((key) => keys.current.has(key))
      if (held && !locked()) {
        // Without pointer lock the cursor stops at the screen edge. Remember the turn speed and
        // whether it's pinned, so useFrame keeps turning that way (never stops at the edge).
        const ed = edge.current
        const now = performance.now()
        const dt = (now - ed.lastT) / 1000
        ed.lastT = now
        if (dt > 0 && dt < 0.25) {
          if (dx !== 0) ed.vx = 0.6 * ed.vx + 0.4 * (Math.abs(dx) * k * STEER_GAIN) / dt
          if (dy !== 0) ed.vy = 0.6 * ed.vy + 0.4 * (Math.abs(dy) * k * STEER_GAIN) / dt
        }
        ed.x = e.clientX <= EDGE_PX ? -1 : e.clientX >= window.innerWidth - 1 - EDGE_PX ? 1 : 0
        ed.y = e.clientY <= EDGE_PX ? -1 : e.clientY >= window.innerHeight - 1 - EDGE_PX ? 1 : 0
      }
      if (held) {
        // Steering: the head turns toward the mouse (right looks right, up looks up).
        look.y -= dx * k * STEER_GAIN
        look.x = THREE.MathUtils.clamp(look.x - dy * k * STEER_GAIN, -1.55, 1.55)
      } else if (dragging) {
        // Dragging grabs the room: it follows the cursor.
        look.y += dx * k * DRAG_GAIN
        look.x = THREE.MathUtils.clamp(look.x + dy * k * DRAG_GAIN, -1.55, 1.55)
      }
    }
    const onUp = () => (dragging = false)
    // The cursor left the window while steering: treat it as pinned at the edge it crossed.
    const onOut = (e: MouseEvent) => {
      if (e.relatedTarget || locked() || lastX === null || !STEER_KEYS.some((key) => keys.current.has(key))) return
      const ed = edge.current
      const w = window.innerWidth
      const h = window.innerHeight
      const near = Math.min(lastX, w - lastX, lastY, h - lastY) + LEAVE_PX
      ed.x = lastX <= near ? -1 : w - lastX <= near ? 1 : 0
      ed.y = lastY <= near ? -1 : h - lastY <= near ? 1 : 0
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      wheel.current += -e.deltaY
    }
    // Holding a movement key captures the mouse (hidden, unbounded, like a game); letting go
    // of all of them releases it. Where pointer lock is refused (e.g. embedded panes), the
    // cursor is hidden by CSS and edge-pinning above keeps the turn going.
    const onKeyDown = (e: KeyboardEvent) => {
      if (!STEER_KEYS.includes(e.code) || e.repeat || locked() || isTyping(e)) return
      try {
        const p = dom.requestPointerLock() as unknown as Promise<void> | undefined
        p?.catch?.(() => {})
      } catch {
        /* pointer lock unavailable */
      }
    }
    const onKeyUp = () => {
      if (locked() && !STEER_KEYS.some((key) => keys.current.has(key))) document.exitPointerLock()
    }
    const onBlur = () => {
      if (locked()) document.exitPointerLock()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    dom.addEventListener('pointerdown', onDown)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    document.addEventListener('mouseout', onOut)
    dom.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      document.removeEventListener('mouseout', onOut)
      dom.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      dom.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      if (locked()) document.exitPointerLock()
    }
  }, [camera, dom, look, goalActive, keys])

  useEffect(
    () => () => {
      onSteeringChange?.(false)
      document.documentElement.classList.remove('bd-steering')
    },
    [onSteeringChange],
  )

  const forward = useMemo(() => new THREE.Vector3(), [])
  const right = useMemo(() => new THREE.Vector3(), [])
  const move = useMemo(() => new THREE.Vector3(), [])

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.1)
    if (goalActive.current) {
      // A go-to animation owns the camera; pick up wherever it leaves us.
      look.setFromQuaternion(camera.quaternion, 'YXZ')
      look.z = 0
      wheel.current = 0
      return
    }
    const k = keys.current
    const nowSteering = STEER_KEYS.some((key) => k.has(key))
    if (nowSteering !== steering.current) {
      steering.current = nowSteering
      // Hide the cursor on the whole page while steering, not only over the 3D view.
      document.documentElement.classList.toggle('bd-steering', nowSteering)
      if (!nowSteering) Object.assign(edge.current, { x: 0, y: 0, vx: 0, vy: 0 })
      onSteeringChange?.(nowSteering)
    }
    const ed = edge.current
    if (nowSteering && (ed.x || ed.y) && document.pointerLockElement !== dom) {
      // Pinned at a screen edge: keep turning in that direction at the recent speed.
      const vx = THREE.MathUtils.clamp(ed.vx, EDGE_MIN_SPEED, EDGE_MAX_SPEED)
      const vy = THREE.MathUtils.clamp(ed.vy, EDGE_MIN_SPEED, EDGE_MAX_SPEED)
      look.y -= ed.x * vx * delta
      look.x = THREE.MathUtils.clamp(look.x - ed.y * vy * delta, -1.55, 1.55)
    }
    const speed = 2.0 * (k.has('ShiftLeft') || k.has('ShiftRight') ? 3 : 1) * (k.has('AltLeft') || k.has('AltRight') ? 0.25 : 1)

    camera.quaternion.setFromEuler(look)
    camera.getWorldDirection(forward)
    right.crossVectors(forward, camera.up).normalize()

    move.set(0, 0, 0)
    if (k.has('KeyW') || k.has('ArrowUp')) move.add(forward)
    if (k.has('KeyS') || k.has('ArrowDown')) move.sub(forward)
    if (k.has('KeyD') || k.has('ArrowRight')) move.add(right)
    if (k.has('KeyA') || k.has('ArrowLeft')) move.sub(right)
    if (k.has('KeyE')) move.y += 1
    if (k.has('KeyQ') || k.has('KeyC')) move.y -= 1
    if (move.lengthSq() > 0) camera.position.addScaledVector(move.normalize(), speed * delta)
    if (wheel.current !== 0) {
      camera.position.addScaledVector(forward, wheel.current * 0.0015 * speed)
      wheel.current = 0
    }
  })
  return null
}

/** Smoothly moves the camera to a goal, in any mode. Orbit controls re-center on the goal. */
export function CameraTween({ goal, active, onDone }: { goal: CameraGoal | null; active: MutableRefObject<boolean>; onDone: () => void }) {
  const camera = useThree((s) => s.camera)
  // Read controls fresh each frame: OrbitControls may mount in the same update as the goal.
  const get = useThree((s) => s.get)
  const state = useMemo(() => ({ fromPos: new THREE.Vector3(), fromLook: new THREE.Vector3(), t: 0, goal: null as CameraGoal | null }), [])
  const tmp = useMemo(() => ({ pos: new THREE.Vector3(), look: new THREE.Vector3(), to: new THREE.Vector3(), toLook: new THREE.Vector3() }), [])

  useEffect(() => {
    if (!goal) return
    state.goal = goal
    state.t = 0
    state.fromPos.copy(camera.position)
    const dir = camera.getWorldDirection(new THREE.Vector3())
    const dist = camera.position.distanceTo(new THREE.Vector3(...goal.lookAt))
    state.fromLook.copy(camera.position).addScaledVector(dir, dist)
    active.current = true
  }, [goal, camera, state, active])

  useFrame((_, delta) => {
    const g = state.goal
    if (!g) return
    state.t = Math.min(1, state.t + delta / 0.9)
    const e = state.t < 0.5 ? 4 * state.t ** 3 : 1 - (-2 * state.t + 2) ** 3 / 2
    tmp.to.set(...g.position)
    tmp.toLook.set(...g.lookAt)
    tmp.pos.lerpVectors(state.fromPos, tmp.to, e)
    tmp.look.lerpVectors(state.fromLook, tmp.toLook, e)
    camera.position.copy(tmp.pos)
    camera.lookAt(tmp.look)
    const controls = get().controls as unknown as { target: THREE.Vector3; enabled: boolean } | null
    if (controls?.target) {
      controls.target.copy(tmp.look)
      controls.enabled = state.t >= 1
    }
    if (state.t >= 1) {
      state.goal = null
      active.current = false
      onDone()
    }
  })
  return null
}

/** Reports clicks (not drags) on the canvas as world-space rays. */
export function PickHandler({ onPick }: { onPick: (origin: Vec3, dir: Vec3) => void }) {
  const camera = useThree((s) => s.camera)
  const dom = useThree((s) => s.gl.domElement)
  useEffect(() => {
    let sx = 0
    let sy = 0
    let down = false
    const raycaster = new THREE.Raycaster()
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      down = true
      sx = e.clientX
      sy = e.clientY
    }
    const onUp = (e: PointerEvent) => {
      if (!down || e.button !== 0) return
      down = false
      if (Math.hypot(e.clientX - sx, e.clientY - sy) > 5) return
      const r = dom.getBoundingClientRect()
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
      raycaster.setFromCamera(ndc, camera)
      const o = raycaster.ray.origin
      const d = raycaster.ray.direction
      onPick([o.x, o.y, o.z], [d.x, d.y, d.z])
    }
    dom.addEventListener('pointerdown', onDown)
    window.addEventListener('pointerup', onUp)
    return () => {
      dom.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointerup', onUp)
    }
  }, [camera, dom, onPick])
  return null
}

/** A small marker on the orbit pivot, kept the same size on screen. */
export function PivotMarker() {
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3 } | null
  const camera = useThree((s) => s.camera)
  const ref = useRef<THREE.Group>(null)
  useFrame(() => {
    const g = ref.current
    if (!g || !controls?.target) return
    g.position.copy(controls.target)
    g.scale.setScalar(Math.max(0.002, camera.position.distanceTo(controls.target) * 0.012))
    g.quaternion.copy(camera.quaternion)
  })
  return (
    <group ref={ref}>
      <mesh renderOrder={10}>
        <ringGeometry args={[0.8, 1, 32]} />
        <meshBasicMaterial color="#6ee7ff" depthTest={false} transparent opacity={0.9} />
      </mesh>
      <mesh renderOrder={10}>
        <circleGeometry args={[0.25, 16]} />
        <meshBasicMaterial color="#6ee7ff" depthTest={false} />
      </mesh>
    </group>
  )
}
