// Depth v2: 14-bit millimeters + 2-bit confidence per pixel, chunked raw DEFLATE
// (docs/architecture-v3.md §3). Compression is injected so this file stays dependency-free and
// works in the browser (DecompressionStream), Bun/Node (zlib) and tests alike.

export interface DepthIndex {
  format: 'braindance.depth'
  version: 2
  width: number
  height: number
  count: number
  framesPerChunk: number
  /** [byteOffset, byteLength] of each chunk in depth.bin. */
  chunks: [number, number][]
  /** Applied to the pixels before compression; absent = none. */
  filter?: DepthFilter
}

/**
 * `row-delta`: in every row, each pixel after the first is stored as its difference from the
 * pixel to its left, mod 65536. Neighboring depth is close, so this compresses ~40% smaller.
 */
export type DepthFilter = 'row-delta'

/** Applies (or with `undo`, reverses) the row-delta filter in place on rows of `width` pixels. */
export function rowDelta(pixels: Uint16Array, width: number, undo = false): Uint16Array {
  for (let row = 0; row < pixels.length; row += width) {
    if (undo) for (let i = row + 1; i < row + width; i++) pixels[i] = (pixels[i] + pixels[i - 1]) & 0xffff
    else for (let i = row + width - 1; i > row; i--) pixels[i] = (pixels[i] - pixels[i - 1]) & 0xffff
  }
  return pixels
}

export type Deflate = (raw: Uint8Array) => Uint8Array | Promise<Uint8Array>
export type Inflate = (compressed: Uint8Array) => Uint8Array | Promise<Uint8Array>

export const MAX_MM = 0x3fff

/** Packs one pixel. */
export function packPixel(mm: number, confidence: number): number {
  return (Math.min(mm, MAX_MM) & MAX_MM) | ((confidence & 3) << 14)
}

export function pixelMm(value: number): number {
  return value & MAX_MM
}

export function pixelConfidence(value: number): number {
  return value >>> 14
}

/** v1 depth (UInt16 mm) + confidence (UInt8) frames → packed v2 frames, same layout. */
export function packV1(depth: Uint16Array, confidence: Uint8Array): Uint16Array {
  if (depth.length !== confidence.length) throw new Error('depth and confidence must have the same number of pixels.')
  const out = new Uint16Array(depth.length)
  for (let i = 0; i < depth.length; i++) out[i] = packPixel(depth[i], confidence[i])
  return out
}

/** Splits packed frames into separate depth (mm) and confidence arrays (the v1 shapes). */
export function unpack(packed: Uint16Array): { depth: Uint16Array; confidence: Uint8Array } {
  const depth = new Uint16Array(packed.length)
  const confidence = new Uint8Array(packed.length)
  for (let i = 0; i < packed.length; i++) {
    depth[i] = packed[i] & MAX_MM
    confidence[i] = packed[i] >>> 14
  }
  return { depth, confidence }
}

export function chunkOfFrame(index: DepthIndex, frame: number): number {
  if (frame < 0 || frame >= index.count) throw new RangeError(`Depth frame ${frame} is out of range (0–${index.count - 1}).`)
  return Math.floor(frame / index.framesPerChunk)
}

/** Frames [first, first + n) that chunk c holds. */
export function framesOfChunk(index: DepthIndex, c: number): { first: number; n: number } {
  const first = c * index.framesPerChunk
  return { first, n: Math.min(index.framesPerChunk, index.count - first) }
}

/** Packed frames (count × width × height) → depth.bin bytes + index. */
export async function encodeDepthV2(
  packed: Uint16Array,
  o: { width: number; height: number; count: number; framesPerChunk?: number; filter?: DepthFilter },
  deflate: Deflate,
): Promise<{ bin: Uint8Array; index: DepthIndex }> {
  const px = o.width * o.height
  if (packed.length !== px * o.count) throw new Error(`Expected ${px * o.count} pixels, got ${packed.length}.`)
  const fpc = o.framesPerChunk ?? 10
  const parts: Uint8Array[] = []
  const chunks: [number, number][] = []
  let offset = 0
  for (let first = 0; first < o.count; first += fpc) {
    const n = Math.min(fpc, o.count - first)
    let pixels = packed.subarray(first * px, (first + n) * px)
    if (o.filter === 'row-delta') pixels = rowDelta(pixels.slice(), o.width)
    const c = await deflate(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength))
    parts.push(c)
    chunks.push([offset, c.byteLength])
    offset += c.byteLength
  }
  const bin = new Uint8Array(offset)
  let at = 0
  for (const p of parts) {
    bin.set(p, at)
    at += p.byteLength
  }
  const index: DepthIndex = { format: 'braindance.depth', version: 2, width: o.width, height: o.height, count: o.count, framesPerChunk: fpc, chunks }
  if (o.filter) index.filter = o.filter
  return { bin, index }
}

/** One chunk's compressed bytes → its packed frames. */
export async function decodeChunk(index: DepthIndex, c: number, compressed: Uint8Array, inflate: Inflate): Promise<Uint16Array> {
  const { n } = framesOfChunk(index, c)
  const raw = await inflate(compressed)
  const expected = n * index.width * index.height * 2
  if (raw.byteLength !== expected) throw new Error(`Depth chunk ${c} decompressed to ${raw.byteLength} bytes, expected ${expected}.`)
  const aligned = raw.byteOffset % 2 === 0 ? raw : raw.slice()
  const pixels = new Uint16Array(aligned.buffer, aligned.byteOffset, expected / 2)
  return index.filter === 'row-delta' ? rowDelta(pixels, index.width, true) : pixels
}

export function parseDepthIndex(json: string): DepthIndex {
  const x = JSON.parse(json) as DepthIndex
  if (x.format !== 'braindance.depth' || x.version !== 2) throw new Error('depth.index.json is not a braindance depth v2 index.')
  if (!Array.isArray(x.chunks) || x.chunks.length !== Math.ceil(x.count / x.framesPerChunk)) throw new Error('depth.index.json has the wrong number of chunks.')
  if (x.filter !== undefined && x.filter !== 'row-delta') throw new Error(`depth.index.json has an unknown filter "${String(x.filter)}".`)
  return x
}

/** Browser inflate (Safari 16.4+, Chrome 103+). */
export const browserInflate: Inflate = async (compressed) => {
  const stream = new Blob([compressed as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
