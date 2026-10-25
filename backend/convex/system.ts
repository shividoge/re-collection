import { v } from 'convex/values'
import { query } from './_generated/server'
import { notImplemented } from './lib_stub'

export const health = query({
  args: {},
  returns: v.object({
    ok: v.literal(true),
    mock: v.boolean(),
    models: v.object({ offline: v.string(), live: v.string() }),
    workers: v.array(v.object({ workerId: v.string(), kinds: v.array(v.string()), gpu: v.boolean(), maxFrames: v.union(v.number(), v.null()), lastSeen: v.number() })),
  }),
  handler: async () => notImplemented('system.health'),
})
