import { BlurPass } from '@react-three/drei/materials/BlurPass.js'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { planMuseum, walkTarget } from '../src/museum/layout'
import { mergeStill } from '../src/museum/merge'
import { disposeBlurPass } from '../src/museum/Reflector'
import { legacyMuseumHash, museumHash } from '../src/museum/roomSync'
import { shownRoom } from '../src/scene/SceneRoom'
import type { CaptureScene } from '../src/scene/useCaptureScene'

describe('museum addresses', () => {
  it("keep a helper's join code when switching exhibitions", () => {
    expect(museumHash('curated-0', 'KTRB')).toBe('#/museum/curated-0?join=KTRB')
    expect(museumHash('curated-0')).toBe('#/museum/curated-0')
    expect(museumHash(undefined, 'KTRB')).toBe('#/museum?join=KTRB')
    // A helper still typing a code stays a helper.
    expect(museumHash('mine', '')).toBe('#/museum/mine?join=')
  })

  it('send the old #/memories address to the museum before anything else reads it', () => {
    expect(legacyMuseumHash('#/memories')).toBe('#/museum')
    expect(legacyMuseumHash('#/memories?join=KTRB')).toBe('#/museum?join=KTRB')
    expect(legacyMuseumHash('#/museum')).toBe(null)
    expect(legacyMuseumHash('#/')).toBe(null)
  })
})

describe('shared walk destination', () => {
  it('maps to a place in whatever plan the walker has now', () => {
    const small = planMuseum(3)
    const big = planMuseum(9)
    expect(walkTarget(small, -1)).toEqual({ to: small.start })
    expect(walkTarget(small, 2)).toEqual({ to: small.slots[2].view, look: small.slots[2].center })
    expect(walkTarget(big, 8)).toEqual({ to: big.slots[8].view, look: big.slots[8].center })
    expect(walkTarget(small, 8)).toBe(null)
  })
})

describe('reflective floor', () => {
  it("lets go of everything its blur pass made", () => {
    const pass = new BlurPass({ gl: {} as THREE.WebGLRenderer, resolution: 64, width: 4, height: 4 })
    const disposed: string[] = []
    const watch = (name: string, o: THREE.EventDispatcher<{ dispose: object }>) => o.addEventListener('dispose', () => disposed.push(name))
    watch('targetA', pass.renderTargetA)
    watch('targetB', pass.renderTargetB)
    watch('material', pass.convolutionMaterial)
    watch('geometry', pass.screen.geometry)
    disposeBlurPass(pass)
    expect(disposed.sort()).toEqual(['geometry', 'material', 'targetA', 'targetB'])
  })
})

describe('merging the still museum', () => {
  it('leaves live meshes (the exhibition title) alone, so they can change shape', () => {
    const root = new THREE.Group()
    const material = new THREE.MeshBasicMaterial()
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material)
    const title = new THREE.Mesh(new THREE.PlaneGeometry(4, 1), material)
    title.userData.live = true
    root.add(wall, title)
    const { merged } = mergeStill(root)
    expect(wall.visible).toBe(false)
    expect(title.visible).toBe(true)
    expect(merged).toHaveLength(1)
    expect(merged[0].geometry.attributes.position.count).toBe(6)
  })
})

describe('Memory Window replay mask', () => {
  const scene = (splat: boolean) =>
    ({
      splat: splat ? { url: 'room.spz' } : null,
      surface: { status: 'ready', data: {} },
      points: { status: 'ready', data: {} },
    }) as unknown as CaptureScene
  it('is on only while the surface is what is shown', () => {
    expect(shownRoom(scene(false), 'auto', { state: 'loading' })).toBe('surface')
    expect(shownRoom(scene(true), 'auto', { state: 'loading' })).toBe('surface')
    expect(shownRoom(scene(true), 'auto', { state: 'ready' })).toBe('splat')
    expect(shownRoom(scene(true), 'auto', { state: 'failed', message: 'x' })).toBe('surface')
  })
})
