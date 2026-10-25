import { useThree, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import * as THREE from 'three'
import { ornateFrameGeometry } from './Classic'
import type { Artwork as Art } from './exhibitions'
import { fitPicture, type Slot } from './layout'
import type { Look } from './looks'
import { gilding, pool } from './materials'
import { loadPicture, paintInto, paintSize, paintTarget, PHOTO_HEIGHT, VIDEO_HEIGHT } from './painter'
import { acquireVideo, releaseVideo, wantPlaying, type Playlist } from './playback'
import { labelTexture } from './textures'

/** A painted picture ready to hang: its texture and its shape (width / height). */
type Painted = { texture: THREE.Texture; aspect: number }

/** Paints the photo at `src` once; null until it's ready (or if it can't be loaded). */
function usePaintedPhoto(src: string | undefined): Painted | null {
  const gl = useThree((s) => s.gl)
  const invalidate = useThree((s) => s.invalidate)
  const [painted, setPainted] = useState<{ src: string; value: Painted } | null>(null)
  useEffect(() => {
    if (!src) return
    let cancelled = false
    let target: THREE.WebGLRenderTarget | null = null
    loadPicture(src)
      .then(({ texture, width, height }) => {
        if (cancelled) return texture.dispose()
        target = paintTarget(...paintSize(width, height, PHOTO_HEIGHT))
        paintInto(gl, texture, width / height, target)
        texture.dispose()
        setPainted({ src, value: { texture: target.texture, aspect: width / height } })
        invalidate()
      })
      .catch(() => {
        /* a picture that can't be loaded stays a dark canvas, never a stand-in */
      })
    return () => {
      cancelled = true
      target?.dispose()
    }
  }, [src, gl, invalidate])
  return painted && painted.src === src ? painted.value : null
}

/**
 * A video's painting, repainted whenever it shows a new frame while it plays; null until the
 * first frame is painted. Its element is shared with every other piece showing the same file.
 */
function usePaintedVideo(src: string | undefined, hasPoster: boolean, playing: boolean, hz: number): Painted | null {
  const gl = useThree((s) => s.gl)
  const invalidate = useThree((s) => s.invalidate)
  const [video, setVideo] = useState<HTMLVideoElement | null>(null)
  const [painted, setPainted] = useState<Painted | null>(null)
  const target = useRef<THREE.WebGLRenderTarget | null>(null)
  useEffect(() => {
    if (!src) return
    const el = acquireVideo(src, hasPoster)
    setVideo(el)
    return () => {
      setVideo(null)
      setPainted(null)
      target.current?.dispose()
      target.current = null
      releaseVideo(src)
    }
  }, [src, hasPoster])
  useEffect(() => {
    if (!src || !video || !playing) return
    wantPlaying(src, true)
    return () => wantPlaying(src, false)
  }, [src, video, playing])

  // Paint each new frame while it plays (and the first one, for a video without a poster), at
  // most `hz` times a second, from a frame scaled down to the painting's size first (uploading
  // full-size video frames is what costs). When it stops, its last frame stays up.
  useEffect(() => {
    if (!video) return
    const source = new THREE.Texture()
    source.colorSpace = THREE.SRGBColorSpace
    source.generateMipmaps = false
    source.minFilter = THREE.LinearFilter
    source.flipY = false
    let stopped = false
    let busy = false
    let lastPaint = -Infinity
    let frame = 0
    let raf = 0
    const paint = async () => {
      if (stopped || busy || video.readyState < 2 || !video.videoWidth) return
      busy = true
      lastPaint = performance.now()
      const aspect = video.videoWidth / video.videoHeight
      const [w, h] = paintSize(video.videoWidth, video.videoHeight, VIDEO_HEIGHT)
      try {
        const bitmap = await createImageBitmap(video, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium', imageOrientation: 'flipY' })
        if (stopped) return bitmap.close()
        const previous = source.image as ImageBitmap | null
        source.image = bitmap
        source.needsUpdate = true
        let t = target.current
        if (!t || t.width !== w || t.height !== h) {
          t?.dispose()
          t = target.current = paintTarget(w, h)
          setPainted({ texture: t.texture, aspect })
        }
        paintInto(gl, source, aspect, t)
        previous?.close()
        invalidate()
      } catch {
        /* a frame that can't be read is skipped */
      } finally {
        busy = false
      }
    }
    const due = () => performance.now() - lastPaint >= 1000 / hz
    const onFrame = () => {
      if (due()) void paint()
      if (!stopped) frame = video.requestVideoFrameCallback(onFrame)
    }
    // Without frame callbacks (older browsers), look for a new frame on each animation frame.
    let last = -1
    const poll = () => {
      if (video.currentTime !== last && due()) {
        last = video.currentTime
        void paint()
      }
      if (!stopped) raf = requestAnimationFrame(poll)
    }
    const first = () => void paint()
    if (playing) {
      if ('requestVideoFrameCallback' in video) frame = video.requestVideoFrameCallback(onFrame)
      else raf = requestAnimationFrame(poll)
    } else if (!hasPoster && !target.current) {
      if (video.readyState >= 2) first()
      else video.addEventListener('loadeddata', first, { once: true })
    }
    return () => {
      stopped = true
      if ('cancelVideoFrameCallback' in video) video.cancelVideoFrameCallback(frame)
      cancelAnimationFrame(raf)
      video.removeEventListener('loadeddata', first)
      ;(source.image as ImageBitmap | null)?.close?.()
      source.dispose()
    }
  }, [video, playing, hasPoster, hz, gl, invalidate])
  return painted
}

const placeholder = new THREE.MeshStandardMaterial({ color: '#2a2522', roughness: 0.9 })
const glass = new THREE.MeshStandardMaterial({ color: '#ffffff', metalness: 1, roughness: 0.06, transparent: true, opacity: 0.07, envMapIntensity: 1.4, depthWrite: false })
const noRaycast = () => null

/**
 * One framed picture on a wall: frame, card mount, the picture painted as an old oil (paint.ts;
 * it isn't lit by the room, as a well-lit painting looks), a glass front that catches faint reflections, a pool
 * of light on the wall behind, and the label beside it.
 */
export function Artwork({
  art,
  slot,
  look,
  focused,
  onSelect,
  onMeasure,
  playlist,
}: {
  art: Art
  slot: Slot
  look: Look
  focused: boolean
  onSelect: (slot: number) => void
  /** Reports the picture's hung size (m), for stepping into it. */
  onMeasure?: (slot: number, w: number, h: number) => void
  /** Which videos play (MuseumScene decides); none play without one. */
  playlist?: Playlist
}) {
  const isVideo = art.kind === 'video'
  const playing = useSyncExternalStore(playlist?.subscribe ?? noSubscribe, () => playlist?.has(slot.index) ?? false)
  const still = usePaintedPhoto(isVideo ? art.poster : art.src)
  // The piece in focus is repainted at full video pace; a neighbour playing nearby, at half.
  const moving = usePaintedVideo(isVideo ? art.src : undefined, Boolean(art.poster), playing, focused ? 30 : 15)
  // A video shows its poster until its first frame is painted, and keeps its poster if this
  // browser can't play it (an HEVC .mov in Chrome, say).
  const picture = moving ?? still
  const aspect = picture?.aspect ?? 4 / 3
  const { w, h } = fitPicture(slot, aspect)
  useEffect(() => {
    onMeasure?.(slot.index, w, h)
  }, [onMeasure, slot.index, w, h])
  const { border, depth } = look.frame
  const mat = look.mat
  const outerW = w + mat * 2 + border * 2
  const outerH = h + mat * 2 + border * 2

  const label = useMemo(() => labelTexture(art.title ?? '', art.date ?? '', art.caption ?? '', look.darkLabel), [art.title, art.date, art.caption, look.darkLabel])
  useEffect(() => () => label.texture.dispose(), [label])
  const labelW = 0.34

  // Gilded frames are carved (ornate profile, one mesh); the others are plain rails.
  const gilded = look.frame.metalness > 0.5
  const plainFrame = useMemo(
    () =>
      gilded
        ? null
        : new THREE.MeshPhysicalMaterial({
            color: look.frame.color,
            metalness: look.frame.metalness,
            roughness: look.frame.roughness,
            // A thin varnish, so wooden and painted frames catch a soft highlight.
            clearcoat: 0.4,
            clearcoatRoughness: 0.3,
            envMapIntensity: 1.3,
          }),
    [look, gilded],
  )
  useEffect(() => () => plainFrame?.dispose(), [plainFrame])
  const frameMaterial = plainFrame ?? gilding()
  const ornate = useMemo(() => (gilded ? ornateFrameGeometry(outerW, outerH, border) : null), [gilded, outerW, outerH, border])
  useEffect(() => () => ornate?.dispose(), [ornate])

  // The picture, already painted (painter.ts): shown in its own light, like a well-lit painting.
  const pictureMaterial = useMemo(() => (picture ? new THREE.MeshBasicMaterial({ map: picture.texture, toneMapped: false }) : null), [picture])
  useEffect(() => () => pictureMaterial?.dispose(), [pictureMaterial])
  const poolMaterial = useMemo(
    () => new THREE.MeshBasicMaterial({ map: pool(), color: look.pool, transparent: true, opacity: look.poolStrength, blending: THREE.AdditiveBlending, depthWrite: false }),
    [look],
  )
  useEffect(() => () => poolMaterial.dispose(), [poolMaterial])
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    poolMaterial.opacity = look.poolStrength * (focused ? 1.25 : 1)
    invalidate()
  }, [poolMaterial, look, focused, invalidate])
  const matMaterial = useMemo(() => new THREE.MeshStandardMaterial({ color: look.matColor, roughness: 0.95 }), [look])
  useEffect(() => () => matMaterial.dispose(), [matMaterial])
  const labelMaterial = useMemo(() => new THREE.MeshStandardMaterial({ map: label.texture, roughness: 0.8 }), [label])
  useEffect(() => () => labelMaterial.dispose(), [labelMaterial])

  const select = (e: ThreeEvent<MouseEvent>) => {
    // A drag to look around isn't a tap.
    if (e.delta > 8) return
    e.stopPropagation()
    onSelect(slot.index)
  }

  const yaw = Math.atan2(slot.normal[0], slot.normal[1])
  // Labels go to the right, except beside a doorway on its left, where they go to the left.
  const labelSide = slot.normal[1] !== 0 && slot.center[0] < 0 ? -1 : 1
  return (
    <group position={slot.center} rotation={[0, yaw, 0]}>
      {/* The pool of light a picture light leaves on the wall. */}
      <mesh position={[0, 0.12, 0.004]} renderOrder={1} material={poolMaterial}>
        <planeGeometry args={[outerW + 1.1, outerH + 1.3]} />
      </mesh>

      {ornate ? (
        <mesh geometry={ornate} material={frameMaterial} />
      ) : (
        // Frame: four rails around the mount.
        [
          [0, outerH / 2 - border / 2, outerW, border],
          [0, -outerH / 2 + border / 2, outerW, border],
          [-outerW / 2 + border / 2, 0, border, outerH - border * 2],
          [outerW / 2 - border / 2, 0, border, outerH - border * 2],
        ].map(([x, y, bw, bh], i) => (
          <mesh key={i} position={[x, y, depth / 2]} material={frameMaterial}>
            <boxGeometry args={[bw, bh, depth]} />
          </mesh>
        ))
      )}

      {mat > 0 && (
        <mesh position={[0, 0, depth * 0.45]} material={matMaterial}>
          <planeGeometry args={[w + mat * 2, h + mat * 2]} />
        </mesh>
      )}

      <mesh
        position={[0, 0, depth * 0.47]}
        material={pictureMaterial ?? placeholder}
        onClick={select}
        onPointerOver={() => (document.body.style.cursor = 'pointer')}
        onPointerOut={() => (document.body.style.cursor = '')}
      >
        <planeGeometry args={[w, h]} />
      </mesh>

      {/* Glass: almost invisible, but it picks up the room's light at an angle. */}
      <mesh position={[0, 0, depth * 0.9]} raycast={noRaycast} material={glass}>
        <planeGeometry args={[w + mat * 2, h + mat * 2]} />
      </mesh>

      {/* The label, beside the picture at reading height. */}
      <mesh position={[labelSide * (outerW / 2 + 0.12 + labelW / 2), -0.12 - labelW / label.aspect / 2 + 0.05, 0.006]} onClick={select} material={labelMaterial}>
        <planeGeometry args={[labelW, labelW / label.aspect]} />
      </mesh>
    </group>
  )
}

const noSubscribe = () => () => {}
