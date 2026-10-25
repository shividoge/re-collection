// Camera math shared by the viewer, the camera-path playback and (later) DepthReplay.
// Conventions (CLAUDE.md 4.5): ARKit world meters, y up. T is 4×4 camera-to-world,
// column-major. ARKit camera space: x right, y up, looks down −z. three.js cameras use
// the same convention, so T can be used as a three.js camera matrix directly.

import type { FrameRecord } from './formats'

export type Vec3 = [number, number, number]

const DEPTH_W = 256
const DEPTH_H = 192

export function cameraPosition(T: number[]): Vec3 {
  return [T[12], T[13], T[14]]
}

export function transformPoint(T: number[], p: Vec3): Vec3 {
  return [
    T[0] * p[0] + T[4] * p[1] + T[8] * p[2] + T[12],
    T[1] * p[0] + T[5] * p[1] + T[9] * p[2] + T[13],
    T[2] * p[0] + T[6] * p[1] + T[10] * p[2] + T[14],
  ]
}

/**
 * Depth pixel (u, v) at depth d meters → world point. Same steps as CLAUDE.md 6.4:
 * scale K from video to depth resolution, unproject in image-camera space (y down,
 * z forward), flip to ARKit camera space (x, −y, −z), then apply T.
 */
export function unprojectDepthPixel(u: number, v: number, d: number, K: number[], videoW: number, videoH: number, T: number[]): Vec3 {
  const fx = (K[0] * DEPTH_W) / videoW
  const fy = (K[1] * DEPTH_H) / videoH
  const cx = (K[2] * DEPTH_W) / videoW
  const cy = (K[3] * DEPTH_H) / videoH
  const x = ((u - cx) * d) / fx
  const y = ((v - cy) * d) / fy
  return transformPoint(T, [x, -y, -d])
}

/** World point → full-resolution video pixel (u right, v down). Inverse of the above. */
export function projectToImage(world: Vec3, K: number[], T: number[]): [number, number] {
  // Camera-from-world = transpose(R) · (p − t) for a rigid T.
  const dx = world[0] - T[12]
  const dy = world[1] - T[13]
  const dz = world[2] - T[14]
  const xc = T[0] * dx + T[1] * dy + T[2] * dz
  const yc = T[4] * dx + T[5] * dy + T[6] * dz
  const zc = T[8] * dx + T[9] * dy + T[10] * dz
  const depth = -zc
  return [K[0] * (xc / depth) + K[2], K[1] * (-yc / depth) + K[3]]
}

/** Index of the last frame with t ≤ time, clamped to the ends. Frames must be sorted by t. */
export function frameIndexAtTime(frames: FrameRecord[], time: number): number {
  if (frames.length === 0) return -1
  let lo = 0
  let hi = frames.length - 1
  if (time <= frames[0].t) return 0
  if (time >= frames[hi].t) return hi
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (frames[mid].t <= time) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Indices of the frames that have a depth frame (`d` not null), in time order. */
export function depthFrameIndices(frames: FrameRecord[]): number[] {
  const out: number[] = []
  frames.forEach((f, k) => {
    if (f.d !== null) out.push(k)
  })
  return out
}

/**
 * The frame with depth whose `t` is nearest `time`, or -1 if none is within `maxGap` seconds.
 * By time, not by a count of video frames: phone captures have depth at 10 Hz, captures made
 * from a video at 2–5 Hz. Use that frame's own T and K with its depth. `withDepth` comes from
 * depthFrameIndices; frames must be sorted by t.
 */
export function nearestDepthFrame(frames: FrameRecord[], withDepth: number[], time: number, maxGap: number): number {
  if (withDepth.length === 0) return -1
  let lo = 0
  let hi = withDepth.length - 1
  while (lo < hi) {
    // First depth frame with t >= time (or the last one).
    const mid = (lo + hi) >> 1
    if (frames[withDepth[mid]].t < time) lo = mid + 1
    else hi = mid
  }
  let best = withDepth[lo]
  if (lo > 0 && Math.abs(frames[withDepth[lo - 1]].t - time) <= Math.abs(frames[best].t - time)) best = withDepth[lo - 1]
  return Math.abs(frames[best].t - time) <= maxGap ? best : -1
}

/** T · Rz(angle): roll the camera about its own view axis (column-major in, column-major out). */
export function rollColumnMajor(T: number[], angle: number): number[] {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const out = T.slice()
  for (let r = 0; r < 4; r++) {
    const x = T[r]
    const y = T[4 + r]
    out[r] = c * x + s * y
    out[4 + r] = -s * x + c * y
  }
  return out
}

/** Quarter turns clockwise (0–3). */
export type QuarterTurns = 0 | 1 | 2 | 3

/**
 * The sensor image is always landscape, however the phone was held. Returns k so that
 * rolling the camera by k·90° (T · Rz(k·π/2)) brings its up axis closest to world up.
 * The same k, as a CSS rotate(k·90deg), turns the stored video upright.
 */
export function uprightQuarterTurns(T: number[]): QuarterTurns {
  // World-space camera axes: x = column 0, y = column 1. Their world-up components:
  const xUp = T[1]
  const yUp = T[5]
  // Rolling by k·90° makes the new up axis y, −x, −y, x for k = 0..3.
  const scores = [yUp, -xUp, -yUp, xUp]
  let best = 0
  for (let k = 1; k < 4; k++) if (scores[k] > scores[best]) best = k
  return best as QuarterTurns
}

/** Rotate a pixel offset from image center the way CSS rotate(deg) does (screen y down). */
export function rotatePixelOffsetCss(dx: number, dy: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  return [c * dx - s * dy, s * dx + c * dy]
}

/** Most common upright correction across the frames (phones rarely rotate mid-clip). */
export function dominantQuarterTurns(frames: FrameRecord[]): QuarterTurns {
  const counts = [0, 0, 0, 0]
  const step = Math.max(1, Math.floor(frames.length / 200))
  for (let i = 0; i < frames.length; i += step) counts[uprightQuarterTurns(frames[i].T)]++
  return counts.indexOf(Math.max(...counts)) as QuarterTurns
}
