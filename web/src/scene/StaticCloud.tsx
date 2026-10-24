import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { PointCloud } from './formats'

const vertexShader = /* glsl */ `
  attribute vec3 color;
  uniform float uSize;       // point diameter in world meters
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
    float px = uSize * projectionMatrix[1][1] * uViewportH * 0.5 / max(-mv.z, 0.01);
    gl_PointSize = clamp(px, 1.0, 64.0);
  }
`

const fragmentShader = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vColor;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(c, c);
    if (r2 > 1.0) discard;
    // Soft round sprite: gentle falloff toward the rim instead of a hard disc.
    float shade = mix(1.0, 0.72, r2);
    gl_FragColor = vec4(vColor * shade, uOpacity);
  }
`

/** The scanned room as soft round points. Colors are sRGB bytes, written out unconverted. */
interface Props {
  cloud: PointCloud
  /** Point diameter in meters. */
  pointSize?: number
  opacity?: number
  /** Brightness multiplier, e.g. to dim the room around a selection. */
  dim?: number
  /** Blend every point toward this color by `tintMix`. */
  tint?: string
  tintMix?: number
  renderOrder?: number
}

export function StaticCloud({ cloud, pointSize = 0.012, opacity = 1, dim = 1, tint = '#ffffff', tintMix = 0, renderOrder = 0 }: Props) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(cloud.positions, 3))
    g.setAttribute('color', new THREE.BufferAttribute(cloud.colors, 3, true))
    g.computeBoundingSphere()
    return g
  }, [cloud])

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
