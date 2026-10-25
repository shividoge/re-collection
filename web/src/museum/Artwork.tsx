import { useFrame, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { gilding, ornateFrameGeometry } from './Classic'
import type { Artwork as Art } from './exhibitions'
import { fitPicture, type Slot } from './layout'
import type { Look } from './looks'
import { paintMaterial, setPicture } from './paint'
import { labelTexture, lightPoolTexture } from './textures'

const pool = lightPoolTexture()

/** Videos play while the visitor is this close (m); further away they pause on their frame. */
const PLAY_DISTANCE = 7

type Picture = { texture: THREE.Texture; aspect: number; video: HTMLVideoElement | null }

function loadImage(src: string, done: (p: Picture) => void, failed: () => void): () => void {
  let cancelled = false
  let made: THREE.Texture | null = null
  new THREE.TextureLoader().load(
    src,
    (t) => {
      if (cancelled) return t.dispose()
      t.colorSpace = THREE.SRGBColorSpace
      t.anisotropy = 8
      made = t
      const img = t.image as HTMLImageElement
      done({ texture: t, aspect: img.width / img.height, video: null })
    },
    undefined,
    () => !cancelled && failed(),
  )
  return () => {
    cancelled = true
    made?.dispose()
  }
}

/**
 * A picture's texture and shape (w / h), loaded from its URL; null until it's ready or if it
 * fails. A video shows its poster until it plays, and keeps the poster if this browser can't
 * play it (an HEVC .mov in Chrome, say). Also returns a video's element from the start, so it
 * can be started while its poster is still showing.
 */
function usePicture(art: Art): { picture: Picture | null; video: HTMLVideoElement | null } {
  const [state, setState] = useState<Picture | null>(null)
  const [video, setVideo] = useState<HTMLVideoElement | null>(null)
  useEffect(() => {
    if (art.kind === 'photo') return loadImage(art.src, setState, () => setState(null))
    let cancelled = false
    let videoTexture: THREE.Texture | null = null
    const stopPoster = art.poster ? loadImage(art.poster, (p) => !cancelled && setState((s) => (s?.video ? s : p)), () => {}) : () => {}
    const v = document.createElement('video')
    setVideo(v)
    v.src = art.src
    v.crossOrigin = 'anonymous'
    v.muted = true
    v.loop = true
    v.playsInline = true
    v.preload = 'auto'
    // Swap the poster for the video only once it's actually playing: until then the video
    // texture has no frame on the GPU and would show black. Without a poster, show the video as
    // soon as its first frame is ready.
    const show = () => {
      if (cancelled || videoTexture) return
      const t = new THREE.VideoTexture(v)
      t.colorSpace = THREE.SRGBColorSpace
      videoTexture = t
      setState({ texture: t, aspect: v.videoWidth / v.videoHeight || 16 / 9, video: v })
    }
    v.addEventListener('playing', show, { once: true })
    if (!art.poster) v.addEventListener('loadeddata', show, { once: true })
    return () => {
      cancelled = true
      stopPoster()
      videoTexture?.dispose()
      v.pause()
      v.removeAttribute('src')
      v.load()
      setVideo(null)
    }
  }, [art.kind, art.src, art.poster])
  return { picture: state, video }
}

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
}: {
  art: Art
  slot: Slot
  look: Look
  focused: boolean
  onSelect: (slot: number) => void
  /** Reports the picture's hung size (m), for stepping into it. */
  onMeasure?: (slot: number, w: number, h: number) => void
}) {
  const { picture, video } = usePicture(art)
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
  const frameMaterial = useMemo(
    () =>
      gilded
        ? gilding()
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
  useEffect(() => () => frameMaterial.dispose(), [frameMaterial])
  const ornate = useMemo(() => (gilded ? ornateFrameGeometry(outerW, outerH, border) : null), [gilded, outerW, outerH, border])
  useEffect(() => () => ornate?.dispose(), [ornate])

  // The picture itself, painted (paint.ts), so a snapshot looks at home in a gilded frame.
  const painted = useMemo(() => paintMaterial(), [])
  useEffect(() => () => painted.dispose(), [painted])
  useEffect(() => setPicture(painted, picture?.texture ?? null, aspect), [painted, picture, aspect])

  // Videos play only while the visitor is near (or looking at this one), to spare the device.
  const group = useRef<THREE.Group>(null)
  const playing = useRef(false)
  useFrame(({ camera }) => {
    const v = video
    if (!v || !group.current) return
    const near = focused || camera.position.distanceTo(group.current.position) < PLAY_DISTANCE
    if (near && !playing.current) {
      playing.current = true
      v.play().catch(() => (playing.current = false))
    } else if (!near && playing.current) {
      playing.current = false
      v.pause()
    }
  })

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
    <group ref={group} position={slot.center} rotation={[0, yaw, 0]}>
      {/* The pool of light a picture light leaves on the wall. */}
      <mesh position={[0, 0.12, 0.004]} renderOrder={1}>
        <planeGeometry args={[outerW + 1.1, outerH + 1.3]} />
        <meshBasicMaterial map={pool} color={look.pool} transparent opacity={look.poolStrength * (focused ? 1.25 : 1)} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>

      {ornate ? (
        <mesh geometry={ornate} material={frameMaterial} castShadow />
      ) : (
        // Frame: four rails around the mount.
        [
          [0, outerH / 2 - border / 2, outerW, border],
          [0, -outerH / 2 + border / 2, outerW, border],
          [-outerW / 2 + border / 2, 0, border, outerH - border * 2],
          [outerW / 2 - border / 2, 0, border, outerH - border * 2],
        ].map(([x, y, bw, bh], i) => (
          <mesh key={i} position={[x, y, depth / 2]} material={frameMaterial} castShadow>
            <boxGeometry args={[bw, bh, depth]} />
          </mesh>
        ))
      )}

      {mat > 0 && (
        <mesh position={[0, 0, depth * 0.45]}>
          <planeGeometry args={[w + mat * 2, h + mat * 2]} />
          <meshStandardMaterial color={look.matColor} roughness={0.95} />
        </mesh>
      )}

      <mesh position={[0, 0, depth * 0.47]} onClick={select} onPointerOver={() => (document.body.style.cursor = 'pointer')} onPointerOut={() => (document.body.style.cursor = '')}>
        <planeGeometry args={[w, h]} />
        {picture ? <primitive object={painted} attach="material" /> : <meshStandardMaterial color="#2a2522" roughness={0.9} />}
      </mesh>

      {/* Glass: almost invisible, but it picks up the room's light at an angle. */}
      <mesh position={[0, 0, depth * 0.9]} raycast={() => null}>
        <planeGeometry args={[w + mat * 2, h + mat * 2]} />
        <meshStandardMaterial color="#ffffff" metalness={1} roughness={0.06} transparent opacity={0.07} envMapIntensity={1.4} depthWrite={false} />
      </mesh>

      {/* The label, beside the picture at reading height. */}
      <mesh position={[labelSide * (outerW / 2 + 0.12 + labelW / 2), -0.12 - labelW / label.aspect / 2 + 0.05, 0.006]} onClick={select}>
        <planeGeometry args={[labelW, labelW / label.aspect]} />
        <meshStandardMaterial map={label.texture} roughness={0.8} />
      </mesh>
    </group>
  )
}
