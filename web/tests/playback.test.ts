import { describe, expect, it } from 'vitest'
import { Playback } from '../src/scene/playback'
import { roomSteps } from '../src/scene/ProcessingStatus'
import type { CaptureStatus } from '../src/data/assets'

describe('playback clock without a video', () => {
  /** A wall clock the test moves by hand (ms). */
  const clock = () => {
    const c = { ms: 1000, now: () => c.ms }
    return c
  }

  it('runs, stops at the end, seeks, and tells subscribers', () => {
    const c = clock()
    const p = new Playback(c.now)
    p.setDuration(2)
    let notified = 0
    p.subscribe(() => notified++)
    p.play()
    expect(p.playing).toBe(true)
    expect(p.getSnapshot().playing).toBe(true)
    c.ms += 1500
    p.tick()
    expect(p.timeRef.current).toBeCloseTo(1.5)
    c.ms += 1000
    p.tick()
    expect(p.timeRef.current).toBe(2)
    expect(p.playing).toBe(false)
    p.seek(0.5)
    expect(p.getSnapshot()).toEqual({ time: 0.5, playing: false })
    p.setRate(2)
    p.play()
    c.ms += 250
    p.tick()
    expect(p.time).toBeCloseTo(1)
    p.pause()
    expect(p.playing).toBe(false)
    expect(notified).toBeGreaterThan(3)
  })

  it("doesn't count idle time before play, while paused, or before a seek as playback", () => {
    const c = clock()
    const p = new Playback(c.now)
    p.setDuration(60)
    // The canvas sat idle for five minutes; the first frame after Play is 16 ms later.
    c.ms += 300_000
    p.play()
    c.ms += 16
    p.tick()
    expect(p.time).toBeCloseTo(0.016)
    c.ms += 984
    p.tick()
    expect(p.time).toBeCloseTo(1)
    // Paused for a minute, then played again: picks up where it stopped.
    p.pause()
    c.ms += 60_000
    p.tick()
    expect(p.time).toBeCloseTo(1)
    p.play()
    c.ms += 500
    p.tick()
    expect(p.time).toBeCloseTo(1.5)
    // A seek while playing counts from the new time.
    c.ms += 2000
    p.seek(10)
    c.ms += 100
    p.tick()
    expect(p.time).toBeCloseTo(10.1)
    // A speed change keeps the time so far and runs at the new speed from now.
    p.setRate(0.5)
    c.ms += 1000
    p.tick()
    expect(p.time).toBeCloseTo(10.6)
  })

  it('keeps the snapshot object stable while nothing changes', () => {
    const c = clock()
    const p = new Playback(c.now)
    p.setDuration(5)
    const a = p.getSnapshot()
    c.ms += 100
    p.tick()
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
