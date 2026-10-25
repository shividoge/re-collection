// depth.bin + confidence.bin (v1) → depth v2 (docs/architecture-v3.md §3), and depth frames
// for the room geometry.
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { decodeChunk, encodeDepthV2, framesOfChunk, packV1, unpack, type DepthIndex } from '../../../shared/depth'
import type { DepthSource } from './room'

/** DEFLATE level: 6 is within a few percent of 9 on depth, at a fraction of the time. */
export const DEFLATE_LEVEL = 6

export const deflate = (raw: Uint8Array) => new Uint8Array(deflateRawSync(raw, { level: DEFLATE_LEVEL }))
export const inflate = (c: Uint8Array) => new Uint8Array(inflateRawSync(c))

const u16 = (b: Uint8Array) => {
  const a = b.byteOffset % 2 === 0 ? b : b.slice()
  return new Uint16Array(a.buffer, a.byteOffset, a.byteLength >> 1)
}

export interface DepthV2 {
  bin: Uint8Array
  index: DepthIndex
  /** Every frame's packed pixels, back to back. */
  packed: Uint16Array
}

export async function fromV1(depth: Uint8Array, confidence: Uint8Array, o: { width: number; height: number; count: number }): Promise<DepthV2> {
  const packed = packV1(u16(depth), confidence)
  const { bin, index } = await encodeDepthV2(packed, o, deflate)
  return { bin, index, packed }
}

export async function fromV2(bin: Uint8Array, index: DepthIndex): Promise<DepthV2> {
  const px = index.width * index.height
  const packed = new Uint16Array(index.count * px)
  for (let c = 0; c < index.chunks.length; c++) {
    const [offset, length] = index.chunks[c]
    const frames = await decodeChunk(index, c, bin.subarray(offset, offset + length), inflate)
    packed.set(frames, framesOfChunk(index, c).first * px)
  }
  return { bin, index, packed }
}

/** Frame k as the geometry reads it: millimeters and confidence. */
export function depthSource(packed: Uint16Array, px: number): DepthSource {
  return (k) => unpack(packed.subarray(k * px, (k + 1) * px))
}
