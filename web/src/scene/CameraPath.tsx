import { useFrame, useThree } from '@react-three/fiber'
import { useMemo, type RefObject } from 'react'
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
