// Depth v2 frames for the people replay, loaded by the second around the playhead: each chunk is
// one Range request of depth.bin (through the page's fetch cache), inflated and meshed in a
// worker (depthWorker.ts). Chunks far from the playhead, behind or ahead, are dropped. A chunk
// that fails is tried again with backoff (never given up on) and the viewer says so meanwhile.
import { chunkOfFrame, framesOfChunk, type DepthIndex } from '../../../shared/depth'
import { fetchBytes } from '../data'
import type { DepthMeshOptions } from './depthMesh'
import type { FrameRecord } from './formats'
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

/** A failed chunk is tried again after 1 s, then 2, 4, 8, and every 15 s after that. */
export const retryDelay = (attempts: number): number => Math.min(15_000, 1000 * 2 ** (attempts - 1))

/** A chunk that didn't load: depth frames `first`…`first + n − 1`, tried again from `retryAt` (ms). */
export type ChunkFailure = { chunk: number; first: number; n: number; attempts: number; retryAt: number; message: string }

export class DepthSource {
  private chunks = new Map<number, Chunk | 'loading'>()
  private failures = new Map<number, ChunkFailure>()
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private worker: Worker
  private current = 0
  private disposed = false
  /** Called when a chunk arrives or fails, and when a failed one is due again (to render again). */
  onLoad: (() => void) | null = null
  /** Set when the depth worker itself fails: the replay can't show anything any more. */
  error: string | null = null
  private readonly now: () => number

  private url: string
  readonly index: DepthIndex

  constructor(url: string, index: DepthIndex, options: DepthMeshOptions, now: () => number = () => performance.now()) {
    this.now = now
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
      // Coming back to a chunk that failed earlier tries it again at once.
      for (const key of this.failures.keys()) if (!keepChunk(key, c)) this.failures.delete(key)
    }
    this.want(c)
    this.want(chunkOfFrame(this.index, Math.min(this.index.count - 1, k + this.index.framesPerChunk)))
    const chunk = this.chunks.get(c)
    if (!chunk || chunk === 'loading') return null
    const px = this.index.width * this.index.height
    const f = k - c * this.index.framesPerChunk
    return { packed: chunk.packed.subarray(f * px, (f + 1) * px), indices: chunk.indices[f] }
  }

  /** Why depth frame k isn't loaded, if its chunk failed (it's being tried again). */
  failure(k: number): ChunkFailure | null {
    if (k < 0 || k >= this.index.count) return null
    return this.failures.get(chunkOfFrame(this.index, k)) ?? null
  }

  dispose() {
    this.disposed = true
    this.worker.terminate()
    this.chunks.clear()
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
  }

  private want(c: number) {
    if (this.chunks.has(c)) return
    const failure = this.failures.get(c)
    if (failure && this.now() < failure.retryAt) return
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
    this.failures.delete(m.chunk)
    this.onLoad?.()
  }

  private fail(c: number, message: string) {
    if (this.disposed) return
    this.chunks.delete(c)
    const attempts = (this.failures.get(c)?.attempts ?? 0) + 1
    const delay = retryDelay(attempts)
    this.failures.set(c, { chunk: c, ...framesOfChunk(this.index, c), attempts, retryAt: this.now() + delay, message })
    // Render again when it's due, so a paused view tries again too.
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (!this.disposed) this.onLoad?.()
    }, delay)
    this.timers.add(timer)
    this.onLoad?.()
  }

  private post(m: DepthWorkerRequest) {
    this.worker.postMessage(m)
  }
}

/** "Couldn't load the people for 0:12–0:13. Retrying…": the failed chunk as visit times. */
export function failureNote(frames: FrameRecord[], f: ChunkFailure): string {
  const times = frames.filter((r) => r.d !== null && r.d >= f.first && r.d < f.first + f.n).map((r) => r.t)
  const span = times.length ? `${clock(Math.floor(Math.min(...times)))}–${clock(Math.ceil(Math.max(...times)))}` : `depth frames ${f.first}–${f.first + f.n - 1}`
  return `Couldn't load the people for ${span}. Retrying… (${trimStop(f.message)})`
}

const clock = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

/** A reason without its closing period, to sit inside parentheses. */
export const trimStop = (message: string): string => message.replace(/\.\s*$/, '')
