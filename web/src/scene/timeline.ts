// What the video adds to the scanned room, and when.
//
// The room scan gives one stable surface. During the visit, the phone keeps measuring depth
// at 10 Hz; most of it lands on that surface (the room), and the rest is something the scan
// doesn't explain: a person, something brought in or moved, or a corner the scan missed.
// This works out, once, for the whole video, each such thing as voxels that appear when first
// seen (twice, so one noisy frame can't make one) and stay while the camera looks elsewhere,
// until later frames see straight through that spot (the person walked away), colored from the
// 1-per-second keyframes. So at any moment of playback the scene shows everything seen so far
// that's still there, from every angle, not just what the phone points at that instant.
//
// The scanned room itself is never taken away: telling a moved object from depth noise on a
// fuzzy or shiny surface isn't reliable (a ray skimming past a teddy bear's outline looks just
// like a ray through where something used to be), and a wrong guess would punch flickering
// holes in the room. Something moved after the scan shows in its new place; its scanned copy stays.

import { edgePixels, maxFilter, type DepthView, type Grid } from './surface'

export interface MomentView extends DepthView {
  /** Moment time in seconds. */
  t: number
  /** The keyframe for this instant, scaled to the depth grid (RGBA rows), when there is one. */
  color?: Uint8ClampedArray | null
}

export interface TimelineOptions {
  depthW: number
  depthH: number
  videoW: number
  videoH: number
  /** Same band as the room's fusion: free space is only counted this far in front of a surface. */
  truncation?: number
  minConfidence?: number
  maxDepth?: number
  stride?: number
  freeStride?: number
}

export interface Timeline {
  /** Voxel centers of what the room doesn't explain, each shown from `start` until `end` (s). */
  positions: Float32Array
  colors: Uint8Array
  start: Float32Array
  end: Float32Array
}

/** Never ends (seconds). */
export const FOREVER = 1e9

/** Voxels holding a mesh vertex, grown by `grow` voxels in every direction. */
export function meshMask(positions: Float32Array, g: Grid, grow = 0): Uint8Array {
  const mask = new Uint8Array(g.nx * g.ny * g.nz)
  for (let i = 0; i < positions.length; i += 3) {
    const v = voxelOf(g, positions[i], positions[i + 1], positions[i + 2])
    if (v >= 0) mask[v] = 1
  }
  return grow > 0 ? maxFilter(mask, g.nx, g.ny, g.nz, grow) : mask
}

function voxelOf(g: Grid, x: number, y: number, z: number): number {
  const ix = Math.floor((x - g.origin[0]) / g.voxel)
  const iy = Math.floor((y - g.origin[1]) / g.voxel)
  const iz = Math.floor((z - g.origin[2]) / g.voxel)
  if (ix < 0 || iy < 0 || iz < 0 || ix >= g.nx || iy >= g.ny || iz >= g.nz) return -1
  return (iz * g.ny + iy) * g.nx + ix
}

interface Thing {
  start: number
  hits: number
  lastHit: number
  carves: number
  lastCarve: number
  carvedAt: number
  color: [number, number, number] | null
}

/**
 * Builds the timeline from the visit's depth frames, in time order. `room` marks voxels the
 * room surface explains: its mesh voxels, grown by a few centimeters for tracking drift.
 */
export function buildTimeline(views: MomentView[], g: Grid, room: Uint8Array, o: TimelineOptions): Timeline {
  const voxel = g.voxel
  const trunc = o.truncation ?? voxel * 3
  const minConf = o.minConfidence ?? 2
  const maxDepth = o.maxDepth ?? 4.5
  const stride = o.stride ?? 2
  const freeStride = o.freeStride ?? 4
  const W = o.depthW
  const H = o.depthH
  const sx = W / o.videoW
  const sy = H / o.videoH
  const n = g.nx * g.ny * g.nz

  const active = new Uint8Array(n)
  const things = new Map<number, Thing>()
  const out = { positions: [] as number[], colors: [] as number[], start: [] as number[], end: [] as number[] }

  const close = (v: number, s: Thing, end: number) => {
    // One sighting, or never seen in a keyframe (no color to show it with): the live replay
    // still shows it while the camera is on it, but it isn't kept.
    if (s.hits >= 2 && s.color) {
      const x = v % g.nx
      const y = Math.floor(v / g.nx) % g.ny
      const z = Math.floor(v / (g.nx * g.ny))
      out.positions.push(g.origin[0] + (x + 0.5) * voxel, g.origin[1] + (y + 0.5) * voxel, g.origin[2] + (z + 0.5) * voxel)
      out.colors.push(...s.color)
      out.start.push(s.start)
      out.end.push(end)
    }
    things.delete(v)
    active[v] = 0
  }

  views.forEach((view, f) => {
    const T = view.T
    const fx = view.K[0] * sx
    const fy = view.K[1] * sy
    const cx = view.K[2] * sx
    const cy = view.K[3] * sy
    const edge = edgePixels(view.depth, W, H)
    for (let v = 0; v < H; v++)
      for (let u = 0; u < W; u++) {
        const surfaceRay = u % stride === 0 && v % stride === 0
        const freeRay = u % freeStride === 0 && v % freeStride === 0
        if (!surfaceRay && !freeRay) continue
        const k = v * W + u
        if (view.confidence[k] < minConf || edge[k]) continue
        const d = view.depth[k] / 1000
        if (d < 0.2 || d > maxDepth) continue
        const rx = (u + 0.5 - cx) / fx
        const ry = -(v + 0.5 - cy) / fy
        const wx = T[0] * rx + T[4] * ry - T[8]
        const wy = T[1] * rx + T[5] * ry - T[9]
        const wz = T[2] * rx + T[6] * ry - T[10]
        const len = Math.hypot(rx, ry, 1)

        if (surfaceRay) {
          const i = voxelOf(g, T[12] + wx * d, T[13] + wy * d, T[14] + wz * d)
          if (i >= 0) {
            if (!room[i]) {
              let s = things.get(i)
              if (!s) {
                s = { start: view.t, hits: 0, lastHit: -1, carves: 0, lastCarve: -1, carvedAt: 0, color: null }
                things.set(i, s)
                active[i] = 1
              }
              if (s.lastHit !== f) {
                s.hits++
                s.lastHit = f
                s.carves = 0
              }
              if (view.color) {
                const c = k * 4
                s.color = [view.color[c], view.color[c + 1], view.color[c + 2]]
              }
            }
          }
        }

        if (freeRay) {
          // Seen straight through, from the camera to well in front of what this pixel hit.
          for (let t = 0.2; t < d - 2 * trunc; t += voxel / len) {
            const i = voxelOf(g, T[12] + wx * t, T[13] + wy * t, T[14] + wz * t)
            if (i < 0) continue
            if (active[i]) {
              const s = things.get(i)!
              if (s.lastHit === f || s.lastCarve === f) continue
              if (s.carves === 0) s.carvedAt = view.t
              s.lastCarve = f
              // Two frames agreeing it's gone (a sighting in between resets), so one bad pose can't end it.
              if (++s.carves >= 2) close(i, s, s.carvedAt)
            }
          }
        }
      }
  })
  for (const [v, s] of things) close(v, s, FOREVER)

  return {
    positions: new Float32Array(out.positions),
    colors: new Uint8Array(out.colors),
    start: new Float32Array(out.start),
    end: new Float32Array(out.end),
  }
}
