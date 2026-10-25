import { useFrame, useThree } from '@react-three/fiber'
import { BlurPass } from '@react-three/drei/materials/BlurPass.js'
import { MeshReflectorMaterial } from '@react-three/drei/materials/MeshReflectorMaterial.js'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'

/** While the camera holds still, the reflection is redrawn this often at most (ms), so a video
 *  playing on a wall still shows in the floor. */
const STILL_REFRESH_MS = 500

/** True when the view has changed since `last` (camera pose or lens). */
export function viewChanged(last: Float32Array, camera: THREE.Camera): boolean {
  const a = camera.matrixWorld.elements
  const b = camera.projectionMatrix.elements
  let changed = false
  for (let i = 0; i < 16; i++) {
    if (Math.abs(last[i] - a[i]) > 1e-5 || Math.abs(last[16 + i] - b[i]) > 1e-5) changed = true
    last[i] = a[i]
    last[16 + i] = b[i]
  }
  return changed
}

export type ReflectorProps = {
  size: [number, number]
  position: [number, number, number]
  resolution: number
  blur: [number, number]
  mixBlur: number
  mixStrength: number
  mixContrast: number
  depthScale: number
  minDepthThreshold: number
  maxDepthThreshold: number
  mirror: number
  /** Ordinary surface settings (map, normalMap, roughness, …). */
  surface: THREE.MeshStandardMaterialParameters
}

/**
 * A floor that softly reflects the room (a blurred mirror, as polished wood does). Same look as
 * drei's MeshReflectorMaterial, but the reflection is only redrawn when the view changes (and
 * now and then while it doesn't), instead of re-rendering the whole museum every frame.
 */
export function ReflectiveFloor({ size, position, resolution, blur, mixBlur, mixStrength, mixContrast, depthScale, minDepthThreshold, maxDepthThreshold, mirror, surface }: ReflectorProps) {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const mesh = useRef<THREE.Mesh>(null)

  const parts = useMemo(() => {
    const params = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, type: THREE.HalfFloatType }
    const fbo1 = new THREE.WebGLRenderTarget(resolution, resolution, params)
    fbo1.depthBuffer = true
    fbo1.depthTexture = new THREE.DepthTexture(resolution, resolution)
    fbo1.depthTexture.format = THREE.DepthFormat
    fbo1.depthTexture.type = THREE.UnsignedShortType
    const fbo2 = new THREE.WebGLRenderTarget(resolution, resolution, params)
    const hasBlur = blur[0] + blur[1] > 0
    const blurPass = new BlurPass({ gl, resolution, width: blur[0], height: blur[1], minDepthThreshold, maxDepthThreshold, depthScale, depthToBlurRatioBias: 0.25 })
    const textureMatrix = new THREE.Matrix4()
    const material = new MeshReflectorMaterial()
    material.setValues(surface)
    Object.assign(material, {
      mirror,
      textureMatrix,
      mixBlur,
      tDiffuse: fbo1.texture,
      tDepth: fbo1.depthTexture,
      tDiffuseBlur: fbo2.texture,
      hasBlur,
      mixStrength,
      minDepthThreshold,
      maxDepthThreshold,
      depthScale,
      depthToBlurRatioBias: 0.25,
      distortion: 1,
      mixContrast,
    })
    material.defines = { ...material.defines, ...(hasBlur ? { USE_BLUR: '' } : {}), ...(depthScale > 0 ? { USE_DEPTH: '' } : {}) }
    return { fbo1, fbo2, blurPass, hasBlur, textureMatrix, material, virtualCamera: new THREE.PerspectiveCamera(), last: new Float32Array(32), lastAt: -Infinity }
    // The surface settings are fixed for the museum's life.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, resolution, blur[0], blur[1], mixBlur, mixStrength, mixContrast, depthScale, minDepthThreshold, maxDepthThreshold, mirror])
  useEffect(
    () => () => {
      parts.fbo1.dispose()
      parts.fbo2.dispose()
      parts.material.dispose()
    },
    [parts],
  )

  useFrame(({ camera }) => {
    const floor = mesh.current
    if (!floor) return
    const now = performance.now()
    const moved = viewChanged(parts.last, camera)
    if (!moved && now - parts.lastAt < STILL_REFRESH_MS) return
    if (!aim(parts.virtualCamera, parts.textureMatrix, camera, floor)) return
    parts.lastAt = now
    floor.visible = false
    gl.setRenderTarget(parts.fbo1)
    gl.state.buffers.depth.setMask(true)
    if (!gl.autoClear) gl.clear()
    gl.render(scene, parts.virtualCamera)
    if (parts.hasBlur) parts.blurPass.render(gl, parts.fbo1, parts.fbo2)
    floor.visible = true
    gl.setRenderTarget(null)
  })

  return (
    <mesh ref={mesh} rotation={[-Math.PI / 2, 0, 0]} position={position} material={parts.material} userData={{ live: true }}>
      <planeGeometry args={size} />
    </mesh>
  )
}

const plane = new THREE.Plane()
const normal = new THREE.Vector3()
const at = new THREE.Vector3()
const eye = new THREE.Vector3()
const view = new THREE.Vector3()
const target = new THREE.Vector3()
const ahead = new THREE.Vector3()
const rotation = new THREE.Matrix4()
const clip = new THREE.Vector4()
const q = new THREE.Vector4()

/**
 * Points `virtual` at the camera's mirror image below the floor, with the floor as its near
 * plane (oblique clipping, after Lengyel), and sets the matrix that maps the floor into its
 * picture. False when the camera is under the floor.
 */
function aim(virtual: THREE.PerspectiveCamera, textureMatrix: THREE.Matrix4, camera: THREE.Camera, floor: THREE.Object3D): boolean {
  at.setFromMatrixPosition(floor.matrixWorld)
  eye.setFromMatrixPosition(camera.matrixWorld)
  rotation.extractRotation(floor.matrixWorld)
  normal.set(0, 0, 1).applyMatrix4(rotation)
  view.subVectors(at, eye)
  if (view.dot(normal) > 0) return false
  view.reflect(normal).negate().add(at)
  rotation.extractRotation(camera.matrixWorld)
  ahead.set(0, 0, -1).applyMatrix4(rotation).add(eye)
  target.subVectors(at, ahead).reflect(normal).negate().add(at)
  virtual.position.copy(view)
  virtual.up.set(0, 1, 0).applyMatrix4(rotation).reflect(normal)
  virtual.lookAt(target)
  virtual.far = (camera as THREE.PerspectiveCamera).far
  virtual.updateMatrixWorld()
  virtual.projectionMatrix.copy(camera.projectionMatrix)
  textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
  textureMatrix.multiply(virtual.projectionMatrix).multiply(virtual.matrixWorldInverse).multiply(floor.matrixWorld)
  plane.setFromNormalAndCoplanarPoint(normal, at).applyMatrix4(virtual.matrixWorldInverse)
  clip.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant)
  const p = virtual.projectionMatrix.elements
  q.set((Math.sign(clip.x) + p[8]) / p[0], (Math.sign(clip.y) + p[9]) / p[5], -1, (1 + p[10]) / p[14])
  clip.multiplyScalar(2 / clip.dot(q))
  p[2] = clip.x
  p[6] = clip.y
  p[10] = clip.z + 1
  p[14] = clip.w
  return true
}
