// The Memory Window's camera math. The screen is treated as a real window into the room: a
// fixed rectangle in front of the recorded camera, and the viewer's eye moves behind it as
// their head moves. Looking through a window from off-center is an off-axis (asymmetric)
// frustum, not a rotated camera, which is what makes the room read as 3D without glasses.

/** Where the viewer's head is, from the webcam: x right, y up, roughly -1..1; z > 0 is closer. */
export interface Head {
  x: number
  y: number
  z: number
}

export interface WindowSetup {
  /** How far the virtual window sits in front of the recorded camera, in meters. */
  distance: number
  /** Window height in meters (its width follows the screen's aspect). */
  height: number
  /** Screen width / height. */
  aspect: number
  /** How far the eye moves, in meters, for a full head movement (|x| or |y| = 1). */
  travel: number
  /** How much leaning in brings the eye toward the window, in meters, for z = 1. */
  lean: number
}

export const DEFAULT_SETUP: Omit<WindowSetup, 'aspect'> = {
  distance: 0.6,
  height: 0.5,
  travel: 0.28,
  lean: 0.25,
}

/** The eye's position in the recorded camera's frame (x right, y up, −z forward). */
export function eyeOffset(head: Head, setup: WindowSetup): [number, number, number] {
  return [head.x * setup.travel, head.y * setup.travel, -head.z * setup.lean]
}

export interface Frustum {
  left: number
  right: number
  top: number
  bottom: number
  near: number
  far: number
}

/**
 * The asymmetric frustum from an eye at `eye` (camera frame) through a window centered on the
 * camera's axis at z = −distance. Left/right/top/bottom are at the near plane, as
 * THREE.Matrix4.makePerspective expects.
 */
export function windowFrustum(eye: [number, number, number], setup: WindowSetup, near = 0.02, far = 60): Frustum {
  const halfH = setup.height / 2
  const halfW = halfH * setup.aspect
  // Distance from the eye to the window plane along the view axis.
  const toPlane = Math.max(0.05, setup.distance + eye[2])
  const scale = near / toPlane
  return {
    left: (-halfW - eye[0]) * scale,
    right: (halfW - eye[0]) * scale,
    bottom: (-halfH - eye[1]) * scale,
    top: (halfH - eye[1]) * scale,
    near,
    far,
  }
}

/**
 * Turns a detected face into a head position. `cx`, `cy` are the face center and `size` the
 * face width, all as fractions of the webcam frame (as MediaPipe reports). `rest` is where the
 * head was when tracking started, so wherever they sit becomes the center. The webcam sees a
 * mirror image: moving to your right moves your face left in the frame, hence the sign on x.
 */
export function headFromFace(cx: number, cy: number, size: number, rest: { cx: number; cy: number; size: number }): Head {
  const clamp = (v: number) => Math.max(-1, Math.min(1, v))
  return {
    x: clamp(-(cx - rest.cx) / 0.25),
    y: clamp(-(cy - rest.cy) / 0.25),
    // A face 25% wider than at rest counts as fully leaned in.
    z: clamp((size / rest.size - 1) / 0.25),
  }
}

/** Exponential smoothing that settles in about `seconds`, frame-rate independent. */
export function smooth(current: Head, target: Head, dt: number, seconds = 0.15): Head {
  const a = 1 - Math.exp(-dt / seconds)
  return {
    x: current.x + (target.x - current.x) * a,
    y: current.y + (target.y - current.y) * a,
    z: current.z + (target.z - current.z) * a,
  }
}

/**
 * Tablet tilt as a head position, for "look around by moving the iPad": tilting the device is
 * like moving your eye the other way behind the glass. `beta`/`gamma` are DeviceOrientation
 * degrees, `rest` the angles when tilt mode started. 20 degrees is a full movement.
 */
export function headFromTilt(beta: number, gamma: number, rest: { beta: number; gamma: number }): Head {
  const clamp = (v: number) => Math.max(-1, Math.min(1, v))
  return { x: clamp(-(gamma - rest.gamma) / 20), y: clamp((beta - rest.beta) / 20), z: 0 }
}
