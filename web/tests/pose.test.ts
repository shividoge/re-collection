import { describe, expect, it } from 'vitest'
import type { FrameRecord } from '../src/scene/formats'
import {
  cameraPosition,
  depthFrameIndices,
  frameIndexAtTime,
  nearestDepthFrame,
  projectToImage,
  rotatePixelOffsetCss,
  rollColumnMajor,
  transformPoint,
  unprojectDepthPixel,
  uprightQuarterTurns,
} from '../src/scene/pose'

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const K = [1450, 1450, 960, 720]
const W = 1920
const H = 1440

/** Column-major camera-to-world rotated by `deg` about the camera's own z axis, at `pos`. */
function rolledPose(deg: number, pos: [number, number, number] = [0, 0, 0]): number[] {
  const T = rollColumnMajor(I, (deg * Math.PI) / 180)
  T[12] = pos[0]
  T[13] = pos[1]
  T[14] = pos[2]
  return T
}

describe('unprojectDepthPixel (CLAUDE.md 6.4)', () => {
  it('puts the principal point at 1 m straight ahead on camera −z', () => {
    // Depth pixel that maps to the video principal point (960, 720) → (128, 96).
    const p = unprojectDepthPixel(128, 96, 1, K, W, H, I)
    expect(p[0]).toBeCloseTo(0, 6)
    expect(p[1]).toBeCloseTo(0, 6)
    expect(p[2]).toBeCloseTo(-1, 6)
  })

  it('maps image rows downward to camera −y and columns rightward to +x', () => {
    const below = unprojectDepthPixel(128, 150, 1, K, W, H, I)
    const right = unprojectDepthPixel(200, 96, 1, K, W, H, I)
    expect(below[1]).toBeLessThan(0)
    expect(right[0]).toBeGreaterThan(0)
  })

  it('round-trips through projectToImage with a moved, rolled camera', () => {
    const T = rolledPose(-90, [1, 1.5, -2])
    const world = unprojectDepthPixel(40, 170, 2.3, K, W, H, T)
    const [u, v] = projectToImage(world, K, T)
    expect(u).toBeCloseTo((40 * W) / 256, 3)
    expect(v).toBeCloseTo((170 * H) / 192, 3)
  })
})

describe('frameIndexAtTime', () => {
  const frames = [0, 0.1, 0.2, 0.3].map((t) => ({ t, T: I, K, d: null }) as FrameRecord)
  it('returns the last frame at or before t', () => {
    expect(frameIndexAtTime(frames, 0.15)).toBe(1)
    expect(frameIndexAtTime(frames, 0.2)).toBe(2)
  })
  it('clamps outside the range', () => {
    expect(frameIndexAtTime(frames, -5)).toBe(0)
    expect(frameIndexAtTime(frames, 99)).toBe(3)
  })
})

describe('uprightQuarterTurns', () => {
  it('is 0 for a level camera', () => {
    expect(uprightQuarterTurns(I)).toBe(0)
  })

  it('undoes any quarter-turn roll so camera up ends near world up', () => {
    for (const deg of [-90, 90, 180, -100, 80]) {
      const T = rolledPose(deg)
      const k = uprightQuarterTurns(T)
      const fixed = rollColumnMajor(T, (k * Math.PI) / 2)
      // Camera up axis is column 1.
      expect(fixed[5]).toBeGreaterThan(0.9)
    }
  })

  it('rotates the video the same way, so a point above the camera shows near the top', () => {
    for (const deg of [-90, 90, 180]) {
      const T = rolledPose(deg)
      const k = uprightQuarterTurns(T)
      const above = transformPoint(T, [0, 0, 0]).map((c, j) => c + [0, 0.5, 0][j]) as [number, number, number]
      // Push it in front of the camera along its view direction (−column 2).
      const fwd = [-T[8], -T[9], -T[10]]
      const target: [number, number, number] = [above[0] + 2 * fwd[0], above[1] + 2 * fwd[1], above[2] + 2 * fwd[2]]
      const [u, v] = projectToImage(target, K, T)
      const [dx, dy] = rotatePixelOffsetCss(u - K[2], v - K[3], k * 90)
      expect(dy).toBeLessThan(-100)
      expect(Math.abs(dx)).toBeLessThan(1)
    }
  })
})

describe('cameraPosition', () => {
  it('reads the translation column', () => {
    expect(cameraPosition(rolledPose(0, [1, 2, 3]))).toEqual([1, 2, 3])
  })
})

describe('nearestDepthFrame', () => {
  const rec = (t: number, d: number | null): FrameRecord => ({ t, T: I, K, d, phase: 'moment' })

  it('finds depth for every frame of a video capture (60 fps video, depth at ~2 Hz)', () => {
    const frames = Array.from({ length: 410 }, (_, i) => rec(i / 60, i % 27 === 0 ? i / 27 : null))
    const withDepth = depthFrameIndices(frames)
    for (let i = 0; i < frames.length; i++) {
      const k = nearestDepthFrame(frames, withDepth, frames[i].t, 1 / 2.2)
      expect(k).toBe(Math.round(i / 27) * 27)
      expect(frames[k].d).not.toBeNull()
    }
  })

  it('picks the nearest by time on a variable frame rate and returns that frame (its own T and K)', () => {
    const frames = [rec(0, 0), rec(0.5, null), rec(1.9, null), rec(2.0, 1), rec(2.1, null)]
    const withDepth = depthFrameIndices(frames)
    expect(withDepth).toEqual([0, 3])
    expect(nearestDepthFrame(frames, withDepth, 0.9, 2)).toBe(0)
    expect(nearestDepthFrame(frames, withDepth, 1.1, 2)).toBe(3)
    expect(nearestDepthFrame(frames, withDepth, 5, 10)).toBe(3)
  })

  it('shows nothing across a gap longer than maxGap, or with no depth at all', () => {
    const frames = [rec(0, 0), rec(1, null), rec(2, 1)]
    expect(nearestDepthFrame(frames, depthFrameIndices(frames), 1, 0.1)).toBe(-1)
    expect(nearestDepthFrame(frames, depthFrameIndices(frames), 0.05, 0.1)).toBe(0)
    const none = [rec(0, null)]
    expect(nearestDepthFrame(none, depthFrameIndices(none), 0, Infinity)).toBe(-1)
  })
})
