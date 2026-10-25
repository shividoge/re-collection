// The job queue (architecture-v3.md §7): one `jobs` table for every background stage. Workers
// lease jobs for 120 s and heartbeat; facts jobs are run by a Convex action with a 15-minute
// lease. A cron re-queues expired leases; three failed attempts mark the job failed. Every change
// mirrors into the capture's status, so the web sees stages and progress live.
import { ConvexError } from 'convex/values'
import { internal } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import type { JobKind } from '../validators'
import { getCapture, patchStatus } from './data'

export const LEASE_MS = 120_000
/** Facts run in one Convex action (10-minute limit), so its lease outlasts the action. */
export const FACTS_LEASE_MS = 15 * 60_000
export const MAX_ATTEMPTS = 3
export const STOPPED_RESPONDING = 'The worker stopped responding three times.'
export const CONVEX_WORKER = 'convex'

export type Needs = { gpu: boolean; frames?: number }

/** True when the token matches WORKER_TOKEN (compared without early exit). */
export function tokenMatches(token: string, expected: string | undefined): boolean {
  if (!expected) return false
  let diff = token.length ^ expected.length
  for (let i = 0; i < Math.max(token.length, expected.length); i++) diff |= (token.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0)
  return diff === 0
}

export function requireToken(token: string): void {
  if (!process.env.WORKER_TOKEN) throw new ConvexError({ code: 'unauthorized', message: "WORKER_TOKEN isn't set in this Convex deployment." })
  if (!tokenMatches(token, process.env.WORKER_TOKEN)) throw new ConvexError({ code: 'unauthorized', message: 'Wrong worker token.' })
}

/** Is `attempt` (what `claim` returned) the attempt holding the job's current lease? */
export function holdsLease(job: Pick<Doc<'jobs'>, 'status' | 'attempts'>, attempt: number): boolean {
  return job.status === 'leased' && attempt === job.attempts + 1
}

/** Thrown to a worker whose attempt lost its lease (expired, superseded, or the capture was deleted). */
export const cancelled = (message = "This job attempt doesn't hold the lease any more; stop working on it.") => new ConvexError({ code: 'cancelled', message })

/** The job, if `attempt` holds its lease and its capture still exists; else throws `cancelled`. */
export async function requireLease(ctx: QueryCtx | MutationCtx, jobId: Id<'jobs'>, attempt: number): Promise<Doc<'jobs'>> {
  const job = await ctx.db.get(jobId)
  if (!job) throw cancelled(`No job ${jobId}.`)
  if (!holdsLease(job, attempt)) throw cancelled()
  if (!(await getCapture(ctx, job.captureId))) throw cancelled('The capture of this job was deleted.')
  return job
}

/** Can this worker run the job? */
export function canRun(job: Pick<Doc<'jobs'>, 'kind' | 'needs'>, worker: { kinds: readonly string[]; gpu: boolean; maxFrames?: number }): boolean {
  if (job.kind === 'facts' || !worker.kinds.includes(job.kind)) return false
  if (job.needs.gpu && !worker.gpu) return false
  if (job.needs.frames !== undefined && job.needs.frames > (worker.maxFrames ?? Infinity)) return false
  return true
}

export async function activeJob(ctx: MutationCtx, captureId: string, kind: JobKind): Promise<Doc<'jobs'> | null> {
  const jobs = await ctx.db.query('jobs').withIndex('by_capture', (q) => q.eq('captureId', captureId).eq('kind', kind)).collect()
  return jobs.find((j) => j.status === 'queued' || j.status === 'leased') ?? null
}

/**
 * Fails the stage's queued or running job because its inputs are being replaced (the worker's
 * next heartbeat says cancelled, so nothing it made is published). Returns whether there was one.
 */
export async function supersede(ctx: MutationCtx, captureId: string, kind: JobKind, reason: string): Promise<boolean> {
  const job = await activeJob(ctx, captureId, kind)
  if (!job) return false
  await ctx.db.patch(job._id, { status: 'failed', error: reason, leaseUntil: null, updatedAt: Date.now() })
  return true
}

/** Queues a stage (or returns the one already queued or running) and shows it in the status. */
export async function enqueue(ctx: MutationCtx, capture: Doc<'captures'>, kind: JobKind, needs: Needs): Promise<Id<'jobs'>> {
  const existing = await activeJob(ctx, capture.captureId, kind)
  if (existing) return existing._id
  const now = Date.now()
  const jobId = await ctx.db.insert('jobs', {
    captureId: capture.captureId,
    kind,
    status: 'queued',
    needs,
    attempts: 0,
    leaseUntil: null,
    workerId: null,
    progress: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  })
  const fresh = (await ctx.db.get(capture._id)) ?? capture
  const errors = { ...fresh.status.errors }
  delete errors[kind]
  await patchStatus(ctx, fresh, { [kind]: 'queued', errors })
  if (kind === 'facts') await dispatchFacts(ctx, jobId)
  return jobId
}

/** Wait before retrying a failed facts attempt: 30 s, then 60 s (so a rate limit can pass). */
export const FACTS_RETRY_MS = 30_000

/** Leases a facts job to Convex itself and schedules the action that runs it. */
export async function dispatchFacts(ctx: MutationCtx, jobId: Id<'jobs'>): Promise<void> {
  const job = await ctx.db.get(jobId)
  if (!job || job.status !== 'queued') return
  await lease(ctx, job, CONVEX_WORKER, FACTS_LEASE_MS)
  await ctx.scheduler.runAfter(0, internal.factsJob.run, { jobId })
}

/** Leases a queued job and marks its stage running. */
export async function lease(ctx: MutationCtx, job: Doc<'jobs'>, workerId: string, ms = LEASE_MS): Promise<void> {
  const now = Date.now()
  await ctx.db.patch(job._id, { status: 'leased', workerId, leaseUntil: now + ms, progress: null, updatedAt: now })
  const capture = await getCapture(ctx, job.captureId)
  if (capture) await patchStatus(ctx, capture, { [job.kind]: 'running', progress: null })
}

export async function heartbeat(ctx: MutationCtx, job: Doc<'jobs'>, progress: Doc<'jobs'>['progress'] | undefined, ms = LEASE_MS): Promise<void> {
  const now = Date.now()
  await ctx.db.patch(job._id, { leaseUntil: now + ms, updatedAt: now, ...(progress !== undefined ? { progress } : {}) })
  const capture = await getCapture(ctx, job.captureId)
  if (capture && progress !== undefined) await patchStatus(ctx, capture, { progress })
}

export async function markDone(ctx: MutationCtx, job: Doc<'jobs'>): Promise<void> {
  await ctx.db.patch(job._id, { status: 'done', leaseUntil: null, progress: null, error: null, updatedAt: Date.now() })
  const capture = await getCapture(ctx, job.captureId)
  if (!capture) return
  const errors = { ...capture.status.errors }
  delete errors[job.kind]
  await patchStatus(ctx, capture, { [job.kind]: 'done', errors, progress: null })
}

/** A failed attempt: re-queued while attempts remain (and it's worth retrying), else failed. */
export async function markFailed(ctx: MutationCtx, job: Doc<'jobs'>, error: string, retryable: boolean): Promise<'queued' | 'failed'> {
  const attempts = job.attempts + 1
  const now = Date.now()
  const capture = await getCapture(ctx, job.captureId)
  if (retryable && attempts < MAX_ATTEMPTS && capture) {
    await ctx.db.patch(job._id, { status: 'queued', attempts, leaseUntil: null, workerId: null, progress: null, error, updatedAt: now })
    await patchStatus(ctx, capture, { [job.kind]: 'queued', progress: null })
    if (job.kind === 'facts') await ctx.scheduler.runAfter(FACTS_RETRY_MS * attempts, internal.factsJob.dispatch, { jobId: job._id })
    return 'queued'
  }
  await ctx.db.patch(job._id, { status: 'failed', attempts, leaseUntil: null, progress: null, error, updatedAt: now })
  if (capture) await patchStatus(ctx, capture, { [job.kind]: 'failed', errors: { ...capture.status.errors, [job.kind]: error }, progress: null })
  return 'failed'
}

/** The cron: every leased job whose lease ran out counts as a failed attempt. */
export async function reapExpired(ctx: MutationCtx, now = Date.now()): Promise<number> {
  const expired = await ctx.db.query('jobs').withIndex('by_lease', (q) => q.eq('status', 'leased').lt('leaseUntil', now)).collect()
  for (const job of expired) {
    const attempts = job.attempts + 1
    await markFailed(ctx, job, attempts >= MAX_ATTEMPTS ? STOPPED_RESPONDING : 'The worker stopped responding; trying again.', true)
  }
  return expired.length
}

/** Records a worker as online (from claims and heartbeats). */
export async function seeWorker(ctx: MutationCtx, w: { workerId: string; kinds?: JobKind[]; gpu?: boolean; maxFrames?: number }): Promise<void> {
  if (w.workerId === CONVEX_WORKER) return
  const row = await ctx.db.query('workers').withIndex('by_workerId', (q) => q.eq('workerId', w.workerId)).unique()
  const now = Date.now()
  if (!row) {
    await ctx.db.insert('workers', { workerId: w.workerId, kinds: w.kinds ?? [], gpu: w.gpu ?? false, maxFrames: w.maxFrames, lastSeen: now })
  } else {
    await ctx.db.patch(row._id, {
      lastSeen: now,
      ...(w.kinds ? { kinds: w.kinds } : {}),
      ...(w.gpu !== undefined ? { gpu: w.gpu } : {}),
      ...(w.kinds ? { maxFrames: w.maxFrames } : {}),
    })
  }
}
