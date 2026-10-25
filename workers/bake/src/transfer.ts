// Downloads from and uploads to presigned R2 URLs, with retries. `fetch` is injectable for tests.
import { open, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { UploadTarget } from '../../../backend/convex/validators'

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>

/** A transfer that failed; worth retrying the job later (a network blip, an expired URL). */
export class TransferError extends Error {}

export interface RetryOptions {
  attempts?: number
  /** First wait between attempts, doubled each time. */
  backoffMs?: number
  signal?: AbortSignal
  fetch?: Fetch
  /** Overrides transferTimeoutMs (tests). */
  timeoutMs?: number
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true })
  })

/**
 * How long one try of a transfer may take before it's abandoned and retried: a stalled
 * connection (it happens when the uplink is saturated) otherwise hangs the job forever while
 * its heartbeat keeps the lease alive. Assumes at least ~4 Mbit/s, plus 30 s of slack.
 */
export const transferTimeoutMs = (bytes: number) => 30_000 + Math.ceil(bytes / 512_000) * 1000

async function withRetry<T>(what: string, o: RetryOptions, bytes: number, run: (fetch: Fetch) => Promise<T>): Promise<T> {
  const attempts = o.attempts ?? 4
  const base = o.fetch ?? fetch
  let last: unknown
  for (let a = 0; a < attempts; a++) {
    o.signal?.throwIfAborted()
    if (a > 0) await wait((o.backoffMs ?? 1000) * 2 ** (a - 1), o.signal)
    // One timeout per try, covering the response body too (the same signal aborts the stream).
    const timeout = AbortSignal.timeout(o.timeoutMs ?? transferTimeoutMs(bytes))
    const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout
    const timed: Fetch = (url, init) => base(url, { ...init, signal })
    try {
      return await run(timed)
    } catch (e) {
      if (o.signal?.aborted) throw o.signal.reason
      last = e
    }
  }
  throw new TransferError(`${what} failed after ${attempts} tries: ${(last as Error)?.message ?? String(last)}`)
}

async function ok(res: Response, what: string): Promise<Response> {
  if (res.ok) return res
  const body = (await res.text().catch(() => '')).slice(0, 200)
  throw new Error(`${what}: HTTP ${res.status}${body ? ` ${body}` : ''}`)
}

/**
 * Streams `url` to `path` and checks the size. Reads the body chunk by chunk itself: Bun.write(path,
 * response) (Bun 1.4) can hang forever on a large R2 response and ignores the abort signal.
 */
export async function download(url: string, path: string, bytes: number, o: RetryOptions = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await withRetry(`Downloading ${path.split('/').at(-1)}`, o, bytes, async (f) => {
    const res = await ok(await f(url), 'GET')
    if (!res.body) throw new Error('no response body')
    const file = await open(path, 'w')
    let written = 0
    try {
      for await (const chunk of res.body) {
        written += chunk.byteLength
        if (written > bytes) throw new Error(`got more than the ${bytes} bytes expected`)
        await file.write(chunk)
      }
    } finally {
      await file.close()
    }
    if (written !== bytes) throw new Error(`got ${written} bytes, expected ${bytes}`)
  })
}

export interface FinishedPart {
  partNumber: number
  etag: string
}

/**
 * Uploads `body` to the target `worker.outputUrls` returned: one PUT with the target's
 * headers, or its parts in parallel (each `partSize` bytes, the last shorter). Returns the
 * parts' ETags for `worker.finishOutput`, or undefined for a single PUT.
 */
export async function upload(target: UploadTarget, body: Uint8Array<ArrayBuffer>, o: RetryOptions & { parallel?: number } = {}): Promise<FinishedPart[] | undefined> {
  if (target.single) {
    const { url, headers } = target.single
    await withRetry(`Uploading ${target.key}`, o, body.byteLength, async (f) => {
      await ok(await f(url, { method: 'PUT', headers, body }), 'PUT')
    })
    return undefined
  }
  const parts = target.parts ?? []
  const size = target.partSize ?? 0
  if (!(size > 0) || parts.length !== Math.ceil(body.byteLength / size))
    throw new TransferError(`The upload target for ${target.key} has ${parts.length} parts of ${size} bytes, which doesn't fit ${body.byteLength} bytes.`)
  const done: FinishedPart[] = []
  await inParallel(parts, o.parallel ?? 4, async ({ partNumber, url }, signal) => {
    const slice = body.subarray((partNumber - 1) * size, partNumber * size)
    const etag = await withRetry(`Uploading part ${partNumber} of ${target.key}`, { ...o, signal }, slice.byteLength, async (f) => {
      const res = await ok(await f(url, { method: 'PUT', body: slice }), 'PUT')
      const tag = res.headers.get('etag')
      if (!tag) throw new Error('no ETag in the response')
      return tag
    })
    done.push({ partNumber, etag })
  }, o.signal)
  return done.sort((a, b) => a.partNumber - b.partNumber)
}

/**
 * Runs `run` over `items`, at most `n` at a time. The first failure (or `parent` aborting) stops
 * scheduling and aborts the `signal` every running item got; it returns only once every running
 * item has settled, then throws that first failure. So nothing is still writing when it throws.
 */
export async function inParallel<T>(items: T[], n: number, run: (item: T, signal: AbortSignal) => Promise<void>, parent?: AbortSignal): Promise<void> {
  const group = new AbortController()
  const signal = parent ? AbortSignal.any([parent, group.signal]) : group.signal
  let next = 0
  let failure: { error: unknown } | null = null
  await Promise.allSettled(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (!failure && !signal.aborted && next < items.length) {
        try {
          await run(items[next++], signal)
        } catch (error) {
          if (!failure) {
            failure = { error }
            group.abort(error)
          }
        }
      }
    }),
  )
  if (failure) throw (failure as { error: unknown }).error
  parent?.throwIfAborted()
}
