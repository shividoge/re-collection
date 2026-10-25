// The room surface and the visit timeline, built exactly as the browser built them
// (web/src/scene/surfaceWorker.ts and useRoomSurface.ts), from the same pure modules.
import { alignToRoom, indexPoints } from '../../../web/src/scene/align'
import type { FrameRecord, FrameLog } from '../../../web/src/scene/formats'
import { buildRoomSurface, type DepthView, type Grid, type KeyView, type RoomMesh } from '../../../web/src/scene/surface'
import { buildTimeline, meshMask, type MomentView, type Timeline } from '../../../web/src/scene/timeline'

/** Same as surfaceWorker.ts ROOM_MARGIN_VOXELS. */
export const ROOM_MARGIN_VOXELS = 3

/** Most keyframes used to texture the room (useRoomSurface.ts MAX_KEYFRAMES). */
export const MAX_KEYFRAMES = 32

/** Which of `count` keyframes texture the room, in layer order (useRoomSurface.ts loadKeyframes). */
export function pickKeyframes(count: number): number[] {
  return count <= MAX_KEYFRAMES ? [...Array(count).keys()] : Array.from({ length: MAX_KEYFRAMES }, (_, i) => Math.round((i * (count - 1)) / (MAX_KEYFRAMES - 1)))
}

/** A depth frame by its index in depth.bin. */
export type DepthSource = (k: number) => { depth: Uint16Array; confidence: Uint8Array }

export interface RoomKeyframe {
  file: string
  t: number
  /** RGBA at the depth grid's size, for the timeline's colors. */
  small: Uint8ClampedArray
}

export interface RoomInput {
  frames: FrameLog
  depth: DepthSource
  depthW: number
  depthH: number
  videoW: number
  videoH: number
  points: Float32Array
  colors: Uint8Array
  /** The picked keyframes, in layer order. */
  keyframes: RoomKeyframe[]
}

export interface SurfaceBake {
  surface: RoomMesh
  grid: Grid
  /** surfaceWorker.ts `skip`: 1 where the replay draws nothing. */
  skip: Uint8Array
  /** What the timeline step needs. */
  visit: MomentView[]
  colorOf: { view: number; small: Uint8ClampedArray }[]
  options: { depthW: number; depthH: number; videoW: number; videoH: number }
}

/** The pose of the moment frame nearest `t` (the first of equals), as loadKeyframes picks it. */
function nearestFrame(moment: FrameRecord[], t: number): FrameRecord {
  let f = 0
  for (let i = 1; i < moment.length; i++) if (Math.abs(moment[i].t - t) < Math.abs(moment[f].t - t)) f = i
  return moment[f]
}

/** The room surface; null when the capture has no scan depth (a bare room.bin stays as points, as in the browser). */
export function bakeSurface(inp: RoomInput): SurfaceBake | null {
  const scanFrames = inp.frames.scan.filter((f) => f.d !== null)
  const allMoment = inp.frames.moment
  const momentFrames = allMoment.filter((f) => f.d !== null)
  if (scanFrames.length === 0) return null
  const options = { depthW: inp.depthW, depthH: inp.depthH, videoW: inp.videoW, videoH: inp.videoH }
  const viewOf = (f: FrameRecord): DepthView & { t: number } => ({ T: f.T, K: f.K, t: f.t, ...inp.depth(f.d as number) })
  const px = inp.depthW * inp.depthH

  const visit: MomentView[] = momentFrames.map(viewOf)
  // The browser only loads keyframes when the visit has depth frames.
  const keyframes = momentFrames.length > 0 ? inp.keyframes.map((k) => ({ ...k, ...poseOf(nearestFrame(allMoment, k.t)) })) : []
  // Each keyframe goes with the depth frame closest to it in time, within 0.06 s.
  const nearest = keyframes.map(({ t }) => {
    let best = -1
    for (let i = 0; i < visit.length; i++) if (best < 0 || Math.abs(visit[i].t - t) < Math.abs(visit[best].t - t)) best = i
    return best >= 0 && Math.abs(visit[best].t - t) <= 0.06 ? best : -1
  })
  const noDepth = { depth: new Uint16Array(px), confidence: new Uint8Array(px) }
  const roomIndex = indexPoints(inp.points)
  const keys: KeyView[] = keyframes.map((k, j) => {
    if (nearest[j] < 0) return { T: k.T, K: k.K, ...noDepth }
    const d = visit[nearest[j]]
    return { T: alignToRoom({ ...d, T: k.T, K: k.K }, roomIndex, options), K: k.K, depth: d.depth, confidence: d.confidence }
  })

  const { mesh, grid, reached } = buildRoomSurface(scanFrames.map(viewOf), keys, { ...options, points: inp.points, colors: inp.colors })
  const skip = meshMask(mesh.positions, grid, ROOM_MARGIN_VOXELS)
  for (let i = 0; i < skip.length; i++) if (!reached[i]) skip[i] = 1
  const colorOf = keyframes.flatMap((k, j) => (nearest[j] >= 0 ? [{ view: nearest[j], small: k.small }] : []))
  return { surface: mesh, grid, skip, visit, colorOf, options }
}

/** What the visit adds to the room over time; null when the visit has no depth frames. */
export function bakeTimeline(s: SurfaceBake): Timeline | null {
  if (s.visit.length === 0) return null
  for (const { view, small } of s.colorOf) s.visit[view].color = small
  return buildTimeline(s.visit, s.grid, s.skip, s.options)
}

const poseOf = (f: FrameRecord) => ({ T: f.T, K: f.K })
