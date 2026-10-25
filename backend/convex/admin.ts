// Writes only the import script (and operators) may make: restoring review state and sessions
// from the guide's data folder. Every function takes the shared WORKER_TOKEN.
import { v } from 'convex/values'
import { mutation } from './_generated/server'
import { getMomentDoc, patchStatus, requireCapture } from './lib/data'
import { requireToken } from './lib/jobs'
import { moment, session } from './validators'

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
