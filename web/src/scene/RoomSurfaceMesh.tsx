import { useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useKeyframeTexture } from './keyframeTexture'
import type { SurfaceData } from './packs'
import { SELECTION_GLSL, applySelection, selectionUniforms, type SelectionTint } from './selectionTint'
import { trimStop } from './depthSource'
import type { SceneNote } from './useCaptureScene'

/**
 * The fused room surface from surface.pack (indexed; keyframe layers loaded straight to the GPU,
 * keyframeTexture.ts). Triangles a keyframe sees well show that keyframe's pixels (sharp:
 * text and logos read); the rest show the scan points' colors with a touch of shading from the
 * normal so their shape reads. Both are sRGB bytes, written out unconverted. A selected object
 * is tinted per pixel (see selectionTint.ts). Pushed slightly back in depth so the live replay
 * of the same spot draws on top of it.
 */
export function RoomSurfaceMesh({
  surface,
  keyframeUrls,
  selection = null,
  dim = 1,
  visible = true,
  onNote,
}: {
  surface: SurfaceData
  /** URL of each keyframe layer (surface.keyframes[i].file), or null to use vertex colors only. */
  keyframeUrls: string[] | null
  selection?: SelectionTint | null
  /** Brightness multiplier. */
  dim?: number
  visible?: boolean
  /** Told when the keyframe photos fail (the surface then shows its measured colors). */
  onNote?: SceneNote
}) {
  const invalidate = useThree((s) => s.invalidate)
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(surface.positions, 3))
    g.setAttribute('normal', new THREE.BufferAttribute(surface.normals, 3, true))
    g.setAttribute('color', new THREE.BufferAttribute(surface.colors, 3, true))
    g.setAttribute('uv', new THREE.BufferAttribute(surface.uvs, 2, true))
    g.setAttribute('layer', new THREE.BufferAttribute(surface.layers, 1))
    g.setIndex(new THREE.BufferAttribute(surface.indices, 1))
    g.computeBoundingSphere()
    return g
  }, [surface])
  const keys = useKeyframeTexture(keyframeUrls)
  const keyTexture = keys.status === 'ready' ? keys.texture : null
  const keysFailed = keys.status === 'failed' ? keys.message : null
  useEffect(() => {
    if (!onNote) return
    onNote('keyframes', keysFailed && `Couldn't load the room's photos (${trimStop(keysFailed)}); showing measured colors.`)
    return () => onNote('keyframes', null)
  }, [onNote, keysFailed])

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { uKeys: { value: EMPTY_ARRAY }, uHasKeys: { value: 0 }, uDim: { value: 1 }, ...selectionUniforms() },
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
          uniform float uDim;
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
            gl_FragColor = vec4(tintSelected(color * uDim, vWorld), 1.0);
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
    invalidate()
  }, [material, keyTexture, invalidate])
  useEffect(() => {
    material.uniforms.uDim.value = dim
    invalidate()
  }, [material, dim, invalidate])
  useEffect(() => {
    applySelection(material, selection)
    invalidate()
  }, [material, selection, invalidate])
  useEffect(() => () => geometry.dispose(), [geometry])
  useEffect(() => () => material.dispose(), [material])

  return <mesh geometry={geometry} material={material} visible={visible} />
}

const EMPTY_ARRAY = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1)
