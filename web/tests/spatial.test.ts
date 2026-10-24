import { describe, expect, it } from 'vitest'
import {
  CEILING,
  FLOOR,
  OBJECT,
  WALL,
  boundsOfPoints,
  buildVoxelIndex,
  classifyStructure,
  estimateLevels,
  pointsOfVoxels,
  raycastVoxels,
  segmentAt,
  verticesInVoxels,
  visibleIntervals,
} from '../src/scene/spatial'
import { K, ROOM, TABLE, VIDEO, lookAtPose, makeFixture } from './fixture'

describe('spatial queries on the synthetic room', () => {
  const fx = makeFixture()
  const pos = fx.cloud.positions
  const idx = buildVoxelIndex(pos, 0.03)
  const levels = estimateLevels(pos)
  const structure = classifyStructure(idx, levels.floorY, levels.ceilingY)

  it('indexes every point exactly once', () => {
    expect(idx.points.length).toBe(pos.length / 3)
    expect(new Set(idx.points).size).toBe(pos.length / 3)
  })

  it('finds the floor and no ceiling (the fixture has none)', () => {
    expect(levels.floorY).toBeCloseTo(0, 2)
    expect(levels.ceilingY).toBeNull()
  })

  it('picks the table top with a ray from above', () => {
    const hit = raycastVoxels(idx, [0.1, 2, 0.1], [0, -1, 0])
    expect(hit).not.toBeNull()
    expect(hit!.point[1]).toBeGreaterThan(TABLE.center[1] - 0.04)
    expect(hit!.point[1]).toBeLessThan(TABLE.center[1] + 0.04)
  })

  it('picks a wall with a ray from outside the room', () => {
    const hit = raycastVoxels(idx, [0, 1.2, 6], [0, 0, -1])
    expect(hit!.point[2]).toBeCloseTo(ROOM.zMax, 1)
  })

  it('returns null for a ray that misses the cloud', () => {
    expect(raycastVoxels(idx, [0, 10, 0], [0, 1, 0])).toBeNull()
  })

  it('labels floor, walls and the table', () => {
    const at = (p: [number, number, number]) => structure[raycastVoxels(idx, [p[0], p[1] + 0.5, p[2]], [0, -1, 0])!.id]
    expect(at([1.5, 0, 1.2])).toBe(FLOOR)
    expect(at([0, 0.75, 0])).toBe(OBJECT)
    const wall = raycastVoxels(idx, [0, 1.2, 0], [1, 0, 0])!
    expect(structure[wall.id]).toBe(WALL)
    expect(Array.from(structure).includes(CEILING)).toBe(false)
  })

  it('selects the whole table and nothing else', () => {
    const hit = raycastVoxels(idx, [0.3, 2, -0.2], [0, -1, 0])!
    const seg = segmentAt(idx, structure, hit.id)
    expect(seg.kind).toBe('object')
    expect(seg.truncated).toBe(false)
    const b = boundsOfPoints(pos, pointsOfVoxels(idx, seg.voxels))
    expect(b.size[0]).toBeCloseTo(2 * TABLE.half[0], 1)
    expect(b.size[2]).toBeCloseTo(2 * TABLE.half[2], 1)
    expect(b.size[1]).toBeLessThan(0.01)
  })

  it('selects a small patch when the click lands on a wall', () => {
    const hit = raycastVoxels(idx, [0, 1.2, 0], [0, 0, -1])!
    const seg = segmentAt(idx, structure, hit.id)
    expect(seg.kind).toBe('wall')
    const b = boundsOfPoints(pos, pointsOfVoxels(idx, seg.voxels))
    expect(Math.max(...b.size)).toBeLessThan(0.6)
  })

  it('sees the table for the whole moment', () => {
    const seg = segmentAt(idx, structure, raycastVoxels(idx, [0, 2, 0], [0, -1, 0])!.id)
    const iv = visibleIntervals(idx, seg.voxels, fx.frames.moment, VIDEO.width, VIDEO.height)
    expect(iv).toHaveLength(1)
    expect(iv[0].tStart).toBe(0)
    expect(iv[0].tEnd).toBeGreaterThan(VIDEO.durationSec - 0.2)
  })

  it('does not see the table through a wall, or when looking away', () => {
    const seg = segmentAt(idx, structure, raycastVoxels(idx, [0, 2, 0], [0, -1, 0])!.id)
    const behindWall = { t: 0, T: lookAtPose([0, 1.4, 3], TABLE.center, -90), K, d: null }
    const lookingAway = { t: 1, T: lookAtPose([0, 1.4, 1], [0, 1.4, 2], -90), K, d: null }
    expect(visibleIntervals(idx, seg.voxels, [behindWall, lookingAway], VIDEO.width, VIDEO.height)).toEqual([])
  })

  it('marks surface vertices on the selected object, not on the wall behind it', () => {
    const seg = segmentAt(idx, structure, raycastVoxels(idx, [0, 2, 0], [0, -1, 0])!.id)
    // A vertex on the table top, one just above it (a fused surface sits within a voxel), and one on a wall.
    const verts = new Float32Array([0.1, TABLE.center[1], 0.1, -0.2, TABLE.center[1] + 0.02, 0.05, ROOM.xMax, 1.2, 0])
    expect(Array.from(verticesInVoxels(idx, seg.voxels, verts))).toEqual([1, 1, 0])
  })
})
