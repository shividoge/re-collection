import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { RoomSurface } from './useRoomSurface'

/**
 * The fused room surface, in the scan's own colors (sRGB bytes, written out unconverted), with
 * a touch of shading from the surface normal so its shape reads. Pushed slightly back in depth
 * so highlighted points drawn on top of it don't flicker.
 */
export function RoomSurfaceMesh({ surface, dim = 1 }: { surface: RoomSurface; dim?: number }) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(surface.positions, 3))
    g.setAttribute('normal', new THREE.BufferAttribute(surface.normals, 3))
    g.setAttribute('color', new THREE.BufferAttribute(surface.colors, 3, true))
    g.setIndex(new THREE.BufferAttribute(surface.indices, 1))
    g.computeBoundingSphere()
    return g
  }, [surface])

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { uDim: { value: 1 } },
        vertexShader: /* glsl */ `
          attribute vec3 color;
          varying vec3 vColor;
          varying vec3 vNormal;
          void main() {
            vColor = color;
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
  }, [material, dim])
  useEffect(() => () => geometry.dispose(), [geometry])
  useEffect(() => () => material.dispose(), [material])

  return <mesh geometry={geometry} material={material} frustumCulled={false} />
}
