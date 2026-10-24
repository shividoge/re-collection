import { describe, expect, it } from 'vitest'
import { DEFAULT_SETUP, eyeOffset, headFromFace, headFromTilt, smooth, windowFrustum } from '../src/window/windowMath'

const setup = { ...DEFAULT_SETUP, aspect: 16 / 9 }

describe('Memory Window camera', () => {
  it('looks straight through the window when the head is centered', () => {
    const f = windowFrustum([0, 0, 0], setup)
    expect(f.left).toBeCloseTo(-f.right)
    expect(f.bottom).toBeCloseTo(-f.top)
    // Window half-height 0.25 m at 0.6 m, scaled to the near plane.
    expect(f.top).toBeCloseTo((0.25 * f.near) / 0.6)
  })

  it('moving the eye right shifts the frustum left, so you see more of the left side of the room', () => {
    const centered = windowFrustum([0, 0, 0], setup)
    const right = windowFrustum([0.2, 0, 0], setup)
    expect(right.left).toBeLessThan(centered.left)
    expect(right.right).toBeLessThan(centered.right)
    // The window edges stay fixed in space: the frustum width doesn't change.
    expect(right.right - right.left).toBeCloseTo(centered.right - centered.left)
  })

  it('leaning in widens the view, like stepping up to a window', () => {
    const rest = windowFrustum([0, 0, 0], setup)
    const leaning = windowFrustum([0, 0, -0.2], setup)
    expect(leaning.top - leaning.bottom).toBeGreaterThan(rest.top - rest.bottom)
  })

  it('never puts the eye through the glass', () => {
    const f = windowFrustum([0, 0, -5], setup)
    expect(Number.isFinite(f.top)).toBe(true)
    expect(f.top).toBeGreaterThan(0)
  })

  it('maps a head movement to an eye movement in meters', () => {
    expect(eyeOffset({ x: 1, y: -1, z: 1 }, setup)).toEqual([setup.travel, -setup.travel, -setup.lean])
  })
})

describe('head from the webcam', () => {
  const rest = { cx: 0.5, cy: 0.5, size: 0.2 }

  it('starts centered wherever the person sits', () => {
    expect(headFromFace(0.5, 0.5, 0.2, rest)).toEqual({ x: -0, y: -0, z: 0 })
  })

  it('un-mirrors the webcam: a face moving left in the frame is the person moving right', () => {
    expect(headFromFace(0.4, 0.5, 0.2, rest).x).toBeGreaterThan(0)
  })

  it('a bigger face means leaning in, and everything is clamped to -1..1', () => {
    expect(headFromFace(0.5, 0.5, 0.25, rest).z).toBeCloseTo(1)
    expect(headFromFace(0, 1, 1, rest)).toEqual({ x: 1, y: -1, z: 1 })
  })

  it('tilt maps to the same head space', () => {
    expect(headFromTilt(40, -10, { beta: 40, gamma: 0 })).toEqual({ x: 0.5, y: 0, z: 0 })
  })

  it('smoothing moves toward the target without overshooting', () => {
    const s = smooth({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, 1 / 60)
    expect(s.x).toBeGreaterThan(0)
    expect(s.x).toBeLessThan(1)
    expect(smooth(s, { x: 1, y: 1, z: 1 }, 10).x).toBeCloseTo(1)
  })
})
