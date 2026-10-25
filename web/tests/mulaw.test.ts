import { describe, expect, it } from 'vitest'
import { decode, decodeSample, encode, encodeSample, resample, rms } from '../src/museum/live/mulaw'

describe('μ-law voice relay', () => {
  it('round-trips a sample within the codec\'s step size', () => {
    for (const s of [0, 1, -1, 100, -100, 1000, -5000, 12000, -32000, 32767]) {
      const back = decodeSample(encodeSample(s))
      // μ-law keeps about 2–3% of the value, and small values almost exactly.
      expect(Math.abs(back - s)).toBeLessThanOrEqual(Math.max(8, Math.abs(s) * 0.035))
    }
  })
  it('keeps a tone recognisable and about as loud', () => {
    const tone = new Float32Array(1600).map((_, i) => 0.5 * Math.sin((i / 16000) * 2 * Math.PI * 440))
    const back = decode(encode(tone))
    expect(back.length).toBe(tone.length)
    expect(rms(back)).toBeCloseTo(rms(tone), 1)
  })
  it('resamples 48 kHz to 16 kHz to a third of the samples', () => {
    const input = new Float32Array(4800).fill(0.25)
    const out = resample(input, 48000, 16000)
    expect(out.length).toBe(1600)
    expect(out[800]).toBeCloseTo(0.25)
  })
})
