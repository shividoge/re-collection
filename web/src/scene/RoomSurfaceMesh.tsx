import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { RoomSurface } from './useRoomSurface'

/**
 * The fused room surface, in the scan's own colors (sRGB bytes, written out unconverted), with
 * a touch of shading from the surface normal so its shape reads. `selected` marks the vertices
 * of a selected object (1 per vertex); they're tinted, and nothing else changes.
 */
export function RoomSurfaceMesh({
  surface,
  dim = 1,
  selected = null,
  tint = '#6ee7ff',
}: {
  surface: RoomSurface
  dim?: number
  selected?: Uint8Array | null
  tint?: string
}) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(surface.positions, 3))
    g.setAttribute('normal', new THREE.BufferAttribute(surface.normals, 3))
    g.setAttribute('color', new THREE.BufferAttribute(surface.colors, 3, true))
    g.setAttribute('aSelected', new THREE.BufferAttribute(new Uint8Array(surface.positions.length / 3), 1, true))
    g.setIndex(new THREE.BufferAttribute(surface.indices, 1))
    g.computeBoundingSphere()
    return g
  }, [surface])
  useEffect(() => {
    const ok = selected && selected.length === surface.positions.length / 3
    geometry.setAttribute('aSelected', new THREE.BufferAttribute(ok ? selected : new Uint8Array(surface.positions.length / 3), 1, true))
  }, [geometry, selected, surface])

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { uDim: { value: 1 }, uTint: { value: new THREE.Color('#6ee7ff') } },
        vertexShader: /* glsl */ `
          attribute vec3 color;
          attribute float aSelected;
          uniform vec3 uTint;
          varying vec3 vColor;
          varying vec3 vNormal;
          void main() {
            vColor = mix(color, uTint, aSelected * 0.6);
            vNormal = normal;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float uDim;
          varying vec3 vColor;
          varying vec3 vNormal;
          void main() {
            float light = 0.82 + 0.18 * abs(dot(normalize(vNormal), normalize(vec3(0.3, 0.8, 0.5))));
            gl_FragColor = vec4(vColor * light * uDim, 1.0);
          }
        `,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      }),
    [],
  )
  useEffect(() => {
    material.uniforms.uDim.value = dim
    material.uniforms.uTint.value.set(tint)
  }, [material, dim, tint])
  useEffect(() => () => geometry.dispose(), [geometry])
  useEffect(() => () => material.dispose(), [material])

  return <mesh geometry={geometry} material={material} frustumCulled={false} />
}
