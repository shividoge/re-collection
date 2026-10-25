import { describe, expect, it } from 'vitest'
import { Playback } from '../src/scene/playback'
import { roomSteps } from '../src/scene/ProcessingStatus'
import type { CaptureStatus } from '../src/data/assets'

describe('playback clock without a video', () => {
  it('runs, stops at the end, seeks, and tells subscribers', () => {
    const p = new Playback()
    p.setDuration(2)
    let notified = 0
    p.subscribe(() => notified++)
    p.play()
    expect(p.playing).toBe(true)
    expect(p.getSnapshot().playing).toBe(true)
    p.tick(1.5)
    expect(p.timeRef.current).toBeCloseTo(1.5)
    p.tick(1)
    expect(p.timeRef.current).toBe(2)
    expect(p.playing).toBe(false)
    p.seek(0.5)
    expect(p.getSnapshot()).toEqual({ time: 0.5, playing: false })
    p.setRate(2)
    p.play()
    p.tick(0.25)
    expect(p.time).toBeCloseTo(1)
    p.pause()
    expect(p.playing).toBe(false)
    expect(notified).toBeGreaterThan(3)
  })

  it('keeps the snapshot object stable while nothing changes', () => {
    const p = new Playback()
    p.setDuration(5)
    const a = p.getSnapshot()
    p.tick(0.1)
    expect(p.getSnapshot()).toBe(a)
  })
})

describe('processing steps', () => {
  const base: CaptureStatus = {
    source: 'phone',
    upload: 'done',
    uploadErrors: [],
    warnings: [],
    convert: 'skipped',
    facts: 'running',
    bake: 'running',
    splat: 'skipped',
    errors: {},
    progress: null,
    updatedAt: 0,
  }
  it('lists upload and bake for a phone capture, and the conversion for a video', () => {
    expect(roomSteps(base).map((s) => s.name)).toEqual(['Upload', 'Preparing the 3D room'])
    const video = roomSteps({ ...base, source: 'video', convert: 'failed', errors: { convert: 'Out of GPU memory.' } })
    expect(video[1]).toEqual({ name: 'Rebuilding the room from the video', stage: 'failed', error: 'Out of GPU memory.' })
  })
  it('reports an invalid upload as failed with its errors', () => {
    const s = roomSteps({ ...base, upload: 'invalid', uploadErrors: ['depth.bin is 12 bytes short.'] })
    expect(s[0]).toEqual({ name: 'Upload', stage: 'failed', error: 'depth.bin is 12 bytes short.' })
  })
})
