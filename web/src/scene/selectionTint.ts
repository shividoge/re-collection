import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { selectionMask, type VoxelIndex } from './spatial'

/**
 * The selected object as a 3D texture over the room's voxel grid, so any shader can tint the
 * pixels that belong to it: the fused room surface and the video replay alike.
 */
export interface SelectionTint {
  texture: THREE.Data3DTexture
  origin: [number, number, number]
  size: number
  dims: [number, number, number]
}

export function useSelectionTint(index: VoxelIndex | null, voxels: Uint32Array | null): SelectionTint | null {
  const tint = useMemo(() => {
    if (!index || !voxels) return null
    const [dx, dy, dz] = index.dims
    const texture = new THREE.Data3DTexture(selectionMask(index, voxels), dx, dy, dz)
    texture.format = THREE.RedFormat
    texture.type = THREE.UnsignedByteType
    texture.minFilter = THREE.NearestFilter
    texture.magFilter = THREE.NearestFilter
    texture.unpackAlignment = 1
    texture.needsUpdate = true
    return { texture, origin: index.origin, size: index.size, dims: index.dims } as SelectionTint
  }, [index, voxels])
  useEffect(() => () => tint?.texture.dispose(), [tint])
  return tint
}

/** Fragment-shader helper: `tintSelected(color, worldPosition)`. Needs `selectionUniforms()`. */
export const SELECTION_GLSL = /* glsl */ `
  uniform highp sampler3D uSelMask;
  uniform vec3 uSelOrigin;
  uniform float uSelSize;
  uniform vec3 uSelDims;
  uniform float uSelOn;
  uniform vec3 uSelTint;
  vec3 tintSelected(vec3 color, vec3 world) {
    if (uSelOn < 0.5) return color;
    vec3 c = (floor((world - uSelOrigin) / uSelSize) + 0.5) / uSelDims;
    if (any(lessThan(c, vec3(0.0))) || any(greaterThan(c, vec3(1.0)))) return color;
    return texture(uSelMask, c).r > 0.5 ? mix(color, uSelTint, 0.6) : color;
  }
`

const EMPTY = new THREE.Data3DTexture(new Uint8Array(1), 1, 1, 1)

export function selectionUniforms(tintColor = '#6ee7ff') {
  return {
    uSelMask: { value: EMPTY as THREE.Data3DTexture },
    uSelOrigin: { value: new THREE.Vector3() },
    uSelSize: { value: 1 },
    uSelDims: { value: new THREE.Vector3(1, 1, 1) },
    uSelOn: { value: 0 },
    uSelTint: { value: new THREE.Color(tintColor) },
  }
}

/** Points a material's selection uniforms at `tint` (or turns the tint off). */
export function applySelection(material: THREE.ShaderMaterial, tint: SelectionTint | null) {
  const u = material.uniforms
  u.uSelOn.value = tint ? 1 : 0
  if (!tint) return
  u.uSelMask.value = tint.texture
  u.uSelOrigin.value.set(...tint.origin)
  u.uSelSize.value = tint.size
  u.uSelDims.value.set(...tint.dims)
}
