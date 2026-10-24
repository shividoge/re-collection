// Readers for the capture package files the viewer needs.
// Formats: CLAUDE.md Section 5 and IOS_CAPTURE_PLAN.md Section 7.

export interface PointCloud {
  count: number
  /** xyz per point, ARKit world meters, y up. */
  positions: Float32Array
  /** rgb per point, sRGB bytes. */
  colors: Uint8Array
}

/** room.bin: UInt32 count (little-endian), then count×3 float32 xyz, then count×3 uint8 rgb. */
export function parseRoomBin(buf: ArrayBuffer): PointCloud {
  if (buf.byteLength < 4) throw new Error(`room.bin too short: ${buf.byteLength} bytes, need at least a 4-byte header`)
  const count = new DataView(buf).getUint32(0, true)
  const expected = 4 + count * 15
  if (buf.byteLength !== expected) {
    throw new Error(`room.bin size mismatch: expected ${expected} bytes for ${count} points, got ${buf.byteLength}`)
  }
  // The xyz block starts at byte 4, which is 4-byte aligned, so a Float32Array view works
  // on little-endian hosts (every browser we target). Copy so the cloud owns its memory.
  const positions = new Float32Array(buf.slice(4, 4 + count * 12))
  const colors = new Uint8Array(buf, 4 + count * 12, count * 3)
  return { count, positions, colors }
}

/** Inverse of parseRoomBin. Used by tests and the synthetic fixture. */
export function encodeRoomBin(positions: Float32Array, colors: Uint8Array): ArrayBuffer {
  const count = positions.length / 3
  if (!Number.isInteger(count) || colors.length !== count * 3) throw new Error('positions and colors lengths disagree')
  const buf = new ArrayBuffer(4 + count * 15)
  new DataView(buf).setUint32(0, count, true)
  new Float32Array(buf, 4, count * 3).set(positions)
  new Uint8Array(buf, 4 + count * 12, count * 3).set(colors)
  return buf
}

export interface FrameRecord {
  /** Video frame index; absent on scan-phase lines. */
  i?: number
  /** Seconds relative to the first moment frame (scan frames are negative). */
  t: number
  /** 4×4 camera-to-world, column-major. ARKit camera: x right, y up, looks down −z. */
  T: number[]
  /** [fx, fy, cx, cy] for the full-resolution video frame. */
  K: number[]
  track?: string
  /** Index into depth.bin / confidence.bin, or null when this frame has no depth. */
  d: number | null
  phase?: 'scan' | 'moment'
}

export interface FrameLog {
  scan: FrameRecord[]
  moment: FrameRecord[]
}

const isNumArray = (v: unknown, n: number): v is number[] =>
  Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x))

export function parseFramesJsonl(text: string): FrameLog {
  const scan: FrameRecord[] = []
  const moment: FrameRecord[] = []
  text.split('\n').forEach((raw, idx) => {
    const lineNo = idx + 1
    if (!raw.trim()) return
    let o: Record<string, unknown>
    try {
      o = JSON.parse(raw)
    } catch {
      throw new Error(`frames.jsonl line ${lineNo}: invalid JSON`)
    }
    if (typeof o.t !== 'number' || !Number.isFinite(o.t)) throw new Error(`frames.jsonl line ${lineNo}: t must be a number`)
    if (!isNumArray(o.T, 16)) throw new Error(`frames.jsonl line ${lineNo}: T must be 16 numbers`)
    if (!isNumArray(o.K, 4)) throw new Error(`frames.jsonl line ${lineNo}: K must be 4 numbers`)
    const d = o.d === undefined || o.d === null ? null : o.d
    if (d !== null && typeof d !== 'number') throw new Error(`frames.jsonl line ${lineNo}: d must be a number or null`)
    const rec: FrameRecord = {
      i: typeof o.i === 'number' ? o.i : undefined,
      t: o.t,
      T: o.T,
      K: o.K,
      track: typeof o.track === 'string' ? o.track : undefined,
      d,
      phase: o.phase === 'scan' ? 'scan' : 'moment',
    }
    ;(rec.phase === 'scan' ? scan : moment).push(rec)
  })
  scan.sort((a, b) => a.t - b.t)
  moment.sort((a, b) => a.t - b.t)
  return { scan, moment }
}
