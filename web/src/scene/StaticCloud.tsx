import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { PointCloud } from './formats'

const vertexShader = /* glsl */ `
  attribute vec3 color;
  attribute float aSize;     // this point's diameter in meters (see gaps.ts)
  uniform float uSize;       // multiplier on aSize
  uniform float uViewportH;  // drawing buffer height in pixels
  uniform vec3 uTint;
  uniform float uTintMix;
  uniform float uDim;
  varying vec3 vColor;
  void main() {
    vColor = mix(color, uTint, uTintMix) * uDim;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // Size attenuation: world-space diameter projected to pixels.
    float px = aSize * uSize * projectionMatrix[1][1] * uViewportH * 0.5 / max(-mv.z, 0.01);
    gl_PointSize = clamp(px, 1.0, 128.0);
  }
`

const fragmentShader = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vColor;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    if (dot(c, c) > 1.0) discard;
    // Flat color: overlapping points then read as one continuous surface (a darker rim
    // made every point stand out as a dot, which looked like holes).
    gl_FragColor = vec4(vColor, uOpacity);
  }
`

/** Diameter used until per-point sizes are known, in meters. */
const DEFAULT_SIZE = 0.012

/**
 * The scanned room as soft round points. Colors are sRGB bytes, written out unconverted. With
 * `sizes`, each point is drawn just big enough to overlap its neighbors, so surfaces read as
 * surfaces; real holes (wider than gaps.ts SPLAT_MAX) stay open.
 */
interface Props {
  cloud: PointCloud
  /** Per-point diameters in meters, or null to draw every point at the default size. */
  sizes?: Float32Array | null
  /** Multiplier on every point's size, e.g. to make a highlight stand out. */
  pointSize?: number
  opacity?: number
  /** Brightness multiplier, e.g. to dim the room around a selection. */
  dim?: number
  /** Blend every point toward this color by `tintMix`. */
  tint?: string
  tintMix?: number
  renderOrder?: number
}

export function StaticCloud({ cloud, sizes = null, pointSize = 1, opacity = 1, dim = 1, tint = '#ffffff', tintMix = 0, renderOrder = 0 }: Props) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(cloud.positions, 3))
    g.setAttribute('color', new THREE.BufferAttribute(cloud.colors, 3, true))
    g.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(cloud.count).fill(DEFAULT_SIZE), 1))
    g.computeBoundingSphere()
    return g
  }, [cloud])
  useEffect(() => {
    if (!sizes || sizes.length !== cloud.count) return
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))
  }, [geometry, sizes, cloud.count])

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: {
          uSize: { value: pointSize },
          uViewportH: { value: 1000 },
          uOpacity: { value: opacity },
          uDim: { value: dim },
          uTint: { value: new THREE.Color(tint) },
          uTintMix: { value: tintMix },
        },
        transparent: opacity < 1,
        depthWrite: opacity >= 1,
      }),
    // The effect below handles prop changes without recompiling.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  useEffect(() => {
    material.uniforms.uSize.value = pointSize
    material.uniforms.uOpacity.value = opacity
    material.transparent = opacity < 1
    material.depthWrite = opacity >= 1
    material.uniforms.uDim.value = dim
    material.uniforms.uTint.value.set(tint)
    material.uniforms.uTintMix.value = tintMix
  }, [material, pointSize, opacity, dim, tint, tintMix])

  useEffect(() => () => geometry.dispose(), [geometry])
  useEffect(() => () => material.dispose(), [material])

  return (
    <points
      geometry={geometry}
      material={material}
      frustumCulled={false}
      renderOrder={renderOrder}
      onBeforeRender={(renderer) => {
        material.uniforms.uViewportH.value = renderer.getDrawingBufferSize(tmpSize).y
      }}
    />
  )
}

const tmpSize = new THREE.Vector2()
