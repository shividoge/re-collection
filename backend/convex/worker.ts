// The job protocol for bake and GPU workers (docs/architecture-v3.md §7). Every function takes
// the shared WORKER_TOKEN and, after claim, the `attempt` claim returned: only the attempt holding
// the job's lease can read inputs, write outputs (to keys of its own) and complete or fail it.
import { ConvexError, v } from 'convex/values'
import { parseManifest } from '../../shared/manifest'
import { internal } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import { action, internalQuery, mutation } from './_generated/server'
import { getCapture, getFile, invalid, listFiles, notFound, patchStatus, workerKey } from './lib/data'
import { canRun, cancelled, enqueue, heartbeat as extendLease, holdsLease, lease, markDone, markFailed, requireLease, requireToken, seeWorker } from './lib/jobs'
import { r2Config, stableGetUrl } from './lib/r2'
import { completeUpload, publishOutputs } from './lib/stages'
import { convertFrames, isFileName } from './lib/validate'
import { createTarget, finishUpload, loadUpload } from './uploads'
import { shown } from './lib/errors'
import { area, derived, finishedPart, jobKind, progress, uploadTarget, type Area, type UploadTarget } from './validators'

const token = v.string()
/** The `attempt` claim returned; required on every call about the job. */
const attempt = v.number()

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
  args: { jobId: v.id('jobs'), attempt },
  handler: async (ctx, { jobId, attempt: a }) => {
    const job = await requireLease(ctx, jobId, a)
    const capture = await getCapture(ctx, job.captureId)
    if (!capture) throw cancelled('The capture of this job was deleted.')
    const files = await listFiles(ctx, capture.captureId, job.kind === 'convert' ? 'video' : 'raw')
    return { job, manifestJson: capture.manifestJson, files }
  },
})

/** Presigned GETs for the job's inputs: the capture's raw files, or the source video for convert. */
export const inputs = action({
  args: { token, jobId: v.id('jobs'), attempt },
  returns: v.object({
    manifestJson: v.union(v.string(), v.null()),
    files: v.array(v.object({ name: v.string(), area: area, url: v.string(), bytes: v.number() })),
  }),
  handler: async (ctx, { token: t, jobId, attempt: a }): Promise<{ manifestJson: string | null; files: { name: string; area: Area; url: string; bytes: number }[] }> => {
    requireToken(t)
    const { manifestJson, files } = await ctx.runQuery(internal.worker.jobFiles, { jobId, attempt: a })
    const cfg = r2Config()
    const now = Date.now()
    return { manifestJson, files: files.map((f) => ({ name: f.name, area: f.area, url: stableGetUrl(cfg, f.key, f.rev, now), bytes: f.bytes })) }
  },
})

/**
 * Upload targets for the attempt's outputs, under keys of its own (data.workerKey). Finished
 * outputs are staged; `complete` by the same attempt publishes them.
 */
export const outputUrls = action({
  args: {
    token,
    jobId: v.id('jobs'),
    attempt,
    files: v.array(v.object({ name: v.string(), bytes: v.number(), contentType: v.string(), contentEncoding: v.optional(v.string()), area: v.union(v.literal('raw'), v.literal('derived')) })),
  },
  returns: v.array(v.object({ name: v.string(), target: uploadTarget })),
  handler: async (ctx, { token: t, jobId, attempt: a, files }): Promise<{ name: string; target: UploadTarget }[]> => {
    requireToken(t)
    const { job } = await ctx.runQuery(internal.worker.jobFiles, { jobId, attempt: a })
    const out = []
    for (const f of files) {
      if (!isFileName(f.name)) throw invalid(`"${f.name}" isn't an allowed file name.`)
      if (!Number.isInteger(f.bytes) || f.bytes < 0) throw invalid(`${f.name}: bytes must be a whole number.`)
      const target = await shown(() => createTarget(ctx, { captureId: job.captureId, ...f, key: workerKey(job.captureId, f.area, jobId, a, f.name), jobId, attempt: a }))
      out.push({ name: f.name, target })
    }
    return out
  },
})

/** Completes one output in R2 and stages it (only while this attempt holds the lease). */
export const finishOutput = action({
  args: { token, jobId: v.id('jobs'), attempt, uploadId: v.string(), parts: v.optional(v.array(finishedPart)) },
  returns: v.object({ ok: v.literal(true), bytes: v.number() }),
  handler: async (ctx, { token: t, jobId, attempt: a, uploadId, parts }): Promise<{ ok: true; bytes: number }> => {
    requireToken(t)
    const upload = await loadUpload(ctx, uploadId)
    if (upload.jobId !== jobId || upload.attempt !== a) throw invalid("This upload doesn't belong to that job attempt.")
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
    const job = await ctx.db.get(jobId)
    // This attempt completed it already (a retry after a lost answer): the same answer.
    if (job?.status === 'done' && job.attempts + 1 === a) return { ok: true as const }
    // Expired, superseded, failed or done by another attempt: its outputs are never published.
    if (!job || !holdsLease(job, a)) throw cancelled()
    if (result.kind !== job.kind) throw invalid(`This is a ${job.kind} job, not ${result.kind}.`)
    const capture = await getCapture(ctx, job.captureId)
    if (!capture) throw cancelled('The capture of this job was deleted.')
    const published = new Set((await publishOutputs(ctx, capture, job)).map((f) => `${f.area}/${f.name}`))
    const uploadedHere = (area: Area, name: string) => published.has(`${area}/${name}`)

    if (result.kind === 'bake') {
      if (result.derived.captureId !== capture.captureId) throw invalid(`derived.captureId is ${result.derived.captureId}, not ${capture.captureId}.`)
      for (const name of Object.values(result.derived.files)) {
        if (name && !uploadedHere('derived', name)) throw invalid(`Derived file ${name} wasn't uploaded by this attempt (finish it with worker.finishOutput first).`)
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
      if (!uploadedHere('raw', result.splat.file)) throw invalid(`${result.splat.file} wasn't uploaded by this attempt (finish it with worker.finishOutput first).`)
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
    const job = await ctx.db.get(jobId)
    // Only the attempt holding the lease can fail the job (a stale one would fail someone else's run).
    if (!job || !holdsLease(job, a)) throw cancelled()
    await markFailed(ctx, job, error.slice(0, 2000) || 'The worker failed without saying why.', retryable)
    return { ok: true as const }
  },
})
