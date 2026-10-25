import { useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { pointLevel, POINTS_PER_PIXEL, type PointsData } from './packs'

const vertexShader = /* glsl */ `
  attribute vec3 color;      // sRGB bytes, normalized
  attribute float aSize;     // unorm8 between uSizeMin and uSizeMin + uSizeRange
  uniform vec3 uMin;
  uniform vec3 uExtent;
  uniform float uSizeMin;
  uniform float uSizeRange;
  uniform float uScale;      // level's sizeScale × pointSize
  uniform float uViewportH;
  uniform vec3 uTint;
  uniform float uTintMix;
  uniform float uDim;
  varying vec3 vColor;
  void main() {
    vColor = mix(color, uTint, uTintMix) * uDim;
    vec3 p = uMin + position * uExtent;   // positions are unorm16 inside the cloud's box
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float size = (uSizeMin + aSize * uSizeRange) * uScale;
    gl_PointSize = clamp(size * projectionMatrix[1][1] * uViewportH * 0.5 / max(-mv.z, 0.01), 1.0, 128.0);
  }
`

const fragmentShader = /* glsl */ `
  varying vec3 vColor;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    if (dot(c, c) > 1.0) discard;
    // Flat color: overlapping points read as one continuous surface.
    gl_FragColor = vec4(vColor, 1.0);
  }
`

interface Props {
  points: PointsData
  /** Most points to draw; defaults to the drawing buffer's pixels × POINTS_PER_PIXEL. */
  budget?: number
  pointSize?: number
  dim?: number
  tint?: string
  tintMix?: number
  visible?: boolean
}

/**
 * The room from points.pack: round points, each just big enough to overlap its neighbors (sizes
 * baked with gaps.ts), so surfaces read as surfaces and real holes stay open. Draws the sparsest
 * level of detail that still has a point for about every other pixel; every level is an even
 * sample of the room, with sizes scaled up so it closes the same way. Positions stay quantized
 * on the GPU and are decoded in the vertex shader.
 */
export function RoomPoints({ points, budget, pointSize = 1, dim = 1, tint = '#ffffff', tintMix = 0, visible = true }: Props) {
  const width = useThree((s) => s.size.width)
  const height = useThree((s) => s.size.height)
  const dpr = useThree((s) => s.viewport.dpr)
  const invalidate = useThree((s) => s.invalidate)

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(points.positions, 3, true))
    g.setAttribute('color', new THREE.BufferAttribute(points.colors, 3, true))
    g.setAttribute('aSize', new THREE.BufferAttribute(points.sizes, 1, true))
    // Bounds in world space (the attribute holds 0..1), so frustum culling works.
    g.boundingBox = new THREE.Box3(new THREE.Vector3(...points.min), new THREE.Vector3(...points.max))
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere())
    return g
  }, [points])
  useEffect(() => () => geometry.dispose(), [geometry])

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: {
          uMin: { value: new THREE.Vector3() },
          uExtent: { value: new THREE.Vector3() },
          uSizeMin: { value: 0 },
          uSizeRange: { value: 0 },
          uScale: { value: 1 },
          uViewportH: { value: 1000 },
          uDim: { value: 1 },
          uTint: { value: new THREE.Color() },
          uTintMix: { value: 0 },
        },
      }),
    [],
  )
  useEffect(() => () => material.dispose(), [material])

  const level = pointLevel(points.levels, budget ?? width * height * dpr * dpr * POINTS_PER_PIXEL)
  useEffect(() => {
    const u = material.uniforms
    u.uMin.value.set(...points.min)
    u.uExtent.value.set(points.max[0] - points.min[0], points.max[1] - points.min[1], points.max[2] - points.min[2])
    u.uSizeMin.value = points.sizeMin
    u.uSizeRange.value = points.sizeMax - points.sizeMin
    u.uScale.value = points.levels[level].sizeScale * pointSize
    u.uDim.value = dim
    u.uTint.value.set(tint)
    u.uTintMix.value = tintMix
    geometry.setDrawRange(0, points.levels[level].count)
    invalidate()
  }, [material, geometry, points, level, pointSize, dim, tint, tintMix, invalidate])

  return (
    <points
      geometry={geometry}
      material={material}
      visible={visible}
      onBeforeRender={(renderer) => {
        // The viewport being drawn (a render target or one view of a shared canvas), in pixels.
        material.uniforms.uViewportH.value = renderer.getCurrentViewport(tmpViewport).w
      }}
    />
  )
}

const tmpViewport = new THREE.Vector4()
