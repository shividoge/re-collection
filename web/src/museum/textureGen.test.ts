import { describe, expect, it } from 'vitest'
import { carpet, fabric, woodFloor, woodGrain, type PixelMaps } from './textureGen'

const LIGHT: [number, number, number] = [164, 108, 66]
const DARK: [number, number, number] = [82, 48, 28]

/** Mean color difference between neighbouring columns: inside the image, and across the wrap. */
function seams(m: PixelMaps) {
  const { size, color } = m
  const at = (x: number, y: number, c: number) => color[(y * size + x) * 4 + c]
  const diff = (xa: number, xb: number) => {
    let s = 0
    for (let y = 0; y < size; y++) for (let c = 0; c < 3; c++) s += Math.abs(at(xa, y, c) - at(xb, y, c))
    return s / (size * 3)
  }
  let inside = 0
  for (let x = 0; x < size - 1; x++) inside += diff(x, x + 1)
  return { inside: inside / (size - 1), wrap: diff(size - 1, 0) }
}

describe('museum texture generators', () => {
  it('draw the same bytes for the same seed, and different ones for another', () => {
    const a = woodFloor(LIGHT, DARK, 7, 64)
    const b = woodFloor(LIGHT, DARK, 7, 64)
    expect(a.color).toEqual(b.color)
    expect(a.normal).toEqual(b.normal)
    expect(a.rough).toEqual(b.rough)
    expect(woodFloor(LIGHT, DARK, 8, 64).color).not.toEqual(a.color)
  })

  it('make RGBA maps of the asked size with opaque alpha', () => {
    for (const m of [woodFloor(LIGHT, DARK, 7, 32), woodGrain(LIGHT, DARK, 21, 32), fabric(LIGHT, 5, 32), carpet(LIGHT, 9, 32)]) {
      expect(m.size).toBe(32)
      for (const buf of [m.color, m.normal, m.rough]) {
        expect(buf.length).toBe(32 * 32 * 4)
        for (let k = 3; k < buf.length; k += 4) expect(buf[k]).toBe(255)
      }
    }
  })

  it('write unit normals that face out of the surface', () => {
    const { normal } = fabric([170, 74, 68], 5, 64)
    for (let k = 0; k < normal.length; k += 4) {
      const [x, y, z] = [0, 1, 2].map((c) => (normal[k + c] / 255) * 2 - 1)
      expect(Math.abs(Math.hypot(x, y, z) - 1)).toBeLessThan(0.02)
      expect(z).toBeGreaterThan(0)
    }
  })

  it('tile: the right edge runs on into the left one', () => {
    for (const m of [fabric([170, 74, 68], 5, 128), carpet([200, 200, 200], 9, 128), woodFloor(LIGHT, DARK, 7, 128)]) {
      const { inside, wrap } = seams(m)
      expect(wrap).toBeLessThan(inside * 2.5)
    }
  })
})
