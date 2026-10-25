import { describe, expect, it } from 'vitest'
import { STYLES, fitPicture, planMuseum, route, slide, walkable, type RoomStyle } from '../src/museum/layout'

const STYLE_NAMES: RoomStyle[] = ['classic', 'calm', 'gallery', 'salon', 'hall']

describe('museum layout', () => {
  it('gives every picture a slot, and adds rooms only as needed', () => {
    for (const style of STYLE_NAMES) {
      expect(planMuseum(1, style).rooms.length).toBe(1)
      for (const n of [1, 5, 9, 17, 40]) {
        const plan = planMuseum(n, style)
        expect(plan.slots.length).toBe(n)
        // No more rooms than needed (the last room may hold two fewer: a window, or a single centerpiece).
        const perRoom = STYLES[style].perSide * 2 + 2
        expect(plan.rooms.length).toBeLessThanOrEqual(Math.ceil((n + 2) / perRoom))
        expect(plan.doorways.length).toBe(plan.rooms.length - 1)
      }
    }
  })

  it('hangs pictures at the height of their style, clear of panelling, on a wall of their own room', () => {
    for (const style of STYLE_NAMES) {
      const plan = planMuseum(23, style)
      for (const s of plan.slots) {
        const r = plan.rooms[s.room]
        expect(s.center[1]).toBe(plan.spec.hang)
        // Where there's panelling, the frame (mat and border: 0.115 m) clears its rail (top at 1.08 m).
        if (style === 'classic') expect(s.center[1] - s.maxH / 2 - 0.115).toBeGreaterThan(1.08)
        const onSide = Math.abs(s.center[0] - r.x0) < 1e-9 || Math.abs(s.center[0] - r.x1) < 1e-9
        const onBack = Math.abs(s.center[2] - r.zBack) < 1e-9
        expect(onSide || onBack).toBe(true)
        // Within the wall's length, and clear of the doorway.
        expect(s.center[2]).toBeLessThan(r.zFront)
        expect(s.center[2]).toBeGreaterThanOrEqual(r.zBack)
        if (onBack) expect(Math.abs(s.center[0]) - s.maxW / 2).toBeGreaterThanOrEqual(onBack && s.room < plan.rooms.length - 1 ? plan.spec.doorW / 2 : -Infinity)
      }
    }
  })

  it('spreads the pictures on a wall evenly along it, centered', () => {
    // 12 pieces in the classic gallery: the second room has two on each side wall.
    const plan = planMuseum(12, 'classic')
    const room = plan.rooms[1]
    for (const side of [1, -1]) {
      const zs = plan.slots.filter((s) => s.room === 1 && s.normal[0] === side).map((s) => s.center[2])
      expect(zs.length).toBe(2)
      const mid = (room.zFront + room.zBack) / 2
      expect((zs[0] + zs[1]) / 2).toBeCloseTo(mid)
    }
  })

  it('puts every viewing spot where a visitor can stand', () => {
    for (const style of STYLE_NAMES) {
      const plan = planMuseum(30, style)
      expect(walkable(plan, ...plan.start)).toBe(true)
      for (const s of plan.slots) expect(walkable(plan, s.view[0], s.view[1])).toBe(true)
    }
  })

  it('keeps visitors out of walls, but lets them through doorways', () => {
    const plan = planMuseum(20, 'gallery')
    const door = plan.doorways[0]
    // Through the middle of the doorway: fine. Through the wall beside it: blocked.
    expect(walkable(plan, 0, door.z)).toBe(true)
    expect(walkable(plan, plan.spec.width / 2 - 0.5, door.z)).toBe(false)
    // Outside the side wall: blocked.
    expect(walkable(plan, plan.spec.width, -3)).toBe(false)
    // Walking into a wall at a slant slides along it instead of stopping.
    const r = plan.rooms[0]
    const along = slide(plan, [r.x0 + 1, -3], [r.x0 - 1, -4])
    expect(along[1]).toBeCloseTo(-4)
    expect(along[0]).toBeCloseTo(r.x0 + 1)
  })

  it('walks around furniture on the way to every picture', () => {
    const plan = planMuseum(14, 'classic')
    expect(plan.features.length).toBeGreaterThan(4)
    let from = plan.start
    for (const s of plan.slots) {
      const path = route(plan, from, s.view)
      let at = from
      for (const p of path) {
        // Every point along every leg stays clear of furniture and walls.
        for (let t = 0; t <= 1; t += 0.02) expect(walkable(plan, at[0] + (p[0] - at[0]) * t, at[1] + (p[1] - at[1]) * t)).toBe(true)
        at = p
      }
      from = s.view
    }
  })

  it('routes between rooms through the doorways', () => {
    const plan = planMuseum(30, 'salon')
    const last = plan.slots[plan.slots.length - 1]
    const path = route(plan, plan.start, last.view)
    expect(path.length).toBe(plan.rooms.length)
    for (let i = 0; i < plan.doorways.length; i++) expect(path[i]).toEqual([0, plan.doorways[i].z])
    // Within one room it's a straight line.
    expect(route(plan, plan.start, plan.slots[0].view)).toEqual([plan.slots[0].view])
  })

  it('fits a picture to its slot without changing its shape', () => {
    const slot = planMuseum(1, 'gallery').slots[0]
    for (const aspect of [0.5, 0.75, 1, 4 / 3, 16 / 9, 3]) {
      const { w, h } = fitPicture(slot, aspect)
      expect(w / h).toBeCloseTo(aspect)
      expect(w).toBeLessThanOrEqual(slot.maxW + 1e-9)
      expect(h).toBeLessThanOrEqual(slot.maxH + 1e-9)
    }
  })
})

describe('facing a picture', () => {
  it('turns the camera so it looks straight at the picture from its viewing spot', () => {
    // Walker: yaw = atan2(−dx, −dz) for the direction (dx, dz) from the spot to the picture, and
    // the camera looks along (−sin yaw, −cos yaw) (three.js: −z when yaw is 0).
    for (const style of STYLE_NAMES) {
      const plan = planMuseum(25, style)
      for (const s of plan.slots) {
        const dx = s.center[0] - s.view[0]
        const dz = s.center[2] - s.view[1]
        const yaw = Math.atan2(-dx, -dz)
        const len = Math.hypot(dx, dz)
        expect(-Math.sin(yaw)).toBeCloseTo(dx / len)
        expect(-Math.cos(yaw)).toBeCloseTo(dz / len)
        // The spot is in front of the picture (on the side its normal points to).
        expect(-(dx * s.normal[0] + dz * s.normal[1])).toBeGreaterThan(0)
      }
    }
  })
})
