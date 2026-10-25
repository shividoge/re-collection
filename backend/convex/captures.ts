import { ConvexError, v } from 'convex/values'
import { parseManifest } from '../../shared/manifest'
import { internal } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import { action, internalAction, internalMutation, mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import { conflict, getCapture, getFile, getMomentDoc, initialStatus, invalid, keepSplat, listFiles, manifestOf, requireCapture } from './lib/data'
import { abortMultipart, deletePrefix, r2Config, r2ConfigOrNull, stableGetUrl, type R2Config } from './lib/r2'
import { queuedJobs } from './lib/jobs'
import { completeUpload } from './lib/stages'
import { isSourceName } from './lib/validate'
import { captureStatus, derived, fileUrl, jobKind } from './validators'

export const namedFile = v.object({ name: v.string(), ...fileUrl.fields })

export const reconstructionAssets = v.object({
  id: v.string(), manifestJson: v.string(), files: v.array(namedFile),
  derived: v.union(derived, v.null()), derivedFiles: v.array(namedFile),
})

/** Resolve a completed alternate scene without changing the memory's identity or facts. */
export async function preferredReconstruction(ctx: QueryCtx, capture: Doc<'captures'>) {
  const candidates = await ctx.db.query('captures')
    .withIndex('by_reconstructionOf', (q) => q.eq('reconstructionOf', capture.captureId)).order('desc').take(32)
  let best: Doc<'captures'> | null = null
  let points = manifestOf(capture)?.room?.points ?? 0
  for (const candidate of candidates) {
    if (candidate.deleting || candidate.status.upload !== 'done' || candidate.status.bake !== 'done' || !candidate.derived) continue
    const count = candidate.derived.stats.points
    if (count > points) { best = candidate; points = count }
  }
  if (!best) return undefined
  const raw = (await listFiles(ctx, best.captureId, 'raw')).filter((f) => f.name !== 'room.ply')
  const baked = await listFiles(ctx, best.captureId, 'derived')
  const cfg = r2Config()
  return { id: best.captureId, manifestJson: best.manifestJson, files: signFiles(cfg, raw), derived: best.derived, derivedFiles: signFiles(cfg, baked) }
}

/** A queued job and what it needs, so the web can say when no online worker can take it. */
export const queuedJob = v.object({ kind: jobKind, needs: v.object({ gpu: v.boolean(), frames: v.optional(v.number()) }) })

export const captureSummary = v.object({
  id: v.string(),
  title: v.string(),
  createdAt: v.string(),
  durationSec: v.number(),
  source: v.union(v.literal('phone'), v.literal('video')),
  thumbUrl: v.union(v.string(), v.null()),
  status: captureStatus,
  queued: v.array(queuedJob),
  public: v.boolean(),
})

export const captureDetail = v.object({
  id: v.string(),
  manifestJson: v.string(),
  status: captureStatus,
  queued: v.array(queuedJob),
  public: v.boolean(),
  /** Raw files (names as in capture-format.md, e.g. "keyframes/k0001.jpg"), presigned GET URLs. */
  files: v.array(namedFile),
  derived: v.union(derived, v.null()),
  /** Derived files (names as in derived.files), presigned GET URLs. */
  derivedFiles: v.array(namedFile),
  /** A video capture's uploaded source (`source.<ext>` under videos/<id>/), or null. */
  sourceVideo: v.union(namedFile, v.null()),
  reconstruction: v.optional(reconstructionAssets),
})

/** Presigned, day-stable GET URLs for files (architecture-v3.md §6.4). */
export function signFiles(cfg: R2Config, files: readonly Doc<'files'>[], now = Date.now()) {
  return files
    .map((f) => ({ name: f.name, url: stableGetUrl(cfg, f.key, f.rev, now), bytes: f.bytes, rev: f.rev }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function thumbUrl(ctx: Parameters<typeof listFiles>[0], captureId: string): Promise<string | null> {
  const thumb = await getFile(ctx, captureId, 'raw', 'thumb.jpg')
  return thumb ? stableGetUrl(r2Config(), thumb.key, thumb.rev, Date.now()) : null
}

/** Creates (or returns) the capture for this manifest. Idempotent per manifest id. */
export const begin = mutation({
  args: { manifestJson: v.string() },
  returns: v.object({ captureId: v.string() }),
  handler: async (ctx, { manifestJson }) => {
    let manifest
    try {
      manifest = parseManifest(manifestJson)
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error))
    }
    const fields = {
      manifestJson,
      title: manifest.title,
      createdAt: manifest.createdAt ?? new Date().toISOString(),
      durationSec: manifest.video.durationSec ?? 0,
    }
    const existing = await ctx.db.query('captures').withIndex('by_captureId', (q) => q.eq('captureId', manifest.id)).unique()
    if (existing?.deleting) throw conflict('This capture was just deleted and its files are still being removed. Try again in a minute.')
    if (existing) {
      await ctx.db.patch(existing._id, { ...fields, manifestJson: keepSplat(existing, manifestJson) })
    } else {
      const source = manifest.source === 'video' ? 'video' : 'phone'
      await ctx.db.insert('captures', { captureId: manifest.id, ...fields, status: initialStatus(source, Boolean(manifest.room?.splat)), public: false, derived: null })
    }
    return { captureId: manifest.id }
  },
})

/**
 * Validates the upload against the manifest; valid → bake queued. Invalid → the status says
 * `upload: invalid` with the reasons, and this throws ConvexError({ code: 'invalid', errors }).
 * An action (not a mutation) so the invalid status is saved even though the call throws.
 */
export const complete = action({
  args: { captureId: v.string() },
  returns: v.object({ ok: v.literal(true) }),
  handler: async (ctx, { captureId }): Promise<{ ok: true }> => {
    const check = await ctx.runMutation(internal.captures.completeInternal, { captureId })
    if (!check.ok) {
      throw new ConvexError({ code: 'invalid', errors: check.errors, message: `The capture isn't complete: ${check.errors.join(' ')}` })
    }
    return { ok: true }
  },
})

export const completeInternal = internalMutation({
  args: { captureId: v.string() },
  returns: v.object({ ok: v.boolean(), errors: v.array(v.string()), warnings: v.array(v.string()) }),
  handler: async (ctx, { captureId }) => completeUpload(ctx, await requireCapture(ctx, captureId)),
})

export const list = query({
  args: {},
  returns: v.array(captureSummary),
  handler: async (ctx) => {
    const captures = (await ctx.db.query('captures').withIndex('by_createdAt').order('desc').collect()).filter((c) => !c.deleting && !c.reconstructionOf)
    return Promise.all(
      captures.map(async (c) => {
        const moment = await getMomentDoc(ctx, c.captureId)
        return {
          id: c.captureId,
          title: c.title || moment?.moment.title || '',
          createdAt: c.createdAt,
          durationSec: c.durationSec,
          source: c.status.source,
          thumbUrl: await thumbUrl(ctx, c.captureId),
          status: c.status,
          queued: await queuedJobs(ctx, c.captureId),
          public: c.public,
        }
      }),
    )
  },
})

export const get = query({
  args: { captureId: v.string() },
  returns: v.union(captureDetail, v.null()),
  handler: async (ctx, { captureId }) => {
    const capture = await getCapture(ctx, captureId)
    if (!capture) return null
    const raw = await listFiles(ctx, capture.captureId, 'raw')
    const derivedRows = await listFiles(ctx, capture.captureId, 'derived')
    const videoRows = (await listFiles(ctx, capture.captureId, 'video')).filter((f) => isSourceName(f.name))
    const cfg = raw.length || derivedRows.length || videoRows.length ? r2Config() : null
    return {
      id: capture.captureId,
      manifestJson: capture.manifestJson,
      status: capture.status,
      queued: await queuedJobs(ctx, capture.captureId),
      public: capture.public,
      files: cfg ? signFiles(cfg, raw) : [],
      derived: capture.derived,
      derivedFiles: cfg ? signFiles(cfg, derivedRows) : [],
      sourceVideo: cfg ? (signFiles(cfg, videoRows)[0] ?? null) : null,
      reconstruction: await preferredReconstruction(ctx, capture),
    }
  },
})

export const setPublic = mutation({
  args: { captureId: v.string(), public: v.boolean() },
  returns: v.object({ ok: v.literal(true), public: v.boolean() }),
  handler: async (ctx, args) => {
    const capture = await requireCapture(ctx, args.captureId)
    await ctx.db.patch(capture._id, { public: args.public })
    return { ok: true as const, public: args.public }
  },
})

/**
 * Deletes the capture's rows now and leaves a tombstone (`deleting`), so the id can't be used
 * again until a scheduled action has deleted its R2 objects; that action then drops the tombstone.
 */
export const remove = mutation({
  args: { captureId: v.string() },
  returns: v.object({ ok: v.literal(true) }),
  handler: async (ctx, { captureId }) => {
    await removeCapture(ctx, await requireCapture(ctx, captureId))
    return { ok: true as const }
  },
})

/** Deletes a capture's rows, leaves the tombstone and schedules the purge (captures.remove, the abandoned sweep). */
async function removeCapture(ctx: MutationCtx, capture: Doc<'captures'>): Promise<void> {
  const id = capture.captureId
  if (!capture.reconstructionOf) {
    const scenes = await ctx.db.query('captures').withIndex('by_reconstructionOf', (q) => q.eq('reconstructionOf', id)).take(32)
    for (const scene of scenes) if (!scene.deleting) await removeCapture(ctx, scene)
  }
  const openUploads: { key: string; uploadId: string }[] = []
  for (const u of await ctx.db.query('uploads').withIndex('by_capture', (q) => q.eq('captureId', id)).collect()) {
    if (u.status === 'open' && u.r2UploadId) openUploads.push({ key: u.key, uploadId: u.r2UploadId })
    await ctx.db.delete(u._id)
  }
  for (const f of await listFiles(ctx, id)) await ctx.db.delete(f._id)
  for (const j of await ctx.db.query('jobs').withIndex('by_capture', (q) => q.eq('captureId', id)).collect()) await ctx.db.delete(j._id)
  for (const s of await ctx.db.query('sessions').withIndex('by_capture', (q) => q.eq('captureId', id)).collect()) await ctx.db.delete(s._id)
  const moment = await getMomentDoc(ctx, id)
  if (moment) await ctx.db.delete(moment._id)
  const arrangement = await ctx.db.query('museumArrangement').first()
  if (arrangement?.items.some((i) => i.capture === id)) {
    await ctx.db.patch(arrangement._id, { items: arrangement.items.filter((i) => i.capture !== id), updatedAt: new Date().toISOString() })
  }
  await ctx.db.patch(capture._id, { deleting: true })
  await ctx.scheduler.runAfter(0, internal.captures.purge, { captureId: id, openUploads })
}

/** An upload nobody has touched for this long is abandoned. */
export const ABANDONED_MS = 7 * 24 * 3600_000

/**
 * The daily sweep: removes captures whose upload was started but abandoned (still receiving, no
 * file, upload or status change for 7 days, nothing queued or running). Never one with a session,
 * reviewed facts, or (video) an uploaded source, since those hold someone's work.
 */
export const sweepAbandoned = internalMutation({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    const cutoff = Date.now() - ABANDONED_MS
    const removed: string[] = []
    for (const c of await ctx.db.query('captures').collect()) {
      if (c.deleting || c.status.upload !== 'receiving' || c.status.updatedAt > cutoff) continue
      const id = c.captureId
      const files = await listFiles(ctx, id)
      if (files.some((f) => f.createdAt > cutoff || f.area === 'video')) continue
      const uploads = await ctx.db.query('uploads').withIndex('by_capture', (q) => q.eq('captureId', id)).collect()
      if (uploads.some((u) => u.createdAt > cutoff)) continue
      const jobs = await ctx.db.query('jobs').withIndex('by_capture', (q) => q.eq('captureId', id)).collect()
      if (jobs.some((j) => j.status === 'queued' || j.status === 'leased')) continue
      if (await ctx.db.query('sessions').withIndex('by_capture', (q) => q.eq('captureId', id)).first()) continue
      if ((await getMomentDoc(ctx, id))?.facts.some((f) => f.status !== 'pending')) continue
      await removeCapture(ctx, c)
      removed.push(id)
    }
    if (removed.length) console.log(`Removed ${removed.length} abandoned upload(s): ${removed.join(', ')}`)
    return removed
  },
})

/** Deletes a removed capture's objects from R2, then its tombstone. Retried until it works. */
export const purge = internalAction({
  args: { captureId: v.string(), openUploads: v.array(v.object({ key: v.string(), uploadId: v.string() })), retry: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { captureId, openUploads, retry = 0 }) => {
    const cfg = r2ConfigOrNull()
    if (!cfg) {
      console.error(`R2 isn't configured, so the files of deleted capture ${captureId} were left in the bucket.`)
    } else {
      try {
        for (const u of openUploads) await abortMultipart(cfg, u.key, u.uploadId)
        const deleted = (await deletePrefix(cfg, `captures/${captureId}/`)) + (await deletePrefix(cfg, `videos/${captureId}/`))
        console.log(`Deleted ${deleted} objects of capture ${captureId}.`)
      } catch (error) {
        const waitMs = Math.min(60_000 * 2 ** retry, 3_600_000)
        console.error(`Deleting the files of capture ${captureId} failed (trying again in ${waitMs / 1000} s): ${error instanceof Error ? error.message : String(error)}`)
        await ctx.scheduler.runAfter(waitMs, internal.captures.purge, { captureId, openUploads, retry: retry + 1 })
        return null
      }
    }
    await ctx.runMutation(internal.captures.dropTombstone, { captureId })
    return null
  },
})

export const dropTombstone = internalMutation({
  args: { captureId: v.string() },
  returns: v.null(),
  handler: async (ctx, { captureId }) => {
    const row = await ctx.db.query('captures').withIndex('by_captureId', (q) => q.eq('captureId', captureId)).unique()
    if (row?.deleting) await ctx.db.delete(row._id)
    return null
  },
})
