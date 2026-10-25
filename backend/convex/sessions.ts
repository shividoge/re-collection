import { v } from 'convex/values'
import { action, query, mutation } from './_generated/server'
import { notImplemented } from './lib_stub'
import { endReason, endSummary, focus, reply, session } from './validators'

/** 409-equivalent ConvexError({ code: 'no_facts' }) when no facts are approved yet. */
export const start = mutation({
  args: { captureId: v.string() },
  returns: v.object({ sessionId: v.string(), welcome: reply }),
  handler: async () => notImplemented('sessions.start'),
})

export const narrate = action({
  args: { sessionId: v.string(), chapterIndex: v.number() },
  returns: v.object({ reply: reply }),
  handler: async () => notImplemented('sessions.narrate'),
})

export const turn = action({
  args: { sessionId: v.string(), text: v.string(), focus: v.optional(focus) },
  returns: v.object({ reply: reply, branch: v.union(v.string(), v.null()), distress: v.boolean() }),
  handler: async () => notImplemented('sessions.turn'),
})

/** Runs scoring once; calling it again returns the same result. */
export const end = action({
  args: { sessionId: v.string(), reason: endReason },
  returns: endSummary,
  handler: async () => notImplemented('sessions.end'),
})

export const get = query({
  args: { sessionId: v.string() },
  returns: v.union(session, v.null()),
  handler: async () => notImplemented('sessions.get'),
})
