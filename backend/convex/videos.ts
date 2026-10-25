import { v } from 'convex/values'
import { mutation } from './_generated/server'
import { notImplemented } from './lib_stub'

/** A new capture from an old video. Upload the video next with uploads.start({ name: 'source.<ext>' }). */
export const create = mutation({
  args: { title: v.string(), attendees: v.array(v.string()), fileName: v.string(), bytes: v.number(), durationSec: v.optional(v.number()) },
  returns: v.object({ captureId: v.string() }),
  handler: async () => notImplemented('videos.create'),
})
