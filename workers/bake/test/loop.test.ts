import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { parseDepthIndex } from '../../../shared/depth'
import type { Claim, Inputs, WorkerApi } from '../src/api'
import { bakeCapture } from '../src/bake'
import { listDir } from '../src/listing'
import { runJob, runLoop, type Bake, type LoopOptions } from '../src/loop'
import type { Fetch } from '../src/transfer'
import { makeCapture } from './fixture'

const PART = 64 * 1024
const tmpRoot = await mkdtemp(join(tmpdir(), 'bd-loop-'))
afterAll(() => rm(tmpRoot, { recursive: true, force: true }))

type Call = { fn: string; args: Record<string, unknown> }

/** An in-memory backend + R2: raw files served from a capture folder, uploads kept in `objects`. */
async function fakeBackend(captureDir: string, o: { cancelled?: boolean; failGets?: boolean; claims?: (Claim | null)[] } = {}) {
  const calls: Call[] = []
  const objects = new Map<string, { body: Uint8Array; headers: Record<string, string> }>()
  const parts = new Map<string, Map<number, Uint8Array>>()
  const listing = await listDir(captureDir)
  const record = (fn: string, args: object) => calls.push({ fn, args: args as Record<string, unknown> })
  const claims = o.claims ?? [{ jobId: 'job1', kind: 'bake', captureId: 'cap1', attempt: 1 } as unknown as Claim]
  const api: WorkerApi = {
    claim: async (a) => (record('claim', a), claims.shift() ?? null),
    heartbeat: async (a) => (record('heartbeat', a), { ok: true, cancelled: !!o.cancelled }),
    inputs: async (a): Promise<Inputs> => {
      record('inputs', a)
      return {
        manifestJson: await Bun.file(join(captureDir, 'manifest.json')).text(),
        files: [...listing].map(([name, bytes]) => ({ name, area: 'raw' as const, url: `mem://raw/${name}`, bytes })),
      }
    },
    outputUrls: async (a) => {
      record('outputUrls', a)
      return a.files.map((f) =>
        f.bytes > PART
          ? { name: f.name, target: { uploadId: `up-${f.name}`, key: `derived/${f.name}`, partSize: PART, parts: Array.from({ length: Math.ceil(f.bytes / PART) }, (_, i) => ({ partNumber: i + 1, url: `mem://part/${f.name}/${i + 1}` })) } }
          : { name: f.name, target: { uploadId: `up-${f.name}`, key: `derived/${f.name}`, single: { url: `mem://put/${f.name}`, headers: { 'Content-Type': f.contentType, ...(f.contentEncoding ? { 'Content-Encoding': f.contentEncoding } : {}) } } } },
      )
    },
    finishOutput: async (a) => {
      record('finishOutput', a)
      const name = a.uploadId.slice(3)
      if (a.parts) {
        const got = parts.get(name)!
        const body = new Uint8Array(a.parts.reduce((s, p) => s + got.get(p.partNumber)!.byteLength, 0))
        let at = 0
        for (const p of a.parts) {
          expect(p.etag).toBe(`"etag-${name}-${p.partNumber}"`)
          body.set(got.get(p.partNumber)!, at)
          at += got.get(p.partNumber)!.byteLength
        }
        objects.set(name, { body, headers: {} })
      }
      return { ok: true, bytes: objects.get(name)!.body.byteLength }
    },
    complete: async (a) => (record('complete', a), { ok: true }),
    fail: async (a) => (record('fail', a), { ok: true }),
  }
  const fetchImpl: Fetch = async (url, init) => {
    const u = url.replace('mem://', '')
    if (u.startsWith('raw/')) {
      if (o.failGets) return new Response('busy', { status: 503 })
      return new Response(Bun.file(join(captureDir, u.slice(4))))
    }
    const body = new Uint8Array(await new Response(init!.body as BodyInit).arrayBuffer())
    if (u.startsWith('put/')) {
      objects.set(u.slice(4), { body, headers: (init!.headers ?? {}) as Record<string, string> })
      return new Response(null, { status: 200 })
    }
    const [, name, n] = u.split('/')
    if (!parts.has(name)) parts.set(name, new Map())
    parts.get(name)!.set(Number(n), body)
    return new Response(null, { status: 200, headers: { ETag: `"etag-${name}-${n}"` } })
  }
  return { api, calls, objects, fetchImpl }
}

/** A bake that runs until it's told to stop. */
const untilAborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => (signal.aborted ? reject(signal.reason) : signal.addEventListener('abort', () => reject(signal.reason))))

const claim = { jobId: 'job1', kind: 'bake', captureId: 'cap1', attempt: 1 } as unknown as Claim
const quiet = () => {}

function options(b: Awaited<ReturnType<typeof fakeBackend>>, over: Partial<LoopOptions> = {}): LoopOptions {
  return { api: b.api, bake: bakeCapture, workerId: 'test-1', bakeVersion: 'test', stop: new AbortController().signal, tmpRoot, fetch: b.fetchImpl, retryBackoffMs: 1, heartbeatMs: 5, log: quiet, ...over }
}

describe('a job', () => {
  test('claim → download → bake → upload → complete, and the temp folder is gone', async () => {
    const dir = await makeCapture()
    const b = await fakeBackend(dir)
    await runLoop({ ...options(b), stop: AbortSignal.timeout(400), idleMinMs: 50 })
    const fns = b.calls.map((c) => c.fn)
    expect(fns).toContain('complete')
    expect(fns).not.toContain('fail')
    expect(fns.indexOf('inputs')).toBeLessThan(fns.indexOf('outputUrls'))
    expect(fns.filter((f) => f === 'claim').length).toBeGreaterThan(1) // it went back to polling
    // Every call about the job carries the attempt claim returned.
    expect(b.calls.filter((c) => c.fn !== 'claim').every((c) => c.args.attempt === 1)).toBe(true)
    // The derived files arrived: gzip ones decompress, depth.bin is raw v2.
    const complete = b.calls.find((c) => c.fn === 'complete')!.args as { jobId: string; result: { kind: string; derived: { stats: unknown } } }
    expect(complete.jobId).toBe('job1')
    expect(complete.result.kind).toBe('bake')
    const derivedJson = JSON.parse(new TextDecoder().decode(gunzipSync(b.objects.get('derived.json')!.body)))
    expect(derivedJson.stats).toEqual(complete.result.derived.stats)
    expect(b.objects.get('derived.json')!.headers['Content-Encoding']).toBe('gzip')
    const declared = (b.calls.find((c) => c.fn === 'outputUrls')!.args.files as { name: string; contentEncoding?: string; area: string }[])
    expect(declared.find((f) => f.name === 'depth.bin')!.contentEncoding).toBeUndefined()
    expect(declared.every((f) => f.area === 'derived')).toBe(true)
    expect(declared.filter((f) => f.contentEncoding === 'gzip').map((f) => f.name).sort()).toEqual(['depth.index.json', 'derived.json', 'points.pack', 'surface.pack', 'timeline.pack'])
    const index = parseDepthIndex(new TextDecoder().decode(gunzipSync(b.objects.get('depth.index.json')!.body)))
    expect(b.objects.get('depth.bin')!.body.byteLength).toBe(index.chunks.at(-1)![0] + index.chunks.at(-1)![1])
    // points.pack is above one part: it went up in parts and was reassembled in order.
    const direct = await bakeCapture(dir, await listDir(dir), { bakeVersion: 'test' })
    const points = direct.files.find((f) => f.name === 'points.pack')!.bytes
    expect(points.byteLength).toBeGreaterThan(PART)
    expect(Array.from(gunzipSync(b.objects.get('points.pack')!.body))).toEqual(Array.from(points))
    // Heartbeats carried progress.
    const beats = b.calls.filter((c) => c.fn === 'heartbeat')
    expect(beats.length).toBeGreaterThan(0)
    expect(beats[0].args.progress).toMatchObject({ stage: 'bake' })
    expect(await readdir(tmpRoot)).toEqual([])
    await rm(dir, { recursive: true, force: true })
  })

  test('a download that keeps failing fails the job as retryable', async () => {
    const dir = await makeCapture()
    const b = await fakeBackend(dir, { failGets: true })
    await runJob(claim, options(b), quiet)
    const fail = b.calls.find((c) => c.fn === 'fail')!.args
    expect(fail.retryable).toBe(true)
    expect(String(fail.error)).toContain('failed after 4 tries')
    expect(String(fail.error)).toContain('HTTP 503')
    expect(b.calls.some((c) => c.fn === 'complete')).toBe(false)
    expect(await readdir(tmpRoot)).toEqual([])
    await rm(dir, { recursive: true, force: true })
  })

  test('an invalid capture fails the job as not retryable, with the reasons', async () => {
    const dir = await makeCapture((f) => f.set('frames.jsonl', (f.get('frames.jsonl') as string).trim().split('\n').slice(0, -1).join('\n')))
    const b = await fakeBackend(dir)
    await runJob(claim, options(b), quiet)
    expect(b.calls.find((c) => c.fn === 'fail')!.args).toEqual({
      jobId: 'job1',
      attempt: 1,
      error: "The capture can't be baked: frames.jsonl has 3 moment lines, but manifest.video.frameCount is 4.",
      retryable: false,
    })
    await rm(dir, { recursive: true, force: true })
  })

  test('a cancelled job stops without completing or failing', async () => {
    const dir = await makeCapture()
    const b = await fakeBackend(dir, { cancelled: true })
    const slowBake: Bake = (_d, _l, o) => untilAborted(o.signal!)
    await runJob(claim, options(b, { bake: slowBake }), quiet)
    const fns = b.calls.map((c) => c.fn)
    expect(fns).toContain('heartbeat')
    expect(fns).not.toContain('complete')
    expect(fns).not.toContain('fail')
    expect(fns).not.toContain('outputUrls')
    await rm(dir, { recursive: true, force: true })
  })
})

describe('failures and deadlines', () => {
  const never = <T>() => new Promise<T>(() => {})

  test('a failed download aborts the other running downloads, and the job reports only after they stopped', async () => {
    const dir = await makeCapture()
    const b = await fakeBackend(dir)
    const events: string[] = []
    const fetchImpl: Fetch = (url, init) => {
      if (url.endsWith('/frames.jsonl')) return Promise.resolve(new Response('gone', { status: 404 }))
      if (url.startsWith('mem://raw/')) {
        // Every other download stalls until it's aborted.
        return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => (events.push('aborted'), reject(init.signal!.reason)), { once: true }))
      }
      return b.fetchImpl(url, init)
    }
    const api: WorkerApi = { ...b.api, fail: async (a) => (events.push('fail'), b.api.fail(a)) }
    await runJob(claim, options(b, { api, fetch: fetchImpl }), quiet)
    expect(events.at(-1)).toBe('fail')
    expect(events.filter((e) => e === 'aborted').length).toBeGreaterThan(0)
    expect(String(b.calls.find((c) => c.fn === 'fail')!.args.error)).toContain('HTTP 404')
    expect(await readdir(tmpRoot)).toEqual([])
    await rm(dir, { recursive: true, force: true })
  })

  test('a Convex call that never answers is abandoned at its deadline, and the failure report is short too', async () => {
    const dir = await makeCapture()
    const b = await fakeBackend(dir)
    const api: WorkerApi = { ...b.api, inputs: () => never(), fail: (a) => (b.calls.push({ fn: 'fail', args: a }), never()) }
    const started = performance.now()
    await runJob(claim, options(b, { api, callTimeoutMs: 40, reportTimeoutMs: 40 }), quiet)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(String(b.calls.find((c) => c.fn === 'fail')!.args.error)).toContain("worker.inputs didn't answer")
    await rm(dir, { recursive: true, force: true })
  })

  test('kill stops waiting for a pending Convex call at once', async () => {
    const dir = await makeCapture()
    const b = await fakeBackend(dir)
    const kill = new AbortController()
    const api: WorkerApi = { ...b.api, inputs: () => (kill.abort(), never()) }
    const started = performance.now()
    await runJob(claim, options(b, { api, kill: kill.signal }), quiet)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(b.calls.find((c) => c.fn === 'fail')!.args).toMatchObject({ error: 'The worker was stopped before the bake finished.', retryable: true })
    await rm(dir, { recursive: true, force: true })
  })

  test('a call refused because the attempt lost its lease stops the job without reporting', async () => {
    const dir = await makeCapture()
    const b = await fakeBackend(dir)
    const lost = Object.assign(new Error("This job attempt doesn't hold the lease any more"), { data: { code: 'cancelled', message: 'lost' } })
    const api: WorkerApi = { ...b.api, outputUrls: () => Promise.reject(lost) }
    await runJob(claim, options(b, { api }), quiet)
    expect(b.calls.map((c) => c.fn)).not.toContain('fail')
    expect(await readdir(tmpRoot)).toEqual([])
    await rm(dir, { recursive: true, force: true })
  })
})

describe('the loop', () => {
  test('backs off while idle, keeps polling when the backend errors, and stops on signal', async () => {
    const dir = await makeCapture()
    const b = await fakeBackend(dir, { claims: [] })
    let errors = 0
    const flaky: WorkerApi = { ...b.api, claim: async (a) => (++errors % 2 ? Promise.reject(new Error('not deployed')) : b.api.claim(a)) }
    const started = performance.now()
    const logs: string[] = []
    await runLoop({ ...options(b), api: flaky, stop: AbortSignal.timeout(300), idleMinMs: 10, idleMaxMs: 80, log: (l) => logs.push(l) })
    expect(performance.now() - started).toBeLessThan(500)
    // 10 + 20 + 40 + 80 + 80 ... ms: about 6 claims in 300 ms, not 30.
    const claims = errors
    expect(claims).toBeGreaterThanOrEqual(4)
    expect(claims).toBeLessThanOrEqual(8)
    expect(logs.some((l) => l.includes('not deployed'))).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })

  test('on stop, the running job finishes; on kill, it fails as retryable', async () => {
    const dir = await makeCapture()
    const finishing = await fakeBackend(dir)
    const stop = new AbortController()
    const slowish: Bake = async (d, l, o) => {
      stop.abort()
      await Bun.sleep(30)
      return bakeCapture(d, l, o)
    }
    await runLoop({ ...options(finishing), bake: slowish, stop: stop.signal })
    expect(finishing.calls.map((c) => c.fn)).toContain('complete')
    expect(finishing.calls.filter((c) => c.fn === 'claim').length).toBe(1)

    const killed = await fakeBackend(dir)
    const stop2 = new AbortController()
    const kill = new AbortController()
    const stuck: Bake = (_d, _l, o) => {
      stop2.abort()
      kill.abort()
      return untilAborted(o.signal!)
    }
    await runLoop({ ...options(killed), bake: stuck, stop: stop2.signal, kill: kill.signal })
    expect(killed.calls.find((c) => c.fn === 'fail')!.args).toEqual({ jobId: 'job1', attempt: 1, error: 'The worker was stopped before the bake finished.', retryable: true })
    await rm(dir, { recursive: true, force: true })
  })
})
