import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { SELECTION_GLSL, applySelection, selectionUniforms, type SelectionTint } from './selectionTint'
import type { RoomSurface } from './useRoomSurface'

/**
 * The fused room surface, in the scan's own colors (sRGB bytes, written out unconverted), with
 * a touch of shading from the surface normal so its shape reads. A selected object is tinted
 * per pixel (see selectionTint.ts); nothing else changes. Pushed slightly back in depth so the
 * video replay of the same surfaces draws on top of it.
 */
export function RoomSurfaceMesh({ surface, dim = 1, selection = null }: { surface: RoomSurface; dim?: number; selection?: SelectionTint | null }) {
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
        uniforms: { uDim: { value: 1 }, ...selectionUniforms() },
        vertexShader: /* glsl */ `
          attribute vec3 color;
          varying vec3 vColor;
          varying vec3 vNormal;
          varying vec3 vWorld;
          void main() {
            vColor = color;
            vNormal = normal;
            vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float uDim;
          varying vec3 vColor;
          varying vec3 vNormal;
          varying vec3 vWorld;
          ${SELECTION_GLSL}
          void main() {
            float light = 0.82 + 0.18 * abs(dot(normalize(vNormal), normalize(vec3(0.3, 0.8, 0.5))));
            gl_FragColor = vec4(tintSelected(vColor * light * uDim, vWorld), 1.0);
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
    applySelection(material, selection)
  }, [material, dim, selection])
  useEffect(() => () => geometry.dispose(), [geometry])
  useEffect(() => () => material.dispose(), [material])

  return <mesh geometry={geometry} material={material} frustumCulled={false} />
}
