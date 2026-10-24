import { useFrame, useThree } from '@react-three/fiber'
import { useMemo, useRef, type MutableRefObject } from 'react'
import * as THREE from 'three'
import type { FrameRecord } from './formats'
import { dominantQuarterTurns, frameIndexAtTime, rollColumnMajor } from './pose'

function poseMatrix(T: number[], quarterTurns: number): THREE.Matrix4 {
  return new THREE.Matrix4().fromArray(rollColumnMajor(T, (quarterTurns * Math.PI) / 2))
}

/** The recorder's path as a faint line, plus a small frustum at the current playhead. */
export function CameraPath({ frames, timeRef, color = '#6ee7ff' }: { frames: FrameRecord[]; timeRef: MutableRefObject<number>; color?: string }) {
  const line = useMemo(() => {
    const pts = new Float32Array(frames.length * 3)
    frames.forEach((f, i) => pts.set([f.T[12], f.T[13], f.T[14]], i * 3))
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pts, 3))
    return new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.35 }))
  }, [frames, color])

  const marker = useRef<THREE.Group>(null)
  const k = useMemo(() => dominantQuarterTurns(frames), [frames])

  useFrame(() => {
    const m = marker.current
    if (!m || frames.length === 0) return
    const f = frames[frameIndexAtTime(frames, timeRef.current)]
    poseMatrix(f.T, k).decompose(m.position, m.quaternion, m.scale)
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
export function FollowCamera({ frames, timeRef, videoW, videoH, smoothing = 6 }: { frames: FrameRecord[]; timeRef: MutableRefObject<number>; videoW: number; videoH: number; smoothing?: number }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const k = useMemo(() => dominantQuarterTurns(frames), [frames])
  const target = useMemo(() => ({ pos: new THREE.Vector3(), quat: new THREE.Quaternion(), scale: new THREE.Vector3(), first: true }), [])

  useFrame((_, delta) => {
    if (frames.length === 0) return
    const f = frames[frameIndexAtTime(frames, timeRef.current)]
    poseMatrix(f.T, k).decompose(target.pos, target.quat, target.scale)
    // Vertical field of view of the upright image.
    const [fx, fy] = f.K
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
  })
  return null
}
