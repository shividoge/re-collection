// The museum's sound: quiet classical music while walking (Satie's Gymnopédie No. 1, a public
// domain recording; see public/museum/audio/CREDITS.md), fading away when the visitor steps into
// a picture (each picture has its own sound) and rising again gently when they come back, and
// the sound of diving through a picture, made right here (no files).
//
// Browsers only allow sound after the visitor has clicked or tapped, so nothing plays until then.

const MUSIC_URL = `${import.meta.env.BASE_URL}museum/audio/gymnopedie-1.mp3`
const PREF_KEY = 'relive.museum.music'
/** The music's normal level: clearly heard, still below a voice. */
const MUSIC_LEVEL = 0.85

export class MuseumSound {
  private ctx: AudioContext | null = null
  private music: HTMLAudioElement | null = null
  private musicGain: GainNode | null = null
  private fx: GainNode | null = null
  private warps: Promise<{ forward: AudioBuffer; backward: AudioBuffer }> | null = null
  private enabled: boolean
  /** The music's level now, 0–1 of the normal level (lower while others talk in a live visit). */
  private base = 1

  constructor() {
    let saved: string | null = null
    try {
      saved = localStorage.getItem(PREF_KEY)
    } catch {
      // Private mode: music on by default.
    }
    this.enabled = saved !== 'off'
  }

  get musicOn() {
    return this.enabled
  }

  /** The level the music comes back to (0–1 of normal). */
  get level() {
    return this.base
  }

  /** Call from a click or tap: starts the audio engine and fades the music in. */
  wake() {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      this.ctx = new Ctx()
      this.fx = this.ctx.createGain()
      this.fx.gain.value = 0.9
      this.fx.connect(this.ctx.destination)
      this.warps = renderWarp(this.ctx.sampleRate)
      this.music = new Audio(MUSIC_URL)
      this.music.loop = true
      this.music.preload = 'auto'
      this.musicGain = this.ctx.createGain()
      this.musicGain.gain.value = 0
      this.ctx.createMediaElementSource(this.music).connect(this.musicGain).connect(this.ctx.destination)
    }
    void this.ctx.resume()
    if (this.enabled && this.music?.paused) {
      void this.music.play().catch(() => {})
      this.fadeMusic(MUSIC_LEVEL * this.base, 4)
    }
  }

  /** Sets the level the music comes back to (0–1 of normal); fades to it now unless `quietNow`. */
  setBase(level: number, quietNow = false) {
    this.base = level
    if (!quietNow) this.musicTo(level, 1.5)
  }

  setMusic(on: boolean) {
    this.enabled = on
    try {
      localStorage.setItem(PREF_KEY, on ? 'on' : 'off')
    } catch {
      // Private mode: the choice lasts for this visit.
    }
    if (!this.ctx || !this.music) return
    if (on) {
      void this.music.play().catch(() => {})
      this.fadeMusic(MUSIC_LEVEL * this.base, 2)
    } else {
      this.fadeMusic(0, 1.2)
      const m = this.music
      setTimeout(() => !this.enabled && m.pause(), 1300)
    }
  }

  /** Fades the music to `level` (0–1 of the normal level) over `seconds`. */
  musicTo(level: number, seconds: number) {
    if (this.enabled) this.fadeMusic(MUSIC_LEVEL * level, seconds)
  }

  private fadeMusic(to: number, seconds: number) {
    if (!this.ctx || !this.musicGain) return
    const g = this.musicGain.gain
    const now = this.ctx.currentTime
    g.cancelScheduledValues(now)
    g.setValueAtTime(g.value, now)
    // An exponential-feeling fade without hitting zero: linear to a hair above, then off.
    g.linearRampToValueAtTime(Math.max(to, 0.0001), now + seconds)
  }

  /**
   * Stops everything and lets the audio engine go (leaving the museum). A later `wake()` starts
   * afresh, so a museum opened again never stacks a second engine on this one.
   */
  dispose() {
    this.music?.pause()
    this.music?.removeAttribute('src')
    this.music?.load()
    void this.ctx?.close().catch(() => {})
    this.ctx = null
    this.music = null
    this.musicGain = null
    this.fx = null
    this.warps = null
  }

  /**
   * The sound of diving through a picture, its crossing `crossIn` seconds from now: forwards to
   * step in, played backwards to step out (the air rushing the other way).
   */
  warp(dir: 'in' | 'out', crossIn: number) {
    const ctx = this.ctx
    if (!ctx || !this.warps || !this.fx) return
    const asked = ctx.currentTime
    const fx = this.fx
    void this.warps.then(({ forward, backward }) => {
      const buffer = dir === 'in' ? forward : backward
      const crossAt = dir === 'in' ? WARP_CROSS : WARP_LEN - WARP_CROSS
      const when = asked + crossIn - crossAt
      const src = ctx.createBufferSource()
      src.buffer = buffer
      src.connect(fx)
      const now = ctx.currentTime
      // If it's late (the sound was still being made), join it where it should be by now.
      if (when >= now) src.start(when)
      else src.start(now, Math.min(buffer.duration - 0.01, now - when))
    })
  }
}

/** Length of the warp sound, and where in it the crossing falls (s). */
const WARP_LEN = 3.2
const WARP_CROSS = 1.8

function noiseBuffer(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const buf = ctx.createBuffer(2, Math.round(ctx.sampleRate * seconds), ctx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const data = buf.getChannelData(c)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  }
  return buf
}

/**
 * Makes the warp sound once, offline: rushing air whose pitch climbs with the speed, a deep
 * rumble under it, a soft shimmer of tones rising an octave, and at the crossing the air parting
 * in a sweep down, all in a dark, wide hall. Nothing tonal is left ringing at the end.
 */
async function renderWarp(rate: number): Promise<{ forward: AudioBuffer; backward: AudioBuffer }> {
  const ctx = new OfflineAudioContext(2, Math.round(rate * WARP_LEN), rate)
  const X = WARP_CROSS
  const noise = noiseBuffer(ctx, WARP_LEN)

  // The hall: a long, darkening tail of noise.
  const hall = ctx.createConvolver()
  const ir = ctx.createBuffer(2, Math.round(rate * 2.6), rate)
  for (let c = 0; c < 2; c++) {
    const data = ir.getChannelData(c)
    let smooth = 0
    for (let i = 0; i < data.length; i++) {
      // Low-passed a little more as it decays, so the tail is warm, not hissy.
      const t = i / data.length
      smooth += ((Math.random() * 2 - 1) - smooth) * (0.6 - 0.45 * t)
      data[i] = smooth * Math.pow(1 - t, 3)
    }
  }
  hall.buffer = ir
  const bus = ctx.createGain()
  const dry = ctx.createGain()
  dry.gain.value = 0.8
  const wet = ctx.createGain()
  wet.gain.value = 0.5
  bus.connect(dry).connect(ctx.destination)
  bus.connect(hall).connect(wet).connect(ctx.destination)

  const envelope = (g: AudioParam, points: [number, number][]) => {
    g.setValueAtTime(points[0][1], points[0][0])
    for (const [t, v] of points.slice(1)) g.exponentialRampToValueAtTime(v, t)
  }
  const play = (node: AudioScheduledSourceNode) => {
    node.start(0)
    node.stop(WARP_LEN)
  }

  // 1. Rushing air, its band climbing with the speed and sweeping across from left to right.
  const air = ctx.createBufferSource()
  air.buffer = noise
  const airBand = ctx.createBiquadFilter()
  airBand.type = 'bandpass'
  envelope(airBand.frequency, [
    [0, 160],
    [X, 3800],
    [X + 0.7, 600],
  ])
  airBand.Q.setValueAtTime(0.6, 0)
  airBand.Q.linearRampToValueAtTime(1.6, X)
  const airGain = ctx.createGain()
  envelope(airGain.gain, [
    [0, 0.0001],
    [X * 0.5, 0.06],
    [X, 0.9],
    [X + 1.3, 0.0001],
  ])
  const airPan = ctx.createStereoPanner()
  airPan.pan.setValueAtTime(-0.35, 0)
  airPan.pan.linearRampToValueAtTime(0.35, X)
  airPan.pan.linearRampToValueAtTime(0, X + 0.8)
  air.connect(airBand).connect(airGain).connect(airPan).connect(bus)
  play(air)

  // 2. A deep rumble underneath, felt more than heard.
  const rumble = ctx.createBufferSource()
  rumble.buffer = noise
  rumble.playbackRate.value = 0.5
  const low = ctx.createBiquadFilter()
  low.type = 'lowpass'
  low.frequency.value = 110
  const rumbleGain = ctx.createGain()
  envelope(rumbleGain.gain, [
    [0, 0.0001],
    [X, 1.6],
    [X + 1.0, 0.0001],
  ])
  rumble.connect(low).connect(rumbleGain).connect(bus)
  play(rumble)

  // 3. A shimmer of soft tones, rising an octave as the visitor speeds up, falling away after.
  const shimmerFilter = ctx.createBiquadFilter()
  shimmerFilter.type = 'lowpass'
  shimmerFilter.Q.value = 1.2
  envelope(shimmerFilter.frequency, [
    [0, 300],
    [X, 5200],
    [X + 0.8, 800],
  ])
  const shimmerGain = ctx.createGain()
  envelope(shimmerGain.gain, [
    [0, 0.0001],
    [X * 0.6, 0.006],
    [X, 0.032],
    [X + 0.9, 0.0001],
  ])
  shimmerFilter.connect(shimmerGain).connect(bus)
  ;[110, 164.81, 220, 329.63, 440, 659.25].forEach((f, i) => {
    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.detune.value = (i % 2 ? 1 : -1) * (4 + i * 2)
    envelope(osc.frequency, [
      [0, f],
      [X, f * 2],
      [X + 0.8, f * 1.4],
    ])
    const pan = ctx.createStereoPanner()
    pan.pan.value = (i / 5) * 1.4 - 0.7
    osc.connect(pan).connect(shimmerFilter)
    play(osc)
  })

  // 4. Going through: the air parting in a fast sweep down.
  const part = ctx.createBufferSource()
  part.buffer = noise
  const partBand = ctx.createBiquadFilter()
  partBand.type = 'bandpass'
  partBand.Q.value = 2
  envelope(partBand.frequency, [
    [0, 5000],
    [X - 0.06, 5000],
    [X + 0.45, 240],
  ])
  const partGain = ctx.createGain()
  envelope(partGain.gain, [
    [0, 0.0001],
    [X - 0.14, 0.0001],
    [X, 0.75],
    [X + 0.6, 0.0001],
  ])
  part.connect(partBand).connect(partGain).connect(bus)
  play(part)

  const forward = await ctx.startRendering()
  // Even it out to a comfortable peak, and make the reversed copy for stepping out.
  let peak = 0
  for (let c = 0; c < forward.numberOfChannels; c++) for (const v of forward.getChannelData(c)) peak = Math.max(peak, Math.abs(v))
  const backward = new AudioBuffer({ length: forward.length, numberOfChannels: forward.numberOfChannels, sampleRate: rate })
  for (let c = 0; c < forward.numberOfChannels; c++) {
    const data = forward.getChannelData(c)
    if (peak > 0) for (let i = 0; i < data.length; i++) data[i] *= 0.85 / peak
    backward.getChannelData(c).set(Float32Array.from(data).reverse())
  }
  return { forward, backward }
}
