import { v } from 'convex/values'
import { internalMutation } from './_generated/server'
import { reapExpired } from './lib/jobs'
import { sweepStaleOutputs } from './lib/stages'

/**
 * Re-queues (or fails, at the third attempt) every job whose lease ran out, then deletes the
 * outputs of attempts that lost their lease. Returns how many leases expired.
 */
export const reap = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const expired = await reapExpired(ctx)
    await sweepStaleOutputs(ctx)
    return expired
  },
})
