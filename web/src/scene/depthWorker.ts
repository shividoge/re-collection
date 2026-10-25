// Off the main thread: inflates one depth v2 chunk (architecture-v3.md §3) and works out, for each
// of its frames, which depth pixels the people replay joins into triangles (gaps.ts). The main
// thread only uploads the packed frame and copies the indices.
import { decodeChunk, browserInflate, type DepthIndex } from '../../../shared/depth'
import { depthChunkMeshes, type DepthMeshOptions } from './depthMesh'

export type DepthWorkerRequest =
  | { kind: 'init'; index: DepthIndex; options: DepthMeshOptions }
  | { kind: 'chunk'; chunk: number; bytes: ArrayBuffer }

export type DepthWorkerReply =
  | { kind: 'chunk'; chunk: number; packed: Uint16Array; indices: Uint16Array[] }
  | { kind: 'error'; chunk: number; message: string }

let index: DepthIndex | null = null
let options: DepthMeshOptions | null = null

self.onmessage = async (e: MessageEvent<DepthWorkerRequest>) => {
  const m = e.data
  if (m.kind === 'init') {
    index = m.index
    options = m.options
    return
  }
  const post = (reply: DepthWorkerReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(reply, transfer)
  try {
    if (!index || !options) throw new Error('depth worker used before init')
    const packed = await decodeChunk(index, m.chunk, new Uint8Array(m.bytes), browserInflate)
    const indices = depthChunkMeshes(packed, index, m.chunk, options)
    post({ kind: 'chunk', chunk: m.chunk, packed, indices }, [packed.buffer, ...indices.map((i) => i.buffer)])
  } catch (err) {
    post({ kind: 'error', chunk: m.chunk, message: err instanceof Error ? err.message : String(err) })
  }
}
