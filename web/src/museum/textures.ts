// The museum's surfaces, drawn in code: no image files to download, so the rooms load at
// once and work offline. Each floor and wall gets a color map, a roughness map (polish varies
// across a real floor, which is what makes reflections look real) and a normal map (seams,
// grain and plaster relief catch the light). Everything tiles seamlessly.

import * as THREE from 'three'

/** Small deterministic PRNG (mulberry32), so a room looks the same every time. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Tileable value noise with `period` cells across the texture; returns f(u, v) for u, v in [0, 1). */
function valueNoise(period: number, seed: number) {
  const r = rng(seed)
  const g = new Float32Array(period * period).map(() => r())
  const at = (x: number, y: number) => g[((y % period) + period) % period * period + (((x % period) + period) % period)]
  return (u: number, v: number) => {
    const x = u * period
    const y = v * period
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const fx = x - x0
    const fy = y - y0
    const sx = fx * fx * (3 - 2 * fx)
    const sy = fy * fy * (3 - 2 * fy)
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx
    return a + (b - a) * sy
  }
}

/** Fractal noise: octaves of value noise, each twice as fine and half as strong. Range ~[0, 1]. */
function fbm(period: number, octaves: number, seed: number) {
  const layers = Array.from({ length: octaves }, (_, o) => valueNoise(period << o, seed + o * 101))
  const norm = layers.reduce((s, _, o) => s + 0.5 ** o, 0)
  return (u: number, v: number) => layers.reduce((s, f, o) => s + f(u, v) * 0.5 ** o, 0) / norm
}

/** A normal map from a height field (tileable, so edges wrap). `strength` scales the relief. */
function normalsFrom(height: Float32Array, size: number, strength: number): Uint8Array {
  const out = new Uint8Array(size * size * 4)
  const h = (x: number, y: number) => height[((y + size) % size) * size + ((x + size) % size)]
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * strength
      const dy = (h(x, y + 1) - h(x, y - 1)) * strength
      const len = Math.hypot(dx, dy, 1)
      const k = (y * size + x) * 4
      out[k] = ((-dx / len) * 0.5 + 0.5) * 255
      out[k + 1] = ((dy / len) * 0.5 + 0.5) * 255
      out[k + 2] = ((1 / len) * 0.5 + 0.5) * 255
      out[k + 3] = 255
    }
  return out
}

function dataTexture(data: Uint8Array, size: number, srgb: boolean, repeat: [number, number]): THREE.DataTexture {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(...repeat)
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  t.magFilter = THREE.LinearFilter
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.generateMipmaps = true
  t.anisotropy = 8
  t.needsUpdate = true
  return t
}

export interface SurfaceMaps {
  map: THREE.Texture
  normalMap: THREE.Texture
  roughnessMap: THREE.Texture
}

type RGB = [number, number, number]

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/** Writes one pixel of color, height and roughness. */
function makeBuffers(size: number) {
  return { color: new Uint8Array(size * size * 4), height: new Float32Array(size * size), rough: new Uint8Array(size * size * 4) }
}

function finish(size: number, b: ReturnType<typeof makeBuffers>, relief: number, repeat: [number, number]): SurfaceMaps {
  return {
    map: dataTexture(b.color, size, true, repeat),
    normalMap: dataTexture(normalsFrom(b.height, size, relief), size, false, repeat),
    roughnessMap: dataTexture(b.rough, size, false, repeat),
  }
}

function put(b: ReturnType<typeof makeBuffers>, k: number, c: RGB, height: number, roughness: number) {
  b.color[k * 4] = Math.max(0, Math.min(255, c[0]))
  b.color[k * 4 + 1] = Math.max(0, Math.min(255, c[1]))
  b.color[k * 4 + 2] = Math.max(0, Math.min(255, c[2]))
  b.color[k * 4 + 3] = 255
  b.height[k] = height
  // Roughness lives in the green channel (three.js reads G).
  const r = Math.max(0, Math.min(255, roughness * 255))
  b.rough[k * 4] = r
  b.rough[k * 4 + 1] = r
  b.rough[k * 4 + 2] = r
  b.rough[k * 4 + 3] = 255
}

/**
 * Wooden floor boards. `pattern` 'planks' are long boards in staggered rows (a modern gallery);
 * 'boards' are wide, plain, matte boards with barely visible seams (the calm room: a busy or
 * shiny floor can read as a step, a hole or a wet patch to someone with dementia);
 * 'herringbone' is short blocks at right angles (a classical salon; rotate the texture 45°).
 */
export function woodFloor(pattern: 'planks' | 'boards' | 'herringbone', light: RGB, dark: RGB, seed = 7, size = 1024): SurfaceMaps {
  const b = makeBuffers(size)
  const r = rng(seed)
  const grain = fbm(8, 4, seed + 1)
  const fine = fbm(64, 3, seed + 2)
  const blotch = fbm(4, 3, seed + 3)

  if (pattern === 'planks' || pattern === 'boards') {
    // Rows of boards across the tile, each row split into boards of random length.
    const plain = pattern === 'boards'
    const rows = plain ? 9 : 16
    const rowStarts: number[][] = []
    const tone: number[][] = []
    for (let row = 0; row < rows; row++) {
      const starts: number[] = []
      let u = r() * 0.4
      while (u < 1) {
        starts.push(u)
        u += 0.28 + r() * 0.4
      }
      rowStarts.push(starts)
      tone.push(starts.map(() => r()))
    }
    for (let y = 0; y < size; y++) {
      const v = y / size
      const row = Math.floor(v * rows)
      const inRow = v * rows - row
      for (let x = 0; x < size; x++) {
        const u = x / size
        const starts = rowStarts[row]
        // Which board of the row (boards wrap around the tile).
        let i = starts.length - 1
        for (let s = 0; s < starts.length; s++) if (u >= starts[s]) i = s
        const start = starts[i]
        const along = (u - start + 1) % 1
        const t = tone[row][i]
        // Grain runs along the board: stretched noise plus faint growth rings.
        const g = grain(u * 0.25 + t, v * 4 + row * 0.37)
        const rings = 0.5 + 0.5 * Math.sin((v * rows * 6 + g * 9 + t * 20) * Math.PI)
        const f = fine(u, v)
        // Plain boards: little difference between boards and only a whisper of grain.
        const variety = plain ? 0.35 : 1
        let c = mix(light, dark, 0.15 + 0.5 * t * 0.6 * variety + (g - 0.5) * 0.5 * variety + rings * 0.08 * variety + (blotch(u, v) - 0.5) * 0.25 * variety)
        c = c.map((ch) => ch * (0.94 + f * 0.1)) as RGB
        // Seams: the gap between rows and between board ends.
        const endGap = Math.min(along, 1 - along) * size < 1.5 || Math.abs(u - start) * size < 1.5
        const sideGap = Math.min(inRow, 1 - inRow) * (size / rows) < 1.2
        const seam = endGap || sideGap
        if (seam) c = c.map((ch) => ch * (plain ? 0.82 : 0.45)) as RGB
        const roughness = plain ? 0.78 + f * 0.1 : seam ? 0.85 : 0.3 + (1 - rings) * 0.1 + f * 0.12
        put(b, y * size + x, c, (seam ? (plain ? -0.3 : -1) : 0) + g * (plain ? 0.15 : 0.35) + f * 0.1, roughness)
      }
    }
    return finish(size, b, plain ? 1.2 : 2.2, [1, 1])
  }

  // Herringbone: blocks 1 × k plank widths. Cell (cx, cy) belongs to a horizontal block when
  // (cx − cy) mod 2k < k, else to a vertical one; each block gets its own tone.
  const k = 5
  const cells = 20
  const toneOf = new Map<string, number>()
  const tone = (id: string) => {
    let t = toneOf.get(id)
    if (t === undefined) toneOf.set(id, (t = r()))
    return t
  }
  for (let y = 0; y < size; y++) {
    const py = (y / size) * cells
    const cy = Math.floor(py)
    for (let x = 0; x < size; x++) {
      const px = (x / size) * cells
      const cx = Math.floor(px)
      const d = (((cx - cy) % (2 * k)) + 2 * k) % (2 * k)
      const horizontal = d < k
      let id: string
      let across: number
      let along: number
      if (horizontal) {
        const x0 = cx - d
        id = `h${(x0 + cells) % cells},${cy}`
        across = py - cy
        along = (px - x0) / k
      } else {
        const y0 = cy - (2 * k - 1 - d)
        id = `v${cx},${(y0 + cells) % cells}`
        across = px - cx
        along = (py - y0) / k
      }
      const t = tone(id)
      const g = horizontal ? grain(px / cells * 0.3 + t, py / cells * 3) : grain(px / cells * 3, py / cells * 0.3 + t)
      const f = fine(x / size, y / size)
      let c = mix(light, dark, 0.2 + t * 0.45 + (g - 0.5) * 0.6 + (blotch(x / size, y / size) - 0.5) * 0.2)
      c = c.map((ch) => ch * (0.94 + f * 0.1)) as RGB
      const seam = Math.min(across, 1 - across) * (size / cells) < 1.2 || Math.min(along, 1 - along) * k * (size / cells) < 1.2
      if (seam) c = c.map((ch) => ch * 0.42) as RGB
      put(b, y * size + x, c, (seam ? -1 : 0) + g * 0.3, seam ? 0.85 : 0.22 + f * 0.15)
    }
  }
  return finish(size, b, 2.0, [1, 1])
}

/**
 * Wood grain with no seams, for panelling and furniture: long streaks of grain with faint
 * growth rings and the odd darker figure, running along u.
 */
export function woodGrain(light: RGB, dark: RGB, seed = 21, size = 512): SurfaceMaps {
  const b = makeBuffers(size)
  const streak = fbm(6, 4, seed)
  const figure = fbm(3, 3, seed + 1)
  const fine = fbm(64, 2, seed + 2)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = x / size
      const v = y / size
      // Grain runs along u: stretch the noise that way and bend the rings with it.
      const g = streak(u * 0.15, v)
      const rings = 0.5 + 0.5 * Math.sin((v * 22 + g * 6 + figure(u, v) * 2) * Math.PI)
      const f = fine(u, v)
      const c = mix(light, dark, 0.35 + (g - 0.5) * 0.7 + rings * 0.18 + (f - 0.5) * 0.1)
      put(b, y * size + x, c, g * 0.4 + rings * 0.08, 0.45 + (1 - rings) * 0.08)
    }
  return finish(size, b, 0.8, [1, 1])
}

/** Polished stone: soft clouds of tone, a few darker veins, tiny speckles, high polish. */
export function stoneFloor(base: RGB, vein: RGB, seed = 11, size = 1024): SurfaceMaps {
  const b = makeBuffers(size)
  const cloud = fbm(4, 5, seed)
  const warp = fbm(3, 3, seed + 5)
  const fine = fbm(96, 2, seed + 9)
  const r = rng(seed + 13)
  // Large square slabs, 4 across the tile.
  const slabs = 4
  const slabTone = Array.from({ length: slabs * slabs }, () => r())
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = x / size
      const v = y / size
      const sx = Math.floor(u * slabs)
      const sy = Math.floor(v * slabs)
      const t = slabTone[sy * slabs + sx]
      const w = warp(u, v)
      // Fine veins that come and go (masked by broad noise), as in limestone, not drawn lines.
      const veinLine = Math.abs(Math.sin((u * 2 + v * 1.3 + w * 1.8 + t) * Math.PI * 2))
      const mask = Math.max(0, cloud(v + 0.3, u + t) - 0.55) * 4
      const veinAmount = Math.max(0, 1 - veinLine * 22) * 0.22 * Math.min(1, mask)
      let c = mix(base, vein, (cloud(u + t, v) - 0.5) * 0.6 + 0.15 + veinAmount + (t - 0.5) * 0.15)
      const f = fine(u, v)
      c = c.map((ch) => ch * (0.97 + f * 0.06)) as RGB
      const fu = u * slabs - sx
      const fv = v * slabs - sy
      const seam = Math.min(fu, 1 - fu, fv, 1 - fv) * (size / slabs) < 1.2
      if (seam) c = c.map((ch) => ch * 0.6) as RGB
      put(b, y * size + x, c, (seam ? -0.6 : 0) + f * 0.05, seam ? 0.7 : 0.1 + f * 0.1 + veinAmount * 0.1)
    }
  return finish(size, b, 1.6, [1, 1])
}

/** Painted plaster: a flat color with the faint relief and tone drift of a real wall. */
export function plaster(color: RGB, seed = 3, size = 512): SurfaceMaps {
  const b = makeBuffers(size)
  const broad = fbm(4, 3, seed)
  const relief = fbm(32, 4, seed + 1)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = x / size
      const v = y / size
      const f = relief(u, v)
      const tone = 0.975 + (broad(u, v) - 0.5) * 0.05 + (f - 0.5) * 0.03
      put(b, y * size + x, color.map((ch) => ch * tone) as RGB, f, 0.85 + (f - 0.5) * 0.1)
    }
  return finish(size, b, 1.2, [1, 1])
}

/**
 * Fabric wall covering, as old picture galleries hang: a fine woven texture with faint threads
 * both ways and a soft sheen variation, no printed pattern.
 */
export function fabric(color: RGB, seed = 5, size = 512): SurfaceMaps {
  const b = makeBuffers(size)
  const broad = fbm(4, 3, seed)
  const fuzz = fbm(128, 2, seed + 1)
  const threads = 160
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = x / size
      const v = y / size
      const warp = 0.5 + 0.5 * Math.sin(u * threads * Math.PI * 2)
      const weft = 0.5 + 0.5 * Math.sin(v * threads * Math.PI * 2)
      const weave = (warp * 0.5 + weft * 0.5) * 0.05
      const f = fuzz(u, v)
      const tone = 0.95 + (broad(u, v) - 0.5) * 0.08 + weave + (f - 0.5) * 0.04
      put(b, y * size + x, color.map((ch) => ch * tone) as RGB, weave * 6 + f * 0.3, 0.88 + (f - 0.5) * 0.08)
    }
  return finish(size, b, 0.9, [1, 1])
}

/** A plain wool carpet: one soft color, with the fuzz and faint tufts of real pile. */
export function carpet(color: RGB, seed = 9, size = 512): SurfaceMaps {
  const b = makeBuffers(size)
  const broad = fbm(4, 3, seed)
  const pile = fbm(96, 3, seed + 1)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = x / size
      const v = y / size
      const p = pile(u, v)
      const tone = 0.93 + (broad(u, v) - 0.5) * 0.06 + (p - 0.5) * 0.14
      put(b, y * size + x, color.map((ch) => ch * tone) as RGB, p, 0.97)
    }
  return finish(size, b, 2.5, [1, 1])
}

/**
 * A painted porcelain surface for a vase turned on a lathe: u runs round the vase, v from foot
 * (0) to top (1), so decoration is drawn in horizontal bands.
 * - 'blue-and-white': Chinese export porcelain: cobalt lotus panels, flower scrolls, a key
 *   pattern on the shoulder, a dotted lid.
 * - 'sevres': royal blue ground with gilt lines, and a white reserve on front and back painted
 *   with roses.
 */
export function porcelainTexture(kind: 'blue-and-white' | 'sevres'): THREE.CanvasTexture {
  const W = 1024
  const H = 1024
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  // Canvas y grows downward; v grows upward: v → y = (1 − v)·H.
  const Y = (v: number) => (1 - v) * H
  const r = rng(kind === 'sevres' ? 31 : 29)
  if (kind === 'blue-and-white') {
    const white = '#f3f5f6'
    const cobalt = '#1f3f8f'
    const pale = '#4f6fb8'
    ctx.fillStyle = white
    ctx.fillRect(0, 0, W, H)
    ctx.strokeStyle = cobalt
    ctx.fillStyle = cobalt
    // Foot and neck bands.
    ctx.fillRect(0, Y(0.05), W, Y(0) - Y(0.05))
    ctx.lineWidth = 4
    for (const v of [0.06, 0.3, 0.72, 0.82, 0.86, 0.89]) {
      ctx.beginPath()
      ctx.moveTo(0, Y(v))
      ctx.lineTo(W, Y(v))
      ctx.stroke()
    }
    // Lotus petal panels round the lower body.
    const petals = 12
    for (let i = 0; i < petals; i++) {
      const x0 = (i / petals) * W
      const w = W / petals
      ctx.beginPath()
      ctx.moveTo(x0 + 6, Y(0.07))
      ctx.lineTo(x0 + 6, Y(0.2))
      ctx.quadraticCurveTo(x0 + w / 2, Y(0.33), x0 + w - 6, Y(0.2))
      ctx.lineTo(x0 + w - 6, Y(0.07))
      ctx.stroke()
      ctx.fillStyle = pale
      ctx.beginPath()
      ctx.ellipse(x0 + w / 2, Y(0.14), w * 0.16, (Y(0.07) - Y(0.21)) * 0.3, 0, 0, Math.PI * 2)
      ctx.fill()
    }
    // Flower scrolls: blooms on a winding stem with leaves.
    ctx.strokeStyle = cobalt
    ctx.lineWidth = 5
    ctx.beginPath()
    for (let x = 0; x <= W; x += 8) {
      const v = 0.51 + Math.sin((x / W) * Math.PI * 8) * 0.08
      if (x === 0) ctx.moveTo(x, Y(v))
      else ctx.lineTo(x, Y(v))
    }
    ctx.stroke()
    for (let i = 0; i < 8; i++) {
      const x = ((i + 0.25) / 8) * W
      const v = 0.51 + Math.sin(((i + 0.25) / 8) * Math.PI * 8) * 0.08
      const cx = x
      const cy = Y(v + (i % 2 ? -0.06 : 0.06))
      // A peony: rings of petals round a dark heart.
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2
        ctx.fillStyle = k % 2 ? cobalt : pale
        ctx.beginPath()
        ctx.ellipse(cx + Math.cos(a) * 26, cy + Math.sin(a) * 26, 24, 14, a, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.fillStyle = cobalt
      ctx.beginPath()
      ctx.arc(cx, cy, 14, 0, Math.PI * 2)
      ctx.fill()
      for (const side of [-1, 1]) {
        ctx.fillStyle = pale
        ctx.beginPath()
        ctx.ellipse(cx + side * 62, cy + 30 * side, 26, 9, side * 0.6 + r(), 0, Math.PI * 2)
        ctx.fill()
      }
    }
    // Key (meander) pattern on the shoulder.
    const keyY0 = Y(0.81)
    const keyH = Y(0.73) - Y(0.81)
    ctx.lineWidth = 5
    for (let x = 0; x < W; x += keyH * 1.2) {
      ctx.beginPath()
      ctx.moveTo(x, keyY0 + keyH)
      ctx.lineTo(x, keyY0)
      ctx.lineTo(x + keyH, keyY0)
      ctx.lineTo(x + keyH, keyY0 + keyH * 0.7)
      ctx.lineTo(x + keyH * 0.35, keyY0 + keyH * 0.7)
      ctx.lineTo(x + keyH * 0.35, keyY0 + keyH * 0.35)
      ctx.stroke()
    }
    // The lid: cobalt with white dots.
    ctx.fillStyle = cobalt
    ctx.fillRect(0, 0, W, Y(0.9))
    ctx.fillStyle = white
    for (let i = 0; i < 60; i++) {
      ctx.beginPath()
      ctx.arc(r() * W, r() * Y(0.9), 5, 0, Math.PI * 2)
      ctx.fill()
    }
  } else {
    const blue = '#1c2f78'
    const gilt = '#d9b25e'
    ctx.fillStyle = blue
    ctx.fillRect(0, 0, W, H)
    // A faint glaze pooling: lighter blue in places.
    for (let i = 0; i < 400; i++) {
      ctx.fillStyle = `rgba(80,110,200,${0.03 + r() * 0.04})`
      ctx.beginPath()
      ctx.arc(r() * W, r() * H, 10 + r() * 40, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.fillStyle = gilt
    for (const [v0, v1] of [
      [0, 0.1],
      [0.155, 0.17],
      [0.7, 0.72],
      [0.94, 1],
    ])
      ctx.fillRect(0, Y(v1), W, Y(v0) - Y(v1))
    // Gilt garland dots under the shoulder.
    for (let x = 0; x < W; x += 24) {
      ctx.beginPath()
      ctx.arc(x, Y(0.68), 4, 0, Math.PI * 2)
      ctx.fill()
    }
    // The reserves: white ovals framed in gilt, front (u = 0) and back (u = 0.5), with roses.
    for (const u of [0, 0.5, 1]) {
      const cx = u * W
      const cy = Y(0.43)
      const rx = W * 0.11
      const ry = (Y(0.24) - Y(0.62)) / 2
      ctx.fillStyle = gilt
      ctx.beginPath()
      ctx.ellipse(cx, cy, rx + 10, ry + 10, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#fbf7ef'
      ctx.beginPath()
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
      ctx.fill()
      // A small bouquet: roses and leaves.
      for (const [dx, dy, c] of [
        [0, -10, '#c8425a'],
        [-34, 22, '#e07a8a'],
        [32, 26, '#b8304a'],
        [-6, 46, '#f0a3ad'],
      ] as [number, number, string][]) {
        for (const [lx, ly, a] of [
          [-22, 8, -0.7],
          [22, 10, 0.7],
        ])
          {
            ctx.fillStyle = '#4f7a3a'
            ctx.beginPath()
            ctx.ellipse(cx + dx + lx, cy + dy + ly, 16, 7, a, 0, Math.PI * 2)
            ctx.fill()
          }
        ctx.fillStyle = c
        ctx.beginPath()
        ctx.arc(cx + dx, cy + dy, 17, 0, Math.PI * 2)
        ctx.fill()
        ctx.strokeStyle = 'rgba(90,10,30,0.5)'
        ctx.lineWidth = 3
        ctx.beginPath()
        ctx.arc(cx + dx, cy + dy, 9, 0.5, 5)
        ctx.stroke()
      }
    }
  }
  const t = new THREE.CanvasTexture(canvas)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  t.wrapS = THREE.RepeatWrapping
  return t
}

/**
 * Frosted window glass with daylight behind it: bright, soft, brighter toward the top, with
 * the faint mottling of etched glass. Nothing outside can be seen through it.
 */
export function frostedGlassTexture(): THREE.CanvasTexture {
  const W = 256
  const H = 512
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  const g = ctx.createLinearGradient(0, 0, 0, H)
  g.addColorStop(0, '#fffaf0')
  g.addColorStop(1, '#efe6d8')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)
  const r = rng(41)
  for (let i = 0; i < 1500; i++) {
    ctx.fillStyle = `rgba(255,255,255,${r() * 0.12})`
    ctx.beginPath()
    ctx.arc(r() * W, r() * H, 2 + r() * 6, 0, Math.PI * 2)
    ctx.fill()
  }
  const t = new THREE.CanvasTexture(canvas)
  t.colorSpace = THREE.SRGBColorSpace
  return t
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
