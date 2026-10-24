import { useFrame, useThree } from '@react-three/fiber'
import { useMemo, useRef, type MutableRefObject } from 'react'
import * as THREE from 'three'
import type { FrameRecord } from '../scene/formats'
import { dominantQuarterTurns, frameIndexAtTime, rollColumnMajor } from '../scene/pose'
import { DEFAULT_SETUP, eyeOffset, smooth, windowFrustum, type Head } from './windowMath'

const pose = new THREE.Matrix4()
const basePos = new THREE.Vector3()
const baseQuat = new THREE.Quaternion()
const scale = new THREE.Vector3()
const eye = new THREE.Vector3()

/**
 * Places the 3D camera behind a "window" that sits in front of where the phone was, and moves
 * the eye with the viewer's head (see windowMath.ts). The window itself follows the recorded
 * camera slowly as the visit plays, so the person is carried through the moment while their
 * own movements look around it.
 *
 * `ambient`: when no head is tracked, the eye drifts very slowly so a TV left running still
 * shows depth. It is only camera motion; nothing in the scene changes.
 */
export function WindowCamera({
  frames,
  timeRef,
  head,
  ambient,
  videoW,
  videoH,
}: {
  frames: FrameRecord[]
  timeRef: MutableRefObject<number>
  head: MutableRefObject<Head>
  ambient: boolean
  /** Full video resolution, to size the window like the phone's own view. */
  videoW: number
  videoH: number
}) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const size = useThree((s) => s.size)
  const quarterTurns = useMemo(() => dominantQuarterTurns(frames), [frames])
  const state = useRef({ head: { x: 0, y: 0, z: 0 } as Head, pos: new THREE.Vector3(), quat: new THREE.Quaternion(), first: true, clock: 0 })

  useFrame((_, delta) => {
    const s = state.current
    const dt = Math.min(delta, 0.1)
    s.clock += dt

    // The window: the recorded camera at this moment, turned upright.
    if (frames.length > 0) {
      const f = frames[frameIndexAtTime(frames, timeRef.current)]
      pose.fromArray(rollColumnMajor(f.T, (quarterTurns * Math.PI) / 2))
    } else {
      pose.identity() // a scan with no moment starts where the phone started
    }
    pose.decompose(basePos, baseQuat, scale)
    if (s.first) {
      s.pos.copy(basePos)
      s.quat.copy(baseQuat)
      s.first = false
    } else {
      // Slow: the window glides, it never jerks with the handheld phone.
      const a = 1 - Math.exp(-dt / 0.6)
      s.pos.lerp(basePos, a)
      s.quat.slerp(baseQuat, a)
    }

    const target = ambient ? { x: 0.35 * Math.sin(s.clock * 0.25), y: 0.15 * Math.sin(s.clock * 0.17), z: 0 } : head.current
    // Following a real head or finger is quick; drifting on its own is slow and calm.
    s.head = smooth(s.head, target, dt, ambient ? 1.5 : 0.15)

    // Size the window so that, from the center, it shows what the phone's lens saw (a little
    // wider for context): its vertical field of view, upright, at the window's distance.
    let height = DEFAULT_SETUP.height
    if (frames.length > 0) {
      const K = frames[frameIndexAtTime(frames, timeRef.current)].K
      const halfFov = quarterTurns % 2 === 1 ? Math.atan(videoW / 2 / K[0]) : Math.atan(videoH / 2 / K[1])
      height = 2 * DEFAULT_SETUP.distance * Math.tan(halfFov) * 1.1
    }
    const setup = { ...DEFAULT_SETUP, height, aspect: size.width / Math.max(1, size.height) }
    const offset = eyeOffset(s.head, setup)
    eye.set(offset[0], offset[1], offset[2]).applyQuaternion(s.quat)
    camera.position.copy(s.pos).add(eye)
    // No rotation with the head: looking through a window is a shifted frustum, not a turned eye.
    camera.quaternion.copy(s.quat)

    const f = windowFrustum(offset, setup)
    camera.projectionMatrix.makePerspective(f.left, f.right, f.top, f.bottom, f.near, f.far)
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()
  })

  return null
}
