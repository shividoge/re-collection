import { describe, expect, it } from 'vitest'
import { createFetchCache, fileLabel, rangeKey } from '../src/data/fetchCache'

type Call = { url: string; range: string | null; signal: AbortSignal | null }

/** A server holding `files`; answers Range with 206 unless `ignoreRange`. Each answer waits for `release()`. */
function fakeServer(files: Record<string, Uint8Array>, { ignoreRange = false, manual = false } = {}) {
  const calls: Call[] = []
  const pending: (() => void)[] = []
  const fetch = (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>
    const signal = (init.signal ?? null) as AbortSignal | null
    calls.push({ url, range: headers.Range ?? null, signal })
    return new Promise<Response>((resolve, reject) => {
      const answer = () => {
        if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'))
        const body = files[url]
        if (!body) return resolve(new Response('missing', { status: 404 }))
        const m = /^bytes=(\d+)-(\d+)$/.exec(headers.Range ?? '')
        if (m && !ignoreRange) return resolve(new Response(body.slice(Number(m[1]), Number(m[2]) + 1), { status: 206 }))
        resolve(new Response(body.slice(), { status: 200 }))
      }
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      if (manual) pending.push(answer)
      else answer()
    })
  }
  return { fetch, calls, release: () => pending.splice(0).forEach((f) => f()) }
}

const bytes = (n: number, start = 0) => Uint8Array.from({ length: n }, (_, i) => (start + i) % 256)
const arr = (b: ArrayBuffer) => [...new Uint8Array(b)]

describe('fetch cache', () => {
  it('shares one request between concurrent callers and serves repeats from memory', async () => {
    const server = fakeServer({ 'https://r2/a.bin': bytes(10) }, { manual: true })
    const cache = createFetchCache({ fetch: server.fetch })
    const a = cache.fetchBytes('https://r2/a.bin')
    const b = cache.fetchBytes('https://r2/a.bin')
    server.release()
    expect(arr(await a)).toEqual(arr(await b))
    expect(await cache.fetchBytes('https://r2/a.bin')).toBe(await a)
    expect(server.calls).toHaveLength(1)
  })

  it('caches each range under its own key and asks for exactly that range', async () => {
    const server = fakeServer({ 'https://r2/depth.bin': bytes(100) })
    const cache = createFetchCache({ fetch: server.fetch })
    expect(arr(await cache.fetchBytes('https://r2/depth.bin', { range: [10, 5] }))).toEqual([10, 11, 12, 13, 14])
    expect(arr(await cache.fetchBytes('https://r2/depth.bin', { range: [20, 2] }))).toEqual([20, 21])
    await cache.fetchBytes('https://r2/depth.bin', { range: [10, 5] })
    expect(server.calls.map((c) => c.range)).toEqual(['bytes=10-14', 'bytes=20-21'])
    expect(cache.has('https://r2/depth.bin', [10, 5])).toBe(true)
    expect(rangeKey('u', [1, 2])).not.toBe(rangeKey('u', [1, 3]))
  })

  it('answers ranges from a whole file it already has, and keeps a whole file a server sent instead of a range', async () => {
    const server = fakeServer({ 'https://pages/depth.bin': bytes(50) }, { ignoreRange: true })
    const cache = createFetchCache({ fetch: server.fetch })
    expect(arr(await cache.fetchBytes('https://pages/depth.bin', { range: [3, 2] }))).toEqual([3, 4])
    expect(arr(await cache.fetchBytes('https://pages/depth.bin', { range: [40, 3] }))).toEqual([40, 41, 42])
    expect(server.calls).toHaveLength(1)
  })

  it('evicts the least recently used entries once over the byte budget', async () => {
    const server = fakeServer({ 'https://r2/a': bytes(40), 'https://r2/b': bytes(40), 'https://r2/c': bytes(40), 'https://r2/huge': bytes(200) })
    const cache = createFetchCache({ maxBytes: 100, fetch: server.fetch })
    await cache.fetchBytes('https://r2/a')
    await cache.fetchBytes('https://r2/b')
    await cache.fetchBytes('https://r2/a') // a is now the most recent
    await cache.fetchBytes('https://r2/c') // 120 bytes: b goes
    expect(cache.has('https://r2/a')).toBe(true)
    expect(cache.has('https://r2/b')).toBe(false)
    expect(cache.has('https://r2/c')).toBe(true)
    expect(cache.size).toBe(80)
    await cache.fetchBytes('https://r2/huge') // bigger than the whole budget: returned, never cached
    expect(cache.has('https://r2/huge')).toBe(false)
    expect(cache.size).toBe(80)
  })

  it('aborting one caller keeps the download going for the others', async () => {
    const server = fakeServer({ 'https://r2/v': bytes(8) }, { manual: true })
    const cache = createFetchCache({ fetch: server.fetch })
    const stop = new AbortController()
    const first = cache.fetchBytes('https://r2/v', { signal: stop.signal })
    const second = cache.fetchBytes('https://r2/v')
    stop.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(server.calls[0].signal?.aborted).toBe(false)
    server.release()
    expect(arr(await second)).toHaveLength(8)
  })

  it('aborting the only caller cancels the download, and a later request starts afresh', async () => {
    const server = fakeServer({ 'https://r2/v': bytes(8) }, { manual: true })
    const cache = createFetchCache({ fetch: server.fetch })
    const stop = new AbortController()
    const only = cache.fetchBytes('https://r2/v', { signal: stop.signal })
    stop.abort()
    await expect(only).rejects.toMatchObject({ name: 'AbortError' })
    expect(server.calls[0].signal?.aborted).toBe(true)
    const again = cache.fetchBytes('https://r2/v')
    server.release()
    expect(arr(await again)).toHaveLength(8)
    expect(server.calls).toHaveLength(2)
  })

  it('does not cache failures, and says which file failed in plain words', async () => {
    const server = fakeServer({})
    const cache = createFetchCache({ fetch: server.fetch })
    await expect(cache.fetchBytes('https://r2/captures/x/raw/video.mp4?X-Amz-Signature=abc')).rejects.toThrow('Couldn’t download video.mp4 (HTTP 404).')
    await expect(cache.fetchBytes('https://r2/captures/x/raw/video.mp4?X-Amz-Signature=abc')).rejects.toThrow()
    expect(server.calls).toHaveLength(2)
    expect(fileLabel('https://r2/a/keyframes/k0001.jpg?sig')).toBe('k0001.jpg')
  })

  it('reads text through the same cache', async () => {
    const server = fakeServer({ 'https://r2/frames.jsonl': new TextEncoder().encode('{"t":0}\n') })
    const cache = createFetchCache({ fetch: server.fetch })
    expect(await cache.fetchText('https://r2/frames.jsonl')).toBe('{"t":0}\n')
    expect(await cache.fetchText('https://r2/frames.jsonl')).toBe('{"t":0}\n')
    expect(server.calls).toHaveLength(1)
  })
})
