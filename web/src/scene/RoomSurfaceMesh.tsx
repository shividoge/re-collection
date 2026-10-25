import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { SELECTION_GLSL, applySelection, selectionUniforms, type SelectionTint } from './selectionTint'
import type { RoomSurface } from './useRoomSurface'

/**
 * The fused room surface. Triangles a keyframe sees well show that keyframe's pixels (sharp:
 * text and logos read); the rest show the scan points' colors with a touch of shading from the
 * normal so their shape reads. Both are sRGB bytes, written out unconverted. A selected object
 * is tinted per pixel (see selectionTint.ts). Pushed slightly back in depth so the live replay
 * of the same spot draws on top of it.
 */
export function RoomSurfaceMesh({ surface, selection = null }: { surface: RoomSurface; selection?: SelectionTint | null }) {
  const { mesh, keyframes } = surface
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3))
    g.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3))
    g.setAttribute('color', new THREE.BufferAttribute(mesh.colors, 3, true))
    g.setAttribute('uv', new THREE.BufferAttribute(mesh.uvs, 2))
    g.setAttribute('layer', new THREE.BufferAttribute(mesh.layers, 1))
    g.computeBoundingSphere()
    return g
  }, [mesh])

  const keyTexture = useMemo(() => {
    if (!keyframes) return null
    const t = new THREE.DataArrayTexture(keyframes.data, keyframes.width, keyframes.height, keyframes.layers)
    // RGBA: array textures get fixed-size storage, which plain RGB can't have.
    t.format = THREE.RGBAFormat
    t.type = THREE.UnsignedByteType
    t.colorSpace = THREE.NoColorSpace
    // No mipmaps: three doesn't build them for array textures, and without them the texture
    // would be incomplete and sample black.
    t.minFilter = THREE.LinearFilter
    t.magFilter = THREE.LinearFilter
    t.generateMipmaps = false
    t.unpackAlignment = 1
    t.needsUpdate = true
    return t
  }, [keyframes])
  useEffect(() => () => keyTexture?.dispose(), [keyTexture])

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { uKeys: { value: EMPTY_ARRAY }, uHasKeys: { value: 0 }, ...selectionUniforms() },
        vertexShader: /* glsl */ `
          attribute vec3 color;
          attribute float layer;
          varying vec3 vColor;
          varying vec3 vNormal;
          varying vec3 vWorld;
          varying vec2 vUv;
          varying float vLayer;
          void main() {
            vColor = color;
            vNormal = normal;
            vUv = uv;
            vLayer = layer;
            vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          precision highp sampler2DArray;
          uniform sampler2DArray uKeys;
          uniform float uHasKeys;
          varying vec3 vColor;
          varying vec3 vNormal;
          varying vec3 vWorld;
          varying vec2 vUv;
          varying float vLayer;
          ${SELECTION_GLSL}
          void main() {
            vec3 color;
            if (uHasKeys > 0.5 && vLayer > -0.5) {
              color = texture(uKeys, vec3(vUv, floor(vLayer + 0.5))).rgb;
            } else {
              float light = 0.82 + 0.18 * abs(dot(normalize(vNormal), normalize(vec3(0.3, 0.8, 0.5))));
              color = vColor * light;
            }
            gl_FragColor = vec4(tintSelected(color, vWorld), 1.0);
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
    material.uniforms.uKeys.value = keyTexture ?? EMPTY_ARRAY
    material.uniforms.uHasKeys.value = keyTexture ? 1 : 0
  }, [material, keyTexture])
  useEffect(() => applySelection(material, selection), [material, selection])
  useEffect(() => () => geometry.dispose(), [geometry])
  useEffect(() => () => material.dispose(), [material])

  return <mesh geometry={geometry} material={material} frustumCulled={false} />
}

const EMPTY_ARRAY = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1)
