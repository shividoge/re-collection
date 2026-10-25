import { v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { notImplemented } from './lib_stub'
import { captureStatus, derived, fileUrl } from './validators'

export const namedFile = v.object({ name: v.string(), ...fileUrl.fields })

export const captureSummary = v.object({
  id: v.string(),
  title: v.string(),
  createdAt: v.string(),
  durationSec: v.number(),
  source: v.union(v.literal('phone'), v.literal('video')),
  thumbUrl: v.union(v.string(), v.null()),
  status: captureStatus,
  public: v.boolean(),
})

export const captureDetail = v.object({
  id: v.string(),
  manifestJson: v.string(),
  status: captureStatus,
  public: v.boolean(),
  /** Raw files (names as in capture-format.md, e.g. "keyframes/k0001.jpg"), presigned GET URLs. */
  files: v.array(namedFile),
  derived: v.union(derived, v.null()),
  /** Derived files (names as in derived.files), presigned GET URLs. */
  derivedFiles: v.array(namedFile),
})

/** Creates (or returns) the capture for this manifest. Idempotent per manifest id. */
export const begin = mutation({
  args: { manifestJson: v.string() },
  returns: v.object({ captureId: v.string() }),
  handler: async () => notImplemented('captures.begin'),
})

/** Validates the upload against the manifest; valid → bake queued. Throws ConvexError({ code: 'invalid', errors }). */
export const complete = mutation({
  args: { captureId: v.string() },
  returns: v.object({ ok: v.literal(true) }),
  handler: async () => notImplemented('captures.complete'),
})

export const list = query({
  args: {},
  returns: v.array(captureSummary),
  handler: async () => notImplemented('captures.list'),
})

export const get = query({
  args: { captureId: v.string() },
  returns: v.union(captureDetail, v.null()),
  handler: async () => notImplemented('captures.get'),
})

export const setPublic = mutation({
  args: { captureId: v.string(), public: v.boolean() },
  returns: v.object({ ok: v.literal(true), public: v.boolean() }),
  handler: async () => notImplemented('captures.setPublic'),
})

export const remove = mutation({
  args: { captureId: v.string() },
  returns: v.object({ ok: v.literal(true) }),
  handler: async () => notImplemented('captures.remove'),
})
