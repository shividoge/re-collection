// A small synthetic capture for tests: a camera at the origin looking down −z at a flat wall
// 1.5 m away, three scan frames, and a short visit (two depth frames, two keyframes) in which
// a 30 cm square stands 1 m from the camera.
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { encodeRoomBin } from '../../../web/src/scene/formats'

export const ID = '0f3c2a8e-1111-4222-8333-944455556666'
export const DW = 256
export const DH = 192
export const VW = 128
export const VH = 96
const K = [100, 100, 64, 48]
const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const WALL_MM = 1500

export function manifest(over: Record<string, unknown> = {}) {
  return {
    format: 'braindance.capture',
    version: 1,
    id: ID,
    createdAt: '2026-10-24T10:00:00Z',
    title: 'Test',
    attendees: [],
    video: { file: 'video.mp4', width: VW, height: VH, fps: 2, durationSec: 2, frameCount: 4 },
    depth: { file: 'depth.bin', confidenceFile: 'confidence.bin', width: DW, height: DH, unit: 'mm', rateHz: 2, count: 5 },
    room: { bin: 'room.bin', points: 0, voxelMeters: 0.01 },
    phases: { scan: { tStart: -3, tEnd: -1 }, moment: { tStart: 0, tEnd: 2 } },
    keyframes: { dir: 'keyframes', everySec: 1, count: 2 },
    warnings: [],
    ...over,
  }
}

export function framesJsonl(): string {
  const lines = [
    { i: null, t: -3, T, K, d: 0, phase: 'scan' },
    { i: null, t: -2, T, K, d: 1, phase: 'scan' },
    { i: null, t: -1, T, K, d: 2, phase: 'scan' },
    { i: 0, t: 0, T, K, d: 3, phase: 'moment' },
    { i: 1, t: 0.5, T, K, d: null, phase: 'moment' },
    { i: 2, t: 1, T, K, d: 4, phase: 'moment' },
    { i: 3, t: 1.5, T, K, d: null, phase: 'moment' },
  ]
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

/** The wall as the phone's 1 cm points, inside the camera's view, and a strip of floor (so the room has depth). */
export function wallPoints(): { positions: Float32Array; colors: Uint8Array } {
  const p: number[] = []
  const c: number[] = []
  for (let x = -0.9; x <= 0.9; x += 0.01)
    for (let y = -0.68; y <= 0.68; y += 0.01) {
      p.push(x, y, -WALL_MM / 1000)
      c.push(200, 100, 50)
    }
  for (let x = -0.9; x <= 0.9; x += 0.02)
    for (let z = -1.5; z <= -0.5; z += 0.02) {
      p.push(x, -0.695, z)
      c.push(90, 90, 90)
    }
  return { positions: new Float32Array(p), colors: new Uint8Array(c) }
}

/** Writes the capture into a new temp folder; `edit` can change or drop files first. */
export async function makeCapture(edit: (files: Map<string, Uint8Array | string>) => void = () => {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bd-fixture-'))
  const files = new Map<string, Uint8Array | string>()
  const { positions, colors } = wallPoints()
  files.set('manifest.json', JSON.stringify(manifest({ room: { bin: 'room.bin', points: positions.length / 3, voxelMeters: 0.01 } })))
  files.set('frames.jsonl', framesJsonl())
  const px = DW * DH
  const depth = new Uint16Array(px * 5).fill(WALL_MM)
  for (const k of [3, 4])
    for (let v = 66; v < 126; v++) for (let u = 98; u < 158; u++) depth[k * px + v * DW + u] = 1000
  files.set('depth.bin', new Uint8Array(depth.buffer))
  files.set('confidence.bin', new Uint8Array(px * 5).fill(2))
  files.set('room.bin', new Uint8Array(encodeRoomBin(positions, colors)))
  files.set('video.mp4', 'not really a video; the bake never reads it')
  for (const s of [0, 1]) {
    const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 10 + s * 100, g: 120, b: 200 } } }).jpeg().toBuffer()
    files.set(`keyframes/k000${s}.jpg`, new Uint8Array(jpeg))
  }
  edit(files)
  await mkdir(join(dir, 'keyframes'), { recursive: true })
  for (const [name, data] of files) await writeFile(join(dir, name), data)
  return dir
}
