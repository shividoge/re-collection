import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, type RefObject } from 'react'
import * as THREE from 'three'
import type { FrameRecord } from './formats'
import { dominantQuarterTurns, frameIndexAtTime, rollColumnMajor } from './pose'

/** Every frame's pose, turned upright, as position + rotation: worked out once, read per frame. */
function uprightPoses(frames: FrameRecord[]): { positions: Float32Array; quaternions: Float32Array } {
  const k = dominantQuarterTurns(frames)
  const positions = new Float32Array(frames.length * 3)
  const quaternions = new Float32Array(frames.length * 4)
  const m = new THREE.Matrix4()
  const p = new THREE.Vector3()
  const q = new THREE.Quaternion()
  const s = new THREE.Vector3()
  frames.forEach((f, i) => {
    m.fromArray(rollColumnMajor(f.T, (k * Math.PI) / 2)).decompose(p, q, s)
    p.toArray(positions, i * 3)
    q.toArray(quaternions, i * 4)
  })
  return { positions, quaternions }
}

/** The recorder's path as a faint line, plus a small frustum at the current playhead. */
export function CameraPath({ frames, timeRef, color = '#ff5c3a' }: { frames: FrameRecord[]; timeRef: RefObject<number>; color?: string }) {
  const line = useMemo(() => {
    const pts = new Float32Array(frames.length * 3)
    frames.forEach((f, i) => pts.set([f.T[12], f.T[13], f.T[14]], i * 3))
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pts, 3))
    return new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.35 }))
  }, [frames, color])
  useEffect(
    () => () => {
      line.geometry.dispose()
      ;(line.material as THREE.Material).dispose()
    },
    [line],
  )
  const poses = useMemo(() => uprightPoses(frames), [frames])
  const marker = useRef<THREE.Group>(null)

  useFrame(() => {
    const m = marker.current
    if (!m || frames.length === 0) return
    const i = frameIndexAtTime(frames, timeRef.current ?? 0)
    m.position.fromArray(poses.positions, i * 3)
    m.quaternion.fromArray(poses.quaternions, i * 4)
  })

  return (
    <>
      <primitive object={line} />
      <group ref={marker}>
        {/* Frustum: apex at the camera, opening down −z like the camera it marks. */}
        <mesh position={[0, 0, -0.06]} rotation={[Math.PI / 2, 0, 0]}>
          <coneGeometry args={[0.05, 0.12, 4, 1, true]} />
          <meshBasicMaterial color={color} wireframe />
        </mesh>
      </group>
    </>
  )
}

/** Drives the viewer camera along the recorded poses, smoothed, upright. */
export function FollowCamera({ frames, timeRef, videoW, videoH, smoothing = 6 }: { frames: FrameRecord[]; timeRef: RefObject<number>; videoW: number; videoH: number; smoothing?: number }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const k = useMemo(() => dominantQuarterTurns(frames), [frames])
  const poses = useMemo(() => uprightPoses(frames), [frames])
  const target = useMemo(() => ({ pos: new THREE.Vector3(), quat: new THREE.Quaternion(), first: true }), [])

  useFrame((state, delta) => {
    if (frames.length === 0) return
    const i = frameIndexAtTime(frames, timeRef.current ?? 0)
    target.pos.fromArray(poses.positions, i * 3)
    target.quat.fromArray(poses.quaternions, i * 4)
    // Vertical field of view of the upright image.
    const [fx, fy] = frames[i].K
    const fov = k % 2 === 1 ? 2 * Math.atan(videoW / 2 / fx) : 2 * Math.atan(videoH / 2 / fy)
    const fovDeg = THREE.MathUtils.radToDeg(fov)
    if (Math.abs(camera.fov - fovDeg) > 0.01) {
      camera.fov = fovDeg
      camera.updateProjectionMatrix()
    }
    if (target.first) {
      camera.position.copy(target.pos)
      camera.quaternion.copy(target.quat)
      target.first = false
      return
    }
    const a = 1 - Math.exp(-smoothing * delta)
    camera.position.lerp(target.pos, a)
    camera.quaternion.slerp(target.quat, a)
    // Still easing toward the recorded pose: keep drawing until it's there.
    if (camera.position.distanceToSquared(target.pos) > 1e-8 || 1 - Math.abs(camera.quaternion.dot(target.quat)) > 1e-8) state.invalidate()
  })
  return null
}
