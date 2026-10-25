import { describe, expect, it } from 'vitest'
import { shouldDetect } from './useHeadTracker'

describe('shouldDetect', () => {
  it('detects on the first new frame', () => {
    expect(shouldDetect(0.1, -1, 1000, -Infinity)).toBe(true)
  })
  it('skips a frame it has already seen', () => {
    expect(shouldDetect(0.5, 0.5, 2000, 0)).toBe(false)
  })
  it('skips new frames that come sooner than 15 Hz', () => {
    expect(shouldDetect(0.6, 0.5, 1050, 1000)).toBe(false)
  })
  it('detects once 1/15 s has passed', () => {
    expect(shouldDetect(0.6, 0.5, 1000 + 1000 / 15, 1000)).toBe(true)
  })
})
