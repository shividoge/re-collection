import { useFrame, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import type { Artwork as Art } from './exhibitions'
import { fitPicture, type Slot } from './layout'
import type { Look } from './looks'
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
 * fails. A video shows its poster until its first frame is ready, and keeps the poster if this
 * browser can't play it (an HEVC .mov in Chrome, say).
 */
function usePicture(art: Art): Picture | null {
  const [state, setState] = useState<Picture | null>(null)
  useEffect(() => {
    if (art.kind === 'photo') return loadImage(art.src, setState, () => setState(null))
    let cancelled = false
    let videoTexture: THREE.Texture | null = null
    const stopPoster = art.poster ? loadImage(art.poster, (p) => !cancelled && setState((s) => (s?.video ? s : p)), () => {}) : () => {}
    const v = document.createElement('video')
    v.src = art.src
    v.crossOrigin = 'anonymous'
    v.muted = true
    v.loop = true
    v.playsInline = true
    v.preload = 'auto'
    v.addEventListener(
      'loadeddata',
      () => {
        if (cancelled) return
        const t = new THREE.VideoTexture(v)
        t.colorSpace = THREE.SRGBColorSpace
        videoTexture = t
        setState({ texture: t, aspect: v.videoWidth / v.videoHeight || 16 / 9, video: v })
      },
      { once: true },
    )
    return () => {
      cancelled = true
      stopPoster()
      videoTexture?.dispose()
      v.pause()
      v.removeAttribute('src')
      v.load()
    }
  }, [art.kind, art.src, art.poster])
  return state
}

/**
 * One framed picture on a wall: frame, card mount, the picture in its own colors (it isn't lit
 * by the room, as a well-lit print looks), a glass front that catches faint reflections, a pool
 * of light on the wall behind, and the label beside it.
 */
export function Artwork({
  art,
  slot,
  look,
  focused,
  onSelect,
}: {
  art: Art
  slot: Slot
  look: Look
  focused: boolean
  onSelect: (slot: number) => void
}) {
  const picture = usePicture(art)
  const aspect = picture?.aspect ?? 4 / 3
  const { w, h } = fitPicture(slot, aspect)
  const { border, depth } = look.frame
  const mat = look.mat
  const outerW = w + mat * 2 + border * 2
  const outerH = h + mat * 2 + border * 2

  const label = useMemo(() => labelTexture(art.title ?? '', art.date ?? '', art.caption ?? '', look.darkLabel), [art.title, art.date, art.caption, look.darkLabel])
  useEffect(() => () => label.texture.dispose(), [label])
  const labelW = 0.26

  const frameMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color: look.frame.color, metalness: look.frame.metalness, roughness: look.frame.roughness, envMapIntensity: 1.3 }),
    [look],
  )
  useEffect(() => () => frameMaterial.dispose(), [frameMaterial])

  // Videos play only while the visitor is near (or looking at this one), to spare the device.
  const group = useRef<THREE.Group>(null)
  const playing = useRef(false)
  useFrame(({ camera }) => {
    const v = picture?.video
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

      {/* Frame: four rails around the mount. */}
      {[
        [0, outerH / 2 - border / 2, outerW, border],
        [0, -outerH / 2 + border / 2, outerW, border],
        [-outerW / 2 + border / 2, 0, border, outerH - border * 2],
        [outerW / 2 - border / 2, 0, border, outerH - border * 2],
      ].map(([x, y, bw, bh], i) => (
        <mesh key={i} position={[x, y, depth / 2]} material={frameMaterial} castShadow>
          <boxGeometry args={[bw, bh, depth]} />
        </mesh>
      ))}
      {/* A gilded frame gets an inner lip, as carved frames have. */}
      {look.frame.metalness > 0.5 &&
        [
          [0, h / 2 + mat + 0.008, w + mat * 2 + 0.016, 0.016],
          [0, -h / 2 - mat - 0.008, w + mat * 2 + 0.016, 0.016],
          [-w / 2 - mat - 0.008, 0, 0.016, h + mat * 2],
          [w / 2 + mat + 0.008, 0, 0.016, h + mat * 2],
        ].map(([x, y, bw, bh], i) => (
          <mesh key={`lip${i}`} position={[x, y, depth * 0.75]} material={frameMaterial}>
            <boxGeometry args={[bw, bh, depth * 0.5]} />
          </mesh>
        ))}

      {mat > 0 && (
        <mesh position={[0, 0, depth * 0.45]}>
          <planeGeometry args={[w + mat * 2, h + mat * 2]} />
          <meshStandardMaterial color={look.matColor} roughness={0.95} />
        </mesh>
      )}

      <mesh position={[0, 0, depth * 0.47]} onClick={select} onPointerOver={() => (document.body.style.cursor = 'pointer')} onPointerOut={() => (document.body.style.cursor = '')}>
        <planeGeometry args={[w, h]} />
        {picture ? <meshBasicMaterial map={picture.texture} toneMapped={false} /> : <meshStandardMaterial color="#2a2522" roughness={0.9} />}
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
