import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

/**
 * One clock for the whole viewer. When a video is present it is the master (so sound,
 * picture and 3D stay in sync); without one, a plain clock runs over the frame times.
 * `timeRef` updates every animation frame for the 3D scene; `time` updates ~15×/s for UI.
 */
export function usePlayback(videoRef: RefObject<HTMLVideoElement | null>, hasVideo: boolean, duration: number, rate = 1) {
  const timeRef = useRef(0)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const playingRef = useRef(false)

  useEffect(() => {
    const v = videoRef.current
    if (v) v.playbackRate = rate
  }, [videoRef, rate, hasVideo])

  useEffect(() => {
    let raf = 0
    let last = performance.now()
    let lastUi = 0
    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      const v = hasVideo ? videoRef.current : null
      if (v) {
        timeRef.current = v.currentTime
        if (playingRef.current === v.paused) {
          playingRef.current = !v.paused
          setPlaying(!v.paused)
        }
      } else if (playingRef.current) {
        timeRef.current = Math.min(duration, timeRef.current + dt * rate)
        if (timeRef.current >= duration) {
          playingRef.current = false
          setPlaying(false)
        }
      }
      if (now - lastUi > 66) {
        lastUi = now
        setTime(timeRef.current)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [videoRef, hasVideo, duration, rate])

  const play = useCallback(() => {
    const v = hasVideo ? videoRef.current : null
    if (v) {
      v.play().catch(() => {
        /* the element's own error handler reports playback failures */
      })
    } else {
      if (timeRef.current >= duration) timeRef.current = 0
      playingRef.current = true
      setPlaying(true)
    }
  }, [videoRef, hasVideo, duration])

  const pause = useCallback(() => {
    const v = hasVideo ? videoRef.current : null
    if (v) v.pause()
    playingRef.current = false
    setPlaying(false)
  }, [videoRef, hasVideo])

  const seek = useCallback(
    (t: number) => {
      const clamped = Math.max(0, Math.min(duration, t))
      const v = hasVideo ? videoRef.current : null
      if (v) v.currentTime = clamped
      timeRef.current = clamped
      setTime(clamped)
    },
    [videoRef, hasVideo, duration],
  )

  return { timeRef, time, playing, play, pause, seek }
}
