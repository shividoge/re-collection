// Draws the museum's surfaces (src/museum/textureGen.ts) and saves them as WebP images in
// public/museum/textures/, which src/museum/textures.ts loads. Run it again after changing a
// generator or a color they use:
//
//   bun web/scripts/bake-museum-textures.ts
//
// Every image has its top row at texture v = 1 (the canvas convention). Color maps are lossy
// (quality 90), normal, roughness and surface maps lossless. The output is the same every run.

import { mkdirSync, writeFileSync } from 'node:fs'
import { createCanvas, ImageData, type Canvas } from '@napi-rs/canvas'
import { planMuseum } from '../src/museum/layout.ts'
import { LOOK } from '../src/museum/looks.ts'
import { carpet, fabric, frostedGlass, imperialPorcelain, persianRug, rugHeight, woodFloor, woodGrain, type PixelMaps } from '../src/museum/textureGen.ts'

const OUT = new URL('../public/museum/textures/', import.meta.url)
mkdirSync(OUT, { recursive: true })

type Ctx = CanvasRenderingContext2D
const LOSSY = 90
const LOSSLESS = 100 // @napi-rs/canvas writes lossless WebP at quality 100

function save(name: string, canvas: Canvas, quality: number) {
  const bytes = canvas.encodeSync('webp', quality)
  writeFileSync(new URL(name, OUT), bytes)
  console.log(`${name.padEnd(24)} ${`${canvas.width}×${canvas.height}`.padEnd(10)} ${(bytes.length / 1024).toFixed(0).padStart(5)} KB`)
}

/** A canvas holding RGBA rows that run bottom-up (a DataTexture's), flipped so the top row is v = 1. */
function fromRows(data: Uint8Array, size: number): Canvas {
  const flipped = new Uint8ClampedArray(data.length)
  const row = size * 4
  for (let y = 0; y < size; y++) flipped.set(data.subarray(y * row, (y + 1) * row), (size - 1 - y) * row)
  const canvas = createCanvas(size, size)
  canvas.getContext('2d').putImageData(new ImageData(flipped, size, size), 0, 0)
  return canvas
}

function surface(name: string, maps: PixelMaps, parts: ('map' | 'normal' | 'rough')[]) {
  if (parts.includes('map')) save(`${name}.map.webp`, fromRows(maps.color, maps.size), LOSSY)
  if (parts.includes('normal')) save(`${name}.normal.webp`, fromRows(maps.normal, maps.size), LOSSLESS)
  if (parts.includes('rough')) save(`${name}.rough.webp`, fromRows(maps.rough, maps.size), LOSSLESS)
}

function draw(w: number, h: number, paint: (ctx: Ctx) => void): Canvas {
  const canvas = createCanvas(w, h)
  paint(canvas.getContext('2d') as unknown as Ctx)
  return canvas
}

/** `canvas` scaled down to w × h with high-quality smoothing. */
function shrink(canvas: Canvas, w: number, h: number): Canvas {
  const out = createCanvas(w, h)
  const ctx = out.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(canvas, 0, 0, w, h)
  return out
}

surface('floor', woodFloor(LOOK.floor.light, LOOK.floor.dark), ['map', 'normal', 'rough'])
surface('parquet', woodFloor([112, 70, 42], [54, 31, 18], 23), ['map', 'normal', 'rough'])
surface('fabric', fabric(LOOK.wall), ['map', 'normal', 'rough'])
surface('wood-grain', woodGrain([108, 66, 42], [48, 27, 17]), ['map', 'normal'])
surface('carpet-pile', carpet([200, 200, 200], 9, 256), ['normal'])

// The rug fills the room less a margin all round; every room is the same size (layout SPEC).
const room = planMuseum(1).rooms[0]
const inset = 0.85
const aspect = (room.x1 - room.x0 - inset * 2) / (room.zFront - room.zBack - inset * 2)
const rug = draw(2048, rugHeight(2048, aspect), (ctx) => persianRug(ctx, 2048, rugHeight(2048, aspect)))
save('rug.webp', shrink(rug, 1024, Math.round(rug.height / 2)), LOSSY)

const porcelain = createCanvas(1024, 1024)
const porcelainSurface = createCanvas(1024, 1024)
imperialPorcelain(porcelain.getContext('2d') as unknown as Ctx, porcelainSurface.getContext('2d') as unknown as Ctx, 1024, 1024)
save('porcelain.map.webp', porcelain, LOSSY)
save('porcelain.surface.webp', shrink(porcelainSurface, 512, 512), LOSSLESS)

save('frosted-glass.webp', draw(256, 512, (ctx) => frostedGlass(ctx, 256, 512)), LOSSY)
