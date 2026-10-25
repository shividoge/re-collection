import { v } from 'convex/values'
import { internalMutation } from './_generated/server'
import { reapExpired } from './lib/jobs'

/** Re-queues (or fails, at the third attempt) every job whose lease ran out. */
export const reap = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => reapExpired(ctx),
})
