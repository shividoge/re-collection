// The museum's materials, made once per page and shared by every room and piece of furniture:
// one material per look means Merged (merge.ts) can draw all the pieces that share it at once,
// and coming back to the museum doesn't compile any shaders again.

import * as THREE from 'three'
import { LOOK } from './looks'
import { carpetPileNormal, frostedGlassTexture, lightPoolTexture, museumMaps, porcelainTextures, rugTexture, woodGrainMaps } from './textures'

const once = <T>(make: () => T) => {
  let made: T | undefined
  return () => (made ??= make())
}

/** A copy of a texture tiled `r` times (copies share the pixels on the GPU). */
function tile(t: THREE.Texture, r: number, rotation = 0): THREE.Texture {
  const c = t.clone()
  c.repeat.set(r, r)
  c.rotation = rotation
  // A copy isn't drawn until it's marked ready; the pixels upload once for all copies.
  c.needsUpdate = true
  return c
}

export const GOLD = '#c9a052'
const BRASS = '#b8913f'

/** The soft round glow used for light pools, halos and sconce glows (small, drawn at runtime). */
export const pool = once(lightPoolTexture)

/**
 * Dark varnished wood: a fine grain under a clear coat, so it catches a soft highlight from the
 * skylight the way polished panelling does, without looking wet.
 */
export const varnishedWood = once(() => {
  const maps = woodGrainMaps()
  return new THREE.MeshPhysicalMaterial({
    map: tile(maps.map, 1.5),
    normalMap: tile(maps.normalMap, 1.5),
    normalScale: new THREE.Vector2(0.4, 0.4),
    roughness: 0.5,
    clearcoat: 0.55,
    clearcoatRoughness: 0.28,
    envMapIntensity: 1,
  })
})

/** The same wood seen from inside an arch's curve. */
export const soffitWood = once(() => {
  const m = varnishedWood().clone()
  m.side = THREE.DoubleSide
  return m
})

/**
 * Darker herringbone parquet for the floor's edge and the doorways, in the same pattern as the
 * floor itself. Geometry using it needs world UVs, so the pattern runs on unbroken.
 */
export const darkParquet = once(() => {
  const maps = museumMaps('parquet')
  return new THREE.MeshPhysicalMaterial({
    map: tile(maps.map, 1 / 1.6, Math.PI / 4),
    normalMap: tile(maps.normalMap, 1 / 1.6, Math.PI / 4),
    roughnessMap: tile(maps.roughnessMap, 1 / 1.6, Math.PI / 4),
    normalScale: new THREE.Vector2(0.6, 0.6),
    roughness: 1,
    clearcoat: 0.3,
    clearcoatRoughness: 0.35,
  })
})

/** Gilding: warm gold leaf, polished on the high points. */
export const gilding = once(() => new THREE.MeshPhysicalMaterial({ color: GOLD, metalness: 1, roughness: 0.27, clearcoat: 0.35, clearcoatRoughness: 0.3, envMapIntensity: 1.5 }))

export const inlay = once(() => new THREE.MeshStandardMaterial({ color: '#c9a27a', roughness: 0.5 }))
export const corniceIvory = once(() => new THREE.MeshStandardMaterial({ color: LOOK.trim, roughness: 0.6 }))

// The skylight lantern.
export const lanternGlow = once(() => new THREE.MeshStandardMaterial({ color: '#000000', emissive: '#fff4e2', emissiveIntensity: 1.25 }))
export const lanternIvory = once(() => new THREE.MeshStandardMaterial({ color: LOOK.trim, roughness: 0.55 }))
export const lanternGold = once(() => new THREE.MeshStandardMaterial({ color: GOLD, roughness: 0.3, metalness: 0.85 }))
export const lanternSpot = once(() => new THREE.MeshStandardMaterial({ color: '#1e1b18', roughness: 0.4, metalness: 0.6 }))

/** A Persian medallion rug; alphaTest because the fringe is threads with floor between them. */
export const rug = once(() => {
  const normal = carpetPileNormal().clone()
  normal.repeat.set(6, 9)
  normal.needsUpdate = true
  return new THREE.MeshStandardMaterial({ map: rugTexture(), normalMap: normal, normalScale: new THREE.Vector2(0.5, 0.5), roughness: 1, alphaTest: 0.5 })
})

// Candles and their holders.
export const wax = once(() => new THREE.MeshStandardMaterial({ color: '#f4ecdc', roughness: 0.6, emissive: '#ffcf8a', emissiveIntensity: 0.08 }))
export const candelabrumBrass = once(() => new THREE.MeshPhysicalMaterial({ color: BRASS, metalness: 1, roughness: 0.3, clearcoat: 0.3 }))
export const sconceBrass = once(() => new THREE.MeshPhysicalMaterial({ color: BRASS, metalness: 1, roughness: 0.28, clearcoat: 0.3 }))
export const sconceGlow = once(
  () => new THREE.MeshBasicMaterial({ map: pool(), color: '#ffb867', transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false }),
)
export const bronze = once(() => new THREE.MeshPhysicalMaterial({ color: '#6d4a26', metalness: 1, roughness: 0.4, clearcoat: 0.2 }))

// The settee.
export const setteeVelvet = once(() => new THREE.MeshPhysicalMaterial({ color: '#7d1f24', roughness: 0.8, sheen: 1, sheenRoughness: 0.45, sheenColor: new THREE.Color('#d0555a') }))
export const buttons = once(() => new THREE.MeshStandardMaterial({ color: '#4a1014', roughness: 0.6 }))

/** Red-ground porcelain with gold decoration: the gold is metal, the red a glossy glaze. */
export const porcelain = once(() => {
  const { map, surface } = porcelainTextures()
  return new THREE.MeshPhysicalMaterial({ map, roughnessMap: surface, metalnessMap: surface, roughness: 1, metalness: 1, clearcoat: 0.8, clearcoatRoughness: 0.08, envMapIntensity: 1.3 })
})

// The fireplace.
export const marble = once(() => new THREE.MeshPhysicalMaterial({ color: '#efe8de', roughness: 0.22, clearcoat: 0.6, clearcoatRoughness: 0.15, envMapIntensity: 1 }))
export const soot = once(() => new THREE.MeshStandardMaterial({ color: '#141010', roughness: 0.95 }))
export const logs = once(() => new THREE.MeshStandardMaterial({ color: '#3a2618', roughness: 0.9, emissive: '#ff5a1a', emissiveIntensity: 0.25 }))
export const fireFlames = once(() =>
  ['#ff7a1f', '#ffb347'].map((color) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })),
)

// The window.
export const windowGlass = once(() => new THREE.MeshStandardMaterial({ color: '#000000', emissive: '#ffffff', emissiveMap: frostedGlassTexture(), emissiveIntensity: 1.1 }))
export const sheer = once(
  () => new THREE.MeshStandardMaterial({ color: '#f7f3ec', emissive: '#fff4e4', emissiveIntensity: 0.55, roughness: 0.95, transparent: true, opacity: 0.94, side: THREE.DoubleSide }),
)
export const drapeVelvet = once(
  () => new THREE.MeshPhysicalMaterial({ color: '#6a121c', roughness: 0.85, sheen: 1, sheenRoughness: 0.4, sheenColor: new THREE.Color('#c0404f'), side: THREE.DoubleSide }),
)
