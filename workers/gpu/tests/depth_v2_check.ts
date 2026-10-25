// Cross-check of the Python depth v2 encoder (tools/video2capture/depthv2.py) against
// shared/depth.ts. Run by tools/video2capture/test_depthv2.py:  bun depth_v2_check.ts <dir>
// <dir> holds depth.bin + depth.index.json (from Python) and expected.raw (the packed frames).
// Decodes Python's file with the TS codec and compares, then writes ts.bin + ts.index.json
// (the TS encoding of the same frames, with the same filter) for Python to decode.
import { readFileSync, writeFileSync } from 'node:fs'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { decodeChunk, encodeDepthV2, parseDepthIndex } from '../../../shared/depth'

const dir = process.argv[2]
const index = parseDepthIndex(readFileSync(`${dir}/depth.index.json`, 'utf8'))
const bin = new Uint8Array(readFileSync(`${dir}/depth.bin`))
const raw = readFileSync(`${dir}/expected.raw`)
const expected = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2)
const px = index.width * index.height
for (let c = 0; c < index.chunks.length; c++) {
  const [off, len] = index.chunks[c]
  const frames = await decodeChunk(index, c, bin.subarray(off, off + len), (b) => new Uint8Array(inflateRawSync(b)))
  const start = c * index.framesPerChunk * px
  for (let i = 0; i < frames.length; i++) {
    if (frames[i] !== expected[start + i]) throw new Error(`chunk ${c} pixel ${i}: ${frames[i]} != ${expected[start + i]}`)
  }
}
const ts = await encodeDepthV2(expected.slice(), { width: index.width, height: index.height, count: index.count, framesPerChunk: index.framesPerChunk, filter: index.filter }, (b) => new Uint8Array(deflateRawSync(b)))
writeFileSync(`${dir}/ts.bin`, ts.bin)
writeFileSync(`${dir}/ts.index.json`, JSON.stringify(ts.index))
console.log(`ok: ${index.count} frames in ${index.chunks.length} chunks decoded identically`)
