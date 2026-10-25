import { MeshReflectorMaterial } from '@react-three/drei'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js'
import { ArchDoorways, Carpets, Cornice, FloorBorder, Lantern, varnishedWood, Wainscot } from './Classic'
import { WALL, type MuseumPlan } from './layout'
import type { Look } from './looks'
import { fabric, titleTexture, woodFloor, type SurfaceMaps } from './textures'

RectAreaLightUniformsLib.init()

/** Generated surfaces are slow to make (a second or so), so each is made once per look. */
const floorCache = new Map<string, SurfaceMaps>()
const wallCache = new Map<string, SurfaceMaps>()

function floorMaps(look: Look): SurfaceMaps {
  const key = `${look.floor.light}:${look.floor.dark}`
  let maps = floorCache.get(key)
  if (!maps) floorCache.set(key, (maps = woodFloor(look.floor.light, look.floor.dark)))
  return maps
}

function wallMaps(color: [number, number, number]): SurfaceMaps {
  const key = color.join(',')
  let maps = wallCache.get(key)
  if (!maps) wallCache.set(key, (maps = fabric(color)))
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

/** The wall fabric repeats every this many meters. */
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

export function Rooms({ plan, look, title, subtitle, reflections }: { plan: MuseumPlan; look: Look; title: string; subtitle: string; reflections: number }) {
  const { spec, rooms, walls, doorways } = plan
  const first = rooms[0]
  const last = rooms[rooms.length - 1]
  const floorW = spec.width
  const floorD = first.zFront - last.zBack

  const floor = useMemo(() => {
    const t = look.floor.metersPerTile
    // Herringbone is laid at 45°, as it usually is.
    return tiled(floorMaps(look), floorW / t, floorD / t, Math.PI / 4)
  }, [look, floorW, floorD])

  const wallMaterial = useMemo(() => {
    const m = wallMaps(look.wall)
    return new THREE.MeshStandardMaterial({ map: m.map, normalMap: m.normalMap, normalScale: new THREE.Vector2(0.35, 0.35), roughnessMap: m.roughnessMap, roughness: 1, envMapIntensity: 0.6 })
  }, [look])
  const wainscotMaterial = useMemo(() => varnishedWood(), [])
  const ceilingMaterial = useMemo(() => new THREE.MeshStandardMaterial({ color: look.ceiling, roughness: 0.95 }), [look])
  useEffect(() => () => [wallMaterial, wainscotMaterial, ceilingMaterial].forEach((m) => m.dispose()), [wallMaterial, wainscotMaterial, ceilingMaterial])

  // Wall faces, door jambs and the wall above each doorway, as one mesh.
  const wallGeometry = useMemo(() => {
    const list = walls.map((w) => wallQuad(w.a, w.b, 0, rooms[w.room].height, w.normal))
    for (const d of doorways) {
      const zf = d.z + WALL / 2
      const zb = d.z - WALL / 2
      const half = d.width / 2
      // The sides of the opening; its arched top is its own piece (Classic.tsx ArchDoorways).
      list.push(wallQuad([-half, zf], [-half, zb], 0, d.height, [1, 0]))
      list.push(wallQuad([half, zf], [half, zb], 0, d.height, [-1, 0]))
    }
    return quads(list)
  }, [walls, doorways, rooms])
  useEffect(() => () => wallGeometry.dispose(), [wallGeometry])

  const wainscotGeometry = useMemo(() => quads(walls.map((w) => wallQuad(w.a, w.b, 0, look.wainscotHeight, w.normal, 0.012))), [walls, look])
  useEffect(() => () => wainscotGeometry.dispose(), [wainscotGeometry])

  const titleArt = useMemo(() => titleTexture(title, subtitle, look.titleInk, look.accent), [title, subtitle, look])
  useEffect(() => () => titleArt.texture.dispose(), [titleArt])
  // The title sits between the mantel's candelabra and the cornice.
  const titleW = 4.2

  return (
    <group>
      <hemisphereLight args={[look.light, '#3a2c22', 0.85]} />

      {/* One floor under every room, so its reflections are rendered once. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, (first.zFront + last.zBack) / 2]} receiveShadow>
        <planeGeometry args={[floorW + WALL * 2, floorD + WALL * 2]} />
        {reflections > 0 && look.floor.mirror > 0 ? (
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
      <mesh geometry={wainscotGeometry} material={wainscotMaterial} />
      <Wainscot plan={plan} look={look} />
      <Cornice plan={plan} look={look} />
      <ArchDoorways plan={plan} wallMaterial={wallMaterial} />
      <FloorBorder plan={plan} />
      <Carpets plan={plan} />

      {rooms.map((room) => (
        <group key={room.index}>
          <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, room.height, (room.zFront + room.zBack) / 2]} material={ceilingMaterial}>
            <planeGeometry args={[spec.width, spec.depth]} />
          </mesh>
          <Lantern room={room} width={spec.width} look={look} />
        </group>
      ))}

      {/* The exhibition's title, lettered on the entrance wall above the fireplace. */}
      <mesh position={[0, 2.65, first.zFront - 0.006]} rotation={[0, Math.PI, 0]}>
        <planeGeometry args={[titleW, titleW / titleArt.aspect]} />
        <meshBasicMaterial map={titleArt.texture} transparent toneMapped={false} />
      </mesh>
    </group>
  )
}
