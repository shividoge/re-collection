import type { FaceDetector } from '@mediapipe/tasks-vision'
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { headFromFace, headFromTilt, type Head } from './windowMath'

export type TrackerStatus =
  | { kind: 'off' }
  | { kind: 'starting' }
  | { kind: 'tracking'; source: 'camera' | 'tilt'; faceVisible: boolean }
  | { kind: 'error'; message: string }

const BASE = import.meta.env.BASE_URL
const MODEL = `${BASE}models/blaze_face_short_range.tflite`
const WASM = `${BASE}mediapipe`
/** Face detection rate; the camera smooths over 0.15 s anyway, so more is wasted work. */
const DETECT_HZ = 15

/** True when a new camera frame has arrived and enough time has passed since the last detection. */
export function shouldDetect(frameTime: number, lastFrameTime: number, now: number, lastDetect: number, hz = DETECT_HZ): boolean {
  return frameTime !== lastFrameTime && now - lastDetect >= 1000 / hz
}

/**
 * Where the viewer's head is, from the device's own front camera (laptop webcam, TV webcam,
 * iPad front camera) or, on a tablet, from tilting the device. Face detection runs in the
 * browser with MediaPipe; no image leaves the device and nothing is recorded.
 *
 * `head` is a ref updated many times a second for the 3D camera; `status` is for the UI.
 */
export function useHeadTracker(): {
  head: MutableRefObject<Head>
  status: TrackerStatus
  startCamera: () => Promise<void>
  startTilt: () => Promise<void>
  recenter: () => void
  stop: () => void
} {
  const head = useRef<Head>({ x: 0, y: 0, z: 0 })
  const [status, setStatus] = useState<TrackerStatus>({ kind: 'off' })
  const stopRef = useRef<() => void>(() => {})
  const recenterRef = useRef<() => void>(() => {})

  const stop = useCallback(() => {
    stopRef.current()
    stopRef.current = () => {}
    recenterRef.current = () => {}
    head.current = { x: 0, y: 0, z: 0 }
    setStatus({ kind: 'off' })
  }, [])

  useEffect(() => () => stopRef.current(), [])

  const startCamera = useCallback(async () => {
    stopRef.current()
    setStatus({ kind: 'starting' })
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus({ kind: 'error', message: 'This browser can’t use the camera here. Open the page over https (or on this computer at localhost).' })
      return
    }
    let stream: MediaStream
    let detector: FaceDetector
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 640, height: 480 }, audio: false })
    } catch {
      setStatus({ kind: 'error', message: 'Camera permission was refused, so head tracking is off. You can still use the window without it.' })
      return
    }
    try {
      // Loaded only when someone asks for head tracking: the library is large.
      const { FaceDetector, FilesetResolver } = await import('@mediapipe/tasks-vision')
      const files = await FilesetResolver.forVisionTasks(WASM)
      detector = await FaceDetector.createFromOptions(files, {
        baseOptions: { modelAssetPath: MODEL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        minDetectionConfidence: 0.5,
      })
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop())
      setStatus({ kind: 'error', message: `Face tracking couldn’t start: ${e instanceof Error ? e.message : String(e)}` })
      return
    }

    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.srcObject = stream
    await video.play().catch(() => undefined)

    let rest: { cx: number; cy: number; size: number } | null = null
    let last: { cx: number; cy: number; size: number } | null = null
    let raf = 0
    let lastTime = -1
    let lastDetect = -Infinity
    let faceVisible = false
    let stopped = false

    const tick = () => {
      if (stopped) return
      raf = requestAnimationFrame(tick)
      const now = performance.now()
      if (video.readyState < 2 || !shouldDetect(video.currentTime, lastTime, now, lastDetect)) return
      lastTime = video.currentTime
      lastDetect = now
      const result = detector.detectForVideo(video, now)
      const box = result.detections[0]?.boundingBox
      const visible = Boolean(box && video.videoWidth)
      if (visible !== faceVisible) {
        faceVisible = visible
        setStatus({ kind: 'tracking', source: 'camera', faceVisible })
      }
      if (!box) return
      const face = {
        cx: (box.originX + box.width / 2) / video.videoWidth,
        cy: (box.originY + box.height / 2) / video.videoHeight,
        size: box.width / video.videoWidth,
      }
      rest ??= face
      last = face
      head.current = headFromFace(face.cx, face.cy, face.size, rest)
    }
    raf = requestAnimationFrame(tick)
    setStatus({ kind: 'tracking', source: 'camera', faceVisible: false })

    recenterRef.current = () => {
      if (last) rest = last
    }
    stopRef.current = () => {
      stopped = true
      cancelAnimationFrame(raf)
      detector.close()
      stream.getTracks().forEach((t) => t.stop())
    }
  }, [])

  const startTilt = useCallback(async () => {
    stopRef.current()
    setStatus({ kind: 'starting' })
    // iOS asks for motion permission, and only from a tap.
    const Orientation = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<'granted' | 'denied'> }
    if (typeof Orientation.requestPermission === 'function') {
      const answer = await Orientation.requestPermission().catch(() => 'denied' as const)
      if (answer !== 'granted') {
        setStatus({ kind: 'error', message: 'Motion permission was refused, so tilt is off.' })
        return
      }
    }
    let rest: { beta: number; gamma: number } | null = null
    let last: { beta: number; gamma: number } | null = null
    const onOrientation = (e: DeviceOrientationEvent) => {
      if (e.beta === null || e.gamma === null) return
      last = { beta: e.beta, gamma: e.gamma }
      rest ??= last
      head.current = headFromTilt(e.beta, e.gamma, rest)
    }
    window.addEventListener('deviceorientation', onOrientation)
    setStatus({ kind: 'tracking', source: 'tilt', faceVisible: true })
    recenterRef.current = () => {
      if (last) rest = last
    }
    stopRef.current = () => window.removeEventListener('deviceorientation', onOrientation)
  }, [])

  const recenter = useCallback(() => recenterRef.current(), [])

  return { head, status, startCamera, startTilt, recenter, stop }
}
