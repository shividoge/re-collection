import { v } from 'convex/values'
import { query, type QueryCtx } from './_generated/server'
import type { Doc } from './_generated/dataModel'
import { getMomentDoc, momentOf, requireCapture } from './lib/data'
import { progressReport } from './lib/session'
import { progressReport as progressValidator } from './validators'

export async function progressFor(ctx: QueryCtx, capture: Doc<'captures'>) {
  const sessions = await ctx.db.query('sessions').withIndex('by_capture', (q) => q.eq('captureId', capture.captureId)).collect()
  return progressReport(capture.captureId, momentOf(await getMomentDoc(ctx, capture.captureId)), capture.createdAt, sessions)
}

/** Recall per finished session, with real times; approved facts; next revisits (+1, +3, +7, +14 days). */
export const get = query({
  args: { captureId: v.string() },
  returns: progressValidator,
  handler: async (ctx, { captureId }) => progressFor(ctx, await requireCapture(ctx, captureId)),
})
