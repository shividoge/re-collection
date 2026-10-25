import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef, type MutableRefObject } from 'react'
import * as THREE from 'three'

import { fetchRange } from '../api'
import type { Manifest } from '../api'
import type { FrameRecord } from './formats'
import { depthMeshIndices, movingPixels } from './gaps'
import { frameIndexAtTime } from './pose'
import { SELECTION_GLSL, applySelection, selectionUniforms, type SelectionTint } from './selectionTint'
import type { VisitTimeline } from './useRoomSurface'

type DepthFrame = { data: Float32Array }

/** Combines one UInt16-millimeter depth frame and its confidence frame into RG floats (meters, 0–2). */
function decodeDepthFrame(depth: ArrayBuffer, confidence: ArrayBuffer, count: number): DepthFrame {
  const mm = new Uint16Array(depth) // little-endian on every platform browsers run on
  const conf = new Uint8Array(confidence)
  const data = new Float32Array(count * 2)
  for (let k = 0; k < count; k++) {
    data[k * 2] = mm[k] / 1000
    data[k * 2 + 1] = conf[k]
  }
  return { data }
}

/** The frame with depth closest to `frame`, up to `maxFrames` either way (depth is 10 Hz). -1 if none. */
function depthFrameNear(frames: FrameRecord[], frame: number, maxFrames = 3): number {
  for (let offset = 0; offset <= maxFrames; offset++) {
    for (const k of offset === 0 ? [frame] : [frame - offset, frame + offset]) {
      if (k >= 0 && k < frames.length && frames[k].d !== null) return k
    }
  }
  return -1
}

/** The voxels the replay skips, as a 3D texture the shaders test world positions against. */
function roomTexture(t: VisitTimeline): THREE.Data3DTexture {
  const { nx, ny, nz } = t.grid
  const texture = new THREE.Data3DTexture(t.skip, nx, ny, nz)
  texture.format = THREE.RedFormat
  texture.type = THREE.UnsignedByteType
  texture.minFilter = THREE.NearestFilter
  texture.magFilter = THREE.NearestFilter
  texture.unpackAlignment = 1
  texture.needsUpdate = true
  return texture
}

/** Diameter of a remembered voxel's splat, in meters (voxels are 2 cm; this closes the gaps). */
const MEMORY_SPLAT = 0.03

/**
 * The Braindance effect: the visit replayed in 3D, in place, in sync with sound, on top of the
 * stable room surface.
 *
 * - Live: each depth frame becomes a 256×192 grid, unprojected with that frame's own camera
 *   pose and colored from the video. Only solid blobs in space the room scan saw are kept
 *   (gaps.ts movingPixels): people and things brought in or moved. The room itself is drawn
 *   once, from the scan, so it never flickers, and walls the scan missed aren't redrawn from
 *   each noisy frame. Neighboring depth pixels on the same surface are joined into triangles
 *   (gaps.ts depthMeshIndices); the jump from a person to the wall behind is never bridged.
 * - Remembered: what the video added, from when it was first seen until later frames saw
 *   through that spot (timeline.ts), colored from the keyframes. It stays while the camera
 *   looks elsewhere, so the scene at any moment shows everything seen so far from every angle.
 *   Where the live frame sees the same spot, the live (exact video color) one is shown.
 *
 * Same math as pose.ts unprojectDepthPixel and docs/capture-format.md: scale K to the depth grid,
 * x = (u − cx')·d/fx', y = (v − cy')·d/fy', z = d, flip to ARKit camera space (x, −y, −z), then T.
 */
export function DepthReplay({
  captureId,
  manifest,
  frames,
  video,
  timeRef,
  show = true,
  selection = null,
  timeline = null,
  minConfidence = 1,
}: {
  captureId: string
  manifest: Manifest
  frames: FrameRecord[]
  video: HTMLVideoElement
  timeRef: MutableRefObject<number>
  /** Hide without unloading (keeps depth frames and textures ready). */
  show?: boolean
  /** The selected object, tinted here too so it stays visible under the replay. */
  selection?: SelectionTint | null
  /**
   * What the video adds to the room, and when; null while it's being built (then nothing live
   * is drawn, so the replay never fights the room) or when it can't be (then the whole frame is).
   */
  timeline?: VisitTimeline | null | 'building'
  minConfidence?: number
}) {
  const { width, height } = manifest.depth
  const cache = useRef(new Map<number, DepthFrame | 'loading'>())
  const shown = useRef(-1)

  const videoTexture = useMemo(() => {
    const texture = new THREE.VideoTexture(video)
    // Pass the video's sRGB bytes straight through, like the room cloud's colors.
    texture.colorSpace = THREE.NoColorSpace
    // Rows stay top-first, matching the depth grid, so (u, v) index both the same way.
    texture.flipY = false
    return texture
  }, [video])

  const depthTexture = useMemo(() => {
    const texture = new THREE.DataTexture(new Float32Array(width * height * 2), width, height, THREE.RGFormat, THREE.FloatType)
    texture.minFilter = THREE.NearestFilter
    texture.magFilter = THREE.NearestFilter
    texture.needsUpdate = true
    return texture
  }, [width, height])

  const geometry = useMemo(() => {
    const pixels = new Float32Array(width * height * 2)
    for (let v = 0; v < height; v++) {
      for (let u = 0; u < width; u++) {
        pixels[(v * width + u) * 2] = u
        pixels[(v * width + u) * 2 + 1] = v
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(width * height * 3), 3))
    g.setAttribute('pixel', new THREE.BufferAttribute(pixels, 2))
    const index = new THREE.BufferAttribute(new Uint32Array((width - 1) * (height - 1) * 6), 1)
    index.setUsage(THREE.DynamicDrawUsage)
    g.setIndex(index)
    g.setDrawRange(0, 0)
    return g
  }, [width, height])

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uDepth: { value: depthTexture },
          uVideo: { value: videoTexture },
          uGrid: { value: new THREE.Vector2(width, height) },
          uK: { value: new THREE.Vector4() }, // fx', fy', cx', cy' on the depth grid
          uT: { value: new THREE.Matrix4() }, // camera-to-world for this depth frame
          uVisible: { value: 0 },
          uRoom: { value: EMPTY_3D },
          uRoomOrigin: { value: new THREE.Vector3() },
          uRoomVoxel: { value: 1 },
          uRoomDims: { value: new THREE.Vector3(1, 1, 1) },
          uRoomOn: { value: 0 },
          ...selectionUniforms(),
        },
        side: THREE.DoubleSide,
        vertexShader: /* glsl */ `
          uniform sampler2D uDepth;
          uniform vec2 uGrid;
          uniform vec4 uK;
          uniform mat4 uT;
          uniform float uVisible;
          attribute vec2 pixel;
          varying vec2 vUv;
          varying vec3 vWorld;
          void main() {
            vUv = (pixel + 0.5) / uGrid;
            float d = texture2D(uDepth, vUv).r;   // meters; unmeasured pixels are never in a triangle
            if (uVisible < 0.5) {
              gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // off screen
              return;
            }
            // Image-camera space (y down, z forward), then ARKit camera space.
            vec3 cam = vec3((pixel.x - uK.z) * d / uK.x, -((pixel.y - uK.w) * d / uK.y), -d);
            vec4 world = uT * vec4(cam, 1.0);
            vWorld = world.xyz;
            gl_Position = projectionMatrix * viewMatrix * world;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform sampler2D uVideo;
          uniform highp sampler3D uRoom;
          uniform vec3 uRoomOrigin;
          uniform float uRoomVoxel;
          uniform vec3 uRoomDims;
          uniform float uRoomOn;
          varying vec2 vUv;
          varying vec3 vWorld;
          ${SELECTION_GLSL}
          void main() {
            // The room surface already shows this spot, or the scan never saw it.
            if (uRoomOn > 0.5) {
              vec3 c = (floor((vWorld - uRoomOrigin) / uRoomVoxel) + 0.5) / uRoomDims;
              if (all(greaterThanEqual(c, vec3(0.0))) && all(lessThanEqual(c, vec3(1.0))) && texture(uRoom, c).r > 0.0) discard;
            }
            gl_FragColor = vec4(tintSelected(texture2D(uVideo, vUv).rgb, vWorld), 1.0);
          }
        `,
      }),
    [depthTexture, videoTexture, width, height],
  )

  const ready = timeline !== null && timeline !== 'building' ? timeline : null
  const isRoom = useMemo(() => {
    if (!ready) return () => false
    const { nx, ny, nz, origin, voxel } = ready.grid
    const room = ready.skip
    return (x: number, y: number, z: number) => {
      const ix = Math.floor((x - origin[0]) / voxel)
      const iy = Math.floor((y - origin[1]) / voxel)
      const iz = Math.floor((z - origin[2]) / voxel)
      // Outside the room's extent counts as room: far stray depth is never replayed.
      if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return true
      return room[(iz * ny + iy) * nx + ix] === 1
    }
  }, [ready])
  // A new room mask means the shown frame's blobs must be worked out again.
  useEffect(() => {
    shown.current = -1
  }, [isRoom])
  const room = useMemo(() => (ready ? roomTexture(ready) : null), [ready])
  useEffect(() => {
    const u = material.uniforms
    u.uRoomOn.value = room && ready ? 1 : 0
    if (!room || !ready) return
    u.uRoom.value = room
    u.uRoomOrigin.value.set(...ready.grid.origin)
    u.uRoomVoxel.value = ready.grid.voxel
    u.uRoomDims.value.set(ready.grid.nx, ready.grid.ny, ready.grid.nz)
  }, [material, room, ready])
  useEffect(() => () => room?.dispose(), [room])

  const memoryGeometry = useMemo(() => {
    if (!ready || ready.start.length === 0) return null
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(ready.positions, 3))
    g.setAttribute('color', new THREE.BufferAttribute(ready.colors, 3, true))
    g.setAttribute('aStart', new THREE.BufferAttribute(ready.start, 1))
    g.setAttribute('aEnd', new THREE.BufferAttribute(ready.end, 1))
    return g
  }, [ready])
  useEffect(() => () => memoryGeometry?.dispose(), [memoryGeometry])

  const memoryMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          // Shared with the live material: the current depth frame and its intrinsics.
          uDepth: material.uniforms.uDepth,
          uGrid: material.uniforms.uGrid,
          uK: material.uniforms.uK,
          uTinv: { value: new THREE.Matrix4() }, // world-to-camera for the current depth frame
          uLive: { value: 0 },
          uTime: { value: 0 },
          uViewportH: { value: 1000 },
          uSize: { value: MEMORY_SPLAT },
          ...selectionUniforms(),
        },
        vertexShader: /* glsl */ `
          attribute vec3 color;
          attribute float aStart;
          attribute float aEnd;
          uniform sampler2D uDepth;
          uniform vec2 uGrid;
          uniform vec4 uK;
          uniform mat4 uTinv;
          uniform float uLive;
          uniform float uTime;
          uniform float uViewportH;
          uniform float uSize;
          varying vec3 vColor;
          varying vec3 vWorld;
          void hide() {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            gl_PointSize = 0.0;
          }
          void main() {
            vColor = color;
            vWorld = position;
            if (uTime < aStart || uTime >= aEnd) { hide(); return; }
            // Where the live frame sees this same spot, the live replay shows it instead.
            if (uLive > 0.5) {
              vec4 cam = uTinv * vec4(position, 1.0);
              float d = -cam.z;
              if (d > 0.05) {
                vec2 px = floor(vec2(cam.x * uK.x / d + uK.z, -cam.y * uK.y / d + uK.w) + 0.5);
                if (px.x >= 0.0 && px.y >= 0.0 && px.x < uGrid.x && px.y < uGrid.y) {
                  vec2 s = texture2D(uDepth, (px + 0.5) / uGrid).rg;
                  if (s.y >= 1.0 && abs(s.x - d) < 0.06) { hide(); return; }
                }
              }
            }
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_Position = projectionMatrix * mv;
            gl_PointSize = clamp(uSize * projectionMatrix[1][1] * uViewportH * 0.5 / max(-mv.z, 0.01), 1.0, 128.0);
          }
        `,
        fragmentShader: /* glsl */ `
          varying vec3 vColor;
          varying vec3 vWorld;
          ${SELECTION_GLSL}
          void main() {
            vec2 c = gl_PointCoord * 2.0 - 1.0;
            if (dot(c, c) > 1.0) discard;
            gl_FragColor = vec4(tintSelected(vColor, vWorld), 1.0);
          }
        `,
      }),
    [material],
  )
  useEffect(() => () => memoryMaterial.dispose(), [memoryMaterial])

  useEffect(() => {
    applySelection(material, selection)
    applySelection(memoryMaterial, selection)
  }, [material, memoryMaterial, selection])

  useEffect(
    () => () => {
      geometry.dispose()
      material.dispose()
      depthTexture.dispose()
      videoTexture.dispose()
    },
    [geometry, material, depthTexture, videoTexture],
  )

  /** Loads depth frame k (and its confidence) with two small Range requests. */
  function load(k: number) {
    if (k < 0 || k >= manifest.depth.count || cache.current.has(k)) return
    cache.current.set(k, 'loading')
    const depthBytes = width * height * 2
    const confBytes = width * height
    Promise.all([
      fetchRange(captureId, manifest.depth.file, k * depthBytes, depthBytes),
      fetchRange(captureId, manifest.depth.confidenceFile, k * confBytes, confBytes),
    ])
      .then(([depth, conf]) => cache.current.set(k, decodeDepthFrame(depth, conf, width * height)))
      .catch(() => cache.current.delete(k))
  }

  // A paused video never pushes its frame to the GPU on its own (the replay stayed black or
  // missing until playback). Upload it once whenever the paused frame changes.
  const uploadedAt = useRef(-1)

  const viewport = useMemo(() => new THREE.Vector2(), [])
  // While the timeline is being built nothing live is drawn: the whole frame would fight the
  // room surface. If it can't be built, the whole frame is drawn as before.
  const liveAllowed = timeline !== 'building'

  useFrame((state) => {
    memoryMaterial.uniforms.uTime.value = timeRef.current
    memoryMaterial.uniforms.uViewportH.value = state.gl.getDrawingBufferSize(viewport).y
    memoryMaterial.uniforms.uLive.value = material.uniforms.uVisible.value
    if (video.paused && video.readyState >= 2 && video.currentTime !== uploadedAt.current) {
      videoTexture.needsUpdate = true
      uploadedAt.current = video.currentTime
    }
    const frame = depthFrameNear(frames, frameIndexAtTime(frames, timeRef.current))
    if (frame < 0) {
      material.uniforms.uVisible.value = 0
      return
    }
    const f = frames[frame]
    const k = f.d as number
    // Keep the next second of depth loading ahead of playback.
    for (let ahead = 0; ahead <= 10; ahead++) load(k + ahead)

    const entry = cache.current.get(k)
    if (!entry || entry === 'loading') return // keep showing the previous frame
    if (shown.current !== k) {
      ;(depthTexture.image.data as Float32Array).set(entry.data)
      depthTexture.needsUpdate = true
      const sx = width / manifest.video.width
      const sy = height / manifest.video.height
      const Kd = [f.K[0] * sx, f.K[1] * sy, f.K[2] * sx, f.K[3] * sy]
      // Only what the room doesn't explain, as solid blobs (people, things brought in).
      const keep = ready ? movingPixels(entry.data, width, height, Kd, f.T, minConfidence, isRoom) : null
      const index = geometry.getIndex()!
      geometry.setDrawRange(0, depthMeshIndices(entry.data, width, height, minConfidence, index.array as Uint32Array, keep))
      index.needsUpdate = true
      material.uniforms.uK.value.set(Kd[0], Kd[1], Kd[2], Kd[3])
      ;(material.uniforms.uT.value as THREE.Matrix4).fromArray(f.T)
      ;(memoryMaterial.uniforms.uTinv.value as THREE.Matrix4).fromArray(f.T).invert()
      shown.current = k
      // Drop frames far behind playback so memory stays flat.
      for (const key of cache.current.keys()) if (key < k - 20) cache.current.delete(key)
    }
    material.uniforms.uVisible.value = 1
  })

  return (
    <>
      <mesh geometry={geometry} material={material} frustumCulled={false} visible={show && liveAllowed} />
      {memoryGeometry && <points geometry={memoryGeometry} material={memoryMaterial} frustumCulled={false} visible={show} />}
    </>
  )
}

const EMPTY_3D = new THREE.Data3DTexture(new Uint8Array(1), 1, 1, 1)
