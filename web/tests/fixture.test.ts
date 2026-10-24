import { describe, expect, it } from 'vitest'
import { parseFramesJsonl, parseRoomBin } from '../src/scene/formats'
import { projectToImage, uprightQuarterTurns } from '../src/scene/pose'
import { K, ROOM, TABLE, VIDEO, makeFixture } from './fixture'

describe('synthetic fixture', () => {
  const fx = makeFixture()

  it('round-trips through the real parsers', () => {
    const cloud = parseRoomBin(fx.roomBin)
    expect(cloud.count).toBe(fx.manifest.room.points)
    const frames = parseFramesJsonl(fx.framesJsonl)
    expect(frames.moment.length).toBe(VIDEO.fps * VIDEO.durationSec)
    expect(frames.scan.every((f) => f.t < 0)).toBe(true)
  })

  it('keeps every point on a room surface or the table', () => {
    const p = fx.cloud.positions
    for (let i = 0; i < p.length; i += 3) {
      const [x, y, z] = [p[i], p[i + 1], p[i + 2]]
      const onSurface =
        Math.abs(y) < 1e-4 ||
        Math.abs(y - TABLE.center[1]) < 1e-4 ||
        Math.abs(x - ROOM.xMin) < 1e-4 ||
        Math.abs(x - ROOM.xMax) < 1e-4 ||
        Math.abs(z - ROOM.zMin) < 1e-4 ||
        Math.abs(z - ROOM.zMax) < 1e-4
      expect(onSurface).toBe(true)
    }
  })

  it('films the table from every moment frame', () => {
    for (const f of fx.frames.moment) {
      const [u, v] = projectToImage(TABLE.center, K, f.T)
      expect(Math.abs(u - K[2])).toBeLessThan(2)
      expect(Math.abs(v - K[3])).toBeLessThan(2)
    }
  })

  it('is held in portrait, so the viewer must turn it a quarter', () => {
    expect(uprightQuarterTurns(fx.frames.moment[0].T)).toBe(1)
  })
})
