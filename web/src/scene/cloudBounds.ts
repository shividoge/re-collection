import * as THREE from 'three'
import type { PointCloud } from './formats'

/** Center and radius of a cloud, for framing the free camera. */
export function cloudBounds(cloud: PointCloud): { center: THREE.Vector3; radius: number } {
  const box = new THREE.Box3()
  const p = cloud.positions
  // Sample at most ~200k points; plenty for framing a 4M-point room.
  const step = Math.max(1, Math.floor(cloud.count / 200_000)) * 3
  const v = new THREE.Vector3()
  for (let i = 0; i < p.length; i += step) box.expandByPoint(v.set(p[i], p[i + 1], p[i + 2]))
  const center = box.getCenter(new THREE.Vector3())
  return { center, radius: Math.max(0.5, box.getSize(new THREE.Vector3()).length() / 2) }
}
