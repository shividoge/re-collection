// Voice relayed through the guide is sent small: 16 kHz mono, one byte per sample (G.711 μ-law,
// as telephones use), about 4 KB per quarter second.

export const RELAY_RATE = 16000

const BIAS = 0x84
const CLIP = 32635

/** One 16-bit sample to a μ-law byte. */
export function encodeSample(sample: number): number {
  let s = Math.max(-32768, Math.min(32767, Math.round(sample)))
  const sign = s < 0 ? 0x80 : 0
  if (sign) s = -s
  s = Math.min(s, CLIP) + BIAS
  let exponent = 7
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--
  const mantissa = (s >> (exponent + 3)) & 0x0f
  return ~(sign | (exponent << 4) | mantissa) & 0xff
}

/** One μ-law byte back to a 16-bit sample. */
export function decodeSample(byte: number): number {
  const u = ~byte & 0xff
  const sign = u & 0x80
  const exponent = (u >> 4) & 0x07
  const mantissa = u & 0x0f
  const s = (((mantissa << 3) + BIAS) << exponent) - BIAS
  return sign ? -s : s
}

/** Samples in −1…1 to μ-law bytes. */
export function encode(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length)
  for (let i = 0; i < samples.length; i++) out[i] = encodeSample(samples[i] * 32767)
  return out
}

/** μ-law bytes to samples in −1…1. */
export function decode(bytes: Uint8Array): Float32Array {
  const out = new Float32Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) out[i] = decodeSample(bytes[i]) / 32768
  return out
}

/** Resamples by linear interpolation (the microphone runs at 44.1 or 48 kHz). */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input
  const n = Math.floor((input.length * to) / from)
  const out = new Float32Array(n)
  const step = from / to
  for (let i = 0; i < n; i++) {
    const at = i * step
    const k = Math.floor(at)
    const f = at - k
    out[i] = input[k] * (1 - f) + (input[Math.min(k + 1, input.length - 1)] ?? 0) * f
  }
  return out
}

/** Loudness of a stretch of samples (root mean square, 0–1). */
export function rms(samples: Float32Array): number {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / Math.max(1, samples.length))
}
