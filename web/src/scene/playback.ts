// One clock for a viewer, outside React. The video is the master when there is one (so sound,
// picture and 3D stay in sync); without one, a plain clock runs over the frame times. The 3D
// scene reads `timeRef` every frame; only the scrubber and time label subscribe to changes
// (usePlaybackState), at most ~15 times a second. PlaybackDriver ticks it from R3F's loop.
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useState, useSyncExternalStore } from 'react'

export interface PlaybackState {
  time: number
  playing: boolean
}

/** UI updates while playing, at most this often (ms). */
const UI_MS = 66

export class Playback {
  readonly timeRef = { current: 0 }
  private video: HTMLVideoElement | null = null
  private duration = 0
  private rate = 1
  private clockPlaying = false
  private state: PlaybackState = { time: 0, playing: false }
  private lastUi = 0
  private listeners = new Set<() => void>()
  private redraw: (() => void) | null = null
  private unbindVideo: (() => void) | null = null

  get playing(): boolean {
    return this.video ? !this.video.paused && !this.video.ended : this.clockPlaying
  }

  get time(): number {
    return this.timeRef.current
  }

  /** Re-render the 3D view (set by PlaybackDriver). */
  setRedraw(redraw: (() => void) | null) {
    this.redraw = redraw
  }

  setDuration(duration: number) {
    this.duration = duration
  }

  setRate(rate: number) {
    this.rate = rate
    if (this.video) this.video.playbackRate = rate
  }

  setVideo(video: HTMLVideoElement | null) {
    if (video === this.video) return
    this.unbindVideo?.()
    this.unbindVideo = null
    this.video = video
    if (!video) return
    video.playbackRate = this.rate
    const onChange = () => {
      this.timeRef.current = video.currentTime
      this.publish(true)
      this.redraw?.()
    }
    const events = ['play', 'pause', 'seeked', 'ended', 'loadeddata'] as const
    for (const e of events) video.addEventListener(e, onChange)
    // A new video frame (also when paused, after a seek) must reach the 3D view.
    let frameCb = 0
    const onFrame = () => {
      this.redraw?.()
      frameCb = video.requestVideoFrameCallback(onFrame)
    }
    if ('requestVideoFrameCallback' in video) frameCb = video.requestVideoFrameCallback(onFrame)
    this.unbindVideo = () => {
      for (const e of events) video.removeEventListener(e, onChange)
      if (frameCb) video.cancelVideoFrameCallback(frameCb)
    }
  }

  /** Advances the clock; called every rendered frame. */
  tick(dt: number) {
    const v = this.video
    if (v) this.timeRef.current = v.currentTime
    else if (this.clockPlaying) {
      this.timeRef.current = Math.min(this.duration, this.timeRef.current + dt * this.rate)
      if (this.timeRef.current >= this.duration) this.clockPlaying = false
    }
    this.publish(false)
  }

  play = () => {
    const v = this.video
    if (v) {
      v.play().catch(() => {
        /* the element's own error handler reports playback failures */
      })
      return
    }
    if (this.timeRef.current >= this.duration) this.timeRef.current = 0
    this.clockPlaying = true
    this.publish(true)
    this.redraw?.()
  }

  pause = () => {
    this.video?.pause()
    this.clockPlaying = false
    this.publish(true)
  }

  toggle = () => (this.playing ? this.pause() : this.play())

  seek = (t: number) => {
    const clamped = Math.max(0, Math.min(this.duration, t))
    if (this.video) this.video.currentTime = clamped
    this.timeRef.current = clamped
    this.publish(true)
    this.redraw?.()
  }

  dispose() {
    this.unbindVideo?.()
    this.unbindVideo = null
    this.video = null
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  getSnapshot = (): PlaybackState => this.state

  /** Tells subscribers about a new time (throttled unless `now`) or play state. */
  private publish(now: boolean) {
    const playing = this.playing
    const time = this.timeRef.current
    const t = performance.now()
    if (playing === this.state.playing && time === this.state.time) return
    if (!now && playing === this.state.playing && t - this.lastUi < UI_MS) return
    this.lastUi = t
    this.state = { time, playing }
    for (const l of this.listeners) l()
  }
}

/** A stable Playback for a viewer, kept in step with its video, duration and rate. */
export function usePlayback(video: HTMLVideoElement | null, duration: number, rate = 1): Playback {
  const [playback] = useState(() => new Playback())
  useEffect(() => playback.setVideo(video), [playback, video])
  useEffect(() => playback.setDuration(duration), [playback, duration])
  useEffect(() => playback.setRate(rate), [playback, rate])
  useEffect(() => () => playback.dispose(), [playback])
  return playback
}

/** Time and play state for UI (scrubber, labels, play button). */
export function usePlaybackState(playback: Playback): PlaybackState {
  return useSyncExternalStore(playback.subscribe, playback.getSnapshot, playback.getSnapshot)
}

/**
 * Put inside the Canvas: ticks the clock from R3F's loop and keeps rendering while playing (the
 * canvas otherwise renders on demand).
 */
export function PlaybackDriver({ playback }: { playback: Playback }) {
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    playback.setRedraw(() => invalidate())
    return () => playback.setRedraw(null)
  }, [playback, invalidate])
  // First, so everything else in the frame reads this frame's time.
  useFrame((_, dt) => {
    playback.tick(dt)
    if (playback.playing) invalidate()
  }, -1)
  return null
}
