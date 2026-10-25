import { v } from 'convex/values'
import { mutation } from './_generated/server'
import { initialStatus, invalid } from './lib/data'
import { MAX_FILE_BYTES } from './uploads'

/**
 * A new capture from an old video. Upload the video next with uploads.start({ name:
 * 'source.<ext>' }); finishing that upload queues the GPU conversion.
 *
 * Until the conversion registers the real package, the capture's manifestJson is a seed with only
 * what the family typed ({ id, title, attendees, createdAt, source: 'video', video: { file,
 * durationSec } }); the GPU worker reads it from worker.inputs. It has no depth, so
 * shared/manifest.ts parseManifest rejects it: show the conversion status instead.
 */
export const create = mutation({
  args: { title: v.string(), attendees: v.array(v.string()), fileName: v.string(), bytes: v.number(), durationSec: v.optional(v.number()) },
  returns: v.object({ captureId: v.string() }),
  handler: async (ctx, args) => {
    const ext = /\.([A-Za-z0-9]{1,5})$/.exec(args.fileName)?.[1]?.toLowerCase()
    if (!ext) throw invalid(`"${args.fileName}" has no file extension, so the video type is unknown.`)
    if (!Number.isInteger(args.bytes) || args.bytes <= 0 || args.bytes > MAX_FILE_BYTES) throw invalid('bytes must be the video size, up to 8 GB.')
    const captureId = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    const title = args.title.replace(/\s+/g, ' ').trim().slice(0, 120)
    const attendees = args.attendees.map((a) => a.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 40)
    const durationSec = args.durationSec !== undefined && Number.isFinite(args.durationSec) && args.durationSec > 0 ? args.durationSec : undefined
    const seed = { id: captureId, title, attendees, createdAt, source: 'video', video: { file: `source.${ext}`, durationSec } }
    await ctx.db.insert('captures', {
      captureId,
      manifestJson: JSON.stringify(seed),
      title,
      createdAt,
      durationSec: durationSec ?? 0,
      status: { ...initialStatus('video', false), convert: 'not_started', splat: 'not_started' },
      public: false,
      derived: null,
    })
    return { captureId }
  },
})
