// The classic picture gallery's details: raised-panel wainscot, the ivory cornice with gilded
// brackets and a cove up to the ceiling, the skylight lantern, the arched doorway, a dark wood
// floor border and rugs, and the furniture: round tufted settees with an urn, candle torchères,
// wall sconces between the pictures, a marble fireplace, pedestals with urns. Repeated pieces are merged into one mesh per material, so a room of mouldings
// still draws cheaply.

import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { WALL, type Feature, type MuseumPlan, type Room } from './layout'
import type { Look } from './looks'
import { carpet, frostedGlassTexture, imperialPorcelain, lightPoolTexture, persianRug, woodFloor, woodGrain, type SurfaceMaps } from './textures'

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

let parquetMaps: SurfaceMaps | null = null
/**
 * Darker herringbone parquet for the floor's edge and the doorways, in the same pattern as the
 * floor itself. Geometry using it needs world UVs (`worldUV`), so the pattern runs on unbroken
 * from one piece to the next.
 */
export function darkParquet(): THREE.MeshPhysicalMaterial {
  parquetMaps ??= woodFloor('herringbone', [112, 70, 42], [54, 31, 18], 23)
  const tile = (t: THREE.Texture) => {
    const c = t.clone()
    c.repeat.set(1 / 1.6, 1 / 1.6)
    c.rotation = Math.PI / 4
    c.needsUpdate = true
    return c
  }
  return new THREE.MeshPhysicalMaterial({
    map: tile(parquetMaps.map),
    normalMap: tile(parquetMaps.normalMap),
    roughnessMap: tile(parquetMaps.roughnessMap),
    normalScale: new THREE.Vector2(0.6, 0.6),
    roughness: 1,
    clearcoat: 0.3,
    clearcoatRoughness: 0.35,
  })
}

/** Sets a floor piece's UVs to its world x, z, so textures line up across pieces. */
function worldUV(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = g.attributes.position
  const uv = new Float32Array(pos.count * 2)
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i)
    uv[i * 2 + 1] = -pos.getZ(i)
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  return g
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

/**
 * Raised-panel wainscot: a tall skirting, a rounded cap rail, and between them panels about
 * 1.2 m wide, each a bevelled frame around a raised field, as joiners make them.
 */
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
      // Skirting, with a small moulding on top; the cap rail with a rounded nose.
      parts.push(wallBox(face, len / 2, 0.11, len, 0.22, 0.04, out))
      parts.push(wallBox(face, len / 2, 0.235, len, 0.03, 0.05, out))
      parts.push(wallBox(face, len / 2, H - 0.02, len, 0.05, 0.05, out))
      const nose = new THREE.CylinderGeometry(0.03, 0.03, len, 12)
      nose.rotateZ(Math.PI / 2)
      nose.rotateY(Math.atan2(face.normal[0], face.normal[1]))
      const mid = [face.origin[0] + along[0] * (len / 2), face.origin[1] + along[1] * (len / 2)]
      nose.translate(mid[0] + face.normal[0] * (out + 0.05), H + 0.02, mid[1] + face.normal[1] * (out + 0.05))
      parts.push(nose)
      const n = Math.max(1, Math.round((len - 0.3) / 1.2))
      const gap = 0.12
      const pw = (len - 0.3 - gap * (n - 1)) / n
      const y0 = 0.36
      const y1 = H - 0.16
      const ph = y1 - y0
      const cy = (y0 + y1) / 2
      const t = 0.075
      for (let i = 0; i < n; i++) {
        const c = 0.15 + pw / 2 + i * (pw + gap)
        // The frame: four mouldings, a bevelled step inside them, then the raised field.
        parts.push(wallBox(face, c, y1 - t / 2, pw, t, 0.03, out))
        parts.push(wallBox(face, c, y0 + t / 2, pw, t, 0.03, out))
        parts.push(wallBox(face, c - pw / 2 + t / 2, cy, t, ph - t * 2, 0.03, out))
        parts.push(wallBox(face, c + pw / 2 - t / 2, cy, t, ph - t * 2, 0.03, out))
        parts.push(wallBox(face, c, cy, pw - t * 2, ph - t * 2, 0.014, out))
        parts.push(wallBox(face, c, cy, pw - t * 2 - 0.08, ph - t * 2 - 0.08, 0.024, out))
      }
    }
    return parts
  }, [plan, H])
  const material = useMemo(() => varnishedWood(), [])
  useEffect(() => () => material.dispose(), [material])
  return <mesh geometry={geometry} material={material} />
}

/**
 * Darker parquet around the edge of each floor and through the doorways, in the floor's own
 * herringbone, with a thin light inlay line: the floor deepens toward the panelling, as in old
 * galleries, and runs on unbroken from one room to the next.
 */
export function FloorBorder({ plan }: { plan: MuseumPlan }) {
  const band = 0.5
  const geometry = useMerged(() => {
    const parts: THREE.BufferGeometry[] = []
    for (const room of plan.rooms) {
      const w = room.x1 - room.x0
      const d = room.zFront - room.zBack
      const cz = (room.zFront + room.zBack) / 2
      for (const [x, z, bw, bd] of [
        [0, room.zFront - band / 2, w, band],
        [0, room.zBack + band / 2, w, band],
        [room.x0 + band / 2, cz, band, d - band * 2],
        [room.x1 - band / 2, cz, band, d - band * 2],
      ]) {
        const g = new THREE.PlaneGeometry(bw, bd)
        g.rotateX(-Math.PI / 2)
        g.translate(x, 0.003, z)
        parts.push(worldUV(g))
      }
    }
    // Through each doorway, joining the two rooms' borders.
    for (const d of plan.doorways) {
      const g = new THREE.PlaneGeometry(d.width, WALL + 0.02)
      g.rotateX(-Math.PI / 2)
      g.translate(0, 0.003, d.z)
      parts.push(worldUV(g))
    }
    return parts
  }, [plan])
  const inlay = useMerged(() => {
    const parts: THREE.BufferGeometry[] = []
    for (const room of plan.rooms) {
      const w = room.x1 - room.x0 - band * 2
      const d = room.zFront - room.zBack - band * 2
      const cz = (room.zFront + room.zBack) / 2
      for (const [x, z, bw, bd] of [
        [0, cz + d / 2, w, 0.025],
        [0, cz - d / 2, w, 0.025],
        [-w / 2, cz, 0.025, d],
        [w / 2, cz, 0.025, d],
      ]) {
        const g = new THREE.PlaneGeometry(bw, bd)
        g.rotateX(-Math.PI / 2)
        g.translate(x, 0.004, z)
        parts.push(g)
      }
    }
    return parts
  }, [plan])
  const material = useMemo(() => darkParquet(), [])
  const inlayMaterial = useMemo(() => new THREE.MeshStandardMaterial({ color: '#c9a27a', roughness: 0.5 }), [])
  useEffect(() => () => [material, inlayMaterial].forEach((m) => m.dispose()), [material, inlayMaterial])
  return (
    <group>
      <mesh geometry={geometry} material={material} />
      <mesh geometry={inlay} material={inlayMaterial} />
    </group>
  )
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
  // The underside of the arch is seen from below, inside the curve.
  const soffitWood = useMemo(() => {
    const m = varnishedWood()
    m.side = THREE.DoubleSide
    return m
  }, [])
  useEffect(() => () => [wood, soffitWood].forEach((m) => m.dispose()), [wood, soffitWood])
  return (
    <group>
      {pieces.map(({ d, half, wall }) => (
        <group key={d.room}>
          <mesh geometry={wall} material={wallMaterial} />
          {/* The opening is lined in wood, sides and arch; its floor is the border's parquet. */}
          {[-1, 1].map((x) => (
            <mesh key={x} position={[x * (half - 0.012), d.height / 2, d.z]} material={wood}>
              <boxGeometry args={[0.024, d.height, WALL + 0.02]} />
            </mesh>
          ))}
          <mesh position={[0, d.height, d.z]} rotation={[Math.PI / 2, 0, 0]} material={soffitWood}>
            <cylinderGeometry args={[half - 0.012, half - 0.012, WALL + 0.02, 48, 1, true, Math.PI / 2, Math.PI]} />
          </mesh>

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

/** A Persian medallion rug in the middle of every room, on the herringbone. */
export function Carpets({ plan }: { plan: MuseumPlan }) {
  const inset = 0.85
  const room = plan.rooms[0]
  const w = room.x1 - room.x0 - inset * 2
  const d = room.zFront - room.zBack - inset * 2
  const pile = useMemo(() => carpet([200, 200, 200], 9, 256), [])
  const material = useMemo(() => {
    const normal = pile.normalMap.clone()
    normal.repeat.set(6, 9)
    normal.needsUpdate = true
    // alphaTest: the fringe is threads with floor showing between them.
    return new THREE.MeshStandardMaterial({ map: persianRug(w / d), normalMap: normal, normalScale: new THREE.Vector2(0.5, 0.5), roughness: 1, alphaTest: 0.5 })
  }, [pile, w, d])
  useEffect(() => () => (material.map?.dispose(), material.dispose()), [material])
  return (
    <group>
      {plan.rooms.map((r) => (
        <mesh key={r.index} position={[0, 0.008, (r.zFront + r.zBack) / 2]} rotation={[-Math.PI / 2, 0, 0]} material={material}>
          <planeGeometry args={[w, d]} />
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

const pool = lightPoolTexture()
const BRASS = '#b8913f'

/** Outlines (radius, height in meters) for vases turned on a lathe, sampled from foot to top. */
function profile(height: number, radius: (t: number) => number, steps = 40): THREE.Vector2[] {
  return Array.from({ length: steps + 1 }, (_, i) => new THREE.Vector2(Math.max(0.001, radius(i / steps)), (i / steps) * height))
}
const smooth = (a: number, b: number, t: number) => {
  const k = Math.min(1, Math.max(0, t))
  return a + (b - a) * k * k * (3 - 2 * k)
}

/** A Chinese lidded baluster jar: foot, swelling body, short neck, domed lid with a knob. */
const JAR = profile(0.62, (t) => {
  if (t < 0.04) return 0.1
  if (t < 0.45) return smooth(0.1, 0.19, (t - 0.04) / 0.41)
  if (t < 0.82) return smooth(0.19, 0.095, (t - 0.45) / 0.37)
  if (t < 0.88) return 0.085
  if (t < 0.89) return 0.115
  if (t < 0.96) return smooth(0.115, 0.04, (t - 0.89) / 0.07)
  return 0.035 * Math.sqrt(Math.max(0, 1 - ((t - 0.98) / 0.02) ** 2)) + 0.001
})

/** A Sèvres-style vase: a socle, a short stem, an egg-shaped body, a neck and a flared lip. */
const SEVRES = profile(0.72, (t) => {
  if (t < 0.08) return 0.11
  if (t < 0.16) return smooth(0.06, 0.05, (t - 0.08) / 0.08)
  if (t < 0.4) return smooth(0.08, 0.17, (t - 0.16) / 0.24)
  if (t < 0.72) return smooth(0.17, 0.07, (t - 0.4) / 0.32)
  if (t < 0.88) return 0.06
  return smooth(0.06, 0.11, (t - 0.88) / 0.12)
})

/** The lid of a covered vase: a low dome with a gilt pine-cone finial. */
const LID = profile(0.14, (t) => {
  if (t < 0.12) return 0.072
  if (t < 0.7) return smooth(0.072, 0.025, (t - 0.12) / 0.58)
  return 0.022
})

/**
 * A covered vase in red-ground porcelain with gold decoration (imperialPorcelain), in chased
 * gilt-bronze mounts: a stepped socle, rings at the foot and lip, scroll handles, a gilt finial.
 * `shape` is the outline: the egg-shaped Sèvres vase, or the baluster jar.
 */
function Vase({ shape, gold, scale = 1 }: { shape: 'sevres' | 'jar'; gold: THREE.Material; scale?: number }) {
  const outline = shape === 'sevres' ? SEVRES : JAR
  const height = outline[outline.length - 1].y
  const geometry = useMemo(() => new THREE.LatheGeometry(outline, 64), [outline])
  const lid = useMemo(() => new THREE.LatheGeometry(LID, 48), [])
  const glaze = useMemo(() => {
    const { map, surface } = imperialPorcelain()
    return new THREE.MeshPhysicalMaterial({ map, roughnessMap: surface, metalnessMap: surface, roughness: 1, metalness: 1, clearcoat: 0.8, clearcoatRoughness: 0.08, envMapIntensity: 1.3 })
  }, [])
  useEffect(() => () => [geometry, lid].forEach((g) => g.dispose()), [geometry, lid])
  useEffect(() => () => (glaze.map?.dispose(), glaze.roughnessMap?.dispose(), glaze.dispose()), [glaze])
  const radiusAt = (y: number) => outline[Math.min(outline.length - 1, Math.round((y / height) * (outline.length - 1)))].x
  const covered = shape === 'sevres'
  return (
    <group scale={scale}>
      {/* Socle: a stepped square gilt-bronze base. */}
      <mesh position={[0, 0.018, 0]} material={gold}>
        <boxGeometry args={[0.24, 0.036, 0.24]} />
      </mesh>
      <mesh position={[0, 0.045, 0]} material={gold}>
        <cylinderGeometry args={[0.1, 0.115, 0.02, 32]} />
      </mesh>
      <group position={[0, 0.055, 0]}>
        <mesh geometry={geometry} material={glaze} />
        {[0.004, height - 0.005].map((y, i) => (
          <mesh key={i} position={[0, y, 0]} rotation={[Math.PI / 2, 0, 0]} material={gold}>
            <torusGeometry args={[radiusAt(y) + 0.006, 0.011, 8, 48]} />
          </mesh>
        ))}
        {covered && (
          <group position={[0, height, 0]}>
            <mesh geometry={lid} material={glaze} />
            <mesh position={[0, 0.17, 0]} material={gold}>
              <sphereGeometry args={[0.034, 16, 12]} />
            </mesh>
            <mesh position={[0, 0.215, 0]} material={gold}>
              <coneGeometry args={[0.022, 0.06, 12]} />
            </mesh>
          </group>
        )}
        {/* Scroll handles in gilt bronze, either side. */}
        {[-1, 1].map((side) => (
          <group key={side} position={[side * radiusAt(height * 0.62) * 1.02, height * 0.62, 0]} rotation={[0, 0, side * 0.35]}>
            <mesh material={gold}>
              <torusGeometry args={[0.055, 0.012, 8, 24, Math.PI * 1.3]} />
            </mesh>
            <mesh position={[side * 0.025, -0.065, 0]} material={gold}>
              <sphereGeometry args={[0.02, 12, 10]} />
            </mesh>
          </group>
        ))}
      </group>
    </group>
  )
}

/** A candle flame: a soft glowing teardrop with a halo, flickering a little. */
function Flame({ position, size = 1 }: { position: [number, number, number]; size?: number }) {
  const flame = useRef<THREE.Mesh>(null)
  const halo = useRef<THREE.Mesh>(null)
  const seed = useMemo(() => Math.random() * 100, [])
  useFrame(({ clock, camera }) => {
    const t = clock.elapsedTime + seed
    const k = 1 + Math.sin(t * 9) * 0.06 + Math.sin(t * 23) * 0.04
    flame.current?.scale.set(0.011 * size, 0.028 * size * k, 0.011 * size)
    if (halo.current) {
      halo.current.quaternion.copy(camera.quaternion)
      ;(halo.current.material as THREE.MeshBasicMaterial).opacity = 0.32 * k
    }
  })
  return (
    <group position={position}>
      <mesh ref={flame}>
        <sphereGeometry args={[1, 12, 10]} />
        <meshBasicMaterial color="#ffd27a" toneMapped={false} />
      </mesh>
      <mesh ref={halo} renderOrder={3}>
        <planeGeometry args={[0.14 * size, 0.14 * size]} />
        <meshBasicMaterial map={pool} color="#ffb24d" transparent opacity={0.32} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  )
}

/** A wax candle with its flame, standing at `y` on a holder. */
function Candle({ x, y, z, h = 0.16 }: { x: number; y: number; z: number; h?: number }) {
  return (
    <group position={[x, y, z]}>
      <mesh position={[0, h / 2, 0]}>
        <cylinderGeometry args={[0.012, 0.013, h, 12]} />
        <meshStandardMaterial color="#f4ecdc" roughness={0.6} emissive="#ffcf8a" emissiveIntensity={0.08} />
      </mesh>
      <Flame position={[0, h + 0.03, 0]} />
    </group>
  )
}

/** Three candles on a brass candelabrum: a turned stem and two curved arms. */
function Candelabrum({ x, y, z, scale = 1 }: { x: number; y: number; z: number; scale?: number }) {
  const brass = useMemo(() => new THREE.MeshPhysicalMaterial({ color: BRASS, metalness: 1, roughness: 0.3, clearcoat: 0.3 }), [])
  useEffect(() => () => brass.dispose(), [brass])
  return (
    <group position={[x, y, z]} scale={scale}>
      <mesh position={[0, 0.015, 0]} material={brass}>
        <cylinderGeometry args={[0.07, 0.08, 0.03, 24]} />
      </mesh>
      <mesh position={[0, 0.17, 0]} material={brass}>
        <cylinderGeometry args={[0.012, 0.02, 0.3, 12]} />
      </mesh>
      <mesh position={[0, 0.3, 0]} rotation={[0, 0, 0]} material={brass}>
        <torusGeometry args={[0.11, 0.008, 8, 24, Math.PI]} />
      </mesh>
      {[-0.11, 0, 0.11].map((dx) => (
        <group key={dx}>
          <mesh position={[dx, dx === 0 ? 0.33 : 0.3, 0]} material={brass}>
            <cylinderGeometry args={[0.025, 0.018, 0.025, 16]} />
          </mesh>
          <Candle x={dx} y={dx === 0 ? 0.34 : 0.31} z={0} />
        </group>
      ))}
    </group>
  )
}

/** A brass wall sconce with two candles, between pictures. */
function Sconce({ position, yaw }: { position: [number, number, number]; yaw: number }) {
  const brass = useMemo(() => new THREE.MeshPhysicalMaterial({ color: BRASS, metalness: 1, roughness: 0.28, clearcoat: 0.3 }), [])
  useEffect(() => () => brass.dispose(), [brass])
  return (
    <group position={position} rotation={[0, yaw, 0]}>
      {/* Back plate and arms. */}
      <mesh position={[0, 0, 0.012]} material={brass}>
        <cylinderGeometry args={[0.05, 0.05, 0.02, 24]} />
      </mesh>
      <mesh position={[0, 0, 0.05]} rotation={[Math.PI / 2, 0, 0]} material={brass}>
        <cylinderGeometry args={[0.01, 0.01, 0.08, 8]} />
      </mesh>
      <mesh position={[0, -0.02, 0.1]} rotation={[Math.PI / 2, 0, 0]} material={brass}>
        <torusGeometry args={[0.12, 0.008, 8, 24, Math.PI]} />
      </mesh>
      {[-0.12, 0.12].map((dx) => (
        <group key={dx}>
          <mesh position={[dx, -0.02, 0.1]} material={brass}>
            <cylinderGeometry args={[0.035, 0.02, 0.025, 16]} />
          </mesh>
          <Candle x={dx} y={-0.005} z={0.1} h={0.13} />
        </group>
      ))}
      {/* The warm glow they throw on the wall. */}
      <mesh position={[0, 0.08, 0.004]}>
        <planeGeometry args={[0.9, 0.9]} />
        <meshBasicMaterial map={pool} color="#ffb867" transparent opacity={0.28} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
    </group>
  )
}

/** Sconces on the side walls, halfway between neighbouring pictures. */
export function Sconces({ plan, count }: { plan: MuseumPlan; count: number }) {
  const spots: { p: [number, number, number]; yaw: number }[] = []
  const hung = plan.slots.slice(0, count)
  for (const room of plan.rooms)
    for (const side of [1, -1]) {
      const onWall = hung.filter((s) => s.room === room.index && s.normal[0] === side).sort((a, b) => b.center[2] - a.center[2])
      for (let i = 1; i < onWall.length; i++) {
        const a = onWall[i - 1]
        const b = onWall[i]
        spots.push({ p: [a.center[0], plan.spec.hang + 0.05, (a.center[2] + b.center[2]) / 2], yaw: Math.atan2(a.normal[0], a.normal[1]) })
      }
    }
  return (
    <group>
      {spots.map((s, i) => (
        <Sconce key={i} position={s.p} yaw={s.yaw} />
      ))}
    </group>
  )
}

/**
 * A round tufted settee (a "borne") in red velvet, with gilt trim and turned feet, and a
 * pedestal rising from its middle with a red-and-gold porcelain jar: the centre of the room.
 */
function Settee({ f, wood, gold }: { f: Feature; wood: THREE.Material; gold: THREE.Material }) {
  const r = 0.72
  const velvet = useMemo(() => new THREE.MeshPhysicalMaterial({ color: '#7d1f24', roughness: 0.8, sheen: 1, sheenRoughness: 0.45, sheenColor: new THREE.Color('#d0555a') }), [])
  const buttonMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#4a1014', roughness: 0.6 }), [])
  // The seat: a soft domed cushion over a straight side, as a lathe profile listed from the
  // bottom up (the lathe faces outward that way).
  const seat = useMemo(
    () =>
      new THREE.LatheGeometry(
        [
          [0, 0.12],
          [r * 0.96, 0.12],
          [r, 0.14],
          [r, 0.38],
          [r * 0.98, 0.42],
          [r * 0.85, 0.45],
          [r * 0.55, 0.465],
          [0, 0.47],
        ].map(([x, y]) => new THREE.Vector2(x, y)),
        64,
      ),
    [],
  )
  useEffect(() => () => [velvet, buttonMat].forEach((m) => m.dispose()), [velvet, buttonMat])
  useEffect(() => () => seat.dispose(), [seat])
  // Buttons in two rings across the cushion, and pleats down the side.
  const buttons: [number, number, number][] = []
  for (const [ring, n, y] of [
    [0.32, 8, 0.468],
    [0.56, 14, 0.452],
  ] as [number, number, number][])
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + ring
      buttons.push([Math.cos(a) * ring, y, Math.sin(a) * ring])
    }
  return (
    <group position={[f.x, 0, f.z]}>
      <mesh geometry={seat} material={velvet} />
      {buttons.map((p, i) => (
        <mesh key={i} position={p} material={buttonMat}>
          <sphereGeometry args={[0.014, 10, 8]} />
        </mesh>
      ))}
      {/* Gilt trim round the seat edge and the base, on turned feet. */}
      <mesh position={[0, 0.39, 0]} rotation={[Math.PI / 2, 0, 0]} material={gold}>
        <torusGeometry args={[r + 0.004, 0.012, 8, 72]} />
      </mesh>
      <mesh position={[0, 0.13, 0]} rotation={[Math.PI / 2, 0, 0]} material={gold}>
        <torusGeometry args={[r - 0.01, 0.016, 8, 72]} />
      </mesh>
      {Array.from({ length: 8 }, (_, i) => {
        const a = (i / 8) * Math.PI * 2
        return (
          <group key={i} position={[Math.cos(a) * (r - 0.08), 0, Math.sin(a) * (r - 0.08)]}>
            <mesh position={[0, 0.07, 0]} material={wood}>
              <sphereGeometry args={[0.055, 16, 12]} />
            </mesh>
            <mesh position={[0, 0.012, 0]} material={gold}>
              <cylinderGeometry args={[0.03, 0.035, 0.024, 16]} />
            </mesh>
          </group>
        )
      })}
      {/* The pedestal in the middle: a fluted column in varnished wood with gilt rings, and the urn. */}
      <mesh position={[0, 0.78, 0]} material={wood}>
        <cylinderGeometry args={[0.13, 0.16, 0.62, 24]} />
      </mesh>
      {[0.48, 1.08].map((y) => (
        <mesh key={y} position={[0, y, 0]} rotation={[Math.PI / 2, 0, 0]} material={gold}>
          <torusGeometry args={[y < 1 ? 0.17 : 0.14, 0.015, 8, 48]} />
        </mesh>
      ))}
      <mesh position={[0, 1.11, 0]} material={wood}>
        <cylinderGeometry args={[0.2, 0.18, 0.05, 32]} />
      </mesh>
      <group position={[0, 1.135, 0]}>
        <Vase shape="jar" gold={gold} />
      </group>
    </group>
  )
}

/** A tall bronze torchère: a tripod foot, a turned stem, and a crown of five candles. */
function Torchere({ f, gold }: { f: Feature; gold: THREE.Material }) {
  const bronze = useMemo(() => new THREE.MeshPhysicalMaterial({ color: '#6d4a26', metalness: 1, roughness: 0.4, clearcoat: 0.2 }), [])
  // Tripod legs: each runs from a foot spread wide on the floor up to the base of the stem.
  const legs = useMemo(
    () =>
      [0, 1, 2].map((i) => {
        const a = (i / 3) * Math.PI * 2
        const bottom = new THREE.Vector3(Math.cos(a) * 0.2, 0.03, Math.sin(a) * 0.2)
        const top = new THREE.Vector3(Math.cos(a) * 0.035, 0.2, Math.sin(a) * 0.035)
        const dir = top.clone().sub(bottom)
        return {
          position: bottom.clone().add(top).multiplyScalar(0.5),
          quaternion: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize()),
          length: dir.length(),
          foot: bottom,
        }
      }),
    [],
  )
  useEffect(() => () => bronze.dispose(), [bronze])
  return (
    <group position={[f.x, 0, f.z]}>
      {legs.map(({ position, quaternion, length, foot }, i) => (
        <group key={i}>
          <mesh position={position} quaternion={quaternion} material={bronze}>
            <cylinderGeometry args={[0.02, 0.028, length, 10]} />
          </mesh>
          <mesh position={foot} material={gold}>
            <sphereGeometry args={[0.03, 12, 10]} />
          </mesh>
        </group>
      ))}
      <mesh position={[0, 0.2, 0]} material={gold}>
        <sphereGeometry args={[0.06, 20, 14]} />
      </mesh>
      <mesh position={[0, 0.9, 0]} material={bronze}>
        <cylinderGeometry args={[0.022, 0.035, 1.4, 16]} />
      </mesh>
      {[0.55, 1.1].map((y) => (
        <mesh key={y} position={[0, y, 0]} material={gold}>
          <sphereGeometry args={[0.04, 16, 12]} />
        </mesh>
      ))}
      <mesh position={[0, 1.62, 0]} material={bronze}>
        <cylinderGeometry args={[0.17, 0.05, 0.08, 24]} />
      </mesh>
      {[0, 1, 2, 3, 4].map((i) => {
        const a = (i / 5) * Math.PI * 2
        const x = i === 0 ? 0 : Math.cos(a) * 0.13
        const z = i === 0 ? 0 : Math.sin(a) * 0.13
        return (
          <group key={i}>
            <mesh position={[x, 1.67, z]} material={gold}>
              <cylinderGeometry args={[0.028, 0.02, 0.02, 14]} />
            </mesh>
            <Candle x={x} y={1.68} z={z} h={i === 0 ? 0.22 : 0.17} />
          </group>
        )
      })}
    </group>
  )
}

/** A pedestal in varnished wood with gilt mouldings, and a covered red-and-gold vase on it. */
function Pedestal({ f, wood, gold }: { f: Feature; wood: THREE.Material; gold: THREE.Material }) {
  return (
    <group position={[f.x, 0, f.z]}>
      <mesh position={[0, 0.05, 0]} material={wood}>
        <boxGeometry args={[0.52, 0.1, 0.52]} />
      </mesh>
      <mesh position={[0, 0.55, 0]} material={wood}>
        <boxGeometry args={[0.4, 0.9, 0.4]} />
      </mesh>
      {[0.12, 0.98].map((y) => (
        <mesh key={y} position={[0, y, 0]} material={gold}>
          <boxGeometry args={[0.44, 0.03, 0.44]} />
        </mesh>
      ))}
      <mesh position={[0, 1.03, 0]} material={wood}>
        <boxGeometry args={[0.5, 0.06, 0.5]} />
      </mesh>
      <group position={[0, 1.06, 0]}>
        <Vase shape="sevres" gold={gold} scale={1.1} />
      </group>
    </group>
  )
}

/**
 * A carved marble fireplace on the entrance wall: pilasters and a mantel shelf, a fire of
 * logs glowing and flickering in the firebox, a stone hearth, candelabra on the mantel.
 */
function Fireplace({ f }: { f: Feature }) {
  const marble = useMemo(() => new THREE.MeshPhysicalMaterial({ color: '#efe8de', roughness: 0.22, clearcoat: 0.6, clearcoatRoughness: 0.15, envMapIntensity: 1 }), [])
  const soot = useMemo(() => new THREE.MeshStandardMaterial({ color: '#141010', roughness: 0.95 }), [])
  const logMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#3a2618', roughness: 0.9, emissive: '#ff5a1a', emissiveIntensity: 0.25 }), [])
  useEffect(() => () => [marble, soot, logMat].forEach((m) => m.dispose()), [marble, soot, logMat])
  const fire = useRef<THREE.PointLight>(null)
  const flames = useRef<THREE.Group>(null)
  useFrame(({ clock }) => {
    const t = clock.elapsedTime
    if (fire.current) fire.current.intensity = 2.4 + Math.sin(t * 7) * 0.4 + Math.sin(t * 17) * 0.3
    flames.current?.children.forEach((c, i) => {
      const k = 1 + Math.sin(t * (6 + i) + i) * 0.18
      c.scale.set(1, k, 1)
    })
  })
  // The wall is at local z = 0; the fireplace faces +z (into the room, after the turn below).
  return (
    <group position={[f.x, 0, f.z + f.hd]} rotation={[0, Math.PI, 0]}>
      {/* Hearth stone. */}
      <mesh position={[0, 0.025, 0.32]} material={marble}>
        <boxGeometry args={[2.1, 0.05, 0.62]} />
      </mesh>
      {/* Pilasters, frieze, mantel shelf. */}
      {[-0.82, 0.82].map((x) => (
        <group key={x}>
          <mesh position={[x, 0.58, 0.14]} material={marble}>
            <boxGeometry args={[0.26, 1.06, 0.28]} />
          </mesh>
          <mesh position={[x, 1.03, 0.16]} material={marble}>
            <boxGeometry args={[0.32, 0.08, 0.32]} />
          </mesh>
        </group>
      ))}
      <mesh position={[0, 1.08, 0.13]} material={marble}>
        <boxGeometry args={[1.9, 0.22, 0.26]} />
      </mesh>
      <mesh position={[0, 1.22, 0.2]} material={marble}>
        <boxGeometry args={[2.15, 0.06, 0.42]} />
      </mesh>
      {/* The firebox: a dark opening with the fire inside. */}
      <mesh position={[0, 0.5, 0.02]} material={soot}>
        <boxGeometry args={[1.38, 0.9, 0.04]} />
      </mesh>
      <mesh position={[0, 0.06, 0.18]} material={soot}>
        <boxGeometry args={[1.3, 0.04, 0.32]} />
      </mesh>
      {[
        [-0.18, 0.12, 0.15, 0.3],
        [0.16, 0.12, 0.17, -0.25],
        [0, 0.2, 0.16, 0.05],
      ].map(([x, y, z, rot], i) => (
        <mesh key={i} position={[x, y, z]} rotation={[0, rot, Math.PI / 2]} material={logMat}>
          <cylinderGeometry args={[0.055, 0.06, 0.5, 12]} />
        </mesh>
      ))}
      <group ref={flames}>
        {[-0.2, -0.05, 0.1, 0.22].map((x, i) => (
          <mesh key={i} position={[x, 0.3, 0.17]}>
            <coneGeometry args={[0.07, 0.3 + (i % 2) * 0.08, 12]} />
            <meshBasicMaterial color={i % 2 ? '#ffb347' : '#ff7a1f'} transparent opacity={0.85} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
          </mesh>
        ))}
      </group>
      <pointLight ref={fire} color="#ff9a4a" intensity={2.6} distance={5} decay={2} position={[0, 0.45, 0.6]} />
      <Candelabrum x={-0.75} y={1.25} z={0.22} />
      <Candelabrum x={0.75} y={1.25} z={0.22} />
    </group>
  )
}

/**
 * A curtain panel hanging in folds, gathered by a tieback at `tieY` (far below the panel for a
 * straight drop). `outer` is the side it's tied back toward (−1 left, +1 right, 0 none); local
 * x runs across the panel, y up from its bottom, and the folds stand out toward +z.
 */
function curtainGeometry(width: number, height: number, outer: number, tieY: number, folds = 7, depth = 0.035): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(width, height, 96, 60)
  const pos = g.attributes.position as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i) + height / 2
    // How much the tieback pulls this height in toward the outer edge.
    const pull = 0.5 * Math.exp(-(((y - tieY) / 0.7) ** 2)) + (y < tieY ? 0.12 : 0)
    const edge = (outer * width) / 2
    const nx = edge + (x - edge) * (1 - pull)
    const fold = Math.sin(((x + width / 2) / width) * folds * Math.PI * 2) * (depth + pull * 0.03)
    pos.setXYZ(i, nx, y, fold + 0.06)
  }
  g.computeVertexNormals()
  return g
}

/**
 * A tall window on the last room's far wall: frosted panes glowing with daylight behind a white
 * sheer curtain that covers the whole window (nothing of the outside shows), red velvet drapes
 * hanging at either side from a gilt pole, under a pelmet with a gold fringe.
 */
export function Window({ plan }: { plan: MuseumPlan }) {
  const room = plan.rooms[plan.rooms.length - 1]
  const z = room.zBack
  const w = 2.2
  const y0 = 1.05
  const y1 = 3.35
  const wood = useMemo(() => varnishedWood(), [])
  const gold = useMemo(() => gilding(), [])
  const glass = useMemo(() => new THREE.MeshStandardMaterial({ color: '#000000', emissive: '#ffffff', emissiveMap: frostedGlassTexture(), emissiveIntensity: 1.1 }), [])
  // The sheer glows with the daylight behind it.
  const sheer = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#f7f3ec', emissive: '#fff4e4', emissiveIntensity: 0.55, roughness: 0.95, transparent: true, opacity: 0.94, side: THREE.DoubleSide }),
    [],
  )
  const velvet = useMemo(
    () => new THREE.MeshPhysicalMaterial({ color: '#6a121c', roughness: 0.85, sheen: 1, sheenRoughness: 0.4, sheenColor: new THREE.Color('#c0404f'), side: THREE.DoubleSide }),
    [],
  )
  // The sheer drops from the pole to the floor, as long as the drapes.
  const sheerPanel = useMemo(() => curtainGeometry(w + 0.2, 3.4, 0, -10, 16, 0.02), [])
  const drapes = useMemo(() => [-1, 1].map((outer) => curtainGeometry(0.85, 3.4, outer, -10, 6, 0.045)), [])
  useEffect(() => () => [wood, gold, glass, sheer, velvet].forEach((m) => m.dispose()), [wood, gold, glass, sheer, velvet])
  useEffect(() => () => [sheerPanel, ...drapes].forEach((g) => g.dispose()), [sheerPanel, drapes])
  return (
    <group position={[0, 0, z]}>
      <mesh position={[0, (y0 + y1) / 2, 0.006]} material={glass}>
        <planeGeometry args={[w, y1 - y0]} />
      </mesh>
      {/* Casing (the sheer hangs over the sill, so there is none to poke through it). */}
      {[-1, 1].map((x) => (
        <mesh key={x} position={[x * (w / 2 + 0.06), (y0 + y1) / 2, 0.03]} material={wood}>
          <boxGeometry args={[0.12, y1 - y0 + 0.24, 0.06]} />
        </mesh>
      ))}
      <rectAreaLight args={['#fff3e2', 3.2, w, y1 - y0]} position={[0, (y0 + y1) / 2, 0.12]} rotation={[0, Math.PI, 0]} />

      {/* The sheer, covering the whole window down to the floor, hung clear of the panelling's cap rail. */}
      <mesh geometry={sheerPanel} material={sheer} position={[0, 0.02, 0.13]} />
      {/* Red drapes at the sides, from the pole to the floor, a clear step in front of the sheer
          (their folds never reach back into it). */}
      {[-1, 1].map((outer, i) => (
        <mesh key={outer} geometry={drapes[i]} material={velvet} position={[outer * (w / 2 + 0.3), 0.02, 0.27]} />
      ))}
      <mesh position={[0, 3.46, 0.36]} rotation={[0, 0, Math.PI / 2]} material={gold}>
        <cylinderGeometry args={[0.024, 0.024, w + 1.6, 16]} />
      </mesh>
      {[-1, 1].map((x) => (
        <mesh key={x} position={[x * (w / 2 + 0.82), 3.46, 0.36]} material={gold}>
          <sphereGeometry args={[0.05, 16, 12]} />
        </mesh>
      ))}
      {/* Pelmet with a gold fringe, in front of everything. */}
      <mesh position={[0, 3.43, 0.44]} material={velvet}>
        <boxGeometry args={[w + 1.4, 0.3, 0.06]} />
      </mesh>
      <mesh position={[0, 3.27, 0.475]} material={gold}>
        <boxGeometry args={[w + 1.4, 0.04, 0.02]} />
      </mesh>
    </group>
  )
}

/** Everything standing on the floor of a furnished room. */
export function Furniture({ plan }: { plan: MuseumPlan }) {
  const wood = useMemo(() => varnishedWood(), [])
  const gold = useMemo(() => gilding(), [])
  useEffect(() => () => [wood, gold].forEach((m) => m.dispose()), [wood, gold])
  return (
    <group>
      {plan.features.map((f, i) => {
        if (f.kind === 'settee') return <Settee key={i} f={f} wood={wood} gold={gold} />
        if (f.kind === 'torch') return <Torchere key={i} f={f} gold={gold} />
        if (f.kind === 'pedestal') return <Pedestal key={i} f={f} wood={wood} gold={gold} />
        return <Fireplace key={i} f={f} />
      })}
    </group>
  )
}
