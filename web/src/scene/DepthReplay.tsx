import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef, type MutableRefObject } from 'react'
import * as THREE from 'three'

import { fetchRange } from '../api'
import type { Manifest } from '../api'
import type { FrameRecord } from './formats'
import { depthMeshIndices } from './gaps'
import { frameIndexAtTime } from './pose'

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

/**
 * The Braindance effect: each depth frame becomes a 256×192 grid, unprojected into the room
 * with that frame's own camera pose and colored from the video, so the people in the visit
 * replay in 3D, in place, in sync with sound. Neighboring depth pixels on the same surface are
 * joined into triangles (gaps.ts depthMeshIndices), so people and objects read as solid; the
 * jump from a person to the wall behind is never bridged.
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
  minConfidence = 1,
}: {
  captureId: string
  manifest: Manifest
  frames: FrameRecord[]
  video: HTMLVideoElement
  timeRef: MutableRefObject<number>
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
          void main() {
            vUv = (pixel + 0.5) / uGrid;
            float d = texture2D(uDepth, vUv).r;   // meters; unmeasured pixels are never in a triangle
            if (uVisible < 0.5) {
              gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // off screen
              return;
            }
            // Image-camera space (y down, z forward), then ARKit camera space.
            vec3 cam = vec3((pixel.x - uK.z) * d / uK.x, -((pixel.y - uK.w) * d / uK.y), -d);
            gl_Position = projectionMatrix * viewMatrix * (uT * vec4(cam, 1.0));
          }
        `,
        fragmentShader: /* glsl */ `
          uniform sampler2D uVideo;
          varying vec2 vUv;
          void main() {
            gl_FragColor = vec4(texture2D(uVideo, vUv).rgb, 1.0);
          }
        `,
      }),
    [depthTexture, videoTexture, width, height],
  )

  // A paused video never pushes its frame to the GPU on its own, which left the replay black
  // until playback. Upload the current frame whenever one is ready or the video is moved.
  useEffect(() => {
    const refresh = () => {
      if (video.readyState >= 2) videoTexture.needsUpdate = true
    }
    refresh()
    video.addEventListener('loadeddata', refresh)
    video.addEventListener('seeked', refresh)
    return () => {
      video.removeEventListener('loadeddata', refresh)
      video.removeEventListener('seeked', refresh)
    }
  }, [video, videoTexture])

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

  useFrame(() => {
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
      const index = geometry.getIndex()!
      geometry.setDrawRange(0, depthMeshIndices(entry.data, width, height, minConfidence, index.array as Uint32Array))
      index.needsUpdate = true
      const sx = width / manifest.video.width
      const sy = height / manifest.video.height
      material.uniforms.uK.value.set(f.K[0] * sx, f.K[1] * sy, f.K[2] * sx, f.K[3] * sy)
      ;(material.uniforms.uT.value as THREE.Matrix4).fromArray(f.T)
      shown.current = k
      // Drop frames far behind playback so memory stays flat.
      for (const key of cache.current.keys()) if (key < k - 20) cache.current.delete(key)
    }
    material.uniforms.uVisible.value = 1
  })

  return <mesh geometry={geometry} material={material} frustumCulled={false} />
}
