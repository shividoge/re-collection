import { v } from 'convex/values'
import { query } from './_generated/server'
import { notImplemented } from './lib_stub'
import { progressReport } from './validators'

export const get = query({
  args: { captureId: v.string() },
  returns: progressReport,
  handler: async () => notImplemented('progress.get'),
})
