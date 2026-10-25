// The room surface's keyframes as one mipmapped array texture. Each JPEG is decoded and resized
// by the browser (createImageBitmap) and copied straight into its GPU layer: no RGBA copy is kept
// in JS and no pixels pass through React state.
import { useThree } from '@react-three/fiber'
import { useEffect, useState } from 'react'
import * as THREE from 'three'
import { fetchBytes } from '../data'
import { fitSize, jpegSize } from './packs'

/** Long side of a keyframe layer on the GPU. */
export const KEYFRAME_MAX_SIDE = 768

export type KeyframeTextureState = { status: 'none' } | { status: 'loading' } | { status: 'ready'; texture: THREE.DataArrayTexture } | { status: 'failed'; message: string }

/**
 * Loads `urls` (layer i = urls[i]) into an array texture. A missing or broken keyframe fails the
 * whole texture, and the surface then shows its vertex colors: it never shows a wrong picture
 * in a layer.
 */
export function useKeyframeTexture(urls: string[] | null): KeyframeTextureState {
  const gl = useThree((s) => s.gl)
  const invalidate = useThree((s) => s.invalidate)
  const key = urls?.join('\n') ?? ''
  const [state, setState] = useState<{ key: string; value: KeyframeTextureState }>({ key: '', value: { status: 'none' } })

  useEffect(() => {
    if (!urls || urls.length === 0) return
    let cancelled = false
    let texture: THREE.DataArrayTexture | null = null
    setState({ key, value: { status: 'loading' } })
    ;(async () => {
      const first = new Uint8Array(await fetchBytes(urls[0]))
      const natural = jpegSize(first)
      if (!natural) throw new Error(`${urls[0]} isn't a JPEG.`)
      const { width, height } = fitSize(natural.width, natural.height, KEYFRAME_MAX_SIDE)
      const bitmaps = await Promise.all(
        urls.map(async (url) => {
          const blob = new Blob([await fetchBytes(url)], { type: 'image/jpeg' })
          return createImageBitmap(blob, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' })
        }),
      )
      if (cancelled) {
        bitmaps.forEach((b) => b.close())
        return
      }
      const t = new THREE.DataArrayTexture(null, width, height, bitmaps.length)
      t.format = THREE.RGBAFormat
      t.type = THREE.UnsignedByteType
      // sRGB bytes, used as they are (like every other color in the viewer).
      t.colorSpace = THREE.NoColorSpace
      t.minFilter = THREE.LinearMipmapLinearFilter
      t.magFilter = THREE.LinearFilter
      t.anisotropy = Math.min(4, gl.capabilities.getMaxAnisotropy())
      // Allocate storage (with mip levels) without uploading anything; the layers are copied in below.
      t.source.dataReady = false
      t.generateMipmaps = true
      t.needsUpdate = true
      gl.initTexture(t)
      texture = t
      bitmaps.forEach((bitmap, layer) => {
        // Mipmaps once, after the last layer.
        t.generateMipmaps = layer === bitmaps.length - 1
        const src = new THREE.Texture(bitmap)
        gl.copyTextureToTexture(src, t, null, new THREE.Vector3(0, 0, layer))
        bitmap.close()
      })
      t.generateMipmaps = true
      setState({ key, value: { status: 'ready', texture: t } })
      invalidate()
    })().catch((e: Error) => !cancelled && setState({ key, value: { status: 'failed', message: e.message } }))
    return () => {
      cancelled = true
      texture?.dispose()
    }
    // `key` stands for `urls`.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key, gl, invalidate])

  if (!urls || urls.length === 0) return { status: 'none' }
  return state.key === key ? state.value : { status: 'loading' }
}
