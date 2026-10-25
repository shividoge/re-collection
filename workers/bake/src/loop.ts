// The job loop (docs/architecture-v3.md §7): claim a bake job, download the raw files, bake,
// upload the derived files, complete. Everything it talks to is injected, so tests run it
// against a fake backend.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, normalize } from 'node:path'
import { gzipSync } from 'node:zlib'
import { parseManifest } from '../../../shared/manifest'
import { bounded, isCancelled, type Claim, type WorkerApi } from './api'
import type { BakeOptions, BakeResult, Progress } from './bake'
import { download, inParallel, upload, type Fetch } from './transfer'
import { bakeInputs, ValidationError, type Listing } from './validate'

export type Bake = (dir: string, listing: Listing, o: BakeOptions) => Promise<BakeResult>

export interface LoopOptions {
  api: WorkerApi
  bake: Bake
  workerId: string
  bakeVersion: string
  /** Jobs at once. */
  concurrency?: number
  /** Stops claiming; the running jobs get `graceMs` to finish, then fail (retryable). */
  stop: AbortSignal
  graceMs?: number
  /** Ends the running jobs now (they fail, retryable). */
  kill?: AbortSignal
  heartbeatMs?: number
  idleMinMs?: number
  idleMaxMs?: number
  tmpRoot?: string
  fetch?: Fetch
  /** First wait between transfer retries. */
  retryBackoffMs?: number
  /** Longest wait for one Convex call (default 60 s). */
  callTimeoutMs?: number
  /** Longest wait for the failure report of a stopped or broken job (default 10 s). */
  reportTimeoutMs?: number
  log?: (line: string) => void
}

/** The job was re-queued or its capture deleted: stop without reporting anything. */
class Cancelled extends Error {}
/** The worker is shutting down. */
class Stopped extends Error {}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(done, ms)
    function done() {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })

/** Runs until `stop` aborts and the running jobs are done. */
export async function runLoop(o: LoopOptions): Promise<void> {
  const log = o.log ?? ((line) => console.log(line))
  const slot = async (n: number) => {
    let idle = o.idleMinMs ?? 2000
    while (!o.stop.aborted) {
      let claim: Claim | null = null
      try {
        // A second signal stops waiting; a lease it may still have taken expires on the backend.
        claim = await bounded(o.api.claim({ workerId: o.workerId, kinds: ['bake'], gpu: false, protocol: 2 }), 'worker.claim', o.callTimeoutMs ?? 60_000, o.kill)
      } catch (e) {
        log(`claim failed: ${(e as Error).message}`)
      }
      if (!claim) {
        await sleep(idle, o.stop)
        idle = Math.min(idle * 2, o.idleMaxMs ?? 15_000)
        continue
      }
      idle = o.idleMinMs ?? 2000
      log(`[${n}] job ${claim.jobId}: bake ${claim.captureId} (attempt ${claim.attempt})`)
      await runJob(claim, o, log)
    }
  }
  await Promise.all(Array.from({ length: o.concurrency ?? 1 }, (_, n) => slot(n)))
}

/** One job, start to finish. Never throws: every outcome is reported to the backend (or logged). */
export async function runJob(claim: Claim, o: LoopOptions, log: (line: string) => void): Promise<void> {
  const { jobId, attempt } = claim
  const cancel = new AbortController()
  const shutdown = new AbortController()
  const signal = AbortSignal.any([cancel.signal, shutdown.signal])
  const callMs = o.callTimeoutMs ?? 60_000
  /** Every Convex call of the job: a deadline, and no more waiting once the job is cancelled or stopped. */
  const call = <T>(what: string, p: Promise<T>, within: AbortSignal = signal): Promise<T> =>
    bounded(p, what, callMs, within).catch((e: unknown) => {
      if (isCancelled(e)) cancel.abort(new Cancelled(`The backend says this attempt no longer holds the job (${what}).`))
      throw e
    })
  let progress: Progress = { stage: 'bake', fraction: 0, message: 'Downloading the capture' }
  const beat = async () => {
    try {
      const r = await call('worker.heartbeat', o.api.heartbeat({ jobId, attempt, progress }))
      if (r.cancelled) cancel.abort(new Cancelled('The job was cancelled.'))
    } catch (e) {
      if (!signal.aborted) log(`heartbeat failed: ${(e as Error).message}`)
    }
  }
  const timer = setInterval(beat, o.heartbeatMs ?? 30_000)
  // On stop: a grace period, then end the job. On kill: end it now.
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  const onStop = () => (graceTimer = setTimeout(() => shutdown.abort(new Stopped()), o.graceMs ?? 90_000))
  const onKill = () => shutdown.abort(new Stopped())
  if (o.stop.aborted) onStop()
  else o.stop.addEventListener('abort', onStop, { once: true })
  if (o.kill?.aborted) onKill()
  else o.kill?.addEventListener('abort', onKill, { once: true })
  let dir: string | null = null
  try {
    const inputs = await call('worker.inputs', o.api.inputs({ jobId, attempt }))
    const listing: Listing = new Map(inputs.files.filter((f) => f.area === 'raw').map((f) => [f.name, f.bytes]))
    if (inputs.manifestJson === null) throw new ValidationError(['manifest.json is missing.'])
    let names: string[]
    try {
      names = bakeInputs(parseManifest(inputs.manifestJson))
    } catch (e) {
      throw new ValidationError([(e as Error).message])
    }
    const wanted = inputs.files.filter((f) => f.area === 'raw' && names.includes(f.name))
    for (const f of wanted) if (f.name !== normalize(f.name) || f.name.startsWith('/') || f.name.startsWith('..')) throw new ValidationError([`The file name "${f.name}" isn't allowed.`])
    dir = await mkdtemp(join(o.tmpRoot ?? tmpdir(), `bd-bake-${claim.captureId}-`))
    const total = wanted.reduce((s, f) => s + f.bytes, 0)
    let got = 0
    const retry = { signal, fetch: o.fetch, backoffMs: o.retryBackoffMs }
    await inParallel(wanted, 4, async (f, s) => {
      await download(f.url, join(dir!, f.name), f.bytes, { ...retry, signal: s })
      got += f.bytes
      progress = { stage: 'bake', fraction: 0.2 * (got / Math.max(1, total)), message: `Downloaded ${Math.round(got / 1e6)} of ${Math.round(total / 1e6)} MB` }
    }, signal)

    const result = await o.bake(dir, listing, {
      bakeVersion: o.bakeVersion,
      signal,
      onProgress: (p) => {
        progress = { ...p, fraction: p.fraction === null ? null : 0.2 + 0.6 * p.fraction }
      },
    })

    progress = { stage: 'bake', fraction: 0.8, message: 'Uploading the room' }
    const files = result.files.map((f) => ({ ...f, body: f.gzip ? new Uint8Array(gzipSync(f.bytes, { level: 6 })) : new Uint8Array(f.bytes) }))
    const targets = await call('worker.outputUrls', o.api.outputUrls({
      jobId,
      attempt,
      files: files.map((f) => ({ name: f.name, bytes: f.body.byteLength, contentType: f.contentType, ...(f.gzip ? { contentEncoding: 'gzip' } : {}), area: 'derived' as const })),
    }))
    const byName = new Map(targets.map((t) => [t.name, t.target]))
    let sent = 0
    const totalUp = files.reduce((s, f) => s + f.body.byteLength, 0)
    await inParallel(files, 2, async (f, s) => {
      const target = byName.get(f.name)
      if (!target) throw new Error(`The backend gave no upload target for ${f.name}.`)
      const parts = await upload(target, f.body, { ...retry, signal: s })
      s.throwIfAborted()
      await call('worker.finishOutput', o.api.finishOutput({ jobId, attempt, uploadId: target.uploadId, ...(parts ? { parts } : {}) }), s)
      sent += f.body.byteLength
      progress = { stage: 'bake', fraction: 0.8 + 0.2 * (sent / totalUp), message: `Uploaded ${Math.round(sent / 1e6)} of ${Math.round(totalUp / 1e6)} MB` }
    }, signal)
    signal.throwIfAborted()
    await call('worker.complete', o.api.complete({ jobId, attempt, result: { kind: 'bake', derived: result.derived } }))
    log(`job ${jobId}: done in ${result.derived.stats.bakeMs} ms of baking`)
  } catch (e) {
    const reason = signal.aborted ? signal.reason : e
    if (reason instanceof Cancelled || isCancelled(reason)) {
      log(`job ${jobId}: cancelled by the backend`)
    } else {
      const validation = reason instanceof ValidationError
      const error =
        reason instanceof Stopped
          ? 'The worker was stopped before the bake finished.'
          : validation
            ? `The capture can't be baked: ${reason.errors.join(' ')}`
            : `The bake failed: ${(reason as Error)?.message ?? String(reason)}`
      log(`job ${jobId}: ${error}`)
      try {
        // Best effort, briefly: if it doesn't arrive, the lease expires and the job is re-queued.
        await bounded(o.api.fail({ jobId, attempt, error, retryable: !validation }), 'worker.fail', o.reportTimeoutMs ?? 10_000)
      } catch (err) {
        log(`reporting the failure failed (the lease will expire and re-queue it): ${(err as Error).message}`)
      }
    }
  } finally {
    clearInterval(timer)
    clearTimeout(graceTimer)
    o.stop.removeEventListener('abort', onStop)
    o.kill?.removeEventListener('abort', onKill)
    if (dir) await rm(dir, { recursive: true, force: true })
  }
}
