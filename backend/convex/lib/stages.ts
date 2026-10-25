// Stage triggers (architecture-v3.md §5), all run inside mutations so they're transactional.
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import type { Area } from '../validators'
import { fileKey, getFile, listFiles, manifestOf, patchStatus } from './data'
import { activeJob, enqueue } from './jobs'
import { convertFrames, factsInputsReady, isSourceName, validatePackage, type Check } from './validate'

export type NewFile = {
  area: Area
  name: string
  bytes: number
  contentType: string
  contentEncoding?: string
  indexedBytes?: number
  indexedCount?: number
}

/** Registers (or re-registers, bumping `rev`) a stored file. */
export async function registerFile(ctx: MutationCtx, capture: Doc<'captures'>, file: NewFile): Promise<Doc<'files'>> {
  const existing = await getFile(ctx, capture.captureId, file.area, file.name)
  const row = { captureId: capture.captureId, key: fileKey(capture.captureId, file.area, file.name), createdAt: Date.now(), ...file }
  if (existing) {
    await ctx.db.replace(existing._id, { ...row, rev: existing.rev + 1 })
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
  // A fresh upload is baked again even if an earlier bake finished.
  if (!(await activeJob(ctx, capture.captureId, 'bake'))) await enqueue(ctx, (await ctx.db.get(capture._id)) ?? capture, 'bake', { gpu: false })
  return check
}
