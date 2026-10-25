// Where everything goes in a museum: the rooms an exhibition needs, the walls and doorways,
// where each picture hangs and how big, where a visitor stands to look at it, and where they
// may walk. Pure geometry, so it can be tested without a renderer.
//
// Rooms stand in a row along −z (the visitor enters at the front of the first room, looking
// down −z), joined by doorways in the middle of the walls between them. Pictures hang on the
// side walls, alternating left and right from front to back, then on the far wall; Next and
// Previous follow that order, so the visitor walks forward through the exhibition.

export type RoomStyle = 'classic' | 'calm' | 'gallery' | 'salon' | 'hall'

export interface StyleSpec {
  /** Room size in meters. */
  width: number
  depth: number
  height: number
  /** Pictures per side wall. */
  perSide: number
  /** Largest picture, frame excluded (m). */
  maxW: number
  maxH: number
  /** Doorway between rooms. */
  doorW: number
  doorH: number
  /** Height of a picture's center (m): eye level, or above the panelling where there is some. */
  hang: number
}

export const STYLES: Record<RoomStyle, StyleSpec> = {
  // A classic picture gallery (rose-red fabric walls, dark wood panelling, a skylight), kept to
  // a modest height and a single row of large pictures. The doorway is arched.
  classic: { width: 7, depth: 9.5, height: 4.4, perSide: 2, maxW: 1.45, maxH: 1.05, doorW: 1.7, doorH: 2.45, hang: 1.85 },
  // The calm room, for the person with dementia (docs/museum.md "Why the calm room"): the
  // size of a living room, a home-height ceiling, few but large pictures per room.
  calm: { width: 6.4, depth: 7.2, height: 3.1, perSide: 2, maxW: 1.45, maxH: 1.15, doorW: 1.6, doorH: 2.35, hang: 1.55 },
  // A bright modern gallery: pale wood, white walls, a skylight.
  gallery: { width: 9, depth: 12, height: 4.4, perSide: 3, maxW: 1.9, maxH: 1.35, doorW: 2.2, doorH: 3, hang: 1.55 },
  // A warm salon: deep walls, parquet, gilded frames under picture lights.
  salon: { width: 7.6, depth: 9.6, height: 4.6, perSide: 3, maxW: 1.5, maxH: 1.2, doorW: 1.8, doorH: 2.8, hang: 1.62 },
  // A grand hall: tall, long, stone floor, arches.
  hall: { width: 9, depth: 17, height: 7, perSide: 4, maxW: 2.2, maxH: 1.6, doorW: 2.6, doorH: 4.2, hang: 1.6 },
}

/** Wall thickness (m). */
export const WALL = 0.24
/** How close a visitor may come to a wall (m). */
export const MARGIN = 0.45

export interface Room {
  index: number
  x0: number
  x1: number
  /** Front (nearer the entrance, larger z) and back. */
  zFront: number
  zBack: number
  height: number
}

/** A straight piece of wall, as the line along its face; `normal` points into the room. */
export interface WallPiece {
  a: [number, number]
  b: [number, number]
  normal: [number, number]
  room: number
}

/** A doorway in the wall between room `room` and room `room + 1`, centered on x = 0. */
export interface Doorway {
  room: number
  z: number
  width: number
  height: number
}

/** Where one picture hangs. */
export interface Slot {
  index: number
  room: number
  /** Center of the picture on the wall face (x, y, z). */
  center: [number, number, number]
  /** Unit vector out of the wall, into the room (x, z). */
  normal: [number, number]
  /** Largest picture that fits here (m). */
  maxW: number
  maxH: number
  /** Where a visitor stands to look at it (x, z), and the point they look at. */
  view: [number, number]
}

/**
 * Something standing on the floor that visitors walk around: a bench, a vitrine (a glass case
 * with a visit's 3D scan inside), or a plinth with a sculpture. A rectangle on the floor.
 */
export interface Feature {
  kind: 'bench' | 'vitrine' | 'plinth'
  room: number
  x: number
  z: number
  /** Half its width (along x) and depth (along z), in meters. */
  hw: number
  hd: number
}

/** How far visitors keep from furniture (m). */
const CLEARANCE = 0.25

export interface MuseumPlan {
  style: RoomStyle
  spec: StyleSpec
  rooms: Room[]
  walls: WallPiece[]
  doorways: Doorway[]
  slots: Slot[]
  features: Feature[]
  /** Where the visitor starts (x, z), facing −z. */
  start: [number, number]
}

/** How many pictures one room holds: both side walls, plus the far wall. */
function capacity(spec: StyleSpec, last: boolean): number {
  // The far wall has a doorway unless it's the last room: then one picture either side of it,
  // otherwise one picture in the middle.
  return spec.perSide * 2 + (last ? 1 : 2)
}

/** The rooms an exhibition of `count` pictures needs, with walls, doorways and picture slots. */
export function planMuseum(count: number, style: RoomStyle): MuseumPlan {
  const spec = STYLES[style]
  let rooms = 1
  while (true) {
    let fits = 0
    for (let r = 0; r < rooms; r++) fits += capacity(spec, r === rooms - 1)
    if (fits >= count) break
    rooms++
  }

  const half = spec.width / 2
  const roomList: Room[] = []
  for (let r = 0; r < rooms; r++) {
    const zFront = -r * (spec.depth + WALL)
    roomList.push({ index: r, x0: -half, x1: half, zFront, zBack: zFront - spec.depth, height: spec.height })
  }

  const walls: WallPiece[] = []
  const doorways: Doorway[] = []
  for (const room of roomList) {
    const last = room.index === rooms - 1
    walls.push({ a: [room.x0, room.zFront], b: [room.x0, room.zBack], normal: [1, 0], room: room.index })
    walls.push({ a: [room.x1, room.zFront], b: [room.x1, room.zBack], normal: [-1, 0], room: room.index })
    // Front wall: solid in the first room (the exhibition's title hangs there), otherwise the
    // doorway from the previous room.
    if (room.index === 0) walls.push({ a: [room.x0, room.zFront], b: [room.x1, room.zFront], normal: [0, -1], room: 0 })
    else {
      walls.push({ a: [room.x0, room.zFront], b: [-spec.doorW / 2, room.zFront], normal: [0, -1], room: room.index })
      walls.push({ a: [spec.doorW / 2, room.zFront], b: [room.x1, room.zFront], normal: [0, -1], room: room.index })
    }
    if (last) walls.push({ a: [room.x0, room.zBack], b: [room.x1, room.zBack], normal: [0, 1], room: room.index })
    else {
      walls.push({ a: [room.x0, room.zBack], b: [-spec.doorW / 2, room.zBack], normal: [0, 1], room: room.index })
      walls.push({ a: [spec.doorW / 2, room.zBack], b: [room.x1, room.zBack], normal: [0, 1], room: room.index })
      doorways.push({ room: room.index, z: room.zBack - WALL / 2, width: spec.doorW, height: spec.doorH })
    }
  }

  // Slots, in visiting order: side walls alternating left and right, front to back, then the far wall.
  const slots: Slot[] = []
  const add = (room: Room, center: [number, number, number], normal: [number, number], maxW: number, maxH: number) => {
    // Stand back far enough to see the whole picture with its frame and label around it, but
    // not so far that a side-wall picture puts you against the opposite wall.
    const reach = normal[0] !== 0 ? spec.width - MARGIN - 0.3 : spec.depth - MARGIN - 0.3
    const back = Math.min(reach, Math.max(2.4, maxW * 1.35, maxH * 2))
    slots.push({
      index: slots.length,
      room: room.index,
      center,
      normal,
      maxW,
      maxH,
      view: [center[0] + normal[0] * back, center[2] + normal[1] * back],
    })
  }
  let left = count
  for (const room of roomList) {
    if (left <= 0) break
    const last = room.index === rooms - 1
    const sideSpacing = spec.depth / spec.perSide
    const sideW = Math.min(spec.maxW, sideSpacing * 0.7)
    for (let k = 0; k < spec.perSide && left > 0; k++) {
      const z = room.zFront - sideSpacing * (k + 0.5)
      add(room, [room.x0, spec.hang, z], [1, 0], sideW, spec.maxH)
      left--
      if (left <= 0) break
      add(room, [room.x1, spec.hang, z], [-1, 0], sideW, spec.maxH)
      left--
    }
    if (left <= 0) break
    if (last) {
      // The far wall of the last room: one picture, a little larger, in the middle.
      add(room, [0, spec.hang, room.zBack], [0, 1], Math.min(spec.width * 0.4, spec.maxW * 1.2), spec.maxH * 1.15)
      left--
    } else {
      // Either side of the doorway.
      const sideOfDoor = (half - spec.doorW / 2) / 2 + spec.doorW / 2
      const w = Math.min(spec.maxW, (half - spec.doorW / 2) * 0.7)
      add(room, [-sideOfDoor, spec.hang, room.zBack], [0, 1], w, spec.maxH)
      left--
      if (left <= 0) break
      add(room, [sideOfDoor, spec.hang, room.zBack], [0, 1], w, spec.maxH)
      left--
    }
  }

  // The classic gallery is furnished: a bench and a vitrine down the middle of each room,
  // sculptures on plinths in the corners that have no picture in front of them.
  const features: Feature[] = []
  if (style === 'classic') {
    for (const room of roomList) {
      const cz = (room.zFront + room.zBack) / 2
      features.push({ kind: 'bench', room: room.index, x: 0, z: cz + 1.9, hw: 0.8, hd: 0.32 })
      features.push({ kind: 'vitrine', room: room.index, x: 0, z: cz - 1, hw: 0.42, hd: 0.42 })
      const corner = half - 0.75
      for (const x of [-corner, corner]) {
        features.push({ kind: 'plinth', room: room.index, x, z: room.zFront - 0.75, hw: 0.3, hd: 0.3 })
        if (room.index === rooms - 1) features.push({ kind: 'plinth', room: room.index, x, z: room.zBack + 0.75, hw: 0.3, hd: 0.3 })
      }
    }
  }

  return { style, spec, rooms: roomList, walls, doorways, slots, features, start: [0, roomList[0].zFront - 1.6] }
}

/** Whether a visitor may stand at (x, z): inside a room, or in a doorway, away from walls. */
export function walkable(plan: MuseumPlan, x: number, z: number): boolean {
  for (const f of plan.features) if (Math.abs(x - f.x) < f.hw + CLEARANCE && Math.abs(z - f.z) < f.hd + CLEARANCE) return false
  for (const r of plan.rooms) {
    if (x > r.x0 + MARGIN && x < r.x1 - MARGIN && z < r.zFront - MARGIN && z > r.zBack + MARGIN) return true
  }
  for (const d of plan.doorways) {
    const halfW = d.width / 2 - MARGIN * 0.6
    if (Math.abs(x) < halfW && Math.abs(z - d.z) < WALL / 2 + MARGIN + 0.05) return true
  }
  return false
}

/**
 * Moves from `from` toward `to` as far as walls allow, sliding along a wall instead of stopping
 * dead when the move is at a slant to it.
 */
export function slide(plan: MuseumPlan, from: [number, number], to: [number, number]): [number, number] {
  if (walkable(plan, to[0], to[1])) return to
  if (walkable(plan, to[0], from[1])) return [to[0], from[1]]
  if (walkable(plan, from[0], to[1])) return [from[0], to[1]]
  return from
}

/** The room (x, z) is in, or the nearest one along z. */
export function roomAt(plan: MuseumPlan, z: number): number {
  for (const r of plan.rooms) if (z <= r.zFront && z >= r.zBack - WALL) return r.index
  return z > 0 ? 0 : plan.rooms.length - 1
}

/**
 * The way from one point to another: straight within a room, through the middle of each
 * doorway in between otherwise (rooms only connect through their doorways).
 */
export function route(plan: MuseumPlan, from: [number, number], to: [number, number]): [number, number][] {
  const a = roomAt(plan, from[1])
  const b = roomAt(plan, to[1])
  const stops: [number, number][] = []
  if (a < b) for (let r = a; r < b; r++) stops.push([0, plan.doorways[r].z])
  else for (let r = a - 1; r >= b; r--) stops.push([0, plan.doorways[r].z])
  stops.push(to)
  // Step around furniture in the way, going round it on the side the walk is already nearer:
  // walking mostly forward, pass it to the left or right; walking mostly across, pass in front
  // of it or behind it.
  const points: [number, number][] = []
  let at = from
  for (const stop of stops) {
    const blocking = plan.features
      .filter((f) => crosses(at, stop, f))
      .sort((p, q) => Math.hypot(p.x - at[0], p.z - at[1]) - Math.hypot(q.x - at[0], q.z - at[1]))
    for (const f of blocking) {
      const ox = f.hw + CLEARANCE + 0.35
      const oz = f.hd + CLEARANCE + 0.35
      if (Math.abs(stop[1] - at[1]) >= Math.abs(stop[0] - at[0])) {
        const x = f.x + ((stop[0] + at[0]) / 2 >= f.x ? ox : -ox)
        const dir = stop[1] < at[1] ? -1 : 1
        points.push([x, f.z - dir * oz], [x, f.z + dir * oz])
      } else {
        const z = f.z + ((stop[1] + at[1]) / 2 >= f.z ? oz : -oz)
        const dir = stop[0] < at[0] ? -1 : 1
        points.push([f.x - dir * ox, z], [f.x + dir * ox, z])
      }
    }
    points.push(stop)
    at = stop
  }
  return points
}

/** Whether the straight line from `a` to `b` passes through `f` (with the clearance around it). */
function crosses(a: [number, number], b: [number, number], f: Feature): boolean {
  const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.05)
  for (let i = 0; i <= steps; i++) {
    const t = i / Math.max(1, steps)
    const x = a[0] + (b[0] - a[0]) * t
    const z = a[1] + (b[1] - a[1]) * t
    if (Math.abs(x - f.x) < f.hw + CLEARANCE && Math.abs(z - f.z) < f.hd + CLEARANCE) return true
  }
  return false
}

/** The size a picture of aspect `aspect` (w/h) is hung at in `slot`. */
export function fitPicture(slot: Slot, aspect: number): { w: number; h: number } {
  let h = slot.maxH
  let w = h * aspect
  if (w > slot.maxW) {
    w = slot.maxW
    h = w / aspect
  }
  return { w, h }
}
