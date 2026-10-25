import { BlendFunction, Effect, EffectAttribute } from 'postprocessing'
import * as THREE from 'three'

/*
 * Stepping into a picture is a dive: the visitor's view rushes forward into the frame, as if
 * the picture were a window onto a real place, and the light streaks and smears outward like
 * travelling through space and time; on the far side the picture's own world comes out of the
 * blur. Stepping out runs the same journey backwards. These are the shared timings, the camera
 * move and the blur.
 */

/** The dive into the frame, from the first push to the moment of going through (ms). */
export const IN_MS = 2000
/** On the far side, the picture's world settling out of the blur (ms). */
export const ARRIVE_MS = 1400
/** Stepping out: the world smearing away until the visitor is back at the frame (ms). */
export const LEAVE_MS = 1300
/** Then the pull back out of the frame to where the visitor stood (ms). */
export const OUT_MS = 1900

/** How much wider the view grows on the way in (degrees), for the feeling of speed. */
const FOV_WARP = 12
/** At the end of the dive the picture fills the view and then some: 1 / OVERFILL times over. */
const OVERFILL = 0.7

export const clamp01 = (t: number) => Math.min(1, Math.max(0, t))
export const smooth = (t: number) => {
  const k = clamp01(t)
  return k * k * (3 - 2 * k)
}

/** Distance from a w × h picture (m) at which it covers a view this wide and tall, overfilled. */
export function coverDistance(w: number, h: number, aspect: number, fovDeg: number): number {
  const tan = Math.tan(THREE.MathUtils.degToRad(fovDeg / 2))
  return (Math.min(h / 2, w / 2 / aspect) / tan) * OVERFILL
}

/**
 * The dive's shape at k (0: where the visitor stood, 1: through the frame): how far along the
 * way the view is, how square it has turned to the picture, and how strong the blur and the
 * light are. It starts as a gentle lean and ends in a rush; the blur only gathers in the second
 * half, so the visitor sees where they're going first.
 */
export function diveShape(k: number) {
  const t = clamp01(k)
  return {
    travel: t * t * (0.3 + 0.7 * t),
    turn: smooth(t * 1.5),
    widen: smooth(t),
    blur: 0.62 * Math.pow(smooth((t - 0.32) / 0.68), 1.5),
    flash: 0.75 * Math.pow(smooth((t - 0.68) / 0.32), 2),
  }
}

/** How long the streaks build before the crossing, and fade after it (ms). */
const STREAK_BUILD_MS = 1200
export const STREAK_FADE_MS = 1300

/** How strong the streaks are at `now`, for a crossing at `cross` (0–1). */
export function streakLevel(now: number, cross: number): number {
  if (now <= cross) return Math.pow(Math.max(0, 1 - (cross - now) / STREAK_BUILD_MS), 2.2)
  return Math.pow(Math.max(0, 1 - (now - cross) / STREAK_FADE_MS), 1.8)
}

type Pose = { pos: THREE.Vector3; quat: THREE.Quaternion; fov: number }

/** A dive in progress, shared between the page (which starts it) and the camera (which flies it). */
export interface Dive {
  dir: 'in' | 'out'
  /** The picture: its middle, which way its wall faces, and its size (m). */
  target: { center: [number, number, number]; normal: [number, number]; w: number; h: number }
  /** When the move starts (performance.now(), ms); until then the view holds where it starts. */
  start: number
  ms: number
  done?: () => void
  finished?: boolean
  /** Filled in on the dive's first frame: the visitor's own view, and the view inside the frame. */
  from?: Pose
  to?: Pose
}

const up = new THREE.Vector3(0, 1, 0)
const look = new THREE.Matrix4()
const middle = new THREE.Vector3()

/** Moves the camera along a dive at time `now`; returns the blur and light for that moment. */
export function flyDive(d: Dive, camera: THREE.PerspectiveCamera, now: number): { blur: number; flash: number; center: [number, number] } {
  if (!d.from || !d.to) {
    const from: Pose = { pos: camera.position.clone(), quat: camera.quaternion.clone(), fov: camera.fov }
    const fov = from.fov + FOV_WARP
    const dist = coverDistance(d.target.w, d.target.h, camera.aspect, fov)
    const [cx, cy, cz] = d.target.center
    const pos = new THREE.Vector3(cx + d.target.normal[0] * dist, cy, cz + d.target.normal[1] * dist)
    look.lookAt(pos, middle.set(cx, cy, cz), up)
    d.from = from
    d.to = { pos, quat: new THREE.Quaternion().setFromRotationMatrix(look), fov }
  }
  const t = clamp01((now - d.start) / d.ms)
  const s = diveShape(d.dir === 'in' ? t : 1 - t)
  camera.position.lerpVectors(d.from.pos, d.to.pos, s.travel)
  camera.quaternion.slerpQuaternions(d.from.quat, d.to.quat, s.turn)
  camera.fov = d.from.fov + (d.to.fov - d.from.fov) * s.widen
  camera.updateProjectionMatrix()
  if (t >= 1 && !d.finished) {
    d.finished = true
    d.done?.()
  }
  // The blur streams out from wherever the picture's middle is on screen (this frame's view).
  camera.updateMatrixWorld()
  const c = middle.set(...d.target.center).project(camera)
  return { blur: s.blur, flash: s.flash, center: [(c.x + 1) / 2, (c.y + 1) / 2] }
}

const fragment = /* glsl */ `
uniform float strength;
uniform float flash;
uniform vec2 center;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  if (strength < 0.001 && flash < 0.001) {
    outputColor = inputColor;
    return;
  }
  vec2 dir = uv - center;
  vec3 acc = vec3(0.0);
  float total = 0.0;
  // Smear each point back toward the middle, the colours parting slightly, as light does
  // through a lens at speed.
  for (int i = 0; i < 40; i++) {
    float t = float(i) / 39.0;
    float w = 1.0 - 0.65 * t;
    vec2 off = dir * strength * t;
    acc.r += texture2D(inputBuffer, uv - off * 1.1).r * w;
    acc.g += texture2D(inputBuffer, uv - off).g * w;
    acc.b += texture2D(inputBuffer, uv - off * 0.9).b * w;
    total += w;
  }
  vec3 color = acc / total;
  // Light gathers in the middle as the visitor goes through.
  float glow = flash * exp(-dot(dir, dir) * 5.0);
  color = color * (1.0 + flash * 0.9) + vec3(1.0, 0.92, 0.8) * glow * 0.9;
  outputColor = vec4(color, inputColor.a);
}
`

/** The radial "warp" blur over the museum while diving into a picture. */
export class WarpBlurEffect extends Effect {
  constructor() {
    super('WarpBlurEffect', fragment, {
      blendFunction: BlendFunction.NORMAL,
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map<string, THREE.Uniform>([
        ['strength', new THREE.Uniform(0)],
        ['flash', new THREE.Uniform(0)],
        ['center', new THREE.Uniform(new THREE.Vector2(0.5, 0.5))],
      ]),
    })
  }

  set(blur: number, flash: number, center: [number, number]) {
    this.uniforms.get('strength')!.value = blur
    this.uniforms.get('flash')!.value = flash
    ;(this.uniforms.get('center')!.value as THREE.Vector2).set(center[0], center[1])
  }
}
