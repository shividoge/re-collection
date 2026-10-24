import { MeshReflectorMaterial, RoundedBox } from '@react-three/drei'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js'
import { WALL, type MuseumPlan, type Room } from './layout'
import type { Look } from './looks'
import { plaster, stoneFloor, titleTexture, woodFloor, type SurfaceMaps } from './textures'

RectAreaLightUniformsLib.init()

/** Generated surfaces are slow to make (a second or so), so each is made once per look. */
const floorCache = new Map<string, SurfaceMaps>()
const plasterCache = new Map<string, SurfaceMaps>()

function floorMaps(look: Look): SurfaceMaps {
  const key = `${look.floor.kind}:${look.floor.light}:${look.floor.dark}`
  let maps = floorCache.get(key)
  if (!maps) {
    const f = look.floor
    maps = f.kind === 'stone' ? stoneFloor(f.light, f.dark) : woodFloor(f.kind, f.light, f.dark)
    floorCache.set(key, maps)
  }
  return maps
}

function plasterMaps(color: [number, number, number]): SurfaceMaps {
  const key = color.join(',')
  let maps = plasterCache.get(key)
  if (!maps) plasterCache.set(key, (maps = plaster(color)))
  return maps
}

/** Copies of the maps tiled `rx` × `ry` times (copies share the pixels). */
function tiled(maps: SurfaceMaps, rx: number, ry: number, rotation = 0): SurfaceMaps {
  const copy = (t: THREE.Texture) => {
    const c = t.clone()
    c.repeat.set(rx, ry)
    c.rotation = rotation
    c.needsUpdate = true
    return c
  }
  return { map: copy(maps.map), normalMap: copy(maps.normalMap), roughnessMap: copy(maps.roughnessMap) }
}

/** Quads as one geometry: each quad is four corners (counter-clockwise seen from the front) and their UVs. */
function quads(list: { p: THREE.Vector3[]; uv: [number, number][] }[]): THREE.BufferGeometry {
  const pos: number[] = []
  const uv: number[] = []
  const index: number[] = []
  for (const q of list) {
    const base = pos.length / 3
    for (let i = 0; i < 4; i++) {
      pos.push(q.p[i].x, q.p[i].y, q.p[i].z)
      uv.push(...q.uv[i])
    }
    index.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(index)
  g.computeVertexNormals()
  return g
}

/** Plaster repeats every this many meters on walls and ceilings. */
const WALL_TILE = 2

/** A vertical quad on the face of a wall from `a` to `b` (x, z), between heights y0 and y1, facing `normal`. */
function wallQuad(a: [number, number], b: [number, number], y0: number, y1: number, normal: [number, number], offset = 0) {
  const ox = normal[0] * offset
  const oz = normal[1] * offset
  // Order the ends so the quad faces along `normal`.
  const cross = (b[0] - a[0]) * normal[1] - (b[1] - a[1]) * normal[0]
  const [p, q] = cross > 0 ? [a, b] : [b, a]
  const len = Math.hypot(q[0] - p[0], q[1] - p[1])
  const start = (p[0] + p[1]) / WALL_TILE
  return {
    p: [
      new THREE.Vector3(p[0] + ox, y0, p[1] + oz),
      new THREE.Vector3(q[0] + ox, y0, q[1] + oz),
      new THREE.Vector3(q[0] + ox, y1, q[1] + oz),
      new THREE.Vector3(p[0] + ox, y1, p[1] + oz),
    ],
    uv: [
      [start, y0 / WALL_TILE],
      [start + len / WALL_TILE, y0 / WALL_TILE],
      [start + len / WALL_TILE, y1 / WALL_TILE],
      [start, y1 / WALL_TILE],
    ] as [number, number][],
  }
}

/** A box `length` long along a wall face, `h` tall and `d` deep, standing out from the face. */
function Strip({ a, b, normal, y, h, d, material }: { a: [number, number]; b: [number, number]; normal: [number, number]; y: number; h: number; d: number; material: THREE.Material }) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1])
  const cx = (a[0] + b[0]) / 2 + (normal[0] * d) / 2
  const cz = (a[1] + b[1]) / 2 + (normal[1] * d) / 2
  const along = Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1])
  return (
    <mesh position={[cx, y + h / 2, cz]} material={material} castShadow={false} receiveShadow>
      <boxGeometry args={along ? [len, h, d] : [d, h, len]} />
    </mesh>
  )
}

export function Rooms({ plan, look, title, subtitle, reflections }: { plan: MuseumPlan; look: Look; title: string; subtitle: string; reflections: number }) {
  const { spec, rooms, walls, doorways } = plan
  const first = rooms[0]
  const last = rooms[rooms.length - 1]
  const floorW = spec.width
  const floorD = first.zFront - last.zBack

  const floor = useMemo(() => {
    const t = look.floor.metersPerTile
    // Herringbone is laid at 45°, as it usually is.
    return tiled(floorMaps(look), floorW / t, floorD / t, look.floor.kind === 'herringbone' ? Math.PI / 4 : 0)
  }, [look, floorW, floorD])

  const wallMaterial = useMemo(() => {
    const m = plasterMaps(look.wall)
    return new THREE.MeshStandardMaterial({ map: m.map, normalMap: m.normalMap, normalScale: new THREE.Vector2(0.35, 0.35), roughnessMap: m.roughnessMap, roughness: 1, envMapIntensity: 0.6 })
  }, [look])
  const wainscotMaterial = useMemo(() => {
    if (!look.wainscot) return null
    const m = plasterMaps(look.wainscot)
    return new THREE.MeshStandardMaterial({ map: m.map, normalMap: m.normalMap, roughness: 0.7, envMapIntensity: 0.8 })
  }, [look])
  const trimMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: look.trim,
        roughness: look.frame.metalness > 0.5 ? 0.35 : 0.55,
        metalness: look.frame.metalness > 0.5 ? 0.75 : 0,
        envMapIntensity: 1,
      }),
    [look],
  )
  const ceilingMaterial = useMemo(() => new THREE.MeshStandardMaterial({ color: look.ceiling, roughness: 0.95 }), [look])
  useEffect(() => () => [wallMaterial, wainscotMaterial, trimMaterial, ceilingMaterial].forEach((m) => m?.dispose()), [wallMaterial, wainscotMaterial, trimMaterial, ceilingMaterial])

  // Wall faces, door jambs and the wall above each doorway, as one mesh.
  const wallGeometry = useMemo(() => {
    const list = walls.map((w) => wallQuad(w.a, w.b, 0, rooms[w.room].height, w.normal))
    for (const d of doorways) {
      const zf = d.z + WALL / 2
      const zb = d.z - WALL / 2
      const half = d.width / 2
      const h = rooms[d.room].height
      // Above the doorway, on both sides.
      list.push(wallQuad([-half, zf], [half, zf], d.height, h, [0, 1]))
      list.push(wallQuad([-half, zb], [half, zb], d.height, h, [0, -1]))
      // The sides of the opening, and its underside.
      list.push(wallQuad([-half, zf], [-half, zb], 0, d.height, [1, 0]))
      list.push(wallQuad([half, zf], [half, zb], 0, d.height, [-1, 0]))
      list.push({
        p: [new THREE.Vector3(-half, d.height, zb), new THREE.Vector3(half, d.height, zb), new THREE.Vector3(half, d.height, zf), new THREE.Vector3(-half, d.height, zf)],
        uv: [
          [0, 0],
          [1, 0],
          [1, 0.1],
          [0, 0.1],
        ],
      })
    }
    return quads(list)
  }, [walls, doorways, rooms])
  useEffect(() => () => wallGeometry.dispose(), [wallGeometry])

  const wainscotGeometry = useMemo(() => (look.wainscot ? quads(walls.map((w) => wallQuad(w.a, w.b, 0, 0.95, w.normal, 0.012))) : null), [walls, look])
  useEffect(() => () => wainscotGeometry?.dispose(), [wainscotGeometry])

  const titleArt = useMemo(() => titleTexture(title, subtitle, look.titleInk, look.accent), [title, subtitle, look])
  useEffect(() => () => titleArt.texture.dispose(), [titleArt])
  const titleW = Math.min(spec.width * 0.72, 5.6)

  return (
    <group>
      <hemisphereLight args={[look.light, '#3a2c22', 0.45]} />

      {/* One floor under every room, so its reflections are rendered once. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, (first.zFront + last.zBack) / 2]} receiveShadow>
        <planeGeometry args={[floorW + WALL * 2, floorD + WALL * 2]} />
        {reflections > 0 ? (
          <MeshReflectorMaterial
            {...floor}
            normalScale={new THREE.Vector2(0.6, 0.6)}
            roughness={1}
            metalness={0}
            envMapIntensity={0.7}
            resolution={reflections}
            blur={[400, 120]}
            mixBlur={1.2}
            mixStrength={look.floor.mirror * 2.2}
            mixContrast={1}
            depthScale={0.6}
            minDepthThreshold={0.6}
            maxDepthThreshold={1.4}
            mirror={look.floor.mirror}
          />
        ) : (
          <meshStandardMaterial {...floor} normalScale={new THREE.Vector2(0.6, 0.6)} roughness={1} envMapIntensity={0.9} />
        )}
      </mesh>

      <mesh geometry={wallGeometry} material={wallMaterial} receiveShadow />
      {wainscotGeometry && wainscotMaterial && <mesh geometry={wainscotGeometry} material={wainscotMaterial} />}

      {walls.map((w, i) => {
        const h = rooms[w.room].height
        return (
          <group key={i}>
            {/* Skirting board, and the cornice where wall meets ceiling. */}
            <Strip a={w.a} b={w.b} normal={w.normal} y={0} h={0.16} d={0.025} material={trimMaterial} />
            <Strip a={w.a} b={w.b} normal={w.normal} y={h - 0.16} h={0.16} d={0.05} material={trimMaterial} />
            <Strip a={w.a} b={w.b} normal={w.normal} y={h - 0.26} h={0.1} d={0.025} material={trimMaterial} />
            {look.wainscot && <Strip a={w.a} b={w.b} normal={w.normal} y={0.93} h={0.05} d={0.03} material={trimMaterial} />}
          </group>
        )
      })}

      {doorways.map((d) => (
        <DoorCasing key={d.room} z={d.z} width={d.width} height={d.height} material={trimMaterial} grand={plan.style === 'hall'} />
      ))}

      {rooms.map((room) => (
        <group key={room.index}>
          <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, room.height, (room.zFront + room.zBack) / 2]} material={ceilingMaterial}>
            <planeGeometry args={[spec.width, spec.depth]} />
          </mesh>
          <Ceiling style={plan.style} room={room} width={spec.width} look={look} />
          <Bench style={plan.style} room={room} look={look} />
        </group>
      ))}

      {/* The exhibition's title, lettered on the entrance wall. */}
      <mesh position={[0, 2.35, first.zFront - 0.006]} rotation={[0, Math.PI, 0]}>
        <planeGeometry args={[titleW, titleW / titleArt.aspect]} />
        <meshBasicMaterial map={titleArt.texture} transparent toneMapped={false} />
      </mesh>
    </group>
  )
}

/** The frame around a doorway, on both faces of the wall; pilasters in the grand hall. */
function DoorCasing({ z, width, height, material, grand }: { z: number; width: number; height: number; material: THREE.Material; grand: boolean }) {
  const w = grand ? 0.45 : 0.12
  const d = grand ? 0.08 : 0.035
  return (
    <group>
      {[1, -1].map((side) => {
        const face = z + (side * WALL) / 2 + (side * d) / 2
        return (
          <group key={side}>
            <mesh position={[-width / 2 - w / 2, (height + (grand ? 0.6 : 0.12)) / 2, face]} material={material}>
              <boxGeometry args={[w, height + (grand ? 0.6 : 0.12), d]} />
            </mesh>
            <mesh position={[width / 2 + w / 2, (height + (grand ? 0.6 : 0.12)) / 2, face]} material={material}>
              <boxGeometry args={[w, height + (grand ? 0.6 : 0.12), d]} />
            </mesh>
            <mesh position={[0, height + (grand ? 0.3 : 0.06), face]} material={material}>
              <boxGeometry args={[width + w * 2, grand ? 0.6 : 0.12, d]} />
            </mesh>
          </group>
        )
      })}
    </group>
  )
}

/** Each style's ceiling: a skylight, a salon's chandelier, or the hall's beams and high windows. */
function Ceiling({ style, room, width, look }: { style: MuseumPlan['style']; room: Room; width: number; look: Look }) {
  const cz = (room.zFront + room.zBack) / 2
  const depth = room.zFront - room.zBack
  const h = room.height
  const glow = useMemo(() => new THREE.MeshStandardMaterial({ color: '#000000', emissive: look.light, emissiveIntensity: 1.4, toneMapped: true }), [look])
  const dark = useMemo(() => new THREE.MeshStandardMaterial({ color: '#2a2622', roughness: 0.6 }), [])
  useEffect(() => () => [glow, dark].forEach((m) => m.dispose()), [glow, dark])

  if (style === 'gallery') {
    // A long skylight down the middle, with its light falling into the room.
    const sw = width * 0.45
    const sd = depth * 0.62
    const bars = 6
    return (
      <group>
        <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, h - 0.004, cz]} material={glow}>
          <planeGeometry args={[sw, sd]} />
        </mesh>
        {Array.from({ length: bars + 1 }, (_, i) => (
          <mesh key={i} position={[0, h - 0.03, cz - sd / 2 + (i * sd) / bars]} material={dark}>
            <boxGeometry args={[sw, 0.05, 0.05]} />
          </mesh>
        ))}
        <mesh position={[0, h - 0.03, cz]} material={dark}>
          <boxGeometry args={[0.05, 0.05, sd]} />
        </mesh>
        <rectAreaLight args={[look.light, 5.5, sw, sd]} position={[0, h - 0.05, cz]} rotation={[-Math.PI / 2, 0, 0]} />
      </group>
    )
  }
  if (style === 'salon') {
    // A ceiling rose and a warm chandelier in the middle of the room.
    return (
      <group>
        <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, h - 0.006, cz]}>
          <circleGeometry args={[0.7, 48]} />
          <meshStandardMaterial color={look.trim} roughness={0.5} metalness={0.4} />
        </mesh>
        <mesh position={[0, h - 0.4, cz]}>
          <cylinderGeometry args={[0.008, 0.008, 0.8, 8]} />
          <meshStandardMaterial color={look.trim} metalness={0.8} roughness={0.3} />
        </mesh>
        <mesh position={[0, h - 0.85, cz]}>
          <torusGeometry args={[0.38, 0.018, 12, 48]} />
          <meshStandardMaterial color={look.trim} metalness={0.9} roughness={0.25} />
        </mesh>
        {Array.from({ length: 8 }, (_, i) => {
          const a = (i / 8) * Math.PI * 2
          return (
            <mesh key={i} position={[Math.cos(a) * 0.38, h - 0.78, cz + Math.sin(a) * 0.38]} material={glow}>
              <sphereGeometry args={[0.045, 16, 12]} />
            </mesh>
          )
        })}
        <pointLight color={look.light} intensity={14} distance={11} decay={2} position={[0, h - 0.9, cz]} />
      </group>
    )
  }
  // The grand hall: beams across, and a band of high windows down both sides.
  const beams = Math.max(3, Math.round(depth / 2.8))
  return (
    <group>
      {Array.from({ length: beams }, (_, i) => (
        <mesh key={i} position={[0, h - 0.22, room.zFront - ((i + 0.5) * depth) / beams]}>
          <boxGeometry args={[width, 0.44, 0.32]} />
          <meshStandardMaterial color={look.trim} roughness={0.8} />
        </mesh>
      ))}
      {[-1, 1].map((side) => (
        <group key={side}>
          <mesh position={[side * (width / 2 - 0.01), h - 0.9, cz]} rotation={[0, -side * (Math.PI / 2), 0]} material={glow}>
            <planeGeometry args={[depth * 0.86, 0.9]} />
          </mesh>
          <rectAreaLight
            args={[look.light, 4, depth * 0.86, 0.9]}
            position={[side * (width / 2 - 0.05), h - 0.9, cz]}
            rotation={[0, side * (Math.PI / 2), 0]}
            onUpdate={(l) => l.lookAt(0, 1.2, cz)}
          />
        </group>
      ))}
    </group>
  )
}

/** Somewhere to sit and look, in the middle of each room. */
function Bench({ style, room, look }: { style: MuseumPlan['style']; room: Room; look: Look }) {
  const cz = (room.zFront + room.zBack) / 2
  if (style === 'salon') {
    return (
      <group position={[0, 0, cz + 0.6]}>
        <RoundedBox args={[1.5, 0.16, 0.5]} radius={0.06} smoothness={4} position={[0, 0.42, 0]}>
          <meshStandardMaterial color="#7c2f3c" roughness={0.85} />
        </RoundedBox>
        {[-0.65, 0.65].flatMap((x) =>
          [-0.18, 0.18].map((z) => (
            <mesh key={`${x},${z}`} position={[x, 0.17, z]}>
              <cylinderGeometry args={[0.022, 0.016, 0.34, 12]} />
              <meshStandardMaterial color={look.trim} metalness={0.9} roughness={0.3} />
            </mesh>
          )),
        )}
      </group>
    )
  }
  if (style === 'hall') {
    return (
      <group>
        {[-1, 1].map((s) => (
          <RoundedBox key={s} args={[2.2, 0.46, 0.55]} radius={0.04} smoothness={3} position={[0, 0.23, cz + s * 2.2]}>
            <meshStandardMaterial color="#bdb2a2" roughness={0.6} />
          </RoundedBox>
        ))}
      </group>
    )
  }
  return (
    <RoundedBox args={[1.7, 0.44, 0.5]} radius={0.03} smoothness={3} position={[0, 0.22, cz + 0.4]}>
      <meshStandardMaterial color="#b88b5c" roughness={0.55} />
    </RoundedBox>
  )
}
