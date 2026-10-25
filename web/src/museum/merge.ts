import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

/** A candle flame found while merging: where it burns (in the merged root's space). */
export type FlameSpot = { matrix: THREE.Matrix4 }

const KEEP = new Set(['position', 'normal', 'uv'])

/** A mesh's geometry, moved by `m`, with exactly the attributes every merged piece shares. */
function prepared(g: THREE.BufferGeometry, m: THREE.Matrix4): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g.clone()
  for (const name of Object.keys(out.attributes)) if (!KEEP.has(name)) out.deleteAttribute(name)
  out.morphAttributes = {}
  out.clearGroups()
  if (!out.attributes.normal) out.computeVertexNormals()
  if (!out.attributes.uv) out.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(out.attributes.position.count * 2), 2))
  return out.applyMatrix4(m)
}

/**
 * Merges every still mesh under `root` into one mesh per material, so a room full of furniture
 * draws in a handful of calls. Meshes under an object marked `userData.live` (animated) are
 * left alone; objects marked `userData.flame` are collected as candle flames instead (drawn
 * together by Flames). The originals are hidden, not removed, so React keeps owning them.
 * Returns the merged meshes (already added to `root`), the flames, and an undo.
 */
export function mergeStill(root: THREE.Object3D): { merged: THREE.Mesh[]; flames: FlameSpot[]; undo: () => void } {
  root.updateWorldMatrix(true, true)
  const toRoot = root.matrixWorld.clone().invert()
  const groups = new Map<THREE.Material, { meshes: THREE.Mesh[]; parts: THREE.BufferGeometry[] }>()
  const flames: FlameSpot[] = []
  const visit = (o: THREE.Object3D) => {
    if (o.userData.live || !o.visible) return
    if (o.userData.flame) flames.push({ matrix: toRoot.clone().multiply(o.matrixWorld) })
    const mesh = o as THREE.Mesh
    if (mesh.isMesh && !(o as THREE.InstancedMesh).isInstancedMesh && !Array.isArray(mesh.material)) {
      const m = toRoot.clone().multiply(o.matrixWorld)
      let group = groups.get(mesh.material)
      if (!group) groups.set(mesh.material, (group = { meshes: [], parts: [] }))
      group.meshes.push(mesh)
      group.parts.push(prepared(mesh.geometry, m))
    }
    for (const c of o.children) visit(c)
  }
  for (const c of root.children) visit(c)

  const merged: THREE.Mesh[] = []
  const hidden: THREE.Mesh[] = []
  for (const [material, { meshes, parts }] of groups) {
    const geometry = parts.length > 1 ? mergeGeometries(parts) : parts[0]
    if (parts.length > 1) parts.forEach((p) => p.dispose())
    // A group that can't merge (it shouldn't happen) keeps drawing as it was.
    if (!geometry) continue
    const mesh = new THREE.Mesh(geometry, material)
    mesh.renderOrder = Math.max(...meshes.map((x) => x.renderOrder))
    mesh.userData.merged = true
    merged.push(mesh)
    for (const x of meshes) {
      x.visible = false
      hidden.push(x)
    }
  }
  for (const m of merged) root.add(m)
  return {
    merged,
    flames,
    undo: () => {
      for (const m of merged) {
        root.remove(m)
        m.geometry.dispose()
      }
      for (const x of hidden) x.visible = true
    },
  }
}
