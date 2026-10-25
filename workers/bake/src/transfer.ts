// Downloads from and uploads to presigned R2 URLs, with retries. `fetch` is injectable for tests.
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
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true })
  })

async function withRetry<T>(what: string, o: RetryOptions, run: (fetch: Fetch) => Promise<T>): Promise<T> {
  const attempts = o.attempts ?? 4
  let last: unknown
  for (let a = 0; a < attempts; a++) {
    o.signal?.throwIfAborted()
    if (a > 0) await wait((o.backoffMs ?? 1000) * 2 ** (a - 1), o.signal)
    try {
      return await run(o.fetch ?? fetch)
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

/** Streams `url` to `path` and checks the size. */
export async function download(url: string, path: string, bytes: number, o: RetryOptions = {}): Promise<void> {
  await withRetry(`Downloading ${path.split('/').at(-1)}`, o, async (f) => {
    const res = await ok(await f(url, { signal: o.signal }), 'GET')
    const written = await Bun.write(path, res)
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
    await withRetry(`Uploading ${target.key}`, o, async (f) => {
      await ok(await f(url, { method: 'PUT', headers, body, signal: o.signal }), 'PUT')
    })
    return undefined
  }
  const parts = target.parts ?? []
  const size = target.partSize ?? 0
  if (!(size > 0) || parts.length !== Math.ceil(body.byteLength / size))
    throw new TransferError(`The upload target for ${target.key} has ${parts.length} parts of ${size} bytes, which doesn't fit ${body.byteLength} bytes.`)
  const done: FinishedPart[] = []
  await inParallel(parts, o.parallel ?? 4, async ({ partNumber, url }) => {
    const slice = body.subarray((partNumber - 1) * size, partNumber * size)
    const etag = await withRetry(`Uploading part ${partNumber} of ${target.key}`, o, async (f) => {
      const res = await ok(await f(url, { method: 'PUT', body: slice, signal: o.signal }), 'PUT')
      const tag = res.headers.get('etag')
      if (!tag) throw new Error('no ETag in the response')
      return tag
    })
    done.push({ partNumber, etag })
  })
  return done.sort((a, b) => a.partNumber - b.partNumber)
}

/** Runs `run` over `items`, at most `n` at a time. */
export async function inParallel<T>(items: T[], n: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) await run(items[next++])
    }),
  )
}
