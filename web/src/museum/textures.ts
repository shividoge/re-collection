// The museum's surfaces. The floors, walls, wood, rug, porcelain and window glass are drawn in
// code at build time (src/museum/textureGen.ts, run by web/scripts/bake-museum-textures.ts) and
// shipped as small images, so opening the museum only decodes them, off the main thread. Wall
// text and light pools are drawn here, in the page, as they're needed.

import * as THREE from 'three'

export interface SurfaceMaps {
  map: THREE.Texture
  normalMap: THREE.Texture
  roughnessMap: THREE.Texture
}

type Wrap = 'both' | 'u' | 'none'

/** Every baked image (public/museum/textures/<name>.webp): sRGB color?, how it wraps, anisotropy. */
const BAKED = {
  'floor.map': [true, 'both', 8],
  'floor.normal': [false, 'both', 8],
  'floor.rough': [false, 'both', 8],
  'parquet.map': [true, 'both', 8],
  'parquet.normal': [false, 'both', 8],
  'parquet.rough': [false, 'both', 8],
  'fabric.map': [true, 'both', 8],
  'fabric.normal': [false, 'both', 8],
  'fabric.rough': [false, 'both', 8],
  'wood-grain.map': [true, 'both', 8],
  'wood-grain.normal': [false, 'both', 8],
  'carpet-pile.normal': [false, 'both', 8],
  rug: [true, 'none', 8],
  'porcelain.map': [true, 'u', 8],
  'porcelain.surface': [false, 'u', 1],
  'frosted-glass': [true, 'none', 1],
} as const satisfies Record<string, readonly [boolean, Wrap, number]>

type Baked = keyof typeof BAKED

const textures = new Map<Baked, THREE.Texture>()
let loading: Promise<void> | null = null

/** Loads every baked museum texture once per page (decoded off the main thread); resolves when all are ready. Rejects with a plain message naming the file that failed. */
export function loadMuseumTextures(): Promise<void> {
  loading ??= (async () => {
    // Images have their top row at v = 1; flipping while decoding puts it last, as WebGL wants.
    const loader = new THREE.ImageBitmapLoader().setOptions({ imageOrientation: 'flipY', premultiplyAlpha: 'none' })
    await Promise.all(
      (Object.keys(BAKED) as Baked[]).map(async (name) => {
        const file = `${name}.webp`
        let image: ImageBitmap
        try {
          image = await loader.loadAsync(`${import.meta.env.BASE_URL}museum/textures/${file}`)
        } catch {
          throw new Error(`Couldn't load the museum texture ${file}.`)
        }
        const [srgb, wrap, anisotropy] = BAKED[name]
        const t = new THREE.Texture(image)
        t.flipY = false
        t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
        if (wrap !== 'none') t.wrapS = THREE.RepeatWrapping
        if (wrap === 'both') t.wrapT = THREE.RepeatWrapping
        t.magFilter = THREE.LinearFilter
        t.minFilter = THREE.LinearMipmapLinearFilter
        t.generateMipmaps = true
        t.anisotropy = anisotropy
        t.needsUpdate = true
        textures.set(name, t)
      }),
    )
  })().catch((e: unknown) => {
    loading = null // so a later call can try again
    throw e
  })
  return loading
}

function baked(name: Baked): THREE.Texture {
  const t = textures.get(name)
  if (!t) throw new Error(`Museum texture ${name} isn't loaded: await loadMuseumTextures() first.`)
  return t
}

/** The shared, loaded textures (call after loadMuseumTextures resolved). Callers clone() them to set repeat/rotation; clones share the GPU upload. */
export function museumMaps(name: 'floor' | 'parquet' | 'fabric'): SurfaceMaps {
  return { map: baked(`${name}.map`), normalMap: baked(`${name}.normal`), roughnessMap: baked(`${name}.rough`) }
}

/** Wood grain for panelling and furniture, running along u. */
export function woodGrainMaps(): { map: THREE.Texture; normalMap: THREE.Texture } {
  return { map: baked('wood-grain.map'), normalMap: baked('wood-grain.normal') }
}

/** The fuzz of a wool carpet's pile, as a normal map. */
export function carpetPileNormal(): THREE.Texture {
  return baked('carpet-pile.normal')
}

/** The Persian medallion rug, fringe included (transparent between the threads: use alphaTest). */
export function rugTexture(): THREE.Texture {
  return baked('rug')
}

/** Red-and-gold porcelain: the color map and a surface map (green: roughness, blue: metalness). */
export function porcelainTextures(): { map: THREE.Texture; surface: THREE.Texture } {
  return { map: baked('porcelain.map'), surface: baked('porcelain.surface') }
}

/** Frosted window glass with daylight behind it, for an emissive map. */
export function frostedGlassTexture(): THREE.Texture {
  return baked('frosted-glass')
}

/** Fonts the museum uses for wall text: a warm serif, as printed museum labels are. */
export const SERIF = '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif'
export const SANS = '-apple-system, "Segoe UI", system-ui, sans-serif'

/** Splits `text` into lines no wider than `width` pixels in the context's current font. */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word
    if (ctx.measureText(next).width > width && line) {
      lines.push(line)
      line = word
    } else line = next
  }
  if (line) lines.push(line)
  return lines
}

function canvasTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  return t
}

/**
 * A museum label: title, date and a short caption, set on a card. Returns the texture and the
 * card's aspect (w / h), so it can be sized in meters.
 */
export function labelTexture(title: string, date: string, caption: string, dark: boolean): { texture: THREE.CanvasTexture; aspect: number } {
  const W = 1024
  const pad = 70
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  ctx.font = `600 64px ${SERIF}`
  const titleLines = wrap(ctx, title || 'Untitled', W - pad * 2).slice(0, 3)
  ctx.font = `400 40px ${SERIF}`
  const captionLines = caption ? wrap(ctx, caption, W - pad * 2).slice(0, 6) : []
  const H = pad * 2 + titleLines.length * 76 + (date ? 64 : 0) + (captionLines.length ? 30 + captionLines.length * 54 : 0)
  canvas.width = W
  canvas.height = H
  ctx.fillStyle = dark ? '#1d1719' : '#f7f3ec'
  ctx.fillRect(0, 0, W, H)
  const ink = dark ? '#f2e8dc' : '#231d1a'
  const soft = dark ? '#bfae9f' : '#6d625a'
  let y = pad + 56
  ctx.fillStyle = ink
  ctx.font = `600 64px ${SERIF}`
  for (const line of titleLines) {
    ctx.fillText(line, pad, y)
    y += 76
  }
  if (date) {
    ctx.fillStyle = soft
    ctx.font = `italic 400 42px ${SERIF}`
    ctx.fillText(date, pad, y + 4)
    y += 64
  }
  if (captionLines.length) {
    y += 30
    ctx.fillStyle = ink
    ctx.font = `400 40px ${SERIF}`
    for (const line of captionLines) {
      ctx.fillText(line, pad, y)
      y += 54
    }
  }
  return { texture: canvasTexture(canvas), aspect: W / H }
}

/** The exhibition's title, lettered straight onto the entrance wall (transparent background). */
export function titleTexture(title: string, subtitle: string, ink: string, accent: string): { texture: THREE.CanvasTexture; aspect: number } {
  const W = 2048
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  ctx.font = `400 168px ${SERIF}`
  const lines = wrap(ctx, title, W - 200).slice(0, 2)
  ctx.font = `italic 400 72px ${SERIF}`
  const sub = subtitle ? wrap(ctx, subtitle, W - 300).slice(0, 2) : []
  const H = 120 + lines.length * 190 + 60 + sub.length * 96 + 80
  canvas.width = W
  canvas.height = H
  ctx.textAlign = 'center'
  ctx.fillStyle = ink
  ctx.font = `400 168px ${SERIF}`
  let y = 120 + 150
  for (const line of lines) {
    ctx.fillText(line, W / 2, y)
    y += 190
  }
  ctx.fillStyle = accent
  ctx.fillRect(W / 2 - 90, y - 70, 180, 6)
  y += 40
  ctx.fillStyle = ink
  ctx.globalAlpha = 0.75
  ctx.font = `italic 400 72px ${SERIF}`
  for (const line of sub) {
    ctx.fillText(line, W / 2, y)
    y += 96
  }
  return { texture: canvasTexture(canvas), aspect: W / H }
}

/** A soft pool of light, as a spotlight leaves on a wall: bright in the middle, fading out. */
export function lightPoolTexture(): THREE.CanvasTexture {
  const S = 256
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = S
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)')
  g.addColorStop(0.7, 'rgba(255,255,255,0.12)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, S, S)
  const t = new THREE.CanvasTexture(canvas)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}
