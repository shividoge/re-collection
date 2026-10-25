// Writes only the import script (and operators) may make: restoring review state and sessions
// from the guide's data folder. Every function takes the shared WORKER_TOKEN.
import { v } from 'convex/values'
import { action, mutation } from './_generated/server'
import { getMomentDoc, invalid, manifestOf, patchStatus, requireCapture } from './lib/data'
import { activeJob, requireToken, supersede } from './lib/jobs'
import { shown } from './lib/errors'
import { listKeys, r2Config } from './lib/r2'
import { moment, session } from './validators'

/** Link an imported scene to its memory before uploading; keep facts and sessions on the original. */
export const registerReconstruction = mutation({
  args: { token: v.string(), captureId: v.string(), originalId: v.string() },
  returns: v.object({ ok: v.literal(true) }),
  handler: async (ctx, { token, captureId, originalId }) => {
    requireToken(token)
    const original = await requireCapture(ctx, originalId)
    const scene = await requireCapture(ctx, captureId)
    if (original.reconstructionOf || original._id === scene._id) throw invalid('A reconstruction must link to an original memory.')
    if (scene.reconstructionOf && scene.reconstructionOf !== original.captureId) throw invalid('This reconstruction belongs to another memory.')
    if (!scene.reconstructionOf) {
      const existing = await ctx.db.query('captures').withIndex('by_reconstructionOf', (q) => q.eq('reconstructionOf', original.captureId)).take(32)
      if (existing.length === 32) throw invalid('Remove an older reconstruction before importing another one.')
    }
    const a = manifestOf(original)
    const b = manifestOf(scene)
    if (!a || !b || (b.room?.points ?? 0) <= (a.room?.points ?? 0)) throw invalid('The reconstruction must contain more room points than the original.')
    if (Math.abs(original.durationSec - scene.durationSec) > Math.max(1, original.durationSec * 0.05)) throw invalid('The reconstruction must cover the same recording.')
    if (await activeJob(ctx, scene.captureId, 'facts')) throw invalid('Wait for this reconstruction\'s fact job to finish before linking it.')
    await ctx.db.patch(scene._id, { reconstructionOf: original.captureId, public: false })
    if (scene.status.facts === 'not_started') await patchStatus(ctx, scene, { facts: 'skipped' })
    return { ok: true as const }
  },
})

/** Puts a moment (facts + review) on a capture as is, and marks facts done so nothing re-extracts it. */
export const importMoment = mutation({
  args: { token: v.string(), moment: moment },
  returns: v.object({ ok: v.literal(true), replaced: v.boolean() }),
  handler: async (ctx, { token, moment: m }) => {
    requireToken(token)
    const capture = await requireCapture(ctx, m.captureId)
    const doc = { ...m, captureId: capture.captureId }
    const existing = await getMomentDoc(ctx, capture.captureId)
    if (existing) await ctx.db.replace(existing._id, doc)
    else await ctx.db.insert('moments', doc)
    const errors = { ...capture.status.errors }
    delete errors.facts
    await patchStatus(ctx, capture, { facts: 'done', errors })
    return { ok: true as const, replaced: existing !== null }
  },
})

/** Restores a session (by its id) exactly as recorded, with its real times. */
export const importSession = mutation({
  args: { token: v.string(), session: session },
  returns: v.object({ ok: v.literal(true), replaced: v.boolean() }),
  handler: async (ctx, { token, session: s }) => {
    requireToken(token)
    await requireCapture(ctx, s.captureId)
    const existing = await ctx.db.query('sessions').withIndex('by_sessionId', (q) => q.eq('sessionId', s.sessionId)).unique()
    if (existing) await ctx.db.replace(existing._id, s)
    else await ctx.db.insert('sessions', s)
    return { ok: true as const, replaced: existing !== null }
  },
})

/**
 * Lets a video capture be converted again with the current converter: upload its source video
 * next (uploads.start "source.<ext>", scripts/reconvert-video.ts), which queues the conversion.
 * The new package replaces the files it writes; facts, the review and sessions stay. A splat of
 * the old conversion is dropped (a new one is trained after the conversion).
 */
export const reconvertVideo = mutation({
  args: { token: v.string(), captureId: v.string() },
  returns: v.object({ ok: v.literal(true) }),
  handler: async (ctx, { token, captureId }) => {
    requireToken(token)
    const capture = await requireCapture(ctx, captureId)
    if (capture.status.source !== 'video') throw invalid('Only a capture made from a video can be converted again.')
    if (await activeJob(ctx, captureId, 'convert')) throw invalid('This video is already being converted.')
    await supersede(ctx, captureId, 'splat', 'The video is being converted again.')
    const fresh = (await ctx.db.get(capture._id)) ?? capture
    await patchStatus(ctx, fresh, { convert: 'not_started', splat: 'not_started' })
    return { ok: true as const }
  },
})

/** Removes a worker from the online list (a retired machine, or a test worker). */
export const forgetWorker = mutation({
  args: { token: v.string(), workerId: v.string() },
  returns: v.object({ ok: v.literal(true), removed: v.boolean() }),
  handler: async (ctx, { token, workerId }) => {
    requireToken(token)
    const row = await ctx.db.query('workers').withIndex('by_workerId', (q) => q.eq('workerId', workerId)).unique()
    if (row) await ctx.db.delete(row._id)
    return { ok: true as const, removed: row !== null }
  },
})

/** Object keys in the bucket under a prefix (at most 1000), to check what a capture left behind. */
export const storageKeys = action({
  args: { token: v.string(), prefix: v.string() },
  returns: v.array(v.string()),
  handler: async (_ctx, { token, prefix }) => {
    requireToken(token)
    if (!prefix.startsWith('captures/') && !prefix.startsWith('videos/')) throw invalid('prefix must start with captures/ or videos/.')
    return shown(async () => (await listKeys(r2Config(), prefix)).slice(0, 1000))
  },
})
