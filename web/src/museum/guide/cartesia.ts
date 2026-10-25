// The AI guide's voice and ears, straight to Cartesia from the browser with a short-lived token
// (the API key stays in Convex: backend guideNode.voiceToken).
// - Sonic speaks: text in over a WebSocket, raw audio chunks back, played as they arrive.
// - Ink-2 listens (Realtime STT "Auto", /stt/turns/websocket): the microphone streamed as 16 kHz
//   PCM. Its turn detection says when the person starts talking (the guide stops), when they're
//   probably done (the answer starts being worked out) and when they're surely done (it's said).
//   It runs with Cartesia's "Patient" turn settings, for people who pause to think, and the
//   palace's names as key terms, so "Priya" is heard as Priya.

export type VoiceToken = { token: string; expiresAt: number; voice: string; version: string; keyterms: string[] }

/** Sonic's model and how the guide sounds: a little slower than conversation, for clarity. */
const TTS_MODEL = 'sonic-3.6'
const TTS_RATE = 24000
const SPEED = 0.9
const STT_MODEL = 'ink-2'
const STT_RATE = 16000
/** Cartesia's "Patient" profile: wait longer before deciding someone has finished. */
const PATIENT_TURNS = { turn_start_threshold: '0.8', turn_eager_end_threshold: '0.3', turn_end_threshold: '0.1', turn_end_timeout_ms: '8000' }
/** While the guide speaks, only clearly louder sound counts as the person talking (its own voice comes back through the mic). */
const BARGE_IN_LEVEL = 0.06

const rms = (x: Float32Array) => {
  let s = 0
  for (let i = 0; i < x.length; i++) s += x[i] * x[i]
  return Math.sqrt(s / Math.max(1, x.length))
}

function resample(input: Float32Array, from: number, to: number): Float32Array {
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

export type Listener = {
  /** The person started talking (the guide should stop). */
  onStart: () => void
  /** They're probably done: what they said so far (start working out an answer). */
  onEager?: (text: string) => void
  /** They went on after all (drop that early answer). */
  onResume?: () => void
  /** What they said, once their turn surely ended. */
  onEnd: (text: string) => void
  /** Something went wrong with listening (shown gently). */
  onError: (message: string) => void
}

export class CartesiaVoice {
  readonly ctx: AudioContext
  private getToken: () => Promise<VoiceToken>
  private token: VoiceToken | null = null
  private tts: WebSocket | null = null
  private ttsReady: Promise<WebSocket> | null = null
  private context = ''
  private sources: AudioBufferSourceNode[] = []
  private playAt = 0
  private finishing: (() => void) | null = null
  private stt: WebSocket | null = null
  private mic: MediaStream | null = null
  private processor: ScriptProcessorNode | null = null
  /** Speaking now (from the first sound until the last plays out). */
  speaking = false
  onSpeaking: (speaking: boolean) => void = () => {}

  constructor(getToken: () => Promise<VoiceToken>) {
    this.getToken = getToken
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    this.ctx = new Ctx()
  }

  private async fresh(): Promise<VoiceToken> {
    if (!this.token || this.token.expiresAt - Date.now() < 60_000) this.token = await this.getToken()
    return this.token
  }

  private url(path: string, params: Record<string, string>, t: VoiceToken, keyterms: string[] = []) {
    const u = new URL(`wss://api.cartesia.ai${path}`)
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
    for (const term of keyterms) u.searchParams.append('keyterm', term)
    u.searchParams.set('cartesia_version', t.version)
    u.searchParams.set('access_token', t.token)
    return u.toString()
  }

  // ---- speaking (Sonic) ---------------------------------------------------------------------

  private async speaker(): Promise<WebSocket> {
    if (this.tts && this.tts.readyState === WebSocket.OPEN) return this.tts
    if (this.ttsReady) return this.ttsReady
    this.ttsReady = (async () => {
      const t = await this.fresh()
      const ws = new WebSocket(this.url('/tts/websocket', {}, t))
      ws.onmessage = (e) => this.onTts(e.data)
      ws.onclose = () => {
        if (this.tts === ws) this.tts = null
      }
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve()
        ws.onerror = () => reject(new Error("Couldn't reach Cartesia to speak."))
      })
      this.tts = ws
      return ws
    })().finally(() => (this.ttsReady = null))
    return this.ttsReady
  }

  private onTts(raw: unknown) {
    if (typeof raw !== 'string') return
    let msg: { type?: string; data?: string; context_id?: string; done?: boolean }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (msg.context_id && msg.context_id !== this.context) return
    if (msg.type === 'chunk' && msg.data) this.play(msg.data)
    if (msg.type === 'done' || msg.done) {
      const wait = Math.max(0, (this.playAt - this.ctx.currentTime) * 1000)
      setTimeout(() => this.finish(), wait)
    }
    if (msg.type === 'error') this.finish()
  }

  private play(base64: string) {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const samples = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4))
    if (samples.length === 0) return
    const buffer = this.ctx.createBuffer(1, samples.length, TTS_RATE)
    buffer.copyToChannel(new Float32Array(samples), 0)
    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.ctx.destination)
    const at = Math.max(this.playAt, this.ctx.currentTime + 0.05)
    source.start(at)
    this.playAt = at + buffer.duration
    this.sources.push(source)
    if (!this.speaking) {
      this.speaking = true
      this.onSpeaking(true)
    }
  }

  private finish() {
    this.sources = []
    if (this.speaking) {
      this.speaking = false
      this.onSpeaking(false)
    }
    this.finishing?.()
    this.finishing = null
  }

  /** Says `text`, starting as soon as the first audio arrives; resolves when it's been said (or stopped). */
  async say(text: string): Promise<void> {
    this.stop()
    if (!text.trim()) return
    void this.ctx.resume()
    const ws = await this.speaker()
    const context = `g${Date.now()}${Math.random().toString(36).slice(2, 7)}`
    this.context = context
    this.playAt = 0
    const t = await this.fresh()
    const said = new Promise<void>((resolve) => (this.finishing = resolve))
    ws.send(
      JSON.stringify({
        model_id: TTS_MODEL,
        transcript: text,
        voice: t.voice,
        output_format: { container: 'raw', encoding: 'pcm_f32le', sample_rate: TTS_RATE },
        language: 'en',
        context_id: context,
        continue: false,
        generation_config: { speed: SPEED },
      }),
    )
    return said
  }

  /** Stops speaking at once (the person started talking, or the scene changed). */
  stop() {
    if (this.tts && this.context && this.tts.readyState === WebSocket.OPEN) this.tts.send(JSON.stringify({ context_id: this.context, cancel: true }))
    this.context = ''
    for (const s of this.sources) {
      try {
        s.stop()
      } catch {
        /* already ended */
      }
    }
    this.playAt = 0
    this.finish()
  }

  // ---- listening (Ink-2) ----------------------------------------------------------------------

  /** Opens the microphone and streams it to Ink-2 until `unlisten`. */
  async listen(listener: Listener) {
    this.unlisten()
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    } catch {
      listener.onError('The microphone is off, so the guide can only talk, not listen.')
      return
    }
    let t: VoiceToken
    try {
      t = await this.fresh()
    } catch (e) {
      listener.onError((e as Error).message)
      return
    }
    const ws = new WebSocket(this.url('/stt/turns/websocket', { model: STT_MODEL, encoding: 'pcm_s16le', sample_rate: String(STT_RATE), ...PATIENT_TURNS }, t, t.keyterms))
    ws.binaryType = 'arraybuffer'
    this.stt = ws
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return
      let msg: { type?: string; transcript?: string; message?: string }
      try {
        msg = JSON.parse(e.data)
      } catch {
        return
      }
      const text = (msg.transcript ?? '').trim()
      if (msg.type === 'turn.start') listener.onStart()
      else if (msg.type === 'turn.eager_end') {
        if (text) listener.onEager?.(text)
      } else if (msg.type === 'turn.resume') listener.onResume?.()
      else if (msg.type === 'turn.end') {
        if (text) listener.onEnd(text)
      } else if (msg.type === 'error') listener.onError(msg.message ?? 'Listening stopped.')
    }
    ws.onerror = () => listener.onError("Couldn't reach Cartesia to listen.")

    const source = this.ctx.createMediaStreamSource(this.mic)
    const processor = this.ctx.createScriptProcessor(4096, 1, 1)
    const silent = this.ctx.createGain()
    silent.gain.value = 0
    processor.onaudioprocess = (e) => {
      const input = new Float32Array(e.inputBuffer.getChannelData(0))
      // The guide's own voice comes back through the microphone: while it speaks, send only what's
      // clearly louder (the person talking over it), which also stops it.
      if (this.speaking) {
        if (rms(input) < BARGE_IN_LEVEL) return
        listener.onStart()
      }
      if (ws.readyState !== WebSocket.OPEN) return
      const samples = resample(input, this.ctx.sampleRate, STT_RATE)
      const pcm = new Int16Array(samples.length)
      for (let i = 0; i < samples.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)))
      ws.send(pcm.buffer)
    }
    source.connect(processor)
    processor.connect(silent).connect(this.ctx.destination)
    this.processor = processor
  }

  unlisten() {
    if (this.stt && this.stt.readyState === WebSocket.OPEN) this.stt.send(JSON.stringify({ type: 'close' }))
    this.stt?.close()
    this.stt = null
    this.processor?.disconnect()
    this.processor = null
    this.mic?.getTracks().forEach((track) => track.stop())
    this.mic = null
  }

  close() {
    this.stop()
    this.unlisten()
    this.tts?.close()
    this.tts = null
    void this.ctx.close().catch(() => {})
  }
}
