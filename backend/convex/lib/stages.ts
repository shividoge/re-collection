// Stage triggers (architecture-v3.md §5), all run inside mutations so they're transactional.
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import type { Area } from '../validators'
import { fileKey, getFile, listFiles, manifestOf, patchStatus } from './data'
import { activeJob, enqueue, holdsLease } from './jobs'
import { PUT_EXPIRES } from './r2'
import { convertFrames, factsInputsReady, isSourceName, validatePackage, type Check } from './validate'

export type NewFile = {
  area: Area
  name: string
  bytes: number
  contentType: string
  contentEncoding?: string
  indexedBytes?: number
  indexedCount?: number
  /** Where it's stored, when not at the file's usual key (a worker attempt's output). */
  key?: string
}

/** Objects to delete from R2 (and multipart uploads to abort first). Keys a file row uses are kept. */
export type Discard = { key: string; r2UploadId?: string }[]

/** Presigned PUTs stay valid this long, so an object may come back once more within it. */
export const LATE_PUT_MS = (PUT_EXPIRES + 5 * 60) * 1000

/**
 * Deletes objects nothing points at. `now` deletes at once (and again after every PUT URL for
 * them has expired, in case a late PUT recreates one); otherwise only after that delay, so
 * someone still reading a replaced file can finish.
 */
export async function scheduleDiscard(ctx: MutationCtx, objects: Discard, { now }: { now: boolean }): Promise<void> {
  if (objects.length === 0) return
  if (now) await ctx.scheduler.runAfter(0, internal.uploads.discard, { objects })
  await ctx.scheduler.runAfter(LATE_PUT_MS, internal.uploads.discard, { objects })
}

/** Registers (or re-registers, bumping `rev`) a stored file. */
export async function registerFile(ctx: MutationCtx, capture: Doc<'captures'>, file: NewFile): Promise<Doc<'files'>> {
  const existing = await getFile(ctx, capture.captureId, file.area, file.name)
  const row = { captureId: capture.captureId, createdAt: Date.now(), ...file, key: file.key ?? fileKey(capture.captureId, file.area, file.name) }
  if (existing) {
    await ctx.db.replace(existing._id, { ...row, rev: existing.rev + 1 })
    if (existing.key !== row.key) await scheduleDiscard(ctx, [{ key: existing.key }], { now: false })
    return (await ctx.db.get(existing._id)) as Doc<'files'>
  }
  const id = await ctx.db.insert('files', { ...row, rev: 1 })
  return (await ctx.db.get(id)) as Doc<'files'>
}

/**
 * After a file lands: a re-upload from the phone re-opens the upload (as the guide did), the
 * source video queues the conversion, and facts start as soon as Claude's inputs are all here.
 */
export async function afterFileRegistered(ctx: MutationCtx, capture: Doc<'captures'>, file: Doc<'files'>, fromJob: boolean): Promise<void> {
  if (file.area === 'video' && isSourceName(file.name)) {
    const seed = JSON.parse(capture.manifestJson) as { video?: { durationSec?: number } }
    await enqueue(ctx, capture, 'convert', { gpu: true, frames: convertFrames(seed.video?.durationSec) })
    return
  }
  if (file.area !== 'raw') return
  if (!fromJob && capture.status.upload !== 'receiving') await patchStatus(ctx, capture, { upload: 'receiving', uploadErrors: [] })
  await maybeQueueFacts(ctx, capture, false)
}

/** Queues facts once, when its inputs are registered (or at upload complete for old captures). */
export async function maybeQueueFacts(ctx: MutationCtx, capture: Doc<'captures'>, uploadComplete: boolean): Promise<void> {
  const fresh = (await ctx.db.get(capture._id)) ?? capture
  if (fresh.status.facts !== 'not_started') return
  const manifest = manifestOf(fresh)
  if (!manifest) return
  const files = await listFiles(ctx, fresh.captureId, 'raw')
  if (uploadComplete || factsInputsReady(manifest, files)) await enqueue(ctx, fresh, 'facts', { gpu: false })
}

/**
 * Checks the package against its manifest (§5 trigger 2). Valid → upload done, bake queued (and
 * facts, if not yet). Invalid → upload invalid with the reasons. Writes the status either way.
 */
export async function completeUpload(ctx: MutationCtx, capture: Doc<'captures'>): Promise<Check> {
  const manifest = manifestOf(capture)
  if (!manifest) {
    const errors = ["manifest.json isn't a readable capture manifest yet."]
    await patchStatus(ctx, capture, { upload: 'invalid', uploadErrors: errors })
    return { ok: false, errors, warnings: [] }
  }
  const check = validatePackage(capture.captureId, manifest, await listFiles(ctx, capture.captureId, 'raw'))
  if (!check.ok) {
    await patchStatus(ctx, capture, { upload: 'invalid', uploadErrors: check.errors, warnings: check.warnings })
    return check
  }
  await patchStatus(ctx, capture, { upload: 'done', uploadErrors: [], warnings: check.warnings })
  await maybeQueueFacts(ctx, capture, true)
  // A fresh upload is baked again, even if an earlier bake finished. A bake still running read the
  // old inputs: it's superseded (its next heartbeat says cancelled) and a new one is queued.
  const running = await activeJob(ctx, capture.captureId, 'bake')
  if (running?.status === 'leased') {
    await ctx.db.patch(running._id, { status: 'failed', error: 'A newer upload replaced its inputs.', leaseUntil: null, updatedAt: Date.now() })
  }
  if (running?.status !== 'queued') await enqueue(ctx, (await ctx.db.get(capture._id)) ?? capture, 'bake', { gpu: false })
  return check
}

/**
 * Publishes what the job's lease-holding attempt stored (worker.finishOutput stages files; only
 * `worker.complete` by that attempt makes them current). Returns the published files.
 */
export async function publishOutputs(ctx: MutationCtx, capture: Doc<'captures'>, job: Doc<'jobs'>): Promise<Doc<'files'>[]> {
  const attempt = job.attempts + 1
  const staged = await ctx.db.query('uploads').withIndex('by_job', (q) => q.eq('jobId', job._id).eq('attempt', attempt)).collect()
  const published: Doc<'files'>[] = []
  for (const u of staged) {
    if (u.status !== 'staged') continue
    await ctx.db.patch(u._id, { status: 'done' })
    published.push(
      await registerFile(ctx, capture, {
        area: u.area,
        name: u.name,
        bytes: u.bytes,
        contentType: u.contentType,
        key: u.key,
        ...(u.contentEncoding ? { contentEncoding: u.contentEncoding } : {}),
        ...(u.indexedBytes !== undefined ? { indexedBytes: u.indexedBytes, indexedCount: u.indexedCount } : {}),
      }),
    )
  }
  if (published.some((f) => f.area === 'raw')) await maybeQueueFacts(ctx, capture, false)
  return published
}

/**
 * Worker uploads (open or staged) of attempts that no longer hold their job's lease: expired,
 * failed, superseded or already completed. Their rows go now and their objects are deleted.
 */
export async function sweepStaleOutputs(ctx: MutationCtx): Promise<number> {
  const objects: Discard = []
  for (const status of ['open', 'staged'] as const) {
    for (const u of await ctx.db.query('uploads').withIndex('by_status', (q) => q.eq('status', status)).collect()) {
      if (!u.jobId) continue
      const job = await ctx.db.get(u.jobId)
      if (job && holdsLease(job, u.attempt ?? 0)) continue
      // (Uploads from before attempt keys wrote to the published key; uploads.discard keeps those.)
      objects.push({ key: u.key, ...(status === 'open' && u.r2UploadId ? { r2UploadId: u.r2UploadId } : {}) })
      await ctx.db.delete(u._id)
    }
  }
  await scheduleDiscard(ctx, objects, { now: true })
  return objects.length
}
