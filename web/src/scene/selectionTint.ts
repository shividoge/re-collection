import { useThree } from '@react-three/fiber'
import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { markVoxels } from './spatial'
import type { SelectionGrid } from './useRoomIndex'

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

/**
 * One mask per room, kept and updated per click: the previous selection's voxels are cleared and
 * the new ones set (spatial.ts markVoxels), instead of rebuilding a full-room mask each time.
 * Allocated on the first selection.
 */
export function useSelectionTint(grid: SelectionGrid | null, coords: Int32Array | null): SelectionTint | null {
  const invalidate = useThree((s) => s.invalidate)
  const [tint, setTint] = useState<SelectionTint | null>(null)
  const state = useRef<{ grid: SelectionGrid | null; tint: SelectionTint | null; shown: Int32Array | null }>({ grid: null, tint: null, shown: null })

  useEffect(() => {
    const st = state.current
    if (st.grid !== grid) {
      st.tint?.texture.dispose()
      Object.assign(st, { grid, tint: null, shown: null })
    }
    if (!grid || (!coords && !st.tint)) {
      setTint(null)
      return
    }
    if (!st.tint) {
      const [dx, dy, dz] = grid.dims
      const texture = new THREE.Data3DTexture(new Uint8Array(dx * dy * dz), dx, dy, dz)
      texture.format = THREE.RedFormat
      texture.type = THREE.UnsignedByteType
      texture.minFilter = THREE.NearestFilter
      texture.magFilter = THREE.NearestFilter
      texture.unpackAlignment = 1
      st.tint = { texture, origin: grid.origin, size: grid.size, dims: grid.dims }
    }
    const mask = st.tint.texture.image.data as Uint8Array
    if (st.shown) markVoxels(mask, grid.dims, st.shown, 0)
    if (coords) markVoxels(mask, grid.dims, coords, 1)
    st.shown = coords
    st.tint.texture.needsUpdate = true
    setTint(coords ? st.tint : null)
    invalidate()
  }, [grid, coords, invalidate])

  useEffect(() => () => state.current.tint?.texture.dispose(), [])
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
