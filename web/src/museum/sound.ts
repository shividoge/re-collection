// The museum's sound: quiet classical music while walking (Satie's Gymnopédie No. 1, a public
// domain recording; see public/museum/audio/CREDITS.md), dipping when the visitor steps into a
// picture and rising again gently when they come back, and soft transition sounds made right
// here from filtered noise and bell tones (no files).
//
// Browsers only allow sound after the visitor has clicked or tapped, so nothing plays until then.

const MUSIC_URL = `${import.meta.env.BASE_URL}museum/audio/gymnopedie-1.mp3`
const PREF_KEY = 'relive.museum.music'
/** The music's normal level: background, below a voice. */
const MUSIC_LEVEL = 0.32

export class MuseumSound {
  private ctx: AudioContext | null = null
  private music: HTMLAudioElement | null = null
  private musicGain: GainNode | null = null
  private fx: GainNode | null = null
  private noise: AudioBuffer | null = null
  private enabled: boolean

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

  /** Call from a click or tap: starts the audio engine and fades the music in. */
  wake() {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      this.ctx = new Ctx()
      this.fx = this.ctx.createGain()
      this.fx.gain.value = 0.9
      this.fx.connect(this.ctx.destination)
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
      this.fadeMusic(MUSIC_LEVEL, 4)
    }
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
      this.fadeMusic(MUSIC_LEVEL, 2)
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

  private whiteNoise(): AudioBuffer {
    if (this.noise) return this.noise
    const ctx = this.ctx!
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    return (this.noise = buf)
  }

  /** A breath of air, swept from one pitch to another through a soft band-pass filter. */
  private whoosh(from: number, to: number, seconds: number, peak: number, delay = 0) {
    const ctx = this.ctx!
    const t = ctx.currentTime + delay
    const src = ctx.createBufferSource()
    src.buffer = this.whiteNoise()
    const band = ctx.createBiquadFilter()
    band.type = 'bandpass'
    band.Q.value = 0.9
    band.frequency.setValueAtTime(from, t)
    band.frequency.exponentialRampToValueAtTime(to, t + seconds)
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(peak, t + seconds * 0.45)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + seconds)
    src.connect(band).connect(gain).connect(this.fx!)
    src.start(t)
    src.stop(t + seconds + 0.05)
  }

  /** A soft bell: a few sine partials with a gentle attack and a long fade. */
  private bell(freq: number, delay: number, level: number, seconds = 2.2) {
    const ctx = this.ctx!
    const t = ctx.currentTime + delay
    for (const [mult, amp] of [
      [1, 1],
      [2.01, 0.35],
      [3.02, 0.12],
    ]) {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = freq * mult
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(level * amp, t + 0.04)
      g.gain.exponentialRampToValueAtTime(0.0001, t + seconds)
      osc.connect(g).connect(this.fx!)
      osc.start(t)
      osc.stop(t + seconds + 0.05)
    }
  }

  /** Stepping into a picture: air rising, then a bright, soft chime as it opens. */
  enter() {
    if (!this.ctx) return
    this.whoosh(260, 2600, 1.0, 0.22)
    this.bell(659.25, 0.62, 0.05) // E5
    this.bell(987.77, 0.7, 0.035) // B5
    this.bell(1318.5, 0.78, 0.02, 1.8) // E6
  }

  /** Coming back out: air falling, and a low, warm tone settling. */
  exit() {
    if (!this.ctx) return
    this.whoosh(2400, 240, 1.0, 0.2)
    this.bell(329.63, 0.45, 0.05, 2.4) // E4
    this.bell(246.94, 0.55, 0.04, 2.6) // B3
  }
}
