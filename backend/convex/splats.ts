// Room splats for captures that came before phone captures got one (lib/stages.ts maybeQueueSplat).
//   bunx convex run splats:backfill '{"dryRun": true}'   lists what it would queue
//   bunx convex run splats:backfill '{"dryRun": false}'  queues them for the GPU worker
import { v } from 'convex/values'
import { internalMutation } from './_generated/server'
import { maybeQueueSplat } from './lib/stages'

export const backfill = internalMutation({
  args: { dryRun: v.boolean() },
  returns: v.array(v.object({ captureId: v.string(), title: v.string(), result: v.string() })),
  handler: async (ctx, { dryRun }) => {
    const out = []
    for (const capture of await ctx.db.query('captures').collect()) {
      let result: string
      if (capture.deleting) result = 'being deleted'
      else if (capture.status.upload !== 'done') result = `upload ${capture.status.upload}`
      else result = await maybeQueueSplat(ctx, capture, { dryRun })
      out.push({ captureId: capture.captureId, title: capture.title, result })
    }
    return out
  },
})
