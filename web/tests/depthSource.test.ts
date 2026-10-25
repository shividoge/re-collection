import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DepthIndex } from '../../shared/depth'
import type { FrameRecord } from '../src/scene/formats'
import type { DepthWorkerReply, DepthWorkerRequest } from '../src/scene/depthWorker'
import { withNote } from '../src/scene/useCaptureScene'

// The Range requests for depth chunks: each test decides which ones fail.
const fetchBytes = vi.fn<(url: string, opts: { range: [number, number] }) => Promise<ArrayBuffer>>()
vi.mock('../src/data', () => ({ fetchBytes: (url: string, opts: { range: [number, number] }) => fetchBytes(url, opts) }))

const { DepthSource, failureNote, retryDelay } = await import('../src/scene/depthSource')

/** Stands in for depthWorker.ts: answers every chunk with empty frames, at once. */
class FakeWorker {
  onmessage: ((e: MessageEvent<DepthWorkerReply>) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  postMessage(m: DepthWorkerRequest) {
    if (m.kind !== 'chunk') return
    const n = 2
    const reply: DepthWorkerReply = { kind: 'chunk', chunk: m.chunk, packed: new Uint16Array(4 * n), indices: Array.from({ length: n }, () => new Uint16Array(0)) }
    queueMicrotask(() => this.onmessage?.({ data: reply } as MessageEvent<DepthWorkerReply>))
  }
  terminate() {}
}

const index: DepthIndex = { format: 'braindance.depth', version: 2, width: 2, height: 2, count: 6, framesPerChunk: 2, chunks: [[0, 10], [10, 10], [20, 10]] }
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('depth chunks that fail', () => {
  let now = 0
  beforeEach(() => {
    now = 0
    vi.stubGlobal('Worker', FakeWorker)
    fetchBytes.mockReset()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('are tried again with backoff, never given up on, and say why meanwhile', async () => {
    let fail = true
    fetchBytes.mockImplementation(async (_url, { range }) => {
      if (range[0] === 10 && fail) throw new Error('HTTP 503')
      return new ArrayBuffer(range[1])
    })
    const source = new DepthSource('depth.bin', index, { poses: [], videoW: 4, videoH: 4, minConfidence: 1, room: null }, () => now)
    let loads = 0
    source.onLoad = () => loads++

    expect(source.frame(2)).toBe(null)
    await settle()
    expect(source.frame(2)).toBe(null)
    expect(source.failure(2)).toMatchObject({ chunk: 1, first: 2, n: 2, attempts: 1, message: 'HTTP 503' })
    // Not again before the backoff is up.
    now = retryDelay(1) - 1
    source.frame(2)
    await settle()
    expect(fetchBytes.mock.calls.filter(([, o]) => o.range[0] === 10)).toHaveLength(1)
    // Due: tried again, fails again, waits longer.
    now = retryDelay(1)
    source.frame(2)
    await settle()
    expect(source.failure(2)?.attempts).toBe(2)
    expect(retryDelay(2)).toBeGreaterThan(retryDelay(1))
    // The storage comes back: the frame loads and the failure is gone.
    fail = false
    now += retryDelay(2)
    source.frame(2)
    await settle()
    expect(source.frame(2)).not.toBe(null)
    expect(source.failure(2)).toBe(null)
    expect(loads).toBeGreaterThan(0)
    source.dispose()
  })

  it('reads as the stretch of the visit the people are missing for', () => {
    const frames: FrameRecord[] = [0, 1, 2, 3].map((d) => ({ t: 12 + d * 0.3, T: [], K: [], d }))
    expect(failureNote(frames, { chunk: 1, first: 2, n: 2, attempts: 1, retryAt: 0, message: 'HTTP 503.' })).toBe("Couldn't load the people for 0:12–0:13. Retrying… (HTTP 503)")
  })
})

describe('live notes', () => {
  it('are kept by key, cleared with null, and unchanged notes keep the same object', () => {
    const a = withNote({}, 'people', 'x')
    expect(a).toEqual({ people: 'x' })
    expect(withNote(a, 'people', 'x')).toBe(a)
    expect(withNote(a, 'keyframes', 'y')).toEqual({ people: 'x', keyframes: 'y' })
    expect(withNote(a, 'people', null)).toEqual({})
    expect(withNote({}, 'people', null)).toEqual({})
  })
})
