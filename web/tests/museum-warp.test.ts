import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { coverDistance, diveShape, flyDive, streakLevel, type Dive } from '../src/museum/warp'

describe('diving into a picture', () => {
  it('ends close enough that the picture covers the whole view', () => {
    for (const aspect of [0.6, 1, 16 / 9]) {
      const fov = 74
      const d = coverDistance(1.4, 1.05, aspect, fov)
      const halfH = d * Math.tan(THREE.MathUtils.degToRad(fov / 2))
      expect(halfH).toBeLessThan(1.05 / 2)
      expect(halfH * aspect).toBeLessThan(1.4 / 2)
      expect(d).toBeGreaterThan(0.1)
    }
  })

  it('starts gently, ends in a rush, and only blurs on the way', () => {
    expect(diveShape(0)).toMatchObject({ travel: 0, turn: 0, blur: 0, flash: 0 })
    expect(diveShape(1).travel).toBeCloseTo(1)
    expect(diveShape(0.25).blur).toBe(0)
    expect(diveShape(0.5).travel).toBeLessThan(0.25)
    expect(diveShape(1).blur).toBeGreaterThan(0.5)
    for (let k = 0.05; k <= 1; k += 0.05) expect(diveShape(k).travel).toBeGreaterThanOrEqual(diveShape(k - 0.05).travel)
  })

  it('flies from the visitor to the frame and back to exactly where they stood', () => {
    const camera = new THREE.PerspectiveCamera(62, 1.5, 0.05, 100)
    camera.position.set(0, 1.62, -2)
    camera.lookAt(-3.5, 1.85, -2)
    const start = camera.position.clone()
    const turn = camera.quaternion.clone()
    let finished = 0
    const dive: Dive = { dir: 'in', target: { center: [-3.5, 1.85, -2], normal: [1, 0], w: 1.4, h: 1.05 }, start: 0, ms: 1000, done: () => finished++ }
    flyDive(dive, camera, 0)
    const end = flyDive(dive, camera, 1000)
    expect(finished).toBe(1)
    expect(camera.position.x).toBeGreaterThan(-3.5)
    expect(camera.position.x).toBeLessThan(-2.5)
    expect(end.center[0]).toBeCloseTo(0.5)
    expect(end.center[1]).toBeCloseTo(0.5)
    Object.assign(dive, { dir: 'out', start: 2000, finished: false })
    // Before the pull back starts, the view holds inside the frame.
    flyDive(dive, camera, 1500)
    expect(camera.position.x).toBeLessThan(-2.5)
    flyDive(dive, camera, 3000)
    expect(finished).toBe(2)
    expect(camera.position.distanceTo(start)).toBeLessThan(1e-6)
    expect(camera.quaternion.angleTo(turn)).toBeLessThan(1e-6)
    expect(camera.fov).toBeCloseTo(62)
  })

  it('streaks build to the crossing and die away after it', () => {
    expect(streakLevel(0, 5000)).toBe(0)
    expect(streakLevel(5000, 5000)).toBe(1)
    expect(streakLevel(4600, 5000)).toBeLessThan(streakLevel(4900, 5000))
    expect(streakLevel(9000, 5000)).toBe(0)
  })
})
