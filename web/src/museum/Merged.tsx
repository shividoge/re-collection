import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as THREE from 'three'
import { pool } from './materials'
import { mergeStill, type FlameSpot } from './merge'

/**
 * Draws its children merged: every still mesh joins one mesh per material (merge.ts), and the
 * candle flames become two instanced meshes animated on the GPU. Remount it (a new `key`) when
 * what's inside changes shape.
 */
export function Merged({ children }: { children: ReactNode }) {
  const root = useRef<THREE.Group>(null)
  const invalidate = useThree((s) => s.invalidate)
  const [flames, setFlames] = useState<FlameSpot[]>([])
  useLayoutEffect(() => {
    if (!root.current) return
    const { flames, undo } = mergeStill(root.current)
    setFlames(flames)
    invalidate()
    return undo
  }, [invalidate])
  return (
    <group ref={root}>
      {children}
      {flames.length > 0 && <Flames spots={flames} />}
    </group>
  )
}

/** Seconds, shared by every flame's shader. */
const time = { value: 0 }

/** Same flicker as each candle had: a slow and a quick wave, offset per flame. */
const FLICKER = /* glsl */ `
attribute float aSeed;
uniform float uTime;
varying float vK;
float flicker() {
  float t = uTime + aSeed;
  return 1.0 + sin(t * 9.0) * 0.06 + sin(t * 23.0) * 0.04;
}
`

function flameMaterial(): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color: '#ffd27a', toneMapped: false })
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time
    shader.vertexShader = FLICKER + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvK = flicker();\ntransformed.y *= vK;')
  }
  m.customProgramCacheKey = () => 'museum-flame'
  return m
}

/**
 * The glow round a flame. It turns with the camera inside its holder's frame (as each halo
 * always did, copying the camera's turn under a turned sconce), and brightens with the flicker.
 */
function haloMaterial(): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ map: pool(), color: '#ffb24d', transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time
    shader.vertexShader = (FLICKER + shader.vertexShader)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvK = flicker();')
      .replace(
        '#include <project_vertex>',
        /* glsl */ `
        mat3 V = mat3(viewMatrix);
        vec4 mvPosition = modelViewMatrix * vec4(instanceMatrix[3].xyz, 1.0);
        mvPosition.xyz += V * (mat3(instanceMatrix) * (transpose(V) * transformed));
        gl_Position = projectionMatrix * mvPosition;`,
      )
    shader.fragmentShader = 'varying float vK;\n' + shader.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.a *= vK;')
  }
  m.customProgramCacheKey = () => 'museum-halo'
  return m
}

/** Every candle flame: a glowing teardrop and its halo, two draw calls for all of them. */
function Flames({ spots }: { spots: FlameSpot[] }) {
  const meshes = useMemo(() => {
    const seeds = new THREE.InstancedBufferAttribute(Float32Array.from(spots, (_, i) => ((i * 37.17) % 100) + 0.5), 1)
    const flame = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 10), flameMaterial(), spots.length)
    const halo = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.14, 0.14), haloMaterial(), spots.length)
    flame.geometry.setAttribute('aSeed', seeds)
    halo.geometry.setAttribute('aSeed', seeds)
    halo.renderOrder = 3
    const p = new THREE.Vector3()
    const q = new THREE.Quaternion()
    const s = new THREE.Vector3()
    const m = new THREE.Matrix4()
    spots.forEach((spot, i) => {
      spot.matrix.decompose(p, q, s)
      flame.setMatrixAt(i, m.compose(p, new THREE.Quaternion(), new THREE.Vector3(0.011 * s.x, 0.028 * s.y, 0.011 * s.z)))
      halo.setMatrixAt(i, spot.matrix)
    })
    // The flames move a little; their bounds are the whole room's anyway.
    flame.frustumCulled = false
    halo.frustumCulled = false
    return { flame, halo }
  }, [spots])
  useEffect(
    () => () => {
      for (const m of [meshes.flame, meshes.halo]) {
        m.geometry.dispose()
        ;(m.material as THREE.Material).dispose()
      }
    },
    [meshes],
  )
  useFrame(({ clock }) => {
    time.value = clock.elapsedTime
  })
  return (
    <>
      <primitive object={meshes.flame} />
      <primitive object={meshes.halo} />
    </>
  )
}
