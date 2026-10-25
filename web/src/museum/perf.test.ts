import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { followIndex, type Artwork } from './exhibitions'
import { mergeStill } from './merge'
import { IDLE_FOR_MS, idleFrameDue } from './pace'
import { paintSize } from './painter'
import { choosePlaying, Playlist, PLAY_DISTANCE, type Piece } from './playback'
import { viewChanged } from './Reflector'

const piece = (index: number, video: boolean, x: number): Piece => ({ index, video, center: [x, 1.6, 0] })

describe('choosePlaying', () => {
  const pieces = [piece(0, true, 0), piece(1, false, 1), piece(2, true, 2), piece(3, true, 5), piece(4, true, 30)]
  it('plays the piece in focus and the nearest other video within reach', () => {
    expect(choosePlaying(pieces, 0, [2.5, 1.6, 0])).toEqual([0, 2])
  })
  it('plays nothing far away, and never a photo', () => {
    expect(choosePlaying(pieces, 1, [100, 1.6, 0])).toEqual([])
    expect(choosePlaying(pieces, -1, [30 + PLAY_DISTANCE + 1, 1.6, 0])).toEqual([])
  })
  it('without focus, plays only the nearest', () => {
    expect(choosePlaying(pieces, -1, [4.6, 1.6, 0])).toEqual([3])
  })
})

describe('Playlist', () => {
  it('notifies only when the set changes', () => {
    const p = new Playlist()
    let calls = 0
    p.subscribe(() => calls++)
    p.set([1, 2])
    p.set([2, 1])
    p.set([2])
    expect(calls).toBe(2)
    expect(p.has(2) && !p.has(1)).toBe(true)
  })
})

describe('followIndex', () => {
  const art = (id: string, captureId?: string): Artwork => ({ id, kind: 'photo', src: id, captureId })
  const items = [art('a', 'c1'), art('b', 'c2'), art('c', 'c1')]
  it('keeps the index when it still shows that visit', () => expect(followIndex(items, 2, 'c1')).toBe(2))
  it('finds the visit when the lists differ', () => expect(followIndex(items, 1, 'c1')).toBe(0))
  it('falls back to the index, or the entrance', () => {
    expect(followIndex(items, 1, 'gone')).toBe(1)
    expect(followIndex(items, 7, 'gone')).toBe(-1)
    expect(followIndex(items, -1, null)).toBe(-1)
  })
})

describe('paintSize', () => {
  it('fits under the height, keeps the shape and never enlarges', () => {
    expect(paintSize(1920, 1440, 768)).toEqual([1024, 768])
    expect(paintSize(640, 480, 768)).toEqual([640, 480])
    expect(paintSize(4000, 1000, 768, 2048)).toEqual([2048, 512])
    expect(paintSize(0, 0, 768)).toEqual([1, 1])
  })
})

describe('idleFrameDue', () => {
  it('flickers for a while after the last touch, then rests', () => {
    expect(idleFrameDue(1000, 0)).toBe(true)
    expect(idleFrameDue(IDLE_FOR_MS + 1, 0)).toBe(false)
  })
})

describe('viewChanged', () => {
  it('notices a moved camera and remembers where it was', () => {
    const cam = new THREE.PerspectiveCamera()
    const last = new Float32Array(32)
    cam.updateMatrixWorld()
    expect(viewChanged(last, cam)).toBe(true)
    expect(viewChanged(last, cam)).toBe(false)
    cam.position.x = 0.1
    cam.updateMatrixWorld()
    expect(viewChanged(last, cam)).toBe(true)
  })
})

describe('mergeStill', () => {
  it('merges still meshes per material, keeps live ones, collects flames, and undoes', () => {
    const root = new THREE.Group()
    const a = new THREE.MeshBasicMaterial()
    const b = new THREE.MeshBasicMaterial()
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), a)
    box.position.set(2, 0, 0)
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), a)
    const other = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), b)
    const live = new THREE.Group()
    live.userData.live = true
    const moving = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), a)
    live.add(moving)
    const flame = new THREE.Object3D()
    flame.position.set(0, 3, 0)
    flame.userData.flame = true
    root.add(box, sphere, other, live, flame)

    const { merged, flames, undo } = mergeStill(root)
    expect(merged).toHaveLength(2)
    expect([box.visible, sphere.visible, other.visible, moving.visible]).toEqual([false, false, false, true])
    expect(flames).toHaveLength(1)
    expect(new THREE.Vector3().setFromMatrixPosition(flames[0].matrix).y).toBe(3)
    // The box moved into place in the merged geometry.
    const withA = merged.find((m) => m.material === a)!
    withA.geometry.computeBoundingBox()
    expect(withA.geometry.boundingBox!.max.x).toBeCloseTo(2.5)

    undo()
    expect(root.children).toHaveLength(5)
    expect(box.visible && sphere.visible && other.visible).toBe(true)
  })
})
