import { v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { conflict, getCapture, getMomentDoc, listFiles, manifestOf, momentOf, notFound, requireCapture } from './lib/data'
import { activeJob, enqueue } from './lib/jobs'
import { captureStatus, fact, moment } from './validators'

/** The moment (facts + review state), or null with the capture's status while facts aren't ready. */
export const get = query({
  args: { captureId: v.string() },
  returns: v.object({ moment: v.union(moment, v.null()), status: v.union(captureStatus, v.null()) }),
  handler: async (ctx, { captureId }) => {
    const capture = await getCapture(ctx, captureId)
    if (!capture) return { moment: null, status: null }
    return { moment: momentOf(await getMomentDoc(ctx, capture.captureId)), status: capture.status }
  },
})

/** The family's review: approve, reject, reword, or mark "don't bring this up". */
export const patchFact = mutation({
  args: {
    captureId: v.string(),
    factId: v.string(),
    status: v.optional(v.union(v.literal('pending'), v.literal('approved'), v.literal('rejected'))),
    editedText: v.optional(v.union(v.string(), v.null())),
    doNotRaise: v.optional(v.boolean()),
  },
  returns: fact,
  handler: async (ctx, args) => {
    const capture = await requireCapture(ctx, args.captureId)
    const doc = await getMomentDoc(ctx, capture.captureId)
    const index = doc?.facts.findIndex((f) => f.id === args.factId) ?? -1
    if (!doc || index < 0) throw notFound(`No fact ${args.factId} in capture ${args.captureId}.`)
    const next = { ...doc.facts[index] }
    if (args.status !== undefined) next.status = args.status
    if (args.editedText !== undefined) next.editedText = args.editedText === null ? null : args.editedText.trim() || null
    if (args.doNotRaise !== undefined) next.doNotRaise = args.doNotRaise
    const facts = [...doc.facts]
    facts[index] = next
    await ctx.db.patch(doc._id, { facts })
    return next
  },
})

/** Re-runs extraction: replaces pending facts, keeps reviewed ones (merged against fresh state). */
export const reextract = mutation({
  args: { captureId: v.string() },
  returns: v.object({ ok: v.literal(true) }),
  handler: async (ctx, { captureId }) => {
    const capture = await requireCapture(ctx, captureId)
    const files = new Set((await listFiles(ctx, capture.captureId, 'raw')).map((f) => f.name))
    if (!manifestOf(capture) || !files.has('manifest.json')) throw conflict("The capture isn't uploaded far enough for facts yet.")
    if (await activeJob(ctx, capture.captureId, 'facts')) throw conflict('Facts are already being extracted.')
    await enqueue(ctx, capture, 'facts', { gpu: false })
    return { ok: true as const }
  },
})
