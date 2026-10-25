// One byte cache for the page's lifetime, shared by every view (capture view, museum step-in,
// Memory Window, front page). Files are immutable per URL (architecture-v3.md §2: a new rev means
// a new URL), so nothing here ever needs revalidating.
// - Concurrent requests for the same URL (and range) share one fetch.
// - LRU by bytes: the least recently used entries go once the total passes `maxBytes`.
// - A range is cached under its own key; a whole file already cached also answers its ranges.
// - Aborting one caller only stops the fetch when no other caller is still waiting for it.
// Returned buffers are shared between callers: never transfer or write into one; copy it first.

import type { FetchBytes } from './assets'

export type Range = [start: number, length: number]
type Init = { range?: Range; signal?: AbortSignal }
type Fetch = (url: string, init: RequestInit) => Promise<Response>

export const rangeKey = (url: string, range?: Range): string => (range ? `${url}#bytes=${range[0]}+${range[1]}` : url)

/** Plain-language name of the file a URL points at, for error messages. */
export function fileLabel(url: string): string {
  try {
    const path = new URL(url, 'http://x/').pathname
    return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)) || 'a file'
  } catch {
    return 'a file'
  }
}

const abortError = () => new DOMException('The request was cancelled.', 'AbortError')

type Inflight = { promise: Promise<ArrayBuffer>; waiting: number; controller: AbortController }

export interface FetchCache {
  fetchBytes: FetchBytes
  fetchText(url: string, init?: { signal?: AbortSignal }): Promise<string>
  /** Bytes held now (for tests and a debug overlay). */
  readonly size: number
  has(url: string, range?: Range): boolean
  clear(): void
}

export function createFetchCache({ maxBytes = 512 * 1024 * 1024, fetch: doFetch = (u, i) => fetch(u, i) }: { maxBytes?: number; fetch?: Fetch } = {}): FetchCache {
  // A Map keeps insertion order: re-inserting on use makes its first key the least recently used.
  const entries = new Map<string, ArrayBuffer>()
  const inflight = new Map<string, Inflight>()
  let size = 0

  const touch = (key: string): ArrayBuffer | undefined => {
    const hit = entries.get(key)
    if (hit === undefined) return undefined
    entries.delete(key)
    entries.set(key, hit)
    return hit
  }

  const store = (key: string, bytes: ArrayBuffer) => {
    if (bytes.byteLength > maxBytes) return
    const old = entries.get(key)
    if (old) size -= old.byteLength
    entries.delete(key)
    entries.set(key, bytes)
    size += bytes.byteLength
    for (const [k, v] of entries) {
      if (size <= maxBytes) break
      entries.delete(k)
      size -= v.byteLength
    }
  }

  async function load(url: string, range: Range | undefined, signal: AbortSignal): Promise<ArrayBuffer> {
    const headers: Record<string, string> = range ? { Range: `bytes=${range[0]}-${range[0] + range[1] - 1}` } : {}
    let response: Response
    try {
      response = await doFetch(url, { headers, signal })
    } catch (error) {
      if (signal.aborted) throw abortError()
      throw new Error(`Couldn’t download ${fileLabel(url)}. Check the connection and try again.`, { cause: error })
    }
    if (!response.ok) throw new Error(`Couldn’t download ${fileLabel(url)} (HTTP ${response.status}).`)
    const bytes = await response.arrayBuffer()
    if (!range) return bytes
    // A server that ignores Range sends the whole file (200): keep it whole, and answer from it.
    if (response.status !== 206) {
      store(url, bytes)
      return bytes.slice(range[0], range[0] + range[1])
    }
    return bytes
  }

  const fetchBytes: FetchBytes = (url, init: Init = {}) => {
    const { range, signal } = init
    if (signal?.aborted) return Promise.reject(abortError())
    const key = rangeKey(url, range)
    const hit = touch(key)
    if (hit) return Promise.resolve(hit)
    if (range) {
      const whole = touch(url)
      if (whole) return Promise.resolve(whole.slice(range[0], range[0] + range[1]))
    }

    let flight = inflight.get(key)
    if (!flight) {
      const controller = new AbortController()
      const promise = load(url, range, controller.signal).then(
        (bytes) => {
          if (inflight.get(key) === flight) inflight.delete(key)
          store(key, bytes)
          return bytes
        },
        (error: unknown) => {
          if (inflight.get(key) === flight) inflight.delete(key)
          throw error
        },
      )
      flight = { promise, waiting: 0, controller }
      inflight.set(key, flight)
    }
    const shared = flight
    shared.waiting += 1
    if (!signal) return shared.promise.finally(() => void (shared.waiting -= 1))

    return new Promise<ArrayBuffer>((resolve, reject) => {
      let settled = false
      const leave = () => {
        if (settled) return false
        settled = true
        shared.waiting -= 1
        signal.removeEventListener('abort', onAbort)
        return true
      }
      const onAbort = () => {
        if (!leave()) return
        // Nobody else wants it: stop downloading.
        if (shared.waiting === 0) {
          shared.controller.abort()
          if (inflight.get(key) === shared) inflight.delete(key)
        }
        reject(abortError())
      }
      signal.addEventListener('abort', onAbort)
      shared.promise.then(
        (bytes) => leave() && resolve(bytes),
        (error: unknown) => leave() && reject(error),
      )
    })
  }

  return {
    fetchBytes,
    fetchText: async (url, init) => new TextDecoder().decode(await fetchBytes(url, init)),
    get size() {
      return size
    },
    has: (url, range) => entries.has(rangeKey(url, range)),
    clear() {
      entries.clear()
      size = 0
    },
  }
}
