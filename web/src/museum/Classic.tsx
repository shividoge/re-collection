// The classic picture gallery's details: panelled wainscot, the ivory cornice with gilded
// brackets and a cove up to the ceiling, the skylight lantern, the arched doorway, carpets and
// the bench. Repeated pieces are merged into one mesh per material, so a room of mouldings
// still draws cheaply.

import { RoundedBox } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { fetchBytes } from '../api'
import { parseRoomBin } from '../scene/formats'
import { WALL, type Feature, type MuseumPlan, type Room } from './layout'
import type { Look } from './looks'
import { carpet, labelTexture, woodGrain, type SurfaceMaps } from './textures'

const GOLD = '#c9a052'

let woodMaps: SurfaceMaps | null = null
/**
 * Dark varnished wood: a fine grain under a clear coat, so it catches a soft highlight from the
 * skylight the way polished panelling does, without looking wet.
 */
export function varnishedWood(): THREE.MeshPhysicalMaterial {
  woodMaps ??= woodGrain([108, 66, 42], [48, 27, 17])
  const tile = (t: THREE.Texture) => {
    const c = t.clone()
    c.repeat.set(1.5, 1.5)
    c.needsUpdate = true
    return c
  }
  return new THREE.MeshPhysicalMaterial({
    map: tile(woodMaps.map),
    normalMap: tile(woodMaps.normalMap),
    normalScale: new THREE.Vector2(0.4, 0.4),
    roughness: 0.5,
    clearcoat: 0.55,
    clearcoatRoughness: 0.28,
    envMapIntensity: 1,
  })
}

/** Gilding: warm gold leaf, polished on the high points. */
export function gilding(): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({ color: GOLD, metalness: 1, roughness: 0.27, clearcoat: 0.35, clearcoatRoughness: 0.3, envMapIntensity: 1.5 })
}

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
  const material = useMemo(() => varnishedWood(), [])
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
  const goldMat = useMemo(() => gilding(), [])
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
  const wood = useMemo(() => varnishedWood(), [])
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

/** A gallery bench: a varnished wood frame, a red cushion and a slatted back, at `f`. */
function Bench({ f, wood }: { f: Feature; wood: THREE.Material }) {
  return (
    <group position={[f.x, 0, f.z]}>
      <RoundedBox args={[1.5, 0.1, 0.48]} radius={0.04} smoothness={3} position={[0, 0.45, 0]}>
        <meshStandardMaterial color="#9a2f2c" roughness={0.85} />
      </RoundedBox>
      <mesh position={[0, 0.38, 0]} material={wood}>
        <boxGeometry args={[1.56, 0.06, 0.52]} />
      </mesh>
      {[-0.72, 0.72].flatMap((x) =>
        [-0.22, 0.22].map((z) => (
          <mesh key={`${x},${z}`} position={[x, 0.19, z]} material={wood}>
            <boxGeometry args={[0.06, 0.38, 0.06]} />
          </mesh>
        )),
      )}
      {/* Slatted back, toward the back of the room. */}
      {[-0.72, 0.72].map((x) => (
        <mesh key={x} position={[x, 0.68, 0.24]} material={wood}>
          <boxGeometry args={[0.06, 0.5, 0.05]} />
        </mesh>
      ))}
      <mesh position={[0, 0.92, 0.24]} material={wood}>
        <boxGeometry args={[1.5, 0.07, 0.06]} />
      </mesh>
      {Array.from({ length: 7 }, (_, i) => (
        <mesh key={i} position={[-0.6 + i * 0.2, 0.68, 0.24]} material={wood}>
          <boxGeometry args={[0.035, 0.42, 0.03]} />
        </mesh>
      ))}
    </group>
  )
}

/**
 * The ornate gilded frame of a classic gallery, as one mesh: a back slab, an outer bead, a
 * hollow cove, a middle bead, a lip and a fine bead at the picture's edge, with rosettes at the
 * corners and small cartouches halfway along each side. `outerW` × `outerH` is the frame's full
 * size and `border` its width, in meters; the front of the frame faces +z.
 */
export function ornateFrameGeometry(outerW: number, outerH: number, border: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  // Four rails of a band `w` wide whose outer edge is `inset` from the frame's outside.
  const band = (inset: number, w: number, d: number, z: number) => {
    const ow = outerW - inset * 2
    const oh = outerH - inset * 2
    for (const [x, y, bw, bh] of [
      [0, oh / 2 - w / 2, ow, w],
      [0, -oh / 2 + w / 2, ow, w],
      [-ow / 2 + w / 2, 0, w, oh - w * 2],
      [ow / 2 - w / 2, 0, w, oh - w * 2],
    ]) {
      const g = new THREE.BoxGeometry(bw, bh, d)
      g.translate(x, y, z + d / 2)
      parts.push(g)
    }
  }
  // A round bead running all the way round, `inset` from the outside.
  const bead = (inset: number, r: number, z: number) => {
    const ow = outerW - inset * 2
    const oh = outerH - inset * 2
    for (const [x, y, len, across] of [
      [0, oh / 2, ow, true],
      [0, -oh / 2, ow, true],
      [-ow / 2, 0, oh, false],
      [ow / 2, 0, oh, false],
    ] as [number, number, number, boolean][]) {
      const g = new THREE.CylinderGeometry(r, r, len + r * 2, 12, 1)
      if (across) g.rotateZ(Math.PI / 2)
      g.translate(x, y, z)
      parts.push(g)
    }
  }
  band(0, border, 0.045, 0)
  bead(0.02, 0.022, 0.06)
  band(border * 0.18, border * 0.42, 0.03, 0.045)
  bead(border * 0.62, 0.013, 0.082)
  band(border * 0.7, border * 0.3, 0.035, 0.05)
  bead(border - 0.008, 0.008, 0.09)
  // Rosettes in the corners, cartouches on the sides.
  const ci = border * 0.42
  for (const [sx, sy] of [
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1],
  ]) {
    const x = sx * (outerW / 2 - ci)
    const y = sy * (outerH / 2 - ci)
    const rose = new THREE.SphereGeometry(1, 16, 10)
    rose.scale(border * 0.34, border * 0.34, 0.03)
    rose.translate(x, y, 0.085)
    parts.push(rose)
    const ring = new THREE.TorusGeometry(border * 0.34, 0.008, 6, 24)
    ring.translate(x, y, 0.082)
    parts.push(ring)
  }
  for (const [x, y, w, h] of [
    [0, outerH / 2 - ci, border * 0.7, border * 0.38],
    [0, -outerH / 2 + ci, border * 0.7, border * 0.38],
    [-outerW / 2 + ci, 0, border * 0.38, border * 0.7],
    [outerW / 2 - ci, 0, border * 0.38, border * 0.7],
  ]) {
    const c = new THREE.SphereGeometry(1, 14, 8)
    c.scale(w / 2, h / 2, 0.022)
    c.translate(x, y, 0.085)
    parts.push(c)
  }
  const merged = mergeGeometries(parts.map((p) => p.toNonIndexed()))
  parts.forEach((p) => p.dispose())
  return merged
}

/** A sculpture on a plinth: alternately a bronze amphora and a polished marble knot. */
function Plinth({ f, index, ivory }: { f: Feature; index: number; ivory: THREE.Material }) {
  const amphora = index % 2 === 0
  const vase = useMemo(() => {
    const profile = [
      [0.0, 0],
      [0.07, 0],
      [0.08, 0.02],
      [0.06, 0.05],
      [0.11, 0.16],
      [0.15, 0.3],
      [0.14, 0.42],
      [0.08, 0.52],
      [0.055, 0.6],
      [0.07, 0.66],
      [0.075, 0.68],
    ].map(([x, y]) => new THREE.Vector2(x, y))
    return new THREE.LatheGeometry(profile, 48)
  }, [])
  useEffect(() => () => vase.dispose(), [vase])
  return (
    <group position={[f.x, 0, f.z]}>
      <mesh position={[0, 0.5, 0]} material={ivory}>
        <boxGeometry args={[0.46, 1, 0.46]} />
      </mesh>
      <mesh position={[0, 1.02, 0]} material={ivory}>
        <boxGeometry args={[0.54, 0.05, 0.54]} />
      </mesh>
      <mesh position={[0, 0.04, 0]} material={ivory}>
        <boxGeometry args={[0.54, 0.08, 0.54]} />
      </mesh>
      {amphora ? (
        <mesh geometry={vase} position={[0, 1.045, 0]}>
          <meshPhysicalMaterial color="#8a5a2c" metalness={1} roughness={0.38} clearcoat={0.2} envMapIntensity={1.3} />
        </mesh>
      ) : (
        <mesh position={[0, 1.27, 0]} rotation={[0.4, 0.3, 0]}>
          <torusKnotGeometry args={[0.13, 0.04, 160, 20, 2, 3]} />
          <meshPhysicalMaterial color="#efe9e1" roughness={0.22} clearcoat={0.5} clearcoatRoughness={0.2} envMapIntensity={1.1} />
        </mesh>
      )}
    </group>
  )
}

/** A visit's room scan as a small model: its colored points, scaled to fit the case. */
function useMiniature(captureId: string | null): THREE.BufferGeometry | null {
  const [geometry, setGeometry] = useState<THREE.BufferGeometry | null>(null)
  useEffect(() => {
    if (!captureId) return
    let cancelled = false
    fetchBytes(captureId, 'room.bin')
      .then((buf) => {
        if (cancelled) return
        const cloud = parseRoomBin(buf)
        const step = Math.max(1, Math.ceil(cloud.count / 70000))
        const n = Math.floor(cloud.count / step)
        const pos = new Float32Array(n * 3)
        const col = new Float32Array(n * 3)
        for (let i = 0; i < n; i++) {
          const j = i * step
          pos.set(cloud.positions.subarray(j * 3, j * 3 + 3), i * 3)
          // sRGB bytes to linear: the museum renders in linear light.
          for (let c = 0; c < 3; c++) col[i * 3 + c] = Math.pow(cloud.colors[j * 3 + c] / 255, 2.2)
        }
        // Fit the middle 96% of the points into a 0.55 m cube, standing on the case floor.
        const axis = (a: number) => {
          const v = Array.from({ length: n }, (_, i) => pos[i * 3 + a]).sort((p, q) => p - q)
          return [v[Math.floor(n * 0.02)], v[Math.floor(n * 0.98)]]
        }
        const [x0, x1] = axis(0)
        const [y0, y1] = axis(1)
        const [z0, z1] = axis(2)
        const scale = 0.55 / Math.max(x1 - x0, y1 - y0, z1 - z0)
        const keep: number[] = []
        const keepCol: number[] = []
        for (let i = 0; i < n; i++) {
          const x = pos[i * 3]
          const y = pos[i * 3 + 1]
          const z = pos[i * 3 + 2]
          if (x < x0 || x > x1 || y < y0 || y > y1 || z < z0 || z > z1) continue
          keep.push((x - (x0 + x1) / 2) * scale, (y - y0) * scale, (z - (z0 + z1) / 2) * scale)
          keepCol.push(col[i * 3], col[i * 3 + 1], col[i * 3 + 2])
        }
        const g = new THREE.BufferGeometry()
        g.setAttribute('position', new THREE.Float32BufferAttribute(keep, 3))
        g.setAttribute('color', new THREE.Float32BufferAttribute(keepCol, 3))
        setGeometry(g)
      })
      .catch(() => {
        // No scan to show: the case stays empty rather than showing something made up.
      })
    return () => {
      cancelled = true
    }
  }, [captureId])
  useEffect(() => () => geometry?.dispose(), [geometry])
  return geometry
}

/** A glass case on a varnished base, with a visit's 3D room scan turning slowly inside, and its label. */
function Vitrine({ f, capture, wood }: { f: Feature; capture: { id: string; title: string } | null; wood: THREE.Material }) {
  const miniature = useMiniature(capture?.id ?? null)
  const turn = useRef<THREE.Group>(null)
  useFrame((_, dt) => {
    if (turn.current) turn.current.rotation.y += dt * 0.12
  })
  const label = useMemo(
    () => (capture ? labelTexture(capture.title, 'The room, as the phone scanned it', '', true) : null),
    [capture],
  )
  useEffect(() => () => label?.texture.dispose(), [label])
  const glass = useMemo(
    () => new THREE.MeshPhysicalMaterial({ color: '#ffffff', roughness: 0.04, metalness: 0, transparent: true, opacity: 0.12, envMapIntensity: 1.6, depthWrite: false }),
    [],
  )
  useEffect(() => () => glass.dispose(), [glass])
  return (
    <group position={[f.x, 0, f.z]}>
      <mesh position={[0, 0.45, 0]} material={wood}>
        <boxGeometry args={[0.8, 0.9, 0.8]} />
      </mesh>
      <mesh position={[0, 0.92, 0]} material={wood}>
        <boxGeometry args={[0.86, 0.05, 0.86]} />
      </mesh>
      <mesh position={[0, 0.05, 0]} material={wood}>
        <boxGeometry args={[0.86, 0.1, 0.86]} />
      </mesh>
      {/* The case: glass on four sides and the top, a thin gilded edge. */}
      <mesh position={[0, 1.27, 0]} material={glass} renderOrder={2}>
        <boxGeometry args={[0.76, 0.66, 0.76]} />
      </mesh>
      <mesh position={[0, 1.605, 0]}>
        <boxGeometry args={[0.78, 0.012, 0.78]} />
        <meshPhysicalMaterial color={GOLD} metalness={1} roughness={0.3} />
      </mesh>
      {miniature && (
        <group ref={turn} position={[0, 0.96, 0]}>
          <points geometry={miniature}>
            <pointsMaterial size={0.006} vertexColors sizeAttenuation toneMapped={false} />
          </points>
        </group>
      )}
      {label && (
        <mesh position={[0, 0.72, 0.402]}>
          <planeGeometry args={[0.3, 0.3 / label.aspect]} />
          <meshStandardMaterial map={label.texture} roughness={0.6} />
        </mesh>
      )}
    </group>
  )
}

/** Everything standing on the floor of a furnished room: benches, vitrines, plinths. */
export function Furniture({ plan, look, captures }: { plan: MuseumPlan; look: Look; captures: { id: string; title: string }[] }) {
  const wood = useMemo(() => varnishedWood(), [])
  const ivory = useMemo(() => new THREE.MeshPhysicalMaterial({ color: look.trim, roughness: 0.45, clearcoat: 0.25, clearcoatRoughness: 0.4 }), [look])
  useEffect(() => () => [wood, ivory].forEach((m) => m.dispose()), [wood, ivory])
  // Number each kind in plan order: plinths alternate sculptures, vitrines take visits in turn.
  const nth = (i: number) => plan.features.slice(0, i).filter((g) => g.kind === plan.features[i].kind).length
  return (
    <group>
      {plan.features.map((f, i) => {
        if (f.kind === 'bench') return <Bench key={i} f={f} wood={wood} />
        if (f.kind === 'plinth') return <Plinth key={i} f={f} index={nth(i)} ivory={ivory} />
        const capture = captures.length ? captures[nth(i) % captures.length] : null
        return <Vitrine key={i} f={f} capture={capture} wood={wood} />
      })}
    </group>
  )
}
