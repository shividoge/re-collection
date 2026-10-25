import { v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { notImplemented } from './lib_stub'
import { captureStatus, fact, moment } from './validators'

/** The moment (facts + review state), or null with the capture's status while facts aren't ready. */
export const get = query({
  args: { captureId: v.string() },
  returns: v.object({ moment: v.union(moment, v.null()), status: v.union(captureStatus, v.null()) }),
  handler: async () => notImplemented('moments.get'),
})

export const patchFact = mutation({
  args: {
    captureId: v.string(),
    factId: v.string(),
    status: v.optional(v.union(v.literal('pending'), v.literal('approved'), v.literal('rejected'))),
    editedText: v.optional(v.union(v.string(), v.null())),
    doNotRaise: v.optional(v.boolean()),
  },
  returns: fact,
  handler: async () => notImplemented('moments.patchFact'),
})

/** Re-runs extraction: replaces pending facts, keeps reviewed ones (merged against fresh state). */
export const reextract = mutation({
  args: { captureId: v.string() },
  returns: v.object({ ok: v.literal(true) }),
  handler: async () => notImplemented('moments.reextract'),
})
