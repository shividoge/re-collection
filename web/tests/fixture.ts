// Synthetic capture for tests and local dev ONLY. The viewer shows a "synthetic test
// fixture" banner whenever it loads this, so it never passes for a real capture.
// A 4 m × 3 m × 2.5 m box room with a table, filmed by a phone held in portrait that
// circles the table. Geometry is known exactly, so tests can check the math against it.

import { encodeRoomBin, type FrameRecord } from '../src/scene/formats.ts'
import { rollColumnMajor, type Vec3 } from '../src/scene/pose.ts'

export const ROOM = { xMin: -2, xMax: 2, zMin: -1.5, zMax: 1.5, yMax: 2.5 }
export const TABLE = { center: [0, 0.75, 0] as Vec3, half: [0.6, 0.02, 0.4] as Vec3 }
export const K = [1450, 1450, 960, 720]
export const VIDEO = { width: 1920, height: 1440, fps: 30, durationSec: 12 }
export const ROLL_DEG = -90

const SPACING = 0.02

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
function norm(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2])
  return [a[0] / l, a[1] / l, a[2] / l]
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/** Column-major camera-to-world for a camera at `pos` looking at `target`, y up, then rolled. */
export function lookAtPose(pos: Vec3, target: Vec3, rollDeg: number): number[] {
  const f = norm(sub(target, pos))
  const x = norm(cross(f, [0, 1, 0]))
  const y = cross(x, f)
  const z: Vec3 = [-f[0], -f[1], -f[2]]
  const T = [...x, 0, ...y, 0, ...z, 0, ...pos, 1]
  return rollColumnMajor(T, (rollDeg * Math.PI) / 180)
}

export function makeRoomCloud(): { positions: Float32Array; colors: Uint8Array } {
  const pos: number[] = []
  const col: number[] = []
  const add = (p: Vec3, c: Vec3) => {
    pos.push(...p)
    col.push(...c)
  }
  const { xMin, xMax, zMin, zMax, yMax } = ROOM
  const steps = (a: number, b: number) => Math.round((b - a) / SPACING)
  const stripe = (v: number, base: Vec3): Vec3 => (Math.floor(v / 0.25) % 2 === 0 ? base : (base.map((c) => c * 0.8) as Vec3))
  // Floor: checkerboard.
  for (let i = 0; i <= steps(xMin, xMax); i++)
    for (let j = 0; j <= steps(zMin, zMax); j++) {
      const x = xMin + i * SPACING
      const z = zMin + j * SPACING
      const dark = (Math.floor((x - xMin) / 0.5) + Math.floor((z - zMin) / 0.5)) % 2 === 0
      add([x, 0, z], dark ? [120, 96, 72] : [200, 170, 130])
    }
  // Four walls, each its own color with horizontal stripes.
  for (let i = 0; i <= steps(xMin, xMax); i++)
    for (let j = 1; j <= steps(0, yMax); j++) {
      const x = xMin + i * SPACING
      const y = j * SPACING
      add([x, y, zMin], stripe(y, [90, 140, 200]))
      add([x, y, zMax], stripe(y, [220, 200, 120]))
    }
  for (let i = 1; i < steps(zMin, zMax); i++)
    for (let j = 1; j <= steps(0, yMax); j++) {
      const z = zMin + i * SPACING
      const y = j * SPACING
      add([xMin, y, z], stripe(y, [120, 190, 140]))
      add([xMax, y, z], stripe(y, [210, 140, 160]))
    }
  // Table top.
  const [cx, cy, cz] = TABLE.center
  const [hx, , hz] = TABLE.half
  for (let i = 0; i <= steps(-hx, hx); i++)
    for (let j = 0; j <= steps(-hz, hz); j++) add([cx - hx + i * SPACING, cy, cz - hz + j * SPACING], [190, 60, 50])
  return { positions: new Float32Array(pos), colors: new Uint8Array(col) }
}

export function makeFrames(): { scan: FrameRecord[]; moment: FrameRecord[] } {
  const { fps, durationSec } = VIDEO
  const n = Math.round(fps * durationSec)
  const moment: FrameRecord[] = []
  for (let i = 0; i < n; i++) {
    const t = i / fps
    const a = (t / durationSec) * Math.PI * 1.5
    const pos: Vec3 = [1.2 * Math.cos(a), 1.4 + 0.05 * Math.sin(3 * a), 1.0 * Math.sin(a)]
    moment.push({ i, t: +t.toFixed(4), T: lookAtPose(pos, TABLE.center, ROLL_DEG), K, track: 'normal', d: i % 3 === 0 ? i / 3 : null, phase: 'moment' })
  }
  const scan: FrameRecord[] = []
  for (let s = 0; s < 40; s++) {
    const t = -8 + s * 0.2
    const a = (s / 40) * Math.PI * 2
    scan.push({ t: +t.toFixed(4), T: lookAtPose([0.3 * Math.cos(a), 1.5, 0.3 * Math.sin(a)], [1.8 * Math.cos(a), 1.0, 1.4 * Math.sin(a)], ROLL_DEG), K, track: 'normal', d: null, phase: 'scan' })
  }
  return { scan, moment }
}

export function makeFixture() {
  const cloud = makeRoomCloud()
  const frames = makeFrames()
  const count = cloud.positions.length / 3
  const manifest = {
    format: 'braindance.capture',
    version: 1,
    id: 'synthetic-box-room',
    createdAt: '2026-10-24T00:00:00Z',
    device: 'synthetic-fixture',
    title: 'Synthetic box room (test fixture)',
    attendees: [],
    coordinates: 'arkit-world-meters-y-up',
    imageOrientation: 'landscapeRight',
    video: { file: 'video.mov', ...VIDEO, frameCount: frames.moment.length },
    room: { ply: null, bin: 'room.bin', points: count, voxelMeters: SPACING, source: 'synthetic' },
    phases: { scan: { tStart: frames.scan[0].t, tEnd: 0 }, moment: { tStart: 0, tEnd: VIDEO.durationSec } },
    warnings: ['synthetic test fixture: not a real capture'],
  }
  const jsonl = [...frames.scan, ...frames.moment].map((f) => JSON.stringify(f)).join('\n') + '\n'
  return { manifest, roomBin: encodeRoomBin(cloud.positions, cloud.colors), framesJsonl: jsonl, frames, cloud }
}
