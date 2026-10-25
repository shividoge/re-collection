import { v } from 'convex/values'
import { action } from './_generated/server'
import { notImplemented } from './lib_stub'
import { finishedPart, uploadTarget } from './validators'

/**
 * Starts uploading one file of a capture. Files ≤ 8 MiB get one presigned PUT (`single`);
 * bigger ones a multipart upload with presigned part URLs (`parts`, `partSize`).
 * `name` "source.<ext>" on a video capture goes to videos/<id>/ and queues convert on finish.
 */
export const start = action({
  args: { captureId: v.string(), name: v.string(), bytes: v.number(), contentType: v.string() },
  returns: uploadTarget,
  handler: async () => notImplemented('uploads.start'),
})

/** The same upload's remaining parts (those R2 doesn't have yet), with fresh URLs. */
export const resume = action({
  args: { uploadId: v.string() },
  returns: v.object({ target: uploadTarget, done: v.array(finishedPart) }),
  handler: async () => notImplemented('uploads.resume'),
})

/** Completes the upload, checks the stored size, registers the file (→ stage triggers). */
export const finish = action({
  args: { uploadId: v.string(), parts: v.optional(v.array(finishedPart)) },
  returns: v.object({ ok: v.literal(true), bytes: v.number() }),
  handler: async () => notImplemented('uploads.finish'),
})
