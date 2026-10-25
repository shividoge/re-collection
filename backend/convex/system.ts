import { v } from 'convex/values'
import { query } from './_generated/server'
import { claudeConfig } from './lib/claude'

export const health = query({
  args: {},
  returns: v.object({
    ok: v.literal(true),
    mock: v.boolean(),
    models: v.object({ offline: v.string(), live: v.string() }),
    workers: v.array(v.object({ workerId: v.string(), kinds: v.array(v.string()), gpu: v.boolean(), maxFrames: v.union(v.number(), v.null()), lastSeen: v.number() })),
  }),
  handler: async (ctx) => {
    const config = claudeConfig()
    const workers = (await ctx.db.query('workers').collect())
      .map((w) => ({ workerId: w.workerId, kinds: w.kinds, gpu: w.gpu, maxFrames: w.maxFrames ?? null, lastSeen: w.lastSeen }))
      .sort((a, b) => b.lastSeen - a.lastSeen)
    return { ok: true as const, mock: config.mock, models: config.models, workers }
  },
})
