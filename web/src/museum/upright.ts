// Turning a visit's sideways pictures upright (scene/upright.ts says how far) as they're shown.
import { useEffect, useState } from 'react'
import type { QuarterTurns } from '../scene/pose'

/** `image` (`w` × `h`) drawn turned `turns` quarter turns clockwise, onto `canvas` (or a new one). */
export function turnImage(image: CanvasImageSource, w: number, h: number, turns: QuarterTurns, canvas: HTMLCanvasElement = document.createElement('canvas')): HTMLCanvasElement {
  const odd = turns % 2 === 1
  canvas.width = odd ? h : w
  canvas.height = odd ? w : h
  const ctx = canvas.getContext('2d')!
  ctx.translate(canvas.width / 2, canvas.height / 2)
  ctx.rotate((turns * Math.PI) / 2)
  ctx.drawImage(image, -w / 2, -h / 2, w, h)
  return canvas
}

/**
 * The turn to apply to a picture that's already flipped for a texture (decoded with
 * imageOrientation 'flipY'): flipping top to bottom reverses which way a turn goes, so turning
 * the flipped picture the other way gives the upright picture, flipped.
 */
export const flippedTurns = (turns: QuarterTurns): QuarterTurns => ((4 - turns) % 4) as QuarterTurns

const urls = new Map<string, Promise<string>>()

/** A URL of the picture at `src`, turned upright: `src` itself when it needs no turn. Made once per picture. */
export function uprightUrl(src: string, turns: QuarterTurns): Promise<string> {
  if (!turns) return Promise.resolve(src)
  const key = `${turns}:${src}`
  let url = urls.get(key)
  if (!url) {
    url = (async () => {
      const res = await fetch(src)
      if (!res.ok) throw new Error(`${res.status} loading a picture`)
      const bitmap = await createImageBitmap(await res.blob())
      const canvas = turnImage(bitmap, bitmap.width, bitmap.height, turns)
      bitmap.close()
      const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/jpeg', 0.92))
      if (!blob) throw new Error("Couldn't turn a picture upright.")
      return URL.createObjectURL(blob)
    })()
    // A failure isn't kept, so the next look tries again.
    url.catch(() => urls.delete(key))
    urls.set(key, url)
  }
  return url
}

/** `src` turned upright for an <img>; undefined until it's ready (never shown sideways meanwhile). */
export function useUprightSrc(src: string | undefined, turns: QuarterTurns = 0): string | undefined {
  const [turned, setTurned] = useState<{ key: string; url: string } | null>(null)
  const key = `${turns}:${src ?? ''}`
  useEffect(() => {
    if (!src || !turns) return
    let cancelled = false
    uprightUrl(src, turns).then(
      (url) => !cancelled && setTurned({ key, url }),
      () => {
        /* a picture that can't be loaded stays empty, as a broken image would */
      },
    )
    return () => {
      cancelled = true
    }
  }, [src, turns, key])
  if (!src || !turns) return src
  return turned?.key === key ? turned.url : undefined
}
