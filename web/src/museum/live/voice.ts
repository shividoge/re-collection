import type { LiveMember } from '../../data'
import type { LiveVisit } from './liveClient'
import { decode, encode, RELAY_RATE, resample, rms } from './mulaw'

/** A direct call that hasn't connected in this long uses the server's relay instead (ms). */
const DIRECT_WAIT_MS = 6000
/** Relayed voice is sent in pieces this long (samples at 16 kHz: a quarter second). */
const RELAY_CHUNK = RELAY_RATE / 4
/** Quieter than this is silence, and isn't sent through the relay (RMS, 0–1). */
const VOICE_LEVEL = 0.012
/** After speech, keep sending this long, so the ends of words aren't cut (ms). */
const HANGOVER_MS = 700
/** Relayed voice plays this far behind, to smooth out uneven arrival (s). */
const JITTER_S = 0.18

type Peer = {
  pc: RTCPeerConnection
  direct: boolean
  since: number
  audio: HTMLAudioElement
  pending: RTCIceCandidateInit[]
  level: AnalyserNode | null
}

type Signal = { type: 'offer' | 'answer'; sdp: string } | { type: 'ice'; candidate: RTCIceCandidateInit }

/**
 * Everyone in the live visit hears everyone else. Each pair of screens tries a direct WebRTC call
 * (the server only passes the setup messages); where that doesn't connect within a few seconds
 * (venue Wi-Fi, phones on mobile data), voice goes through the server instead, as small μ-law
 * pieces, a second or so behind. The browser's echo cancellation and noise suppression are on.
 * Without a microphone (refused, or none) a screen still hears the others.
 */
export class Voice {
  readonly ctx: AudioContext
  micAllowed: boolean | null = null
  private mic: MediaStream | null = null
  private peers = new Map<string, Peer>()
  private visit: LiveVisit
  private buffer: Float32Array[] = []
  private buffered = 0
  private loudAt = 0
  private playingUntil = 0
  private nextAt = new Map<string, number>()
  private heard = new Map<string, number>()
  private processor: ScriptProcessorNode | null = null
  /** This screen's id when the calls were set up; a rejoin (new id) starts every call over. */
  private callsFor: string | null = null
  /** Everyone else in the visit, called or not. */
  private others = new Set<string>()

  constructor(visit: LiveVisit) {
    this.visit = visit
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    this.ctx = new Ctx()
    visit.onSignal = (from, data) => void this.onSignal(from, data as Signal)
    visit.onAudio = (from, bytes) => this.play(from, bytes)
  }

  /** Call from the tap that joins: the browser asks for the microphone, and sound may start. */
  async start() {
    void this.ctx.resume()
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      this.micAllowed = true
      this.capture(this.mic)
    } catch {
      this.micAllowed = false
    }
  }

  stop() {
    for (const id of [...this.peers.keys()]) this.drop(id)
    this.processor?.disconnect()
    this.mic?.getTracks().forEach((t) => t.stop())
    void this.ctx.close().catch(() => {})
  }

  /** Who's speaking now: member ids heard in the last moment (yourself as "me"). */
  speaking(): Set<string> {
    const now = performance.now()
    const out = new Set<string>()
    for (const [id, at] of this.heard) if (now - at < 600) out.add(id)
    for (const [id, p] of this.peers) {
      if (!p.level) continue
      const data = new Float32Array(p.level.fftSize)
      p.level.getFloatTimeDomainData(data)
      if (rms(data) > VOICE_LEVEL) out.add(id)
    }
    if (now - this.loudAt < 300) out.add('me')
    return out
  }

  /** Calls the members who are here, and hangs up on those who left. */
  sync(members: LiveMember[]) {
    const me = this.visit.me
    if (!me) return
    // Joined again with a new id: the others see a new person, so every old call is dead.
    if (me !== this.callsFor) {
      for (const id of [...this.peers.keys()]) this.drop(id)
      this.callsFor = me
    }
    const here = new Set(members.map((m) => m.id))
    this.others = new Set([...here].filter((id) => id !== me))
    for (const id of [...this.peers.keys()]) if (!here.has(id)) this.drop(id)
    for (const m of members) {
      if (m.id === me || this.peers.has(m.id)) continue
      // One side of each pair makes the offer: the one with the smaller id.
      if (me < m.id) void this.call(m.id)
    }
  }

  private peer(id: string): Peer {
    let p = this.peers.get(id)
    if (p) return p
    const pc = new RTCPeerConnection({ iceServers: this.visit.iceServers })
    const audio = new Audio()
    audio.autoplay = true
    p = { pc, direct: false, since: performance.now(), audio, pending: [], level: null }
    const peer = p
    if (this.mic) for (const track of this.mic.getAudioTracks()) pc.addTrack(track, this.mic)
    else pc.addTransceiver('audio', { direction: 'recvonly' })
    pc.onicecandidate = (e) => e.candidate && this.visit.signal(id, { type: 'ice', candidate: e.candidate.toJSON() })
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track])
      audio.srcObject = stream
      void audio.play().catch(() => {})
      try {
        const analyser = this.ctx.createAnalyser()
        analyser.fftSize = 512
        this.ctx.createMediaStreamSource(stream).connect(analyser)
        peer.level = analyser
      } catch {
        /* no level meter: the call still works */
      }
    }
    pc.onconnectionstatechange = () => {
      peer.direct = pc.connectionState === 'connected'
      if (pc.connectionState === 'failed') pc.restartIce?.()
    }
    this.peers.set(id, p)
    return p
  }

  private async call(id: string) {
    const p = this.peer(id)
    const offer = await p.pc.createOffer()
    await p.pc.setLocalDescription(offer)
    this.visit.signal(id, { type: 'offer', sdp: offer.sdp })
  }

  private async onSignal(from: string, s: Signal) {
    if (!s || typeof s !== 'object') return
    try {
      if (s.type === 'offer') {
        // A fresh offer (the other side rejoined): start this call over.
        if (this.peers.has(from) && this.peers.get(from)!.pc.signalingState !== 'stable') this.drop(from)
        const p = this.peer(from)
        await p.pc.setRemoteDescription({ type: 'offer', sdp: s.sdp })
        await this.flush(p)
        const answer = await p.pc.createAnswer()
        await p.pc.setLocalDescription(answer)
        this.visit.signal(from, { type: 'answer', sdp: answer.sdp })
      } else if (s.type === 'answer') {
        const p = this.peers.get(from)
        if (p && p.pc.signalingState === 'have-local-offer') {
          await p.pc.setRemoteDescription({ type: 'answer', sdp: s.sdp })
          await this.flush(p)
        }
      } else if (s.type === 'ice') {
        const p = this.peer(from)
        if (p.pc.remoteDescription) await p.pc.addIceCandidate(s.candidate)
        else p.pending.push(s.candidate)
      }
    } catch {
      /* a setup message out of order: the next offer starts it over */
    }
  }

  private async flush(p: Peer) {
    for (const c of p.pending.splice(0)) await p.pc.addIceCandidate(c).catch(() => {})
  }

  private drop(id: string) {
    const p = this.peers.get(id)
    if (!p) return
    p.pc.close()
    p.audio.srcObject = null
    this.peers.delete(id)
    this.nextAt.delete(id)
  }

  /** Whether voice to or from this member has to go through the server. */
  private relayed(id: string): boolean {
    const p = this.peers.get(id)
    if (!p) return true
    return !p.direct && performance.now() - p.since > DIRECT_WAIT_MS
  }

  /** The microphone, cut into quarter seconds at 16 kHz, for the relay. */
  private capture(stream: MediaStream) {
    const source = this.ctx.createMediaStreamSource(stream)
    const processor = this.ctx.createScriptProcessor(4096, 1, 1)
    const silent = this.ctx.createGain()
    silent.gain.value = 0
    processor.onaudioprocess = (e) => {
      const samples = resample(new Float32Array(e.inputBuffer.getChannelData(0)), this.ctx.sampleRate, RELAY_RATE)
      const level = rms(samples)
      const now = performance.now()
      // While the relay plays someone else, only clearly louder speech goes out: the speakers
      // would otherwise be sent straight back (some browsers don't cancel that echo).
      const theyTalk = this.ctx.currentTime < this.playingUntil
      if (level > (theyTalk ? VOICE_LEVEL * 4 : VOICE_LEVEL)) this.loudAt = now
      this.buffer.push(samples)
      this.buffered += samples.length
      if (this.buffered < RELAY_CHUNK) return
      const chunk = new Float32Array(this.buffered)
      let at = 0
      for (const b of this.buffer.splice(0)) {
        chunk.set(b, at)
        at += b.length
      }
      this.buffered = 0
      // Anyone without a working call (including one not set up yet) needs the relay.
      const anyRelayed = [...this.others].some((id) => this.relayed(id))
      if (anyRelayed && now - this.loudAt < HANGOVER_MS) this.visit.sendAudio(encode(chunk))
    }
    source.connect(processor)
    processor.connect(silent).connect(this.ctx.destination)
    this.processor = processor
  }

  /** A piece of relayed voice, played in order, a moment behind. */
  private play(from: string, bytes: Uint8Array) {
    // Already heard directly: the relay copy (sent before the call connected) is skipped.
    if (!this.relayed(from)) return
    const samples = decode(bytes)
    if (rms(samples) > VOICE_LEVEL) this.heard.set(from, performance.now())
    const buffer = this.ctx.createBuffer(1, samples.length, RELAY_RATE)
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0)
    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.ctx.destination)
    const now = this.ctx.currentTime
    let at = this.nextAt.get(from) ?? 0
    // Fallen behind (a stall): start fresh rather than play old words late.
    if (at < now || at > now + 1.5) at = now + JITTER_S
    source.start(at)
    this.nextAt.set(from, at + buffer.duration)
    this.playingUntil = Math.max(this.playingUntil, at + buffer.duration)
  }
}
