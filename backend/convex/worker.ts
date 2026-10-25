// The job protocol for bake and GPU workers (docs/architecture-v3.md §7). Every function takes
// the shared WORKER_TOKEN.
import { ConvexError, v } from 'convex/values'
import { parseManifest } from '../../shared/manifest'
import { internal } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import { action, internalQuery, mutation, type MutationCtx } from './_generated/server'
import { fileKey, getCapture, getFile, invalid, listFiles, notFound, patchStatus } from './lib/data'
import { canRun, enqueue, heartbeat as extendLease, lease, markDone, markFailed, requireToken, seeWorker } from './lib/jobs'
import { r2Config, stableGetUrl } from './lib/r2'
import { completeUpload } from './lib/stages'
import { convertFrames, isFileName } from './lib/validate'
import { createTarget, finishUpload, loadUpload } from './uploads'
import { shown } from './lib/errors'
import { area, derived, finishedPart, jobKind, progress, uploadTarget, type Area, type UploadTarget } from './validators'

const token = v.string()
/** The `attempt` claim returned. When given, calls from a worker whose lease was taken over are ignored. */
const attempt = v.optional(v.number())

/** Is this call from the worker holding the current lease? (No attempt given: assume so.) */
const holdsLease = (job: Doc<'jobs'>, a: number | undefined) => job.status === 'leased' && (a === undefined || a === job.attempts + 1)

async function requireJob(ctx: MutationCtx, jobId: Doc<'jobs'>['_id']): Promise<Doc<'jobs'>> {
  const job = await ctx.db.get(jobId)
  if (!job) throw notFound(`No job ${jobId}.`)
  return job
}

export const claim = mutation({
  args: { token, workerId: v.string(), kinds: v.array(jobKind), gpu: v.boolean(), maxFrames: v.optional(v.number()) },
  returns: v.union(v.object({ jobId: v.id('jobs'), kind: jobKind, captureId: v.string(), attempt: v.number() }), v.null()),
  handler: async (ctx, args) => {
    requireToken(args.token)
    if (!args.workerId.trim() || args.workerId === 'convex') throw invalid('workerId must be a name for this worker (not "convex").')
    await seeWorker(ctx, args)
    const queued = await ctx.db.query('jobs').withIndex('by_status', (q) => q.eq('status', 'queued')).order('asc').collect()
    for (const job of queued) {
      if (!canRun(job, args)) continue
      if (!(await getCapture(ctx, job.captureId))) {
        await ctx.db.patch(job._id, { status: 'failed', error: 'The capture was deleted.', updatedAt: Date.now() })
        continue
      }
      await lease(ctx, job, args.workerId)
      return { jobId: job._id, kind: job.kind, captureId: job.captureId, attempt: job.attempts + 1 }
    }
    return null
  },
})

export const heartbeat = mutation({
  args: { token, jobId: v.id('jobs'), progress: v.optional(progress), attempt },
  returns: v.object({ ok: v.boolean(), cancelled: v.boolean() }),
  handler: async (ctx, { token: t, jobId, progress: p, attempt: a }) => {
    requireToken(t)
    const job = await ctx.db.get(jobId)
    if (!job || !holdsLease(job, a) || !(await getCapture(ctx, job.captureId))) return { ok: false, cancelled: true }
    await extendLease(ctx, job, p)
    if (job.workerId) await seeWorker(ctx, { workerId: job.workerId })
    return { ok: true, cancelled: false }
  },
})

/** The job, its capture and the files a worker reads (for the actions below). */
export const jobFiles = internalQuery({
  args: { jobId: v.id('jobs') },
  handler: async (ctx, { jobId }) => {
    const job = await ctx.db.get(jobId)
    if (!job) throw notFound(`No job ${jobId}.`)
    const capture = await getCapture(ctx, job.captureId)
    if (!capture) throw notFound('The capture of this job was deleted.')
    if (job.status !== 'leased') throw new ConvexError({ code: 'cancelled', message: "This job isn't leased any more; stop working on it." })
    const files = await listFiles(ctx, capture.captureId, job.kind === 'convert' ? 'video' : 'raw')
    return { job, manifestJson: capture.manifestJson, files }
  },
})

/** Presigned GETs for the job's inputs: the capture's raw files, or the source video for convert. */
export const inputs = action({
  args: { token, jobId: v.id('jobs') },
  returns: v.object({
    manifestJson: v.union(v.string(), v.null()),
    files: v.array(v.object({ name: v.string(), area: area, url: v.string(), bytes: v.number() })),
  }),
  handler: async (ctx, { token: t, jobId }): Promise<{ manifestJson: string | null; files: { name: string; area: Area; url: string; bytes: number }[] }> => {
    requireToken(t)
    const { manifestJson, files } = await ctx.runQuery(internal.worker.jobFiles, { jobId })
    const cfg = r2Config()
    const now = Date.now()
    return { manifestJson, files: files.map((f) => ({ name: f.name, area: f.area, url: stableGetUrl(cfg, f.key, f.rev, now), bytes: f.bytes })) }
  },
})

export const outputUrls = action({
  args: {
    token,
    jobId: v.id('jobs'),
    files: v.array(v.object({ name: v.string(), bytes: v.number(), contentType: v.string(), contentEncoding: v.optional(v.string()), area: v.union(v.literal('raw'), v.literal('derived')) })),
  },
  returns: v.array(v.object({ name: v.string(), target: uploadTarget })),
  handler: async (ctx, { token: t, jobId, files }): Promise<{ name: string; target: UploadTarget }[]> => {
    requireToken(t)
    const { job } = await ctx.runQuery(internal.worker.jobFiles, { jobId })
    const out = []
    for (const f of files) {
      if (!isFileName(f.name)) throw invalid(`"${f.name}" isn't an allowed file name.`)
      if (!Number.isInteger(f.bytes) || f.bytes < 0) throw invalid(`${f.name}: bytes must be a whole number.`)
      const target = await shown(() => createTarget(ctx, { captureId: job.captureId, ...f, key: fileKey(job.captureId, f.area, f.name), jobId }))
      out.push({ name: f.name, target })
    }
    return out
  },
})

export const finishOutput = action({
  args: { token, jobId: v.id('jobs'), uploadId: v.string(), parts: v.optional(v.array(finishedPart)) },
  returns: v.object({ ok: v.literal(true), bytes: v.number() }),
  handler: async (ctx, { token: t, jobId, uploadId, parts }): Promise<{ ok: true; bytes: number }> => {
    requireToken(t)
    const upload = await loadUpload(ctx, uploadId)
    if (upload.jobId !== jobId) throw invalid("This upload doesn't belong to that job.")
    return { ok: true as const, bytes: await shown(() => finishUpload(ctx, upload, parts)) }
  },
})

export const splatInfo = v.object({
  file: v.string(),
  format: v.union(v.literal('spz'), v.literal('3dgs-ply')),
  count: v.number(),
  shDegree: v.number(),
  source: v.union(v.literal('trained-from-video'), v.literal('trained-from-lidar-capture')),
})

export const complete = mutation({
  args: {
    token,
    jobId: v.id('jobs'),
    result: v.union(
      v.object({ kind: v.literal('bake'), derived: derived }),
      v.object({ kind: v.literal('convert'), manifestJson: v.string() }),
      v.object({ kind: v.literal('splat'), splat: splatInfo }),
    ),
    attempt,
  },
  returns: v.object({ ok: v.literal(true) }),
  handler: async (ctx, { token: t, jobId, result, attempt: a }) => {
    requireToken(t)
    const job = await requireJob(ctx, jobId)
    // Done, failed or superseded: nothing to do. Leased to another worker: it will finish it.
    // A reaped job nobody holds yet (queued) is still taken.
    if (job.status === 'done' || job.status === 'failed') return { ok: true as const }
    if (job.status === 'leased' && !holdsLease(job, a)) return { ok: true as const }
    if (result.kind !== job.kind) throw invalid(`This is a ${job.kind} job, not ${result.kind}.`)
    const capture = await getCapture(ctx, job.captureId)
    if (!capture) {
      await ctx.db.patch(job._id, { status: 'failed', error: 'The capture was deleted.', updatedAt: Date.now() })
      return { ok: true as const }
    }

    if (result.kind === 'bake') {
      if (result.derived.captureId !== capture.captureId) throw invalid(`derived.captureId is ${result.derived.captureId}, not ${capture.captureId}.`)
      for (const name of Object.values(result.derived.files)) {
        if (name && !(await getFile(ctx, capture.captureId, 'derived', name))) throw invalid(`Derived file ${name} isn't uploaded yet (finish it with worker.finishOutput first).`)
      }
      await ctx.db.patch(capture._id, { derived: result.derived })
      await markDone(ctx, job)
    } else if (result.kind === 'convert') {
      const manifest = parseManifest(result.manifestJson)
      if (manifest.id !== capture.captureId) throw invalid(`manifest.id is ${manifest.id}, not ${capture.captureId}.`)
      await ctx.db.patch(capture._id, { manifestJson: result.manifestJson, title: manifest.title || capture.title, durationSec: manifest.video.durationSec ?? capture.durationSec })
      const check = await completeUpload(ctx, (await ctx.db.get(capture._id)) ?? capture)
      if (!check.ok) {
        await markFailed(ctx, job, `The converted package is incomplete: ${check.errors.join(' ')}`, false)
        return { ok: true as const }
      }
      await markDone(ctx, job)
      const fresh = (await ctx.db.get(capture._id)) ?? capture
      if (manifest.room?.splat) await patchStatus(ctx, fresh, { splat: 'done' })
      else await enqueue(ctx, fresh, 'splat', { gpu: true, frames: convertFrames(manifest.video.durationSec) })
    } else {
      if (!(await getFile(ctx, capture.captureId, 'raw', result.splat.file))) throw invalid(`${result.splat.file} isn't uploaded yet (finish it with worker.finishOutput first).`)
      const manifest = JSON.parse(capture.manifestJson) as { room?: Record<string, unknown> }
      if (!manifest.room) throw invalid('This capture has no room to add a splat to.')
      manifest.room.splat = result.splat
      await ctx.db.patch(capture._id, { manifestJson: JSON.stringify(manifest) })
      await markDone(ctx, job)
    }
    return { ok: true as const }
  },
})

export const fail = mutation({
  args: { token, jobId: v.id('jobs'), error: v.string(), retryable: v.boolean(), attempt },
  returns: v.object({ ok: v.literal(true) }),
  handler: async (ctx, { token: t, jobId, error, retryable, attempt: a }) => {
    requireToken(t)
    const job = await requireJob(ctx, jobId)
    // Only the worker holding the lease can fail the job (a stale one would fail someone else's run).
    if (holdsLease(job, a)) await markFailed(ctx, job, error.slice(0, 2000) || 'The worker failed without saying why.', retryable)
    return { ok: true as const }
  },
})
