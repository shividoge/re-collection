import { useFrame } from '@react-three/fiber'
import { useMemo, useRef, type RefObject } from 'react'
import * as THREE from 'three'
import type { FrameRecord } from './formats'
import type { PointsData } from './packs'
import { frameIndexAtTime } from './pose'
import { estimateLevels } from './spatial'

/** A schematic recorder, 1.7 m tall, facing local −Z. No inferred body motion. */
function avatarDots() {
  const positions: number[] = []
  const colors: number[] = []
  const peach = new THREE.Color('#ffc6a1')
  const coral = new THREE.Color('#ff714f')
  const shade = new THREE.Color()
  const ellipsoid = (cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, count: number) => {
    for (let i = 0; i < count; i++) {
      const y = 1 - 2 * (i + 0.5) / count
      const r = Math.sqrt(1 - y * y)
      const angle = i * Math.PI * (3 - Math.sqrt(5))
      const x = Math.cos(angle) * r
      const z = Math.sin(angle) * r
      positions.push(cx + x * rx, cy + y * ry, cz + z * rz)
      shade.copy(coral).lerp(peach, (cy + y * ry) / 1.7).multiplyScalar(0.75 + 0.25 * Math.max(0, -z))
      colors.push(shade.r, shade.g, shade.b)
    }
  }
  ellipsoid(0, 1.55, 0, 0.145, 0.15, 0.135, 280)
  ellipsoid(0, 1.11, 0, 0.235, 0.3, 0.125, 650)
  for (const side of [-1, 1]) {
    ellipsoid(side * 0.29, 1.03, 0, 0.065, 0.29, 0.07, 200)
    ellipsoid(side * 0.105, 0.44, 0, 0.085, 0.4, 0.09, 300)
    ellipsoid(side * 0.105, 0.055, -0.045, 0.09, 0.055, 0.15, 100)
  }
  // A dotted footprint and a short forward chevron make position and heading legible.
  for (let i = 0; i < 64; i++) {
    const a = i / 64 * Math.PI * 2
    positions.push(Math.cos(a) * 0.4, 0.015, Math.sin(a) * 0.4)
    colors.push(coral.r, coral.g, coral.b)
  }
  for (let i = -8; i <= 8; i++) {
    positions.push(i * 0.018, 0.015, -0.57 + Math.abs(i) * 0.018)
    colors.push(peach.r, peach.g, peach.b)
  }
  return { positions: new Float32Array(positions), colors: new Float32Array(colors) }
}

function recorderFloor(frames: FrameRecord[], points: PointsData | null): number {
  const heights = frames.map((f) => f.T[13]).sort((a, b) => a - b)
  const cameraY = heights[heights.length >> 1] ?? 0
  if (points && points.count > 0) {
    // The baked cloud is evenly sampled. Bound the work even for multi-million-point rooms.
    const count = Math.min(points.count, 20000)
    const sample = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      const index = Math.floor(i * points.count / count) * 3 + 1
      sample[i * 3 + 1] = points.min[1] + points.positions[index] / 65535 * (points.max[1] - points.min[1])
    }
    const { floorY } = estimateLevels(sample)
    if (floorY !== null && cameraY - floorY > 0.5 && cameraY - floorY < 2.5) return floorY
  }
  // No reliable floor in this capture: use a fixed nominal eye height for the entire clip.
  return cameraY - 1.55
}

const vertexShader = `
  attribute vec3 color;
  varying vec3 vColor;
  void main() {
    vColor = color;
    vec4 view = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * view;
    gl_PointSize = clamp(22.0 / max(0.1, -view.z), 1.5, 5.0);
  }
`
const fragmentShader = `
  varying vec3 vColor;
  void main() {
    float radius = length(gl_PointCoord - 0.5);
    if (radius > 0.5) discard;
    gl_FragColor = vec4(vColor, 1.0 - smoothstep(0.32, 0.5, radius));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

export function RecorderAvatar({ frames, points, timeRef }: { frames: FrameRecord[]; points: PointsData | null; timeRef: RefObject<number> }) {
  const marker = useRef<THREE.Points>(null)
  const dots = useMemo(() => avatarDots(), [])
  const floor = useMemo(() => recorderFloor(frames, points), [frames, points])
  const headings = useMemo(() => {
    let heading = 0
    const result: number[] = []
    for (const { T } of frames) {
      // Camera −Z projected onto the floor. Looking straight up/down keeps the last heading.
      if (Math.hypot(T[8], T[10]) > 0.1) {
        const next = Math.atan2(T[8], T[10])
        heading += Math.atan2(Math.sin(next - heading), Math.cos(next - heading))
      }
      result.push(heading)
    }
    return result
  }, [frames])

  useFrame(() => {
    const avatar = marker.current
    if (!avatar || frames.length === 0) return
    const time = timeRef.current
    const i = frameIndexAtTime(frames, time)
    const j = Math.min(i + 1, frames.length - 1)
    const a = frames[i]
    const b = frames[j]
    const mix = b.t > a.t ? THREE.MathUtils.clamp((time - a.t) / (b.t - a.t), 0, 1) : 0
    // Sample the playhead directly, including reverse seeks; no trailing animation state.
    avatar.position.set(THREE.MathUtils.lerp(a.T[12], b.T[12], mix), floor, THREE.MathUtils.lerp(a.T[14], b.T[14], mix))
    avatar.rotation.set(0, THREE.MathUtils.lerp(headings[i], headings[j], mix), 0)
  })

  if (frames.length === 0) return null
  return (
    <points ref={marker} name="recorder-avatar" raycast={() => {}}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[dots.positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[dots.colors, 3]} />
      </bufferGeometry>
      <shaderMaterial vertexShader={vertexShader} fragmentShader={fragmentShader} transparent depthWrite={false} />
    </points>
  )
}
