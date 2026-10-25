import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import * as THREE from 'three'
import type { FrameRecord } from './formats'
import { DepthSource } from './depthSource'
import type { DepthPose } from './depthMesh'
import { depthFrameIndices, nearestDepthFrame } from './pose'
import type { TimelineData } from './packs'
import { SELECTION_GLSL, applySelection, selectionUniforms, type SelectionTint } from './selectionTint'
import type { DepthSourceInfo } from './useCaptureScene'

/** The voxels the replay skips, as a 3D texture the shaders test world positions against. */
function roomTexture(t: TimelineData): THREE.Data3DTexture {
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

/** GLSL: a packed depth v2 pixel (14-bit mm, 2-bit confidence) from the integer texture. */
const DEPTH_GLSL = /* glsl */ `
  uniform highp usampler2D uDepth;
  float depthMeters(uint s) { return float(s & 0x3FFFu) / 1000.0; }
  uint depthConfidence(uint s) { return s >> 14u; }
`

interface Props {
  depth: DepthSourceInfo
  /** The visit's frames (frames.jsonl moment phase). */
  frames: FrameRecord[]
  videoW: number
  videoH: number
  /** Depth frames per second (manifest depth.rateHz). */
  rateHz: number
  video: HTMLVideoElement
  timeRef: RefObject<number>
  /** Hide without unloading (keeps depth frames and textures ready). */
  show?: boolean
  /** The selected object, tinted here too so it stays visible under the replay. */
  selection?: SelectionTint | null
  /**
   * What the video adds to the room, and when; 'loading' while timeline.pack loads (then nothing
   * live is drawn, so the replay never fights the room), null when there is none or the room is
   * shown as points (then the whole frame is).
   */
  timeline?: TimelineData | null | 'loading'
  minConfidence?: number
}

/**
 * The Braindance effect: the visit replayed in 3D, in place, in sync with sound, on top of the
 * stable room.
 *
 * - Live: each depth frame becomes a 256×192 grid, unprojected with that frame's own camera
 *   pose and colored from the video. Only solid blobs in space the room scan saw are kept
 *   (gaps.ts movingPixels, worked out in depthWorker.ts): people and things brought in or moved.
 *   Neighboring depth pixels on the same surface are joined into triangles; the jump from a
 *   person to the wall behind is never bridged.
 * - Remembered: what the video added, from when it was first seen until later frames saw
 *   through that spot (timeline.pack), colored from the keyframes. Where the live frame sees the
 *   same spot, the live (exact video color) one is shown.
 *
 * The depth frame is uploaded as packed UInt16 to an integer texture and unpacked in the shader.
 * Same math as pose.ts unprojectDepthPixel and docs/capture-format.md: scale K to the depth grid,
 * x = (u − cx')·d/fx', y = (v − cy')·d/fy', z = d, flip to ARKit camera space (x, −y, −z), then T.
 */
export function DepthReplay({ depth, frames, videoW, videoH, rateHz, video, timeRef, show = true, selection = null, timeline = null, minConfidence = 1 }: Props) {
  const { width, height } = depth.index
  const invalidate = useThree((s) => s.invalidate)
  const withDepth = useMemo(() => depthFrameIndices(frames), [frames])
  // Show a depth frame up to one depth interval away (0.1 s on a phone); past that, a gap shows nothing.
  const maxGap = rateHz > 0 ? 1 / rateHz : Infinity
  const ready = timeline !== null && timeline !== 'loading' ? timeline : null

  // One source per depth file and room mask; it meshes in a worker with the mask it was made with.
  // Made in an effect (it owns a worker), so it is always disposed.
  const [source, setSource] = useState<DepthSource | null>(null)
  useEffect(() => {
    if (timeline === 'loading') {
      setSource(null)
      return
    }
    const poses: DepthPose[] = frames.filter((f) => f.d !== null).map((f) => ({ k: f.d as number, T: f.T, K: f.K }))
    const s = new DepthSource(depth.url, depth.index, { poses, videoW, videoH, minConfidence, room: ready ? { grid: ready.grid, skip: ready.skip } : null })
    s.onLoad = () => invalidate()
    setSource(s)
    return () => s.dispose()
  }, [depth, frames, videoW, videoH, minConfidence, timeline, ready, invalidate])

  const videoTexture = useMemo(() => {
    const texture = new THREE.VideoTexture(video)
    // Pass the video's sRGB bytes straight through, like the room's colors.
    texture.colorSpace = THREE.NoColorSpace
    // Rows stay top-first, matching the depth grid, so (u, v) index both the same way.
    texture.flipY = false
    return texture
  }, [video])

  const depthTexture = useMemo(() => {
    const texture = new THREE.DataTexture(new Uint16Array(width * height), width, height, THREE.RedIntegerFormat, THREE.UnsignedShortType)
    texture.internalFormat = 'R16UI'
    texture.minFilter = THREE.NearestFilter
    texture.magFilter = THREE.NearestFilter
    texture.generateMipmaps = false
    texture.unpackAlignment = 2
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
    // Positions come from the depth texture; the attribute only sets the vertex count.
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(width * height * 3), 3))
    g.setAttribute('pixel', new THREE.BufferAttribute(pixels, 2))
    const index = new THREE.BufferAttribute(new Uint16Array((width - 1) * (height - 1) * 6), 1)
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
          ${DEPTH_GLSL}
          uniform vec2 uGrid;
          uniform vec4 uK;
          uniform mat4 uT;
          uniform float uVisible;
          attribute vec2 pixel;
          varying vec2 vUv;
          varying vec3 vWorld;
          void main() {
            vUv = (pixel + 0.5) / uGrid;
            if (uVisible < 0.5) {
              gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // off screen
              return;
            }
            // Meters; unmeasured pixels are never in a triangle.
            float d = depthMeters(texelFetch(uDepth, ivec2(pixel), 0).r);
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
    g.computeBoundingSphere()
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
          ${DEPTH_GLSL}
          attribute vec3 color;
          attribute float aStart;
          attribute float aEnd;
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
                  uint s = texelFetch(uDepth, ivec2(px), 0).r;
                  if (depthConfidence(s) >= 1u && abs(depthMeters(s) - d) < 0.06) { hide(); return; }
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
    invalidate()
  }, [material, memoryMaterial, selection, invalidate])

  useEffect(
    () => () => {
      geometry.dispose()
      material.dispose()
      depthTexture.dispose()
      videoTexture.dispose()
    },
    [geometry, material, depthTexture, videoTexture],
  )

  // The depth frame on screen; reset when the source (and so the meshing) changes.
  const shown = useRef<{ source: DepthSource | null; k: number }>({ source: null, k: -1 })
  // A paused video never pushes its frame to the GPU on its own. Upload it once whenever the
  // paused frame changes.
  const uploadedAt = useRef(-1)
  const viewport = useMemo(() => new THREE.Vector4(), [])

  useFrame((state) => {
    const time = timeRef.current ?? 0
    memoryMaterial.uniforms.uTime.value = time
    memoryMaterial.uniforms.uViewportH.value = state.gl.getCurrentViewport(viewport).w
    memoryMaterial.uniforms.uLive.value = material.uniforms.uVisible.value
    if (video.paused && video.readyState >= 2 && video.currentTime !== uploadedAt.current) {
      videoTexture.needsUpdate = true
      uploadedAt.current = video.currentTime
    }
    const frame = source ? nearestDepthFrame(frames, withDepth, time, maxGap) : -1
    if (!source || frame < 0) {
      material.uniforms.uVisible.value = 0
      return
    }
    const f = frames[frame]
    const k = f.d as number
    const entry = source.frame(k)
    if (!entry) return // keep showing the previous frame until this one arrives
    if (shown.current.source !== source || shown.current.k !== k) {
      depthTexture.image.data = entry.packed
      depthTexture.needsUpdate = true
      const index = geometry.getIndex()!
      ;(index.array as Uint16Array).set(entry.indices)
      index.clearUpdateRanges()
      index.addUpdateRange(0, entry.indices.length)
      index.needsUpdate = true
      geometry.setDrawRange(0, entry.indices.length)
      const sx = width / videoW
      const sy = height / videoH
      material.uniforms.uK.value.set(f.K[0] * sx, f.K[1] * sy, f.K[2] * sx, f.K[3] * sy)
      ;(material.uniforms.uT.value as THREE.Matrix4).fromArray(f.T)
      ;(memoryMaterial.uniforms.uTinv.value as THREE.Matrix4).fromArray(f.T).invert()
      shown.current = { source, k }
    }
    material.uniforms.uVisible.value = 1
  })

  return (
    <>
      <mesh geometry={geometry} material={material} frustumCulled={false} visible={show && timeline !== 'loading'} />
      {memoryGeometry && <points geometry={memoryGeometry} material={memoryMaterial} frustumCulled={false} visible={show} />}
    </>
  )
}

const EMPTY_3D = new THREE.Data3DTexture(new Uint8Array(1), 1, 1, 1)
