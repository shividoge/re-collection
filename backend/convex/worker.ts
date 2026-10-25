// The job protocol for bake and GPU workers (docs/architecture-v3.md §7). Every function takes
// the shared WORKER_TOKEN.
import { v } from 'convex/values'
import { action, mutation } from './_generated/server'
import { notImplemented } from './lib_stub'
import { area, derived, finishedPart, jobKind, progress, uploadTarget } from './validators'

const token = v.string()

export const claim = mutation({
  args: { token, workerId: v.string(), kinds: v.array(jobKind), gpu: v.boolean(), maxFrames: v.optional(v.number()) },
  returns: v.union(v.object({ jobId: v.id('jobs'), kind: jobKind, captureId: v.string(), attempt: v.number() }), v.null()),
  handler: async () => notImplemented('worker.claim'),
})

export const heartbeat = mutation({
  args: { token, jobId: v.id('jobs'), progress: v.optional(progress) },
  returns: v.object({ ok: v.boolean(), cancelled: v.boolean() }),
  handler: async () => notImplemented('worker.heartbeat'),
})

/** Presigned GETs for the job's inputs: the capture's raw files, or the source video for convert. */
export const inputs = action({
  args: { token, jobId: v.id('jobs') },
  returns: v.object({
    manifestJson: v.union(v.string(), v.null()),
    files: v.array(v.object({ name: v.string(), area: area, url: v.string(), bytes: v.number() })),
  }),
  handler: async () => notImplemented('worker.inputs'),
})

export const outputUrls = action({
  args: {
    token,
    jobId: v.id('jobs'),
    files: v.array(v.object({ name: v.string(), bytes: v.number(), contentType: v.string(), contentEncoding: v.optional(v.string()), area: v.union(v.literal('raw'), v.literal('derived')) })),
  },
  returns: v.array(v.object({ name: v.string(), target: uploadTarget })),
  handler: async () => notImplemented('worker.outputUrls'),
})

export const finishOutput = action({
  args: { token, jobId: v.id('jobs'), uploadId: v.string(), parts: v.optional(v.array(finishedPart)) },
  returns: v.object({ ok: v.literal(true), bytes: v.number() }),
  handler: async () => notImplemented('worker.finishOutput'),
})

export const splatInfo = v.object({
  file: v.string(),
  format: v.union(v.literal('spz'), v.literal('3dgs-ply')),
  count: v.number(),
  shDegree: v.number(),
  source: v.union(v.literal('trained-from-video'), v.literal('trained-from-lidar-capture')),
})

export const complete = mutation({
  args: {
    token,
    jobId: v.id('jobs'),
    result: v.union(
      v.object({ kind: v.literal('bake'), derived: derived }),
      v.object({ kind: v.literal('convert'), manifestJson: v.string() }),
      v.object({ kind: v.literal('splat'), splat: splatInfo }),
    ),
  },
  returns: v.object({ ok: v.literal(true) }),
  handler: async () => notImplemented('worker.complete'),
})

export const fail = mutation({
  args: { token, jobId: v.id('jobs'), error: v.string(), retryable: v.boolean() },
  returns: v.object({ ok: v.literal(true) }),
  handler: async () => notImplemented('worker.fail'),
})
