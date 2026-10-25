import { ConvexError, v } from 'convex/values'
import { parseManifest } from '../../shared/manifest'
import { internal } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import { action, internalAction, internalMutation, mutation, query } from './_generated/server'
import { conflict, getCapture, getFile, getMomentDoc, initialStatus, invalid, listFiles, manifestOf, requireCapture } from './lib/data'
import { abortMultipart, deletePrefix, r2Config, r2ConfigOrNull, stableGetUrl, type R2Config } from './lib/r2'
import { completeUpload } from './lib/stages'
import { captureStatus, derived, fileUrl } from './validators'

export const namedFile = v.object({ name: v.string(), ...fileUrl.fields })

export const captureSummary = v.object({
  id: v.string(),
  title: v.string(),
  createdAt: v.string(),
  durationSec: v.number(),
  source: v.union(v.literal('phone'), v.literal('video')),
  thumbUrl: v.union(v.string(), v.null()),
  status: captureStatus,
  public: v.boolean(),
})

export const captureDetail = v.object({
  id: v.string(),
  manifestJson: v.string(),
  status: captureStatus,
  public: v.boolean(),
  /** Raw files (names as in capture-format.md, e.g. "keyframes/k0001.jpg"), presigned GET URLs. */
  files: v.array(namedFile),
  derived: v.union(derived, v.null()),
  /** Derived files (names as in derived.files), presigned GET URLs. */
  derivedFiles: v.array(namedFile),
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
      // Keep a splat the splat job added, if this manifest doesn't bring one.
      const splat = manifestOf(existing)?.room?.splat
      if (splat && manifest.room && !manifest.room.splat) {
        const merged = JSON.parse(manifestJson) as { room: Record<string, unknown> }
        merged.room.splat = splat
        fields.manifestJson = JSON.stringify(merged)
      }
      await ctx.db.patch(existing._id, fields)
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
    const captures = (await ctx.db.query('captures').withIndex('by_createdAt').order('desc').collect()).filter((c) => !c.deleting)
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
    const cfg = raw.length || derivedRows.length ? r2Config() : null
    return {
      id: capture.captureId,
      manifestJson: capture.manifestJson,
      status: capture.status,
      public: capture.public,
      files: cfg ? signFiles(cfg, raw) : [],
      derived: capture.derived,
      derivedFiles: cfg ? signFiles(cfg, derivedRows) : [],
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
    const capture = await requireCapture(ctx, captureId)
    const id = capture.captureId
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
    return { ok: true as const }
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
