// Depth v2 frames for the people replay, loaded by the second around the playhead: each chunk is
// one Range request of depth.bin (through the page's fetch cache), inflated and meshed in a
// worker (depthWorker.ts). Chunks far from the playhead, behind or ahead, are dropped.
import { chunkOfFrame, type DepthIndex } from '../../../shared/depth'
import { fetchBytes } from '../data'
import type { DepthMeshOptions } from './depthMesh'
import type { DepthWorkerReply, DepthWorkerRequest } from './depthWorker'

export interface DepthFrame {
  /** width × height packed v2 pixels (14-bit mm, 2-bit confidence). */
  packed: Uint16Array
  /** Triangles to draw, as indices into the pixel grid. */
  indices: Uint16Array
}

type Chunk = { packed: Uint16Array; indices: Uint16Array[] }

/** Chunks kept around the playhead's: this many behind and ahead. */
const KEEP_BEHIND = 1
const KEEP_AHEAD = 2

/** Which chunks to keep when the playhead is in chunk `c` (pure, for tests). */
export function keepChunk(chunk: number, c: number): boolean {
  return chunk >= c - KEEP_BEHIND && chunk <= c + KEEP_AHEAD
}

export class DepthSource {
  private chunks = new Map<number, Chunk | 'loading'>()
  private failed = new Set<number>()
  private worker: Worker
  private current = 0
  private disposed = false
  /** Called when a chunk arrives (to render again). */
  onLoad: (() => void) | null = null
  /** Set when a chunk can't be loaded; the replay shows nothing for it. */
  error: string | null = null

  private url: string
  readonly index: DepthIndex

  constructor(url: string, index: DepthIndex, options: DepthMeshOptions) {
    this.url = url
    this.index = index
    this.worker = new Worker(new URL('./depthWorker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent<DepthWorkerReply>) => this.receive(e.data)
    this.worker.onerror = (e) => {
      this.error = e.message || 'The depth worker failed.'
      this.onLoad?.()
    }
    this.post({ kind: 'init', index, options })
  }

  /** Depth frame k if it's loaded; asks for its chunk and the next second's otherwise. */
  frame(k: number): DepthFrame | null {
    if (k < 0 || k >= this.index.count) return null
    const c = chunkOfFrame(this.index, k)
    if (c !== this.current) {
      this.current = c
      for (const key of this.chunks.keys()) if (!keepChunk(key, c)) this.chunks.delete(key)
    }
    this.want(c)
    this.want(chunkOfFrame(this.index, Math.min(this.index.count - 1, k + this.index.framesPerChunk)))
    const chunk = this.chunks.get(c)
    if (!chunk || chunk === 'loading') return null
    const px = this.index.width * this.index.height
    const f = k - c * this.index.framesPerChunk
    return { packed: chunk.packed.subarray(f * px, (f + 1) * px), indices: chunk.indices[f] }
  }

  dispose() {
    this.disposed = true
    this.worker.terminate()
    this.chunks.clear()
  }

  private want(c: number) {
    if (this.chunks.has(c) || this.failed.has(c)) return
    this.chunks.set(c, 'loading')
    const [offset, length] = this.index.chunks[c]
    fetchBytes(this.url, { range: [offset, length] }).then(
      // Posted without transfer: the fetch cache's buffer is shared, so the worker gets a copy.
      (bytes) => !this.disposed && this.post({ kind: 'chunk', chunk: c, bytes }),
      (err: Error) => this.fail(c, err.message),
    )
  }

  private receive(m: DepthWorkerReply) {
    if (m.kind === 'error') return this.fail(m.chunk, m.message)
    // Dropped while it was loading: the playhead has moved on.
    if (this.chunks.get(m.chunk) !== 'loading' || !keepChunk(m.chunk, this.current)) {
      if (this.chunks.get(m.chunk) === 'loading') this.chunks.delete(m.chunk)
      return
    }
    this.chunks.set(m.chunk, { packed: m.packed, indices: m.indices })
    this.onLoad?.()
  }

  private fail(c: number, message: string) {
    this.chunks.delete(c)
    this.failed.add(c)
    this.error = `Depth chunk ${c} didn't load: ${message}`
    this.onLoad?.()
  }

  private post(m: DepthWorkerRequest) {
    this.worker.postMessage(m)
  }
}
