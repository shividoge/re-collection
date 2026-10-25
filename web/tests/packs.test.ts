import { describe, expect, it } from 'vitest'
import { encodePack, PackError } from '../../shared/pack'
import { boxBounds, fitSize, gridBox, jpegSize, pathBox, pointLevel, readPoints, readSurface, readTimeline } from '../src/scene/packs'

const grid = { nx: 2, ny: 2, nz: 2, origin: [0, 0, 0] as [number, number, number], voxel: 0.5 }

function pointsPack(levels = [{ count: 2, sizeScale: 2 }, { count: 4, sizeScale: 1 }], count = 4) {
  return encodePack({
    kind: 'points',
    meta: { count, min: [-1, 0, -2], max: [1, 2, 2], sizeMin: 0.008, sizeMax: 0.035, levels },
    arrays: [
      { name: 'positions', data: new Uint16Array(count * 3).fill(65535), components: 3 },
      { name: 'colors', data: new Uint8Array(count * 3).fill(200), components: 3 },
      { name: 'sizes', data: new Uint8Array(count).fill(255), components: 1 },
    ],
  })
}

describe('derived pack readers', () => {
  it('reads points.pack as views, without expanding', () => {
    const bytes = pointsPack()
    const p = readPoints(bytes)
    expect(p.count).toBe(4)
    expect(p.positions).toBeInstanceOf(Uint16Array)
    expect(p.positions.buffer).toBe(bytes.buffer)
    expect(p.levels.at(-1)!.count).toBe(4)
    expect(p.min).toEqual([-1, 0, -2])
  })

  it('rejects points.pack whose levels do not end with the full cloud', () => {
    expect(() => readPoints(pointsPack([{ count: 2, sizeScale: 2 }]))).toThrow(PackError)
    expect(() => readPoints(pointsPack([{ count: 3, sizeScale: 2 }, { count: 2, sizeScale: 1 }]))).toThrow(PackError)
  })

  it('rejects a pack of the wrong kind', () => {
    const t = encodePack({ kind: 'timeline', meta: { grid }, arrays: [] })
    expect(() => readPoints(t)).toThrow(/points pack/)
  })

  it('reads an indexed surface.pack and checks its indices', () => {
    const surface = (indices: Uint32Array) =>
      encodePack({
        kind: 'surface',
        meta: { grid, keyframes: [{ file: 'keyframes/k0000.jpg', t: 0 }] },
        arrays: [
          { name: 'positions', data: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), components: 3 },
          { name: 'normals', data: new Int8Array([0, 0, 127, 0, 0, 127, 0, 0, 127]), components: 3 },
          { name: 'colors', data: new Uint8Array(9), components: 3 },
          { name: 'uvs', data: new Uint16Array(6), components: 2 },
          { name: 'layers', data: new Int16Array([0, 0, -1]), components: 1 },
          { name: 'indices', data: indices, components: 3 },
        ],
      })
    const s = readSurface(surface(new Uint32Array([0, 1, 2])))
    expect(s.keyframes[0].file).toBe('keyframes/k0000.jpg')
    expect(Array.from(s.layers)).toEqual([0, 0, -1])
    expect(() => readSurface(surface(new Uint32Array([0, 1, 3])))).toThrow(/past the last vertex/)
  })

  it('reads timeline.pack and checks the skip grid size', () => {
    const timeline = (skip: number) =>
      encodePack({
        kind: 'timeline',
        meta: { grid },
        arrays: [
          { name: 'positions', data: new Float32Array(3), components: 3 },
          { name: 'colors', data: new Uint8Array(3), components: 3 },
          { name: 'start', data: new Float32Array([1]), components: 1 },
          { name: 'end', data: new Float32Array([1e9]), components: 1 },
          { name: 'skip', data: new Uint8Array(skip), components: 1 },
        ],
      })
    expect(readTimeline(timeline(8)).end[0]).toBe(1e9)
    expect(() => readTimeline(timeline(7))).toThrow(/skip/)
  })
})

describe('points level of detail', () => {
  const levels = [{ count: 65536, sizeScale: 2 }, { count: 262144, sizeScale: 1.4 }, { count: 871688, sizeScale: 1 }]
  it('picks the sparsest level that still meets the budget', () => {
    expect(pointLevel(levels, 10_000)).toBe(0)
    expect(pointLevel(levels, 65536)).toBe(0)
    expect(pointLevel(levels, 100_000)).toBe(1)
    expect(pointLevel(levels, 5_000_000)).toBe(2)
  })
})

describe('framing', () => {
  it('frames a box like the old cloudBounds', () => {
    expect(boxBounds([0, 0, 0], [2, 2, 2])).toEqual({ center: [1, 1, 1], radius: Math.sqrt(12) / 2 })
    expect(boxBounds([0, 0, 0], [0.1, 0.1, 0.1]).radius).toBe(0.5)
  })
  it('gives the grid box and a box around the camera path', () => {
    expect(gridBox(grid).max).toEqual([1, 1, 1])
    const T = new Array(16).fill(0)
    T[12] = 1
    T[13] = 2
    T[14] = 3
    expect(pathBox([T], 1)).toEqual({ min: [0, 1, 2], max: [2, 3, 4] })
    expect(pathBox([])).toBeNull()
  })
})

describe('keyframe sizing', () => {
  it('reads a JPEG size from its SOF marker', () => {
    // SOI, an APP0 segment, then SOF0 with height 720, width 960.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x03, 0xc0, 0x03, 0, 0, 0, 0, 0, 0])
    expect(jpegSize(jpeg)).toEqual({ width: 960, height: 720 })
    expect(jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull()
  })
  it('fits the long side without enlarging', () => {
    expect(fitSize(1920, 1440, 768)).toEqual({ width: 768, height: 576 })
    expect(fitSize(1440, 1920, 768)).toEqual({ width: 576, height: 768 })
    expect(fitSize(640, 480, 768)).toEqual({ width: 640, height: 480 })
  })
})
