// The classic picture gallery's details: panelled wainscot, the ivory cornice with gilded
// brackets and a cove up to the ceiling, the skylight lantern, the arched doorway, carpets and
// the bench. Repeated pieces are merged into one mesh per material, so a room of mouldings
// still draws cheaply.

import { RoundedBox } from '@react-three/drei'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { WALL, type MuseumPlan, type Room } from './layout'
import type { Look } from './looks'
import { carpet, type SurfaceMaps } from './textures'

const DARK_WOOD = '#3a2216'
const GOLD = '#c9a052'

/** A box `w` along a wall, `h` tall, standing `d` out from its face, centered at (along, y). */
function wallBox(face: { origin: [number, number]; along: [number, number]; normal: [number, number] }, along: number, y: number, w: number, h: number, d: number, out = 0) {
  const g = new THREE.BoxGeometry(w, h, d)
  // Box local x runs along the wall, local z out of it.
  const angle = Math.atan2(face.normal[0], face.normal[1])
  g.rotateY(angle)
  g.translate(
    face.origin[0] + face.along[0] * along + face.normal[0] * (out + d / 2),
    y,
    face.origin[1] + face.along[1] * along + face.normal[1] * (out + d / 2),
  )
  return g
}

/** The four full walls of a room (doorways included), each as a face line. */
function roomFaces(room: Room) {
  const faces: { origin: [number, number]; along: [number, number]; normal: [number, number]; length: number }[] = [
    { origin: [room.x0, room.zFront], along: [0, -1], normal: [1, 0], length: room.zFront - room.zBack },
    { origin: [room.x1, room.zBack], along: [0, 1], normal: [-1, 0], length: room.zFront - room.zBack },
    { origin: [room.x1, room.zFront], along: [-1, 0], normal: [0, -1], length: room.x1 - room.x0 },
    { origin: [room.x0, room.zBack], along: [1, 0], normal: [0, 1], length: room.x1 - room.x0 },
  ]
  return faces
}

function useMerged(build: () => THREE.BufferGeometry[], deps: unknown[]) {
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  const geometry = useMemo(() => {
    const parts = build()
    const merged = parts.length ? mergeGeometries(parts) : new THREE.BufferGeometry()
    parts.forEach((p) => p.dispose())
    return merged
  }, deps)
  useEffect(() => () => geometry.dispose(), [geometry])
  return geometry
}

/** Raised panels on the dark wood wainscot, and the rail that caps it. */
export function Wainscot({ plan, look }: { plan: MuseumPlan; look: Look }) {
  const H = look.wainscotHeight
  const geometry = useMerged(() => {
    const parts: THREE.BufferGeometry[] = []
    for (const w of plan.walls) {
      const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1])
      if (len < 0.5) continue
      const along: [number, number] = [(w.b[0] - w.a[0]) / len, (w.b[1] - w.a[1]) / len]
      const face = { origin: w.a, along, normal: w.normal }
      const out = 0.012
      // Cap rail and a lower rail.
      parts.push(wallBox(face, len / 2, H, len, 0.06, 0.05, out))
      parts.push(wallBox(face, len / 2, 0.12, len, 0.22, 0.03, out))
      // Panels about 1.2 m wide, each a frame of four thin mouldings.
      const n = Math.max(1, Math.round((len - 0.3) / 1.25))
      const gap = 0.16
      const pw = (len - 0.3 - gap * (n - 1)) / n
      const y0 = 0.32
      const y1 = H - 0.14
      const t = 0.035
      for (let i = 0; i < n; i++) {
        const c = 0.15 + pw / 2 + i * (pw + gap)
        parts.push(wallBox(face, c, y1, pw, t, 0.02, out))
        parts.push(wallBox(face, c, y0, pw, t, 0.02, out))
        parts.push(wallBox(face, c - pw / 2 + t / 2, (y0 + y1) / 2, t, y1 - y0, 0.02, out))
        parts.push(wallBox(face, c + pw / 2 - t / 2, (y0 + y1) / 2, t, y1 - y0, 0.02, out))
      }
    }
    return parts
  }, [plan, H])
  const material = useMemo(() => new THREE.MeshStandardMaterial({ color: DARK_WOOD, roughness: 0.5, metalness: 0, envMapIntensity: 0.9 }), [])
  useEffect(() => () => material.dispose(), [material])
  return <mesh geometry={geometry} material={material} />
}

/**
 * The cornice: an ivory frieze with gilded lines and a row of carved brackets, and a cove that
 * curves the wall up into the ceiling.
 */
export function Cornice({ plan, look }: { plan: MuseumPlan; look: Look }) {
  const ivory = useMerged(() => {
    const parts: THREE.BufferGeometry[] = []
    for (const room of plan.rooms) {
      const h = room.height
      for (const f of roomFaces(room)) {
        parts.push(wallBox(f, f.length / 2, h - 0.55, f.length, 0.62, 0.04))
        // Brackets every ~0.7 m along the frieze.
        const n = Math.max(2, Math.round(f.length / 0.7))
        for (let i = 0; i < n; i++) parts.push(wallBox(f, ((i + 0.5) * f.length) / n, h - 0.58, 0.11, 0.3, 0.12, 0.04))
        // The cove: a quarter circle in a few flat steps, from the frieze up into the ceiling.
        const steps = 5
        const r = 0.36
        for (let k = 0; k < steps; k++) {
          const a0 = (k / steps) * (Math.PI / 2)
          const a1 = ((k + 1) / steps) * (Math.PI / 2)
          const yA = h - 0.24 + Math.sin(a0) * 0.24
          const yB = h - 0.24 + Math.sin(a1) * 0.24
          const oB = r - Math.cos(a1) * r
          // Each step reaches out as far as the curve does at its top.
          parts.push(wallBox(f, f.length / 2, (yA + yB) / 2, f.length, yB - yA + 0.01, Math.max(0.02, oB) + 0.04))
        }
      }
    }
    return parts
  }, [plan])
  const gold = useMerged(() => {
    const parts: THREE.BufferGeometry[] = []
    for (const room of plan.rooms) {
      const h = room.height
      for (const f of roomFaces(room)) {
        parts.push(wallBox(f, f.length / 2, h - 0.87, f.length, 0.035, 0.06))
        parts.push(wallBox(f, f.length / 2, h - 0.25, f.length, 0.03, 0.07))
        const n = Math.max(2, Math.round(f.length / 0.7))
        for (let i = 0; i < n; i++) parts.push(wallBox(f, ((i + 0.5) * f.length) / n, h - 0.42, 0.15, 0.035, 0.15, 0.04))
      }
    }
    return parts
  }, [plan])
  const ivoryMat = useMemo(() => new THREE.MeshStandardMaterial({ color: look.trim, roughness: 0.6 }), [look])
  const goldMat = useMemo(() => new THREE.MeshStandardMaterial({ color: GOLD, roughness: 0.3, metalness: 0.85, envMapIntensity: 1.2 }), [])
  useEffect(() => () => [ivoryMat, goldMat].forEach((m) => m.dispose()), [ivoryMat, goldMat])
  return (
    <group>
      <mesh geometry={ivory} material={ivoryMat} />
      <mesh geometry={gold} material={goldMat} />
    </group>
  )
}

/** The skylight lantern in the middle of each ceiling: frosted panes in an ivory grid, a gilded rim, small spots. */
export function Lantern({ room, width, look }: { room: Room; width: number; look: Look }) {
  const cz = (room.zFront + room.zBack) / 2
  const depth = room.zFront - room.zBack
  const h = room.height
  const sw = width * 0.42
  const sd = depth * 0.55
  const cols = 3
  const rows = 6
  const glow = useMemo(() => new THREE.MeshStandardMaterial({ color: '#000000', emissive: '#fff4e2', emissiveIntensity: 1.25 }), [])
  const ivory = useMemo(() => new THREE.MeshStandardMaterial({ color: look.trim, roughness: 0.55 }), [look])
  const gold = useMemo(() => new THREE.MeshStandardMaterial({ color: GOLD, roughness: 0.3, metalness: 0.85 }), [])
  const spot = useMemo(() => new THREE.MeshStandardMaterial({ color: '#1e1b18', roughness: 0.4, metalness: 0.6 }), [])
  useEffect(() => () => [glow, ivory, gold, spot].forEach((m) => m.dispose()), [glow, ivory, gold, spot])
  return (
    <group position={[0, 0, cz]}>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, h - 0.006, 0]} material={glow}>
        <planeGeometry args={[sw, sd]} />
      </mesh>
      {Array.from({ length: cols + 1 }, (_, i) => (
        <mesh key={`c${i}`} position={[-sw / 2 + (i * sw) / cols, h - 0.04, 0]} material={ivory}>
          <boxGeometry args={[0.07, 0.07, sd]} />
        </mesh>
      ))}
      {Array.from({ length: rows + 1 }, (_, i) => (
        <mesh key={`r${i}`} position={[0, h - 0.04, -sd / 2 + (i * sd) / rows]} material={ivory}>
          <boxGeometry args={[sw, 0.07, 0.07]} />
        </mesh>
      ))}
      {/* The rim: a deep ivory moulding with a gilded edge. */}
      {[-1, 1].map((s) => (
        <group key={s}>
          <mesh position={[s * (sw / 2 + 0.14), h - 0.12, 0]} material={ivory}>
            <boxGeometry args={[0.28, 0.24, sd + 0.56]} />
          </mesh>
          <mesh position={[0, h - 0.12, s * (sd / 2 + 0.14)]} material={ivory}>
            <boxGeometry args={[sw, 0.24, 0.28]} />
          </mesh>
          <mesh position={[s * (sw / 2 + 0.28), h - 0.24, 0]} material={gold}>
            <boxGeometry args={[0.03, 0.03, sd + 0.6]} />
          </mesh>
          <mesh position={[0, h - 0.24, s * (sd / 2 + 0.28)]} material={gold}>
            <boxGeometry args={[sw + 0.6, 0.03, 0.03]} />
          </mesh>
          {/* Small spotlights on the rim, aimed at the walls. */}
          {Array.from({ length: 4 }, (_, i) => (
            <mesh key={i} position={[s * (sw / 2 + 0.22), h - 0.3, -sd / 2 + ((i + 0.5) * sd) / 4]} rotation={[0, 0, s * 0.6]} material={spot}>
              <cylinderGeometry args={[0.035, 0.045, 0.14, 12]} />
            </mesh>
          ))}
        </group>
      ))}
      <rectAreaLight args={[look.light, 6, sw, sd]} position={[0, h - 0.08, 0]} rotation={[-Math.PI / 2, 0, 0]} />
    </group>
  )
}

/** The arched doorways: the wall above each opening with a round arch cut out, and a dark wood architrave. */
export function ArchDoorways({ plan, wallMaterial }: { plan: MuseumPlan; wallMaterial: THREE.Material }) {
  const pieces = useMemo(
    () =>
      plan.doorways.map((d) => {
        const half = d.width / 2
        const h = plan.rooms[d.room].height
        const shape = new THREE.Shape()
        shape.moveTo(-half, d.height)
        shape.absarc(0, d.height, half, Math.PI, 0, true)
        shape.lineTo(half, h)
        shape.lineTo(-half, h)
        shape.lineTo(-half, d.height)
        const wall = new THREE.ExtrudeGeometry(shape, { depth: WALL, bevelEnabled: false, curveSegments: 32 })
        wall.translate(0, 0, d.z - WALL / 2)
        return { d, half, wall }
      }),
    [plan],
  )
  useEffect(() => () => pieces.forEach((p) => p.wall.dispose()), [pieces])
  const wood = useMemo(() => new THREE.MeshStandardMaterial({ color: DARK_WOOD, roughness: 0.45, envMapIntensity: 1 }), [])
  useEffect(() => () => wood.dispose(), [wood])
  return (
    <group>
      {pieces.map(({ d, half, wall }) => (
        <group key={d.room}>
          <mesh geometry={wall} material={wallMaterial} />
          {[1, -1].map((side) => {
            const z = d.z + (side * WALL) / 2 + side * 0.02
            return (
              <group key={side}>
                {[-1, 1].map((x) => (
                  <mesh key={x} position={[x * (half + 0.06), d.height / 2, z]} material={wood}>
                    <boxGeometry args={[0.12, d.height, 0.04]} />
                  </mesh>
                ))}
                <mesh position={[0, d.height, z]} material={wood}>
                  <torusGeometry args={[half + 0.06, 0.06, 8, 48, Math.PI]} />
                </mesh>
                {/* Keystone. */}
                <mesh position={[0, d.height + half + 0.08, z]} material={wood}>
                  <boxGeometry args={[0.16, 0.22, 0.06]} />
                </mesh>
              </group>
            )
          })}
        </group>
      ))}
    </group>
  )
}

const carpetCache = new Map<string, SurfaceMaps>()

/** A plain carpet in each room, with a slightly deeper border, on the dark wood floor. */
export function Carpets({ plan }: { plan: MuseumPlan }) {
  const field = useMemo(() => {
    const key = 'field'
    let m = carpetCache.get(key)
    if (!m) carpetCache.set(key, (m = carpet([214, 186, 160])))
    const copy = (t: THREE.Texture) => {
      const c = t.clone()
      c.repeat.set(4, 5)
      c.needsUpdate = true
      return c
    }
    return { map: copy(m.map), normalMap: copy(m.normalMap) }
  }, [])
  const fieldMat = useMemo(() => new THREE.MeshStandardMaterial({ ...field, roughness: 1, normalScale: new THREE.Vector2(0.5, 0.5) }), [field])
  const borderMat = useMemo(() => new THREE.MeshStandardMaterial({ map: field.map, color: '#b08a74', roughness: 1 }), [field])
  useEffect(() => () => [fieldMat, borderMat].forEach((m) => m.dispose()), [fieldMat, borderMat])
  const inset = 0.85
  const border = 0.22
  return (
    <group>
      {plan.rooms.map((room) => {
        const w = room.x1 - room.x0 - inset * 2
        const d = room.zFront - room.zBack - inset * 2
        const cz = (room.zFront + room.zBack) / 2
        return (
          <group key={room.index} position={[0, 0.006, cz]} rotation={[-Math.PI / 2, 0, 0]}>
            <mesh material={borderMat}>
              <planeGeometry args={[w, d]} />
            </mesh>
            <mesh position={[0, 0, 0.002]} material={fieldMat}>
              <planeGeometry args={[w - border * 2, d - border * 2]} />
            </mesh>
          </group>
        )
      })}
    </group>
  )
}

/** A gallery bench: a dark wood frame, a red cushion and a slatted back. */
export function ClassicBench({ room }: { room: Room }) {
  const cz = (room.zFront + room.zBack) / 2
  return (
    <group position={[0, 0, cz + 0.8]}>
      <RoundedBox args={[1.5, 0.1, 0.48]} radius={0.04} smoothness={3} position={[0, 0.45, 0]}>
        <meshStandardMaterial color="#9a2f2c" roughness={0.85} />
      </RoundedBox>
      <mesh position={[0, 0.38, 0]}>
        <boxGeometry args={[1.56, 0.06, 0.52]} />
        <meshStandardMaterial color={DARK_WOOD} roughness={0.5} />
      </mesh>
      {[-0.72, 0.72].flatMap((x) =>
        [-0.22, 0.22].map((z) => (
          <mesh key={`${x},${z}`} position={[x, 0.19, z]}>
            <boxGeometry args={[0.06, 0.38, 0.06]} />
            <meshStandardMaterial color={DARK_WOOD} roughness={0.5} />
          </mesh>
        )),
      )}
      {/* Slatted back on the side facing away from the entrance wall. */}
      {[-0.72, 0.72].map((x) => (
        <mesh key={x} position={[x, 0.68, 0.24]}>
          <boxGeometry args={[0.06, 0.5, 0.05]} />
          <meshStandardMaterial color={DARK_WOOD} roughness={0.5} />
        </mesh>
      ))}
      <mesh position={[0, 0.92, 0.24]}>
        <boxGeometry args={[1.5, 0.07, 0.06]} />
        <meshStandardMaterial color={DARK_WOOD} roughness={0.5} />
      </mesh>
      {Array.from({ length: 7 }, (_, i) => (
        <mesh key={i} position={[-0.6 + i * 0.2, 0.68, 0.24]}>
          <boxGeometry args={[0.035, 0.42, 0.03]} />
          <meshStandardMaterial color={DARK_WOOD} roughness={0.5} />
        </mesh>
      ))}
    </group>
  )
}
