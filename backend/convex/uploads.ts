import { ConvexError, v } from 'convex/values'
import { parseManifest } from '../../shared/manifest'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { action, internalAction, internalMutation, internalQuery, type ActionCtx } from './_generated/server'
import { fileKey, invalid, keepSplat, notFound, requireCapture } from './lib/data'
import {
  PART_SIZE,
  abortMultipart,
  deleteObject,
  r2ConfigOrNull,
  SINGLE_MAX,
  completeMultipart,
  createMultipart,
  headObject,
  listParts,
  partCount,
  partUrl,
  putTarget,
  r2Config,
  stableGetUrl,
  R2Error,
  type R2Config,
} from './lib/r2'
import { shown } from './lib/errors'
import { requireLease } from './lib/jobs'
import { afterFileRegistered, registerFile } from './lib/stages'
import { isFileName, isSourceName, readDepthIndex } from './lib/validate'
import { area, finishedPart, uploadTarget, type Area, type UploadTarget } from './validators'

/** Largest single file accepted (a long 4K video is a few GB). */
export const MAX_FILE_BYTES = 8 * 1024 ** 3

/** Where a client upload goes: a video capture's source, or a raw capture file. */
export const prepare = internalQuery({
  args: { captureId: v.string(), name: v.string(), bytes: v.number() },
  returns: v.object({ captureId: v.string(), area: area, key: v.string() }),
  handler: async (ctx, { captureId, name, bytes }) => {
    const capture = await requireCapture(ctx, captureId)
    if (!isFileName(name)) throw invalid(`"${name}" isn't an allowed file name.`)
    if (!Number.isInteger(bytes) || bytes < 0) throw invalid('bytes must be a whole number.')
    if (bytes > MAX_FILE_BYTES) throw invalid(`${name} is larger than the ${MAX_FILE_BYTES / 1024 ** 3} GB upload limit.`)
    const isVideoSource = capture.status.source === 'video' && capture.status.convert !== 'skipped' && isSourceName(name)
    const fileArea: Area = isVideoSource ? 'video' : 'raw'
    return { captureId: capture.captureId, area: fileArea, key: fileKey(capture.captureId, fileArea, name) }
  },
})

export const open = internalMutation({
  args: {
    captureId: v.string(),
    area: area,
    name: v.string(),
    key: v.string(),
    bytes: v.number(),
    contentType: v.string(),
    contentEncoding: v.optional(v.string()),
    r2UploadId: v.optional(v.string()),
    partSize: v.optional(v.number()),
    jobId: v.optional(v.id('jobs')),
    attempt: v.optional(v.number()),
  },
  returns: v.id('uploads'),
  handler: async (ctx, args) => {
    if (args.jobId) await requireLease(ctx, args.jobId, args.attempt ?? 0)
    else await requireCapture(ctx, args.captureId)
    return ctx.db.insert('uploads', { ...args, status: 'open', createdAt: Date.now() })
  },
})

export const getUpload = internalQuery({
  args: { uploadId: v.string() },
  handler: async (ctx, { uploadId }): Promise<Doc<'uploads'> | null> => {
    const id = ctx.db.normalizeId('uploads', uploadId)
    return id ? ctx.db.get(id) : null
  },
})

/**
 * Marks the upload done, registers the file and runs the stage triggers. A worker's output is
 * only staged (its attempt must still hold the lease); `worker.complete` publishes it. An upload
 * that's already done or staged is left as is, so a retried or concurrent finish is a no-op.
 */
export const register = internalMutation({
  args: {
    uploadId: v.id('uploads'),
    bytes: v.number(),
    manifestJson: v.optional(v.string()),
    indexedBytes: v.optional(v.number()),
    indexedCount: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, { uploadId, bytes, manifestJson, indexedBytes, indexedCount }) => {
    const upload = await ctx.db.get(uploadId)
    if (upload && (upload.status === 'done' || upload.status === 'staged')) return null
    if (!upload || upload.status !== 'open') throw notFound("This upload isn't open any more.")
    if (upload.jobId) {
      await requireLease(ctx, upload.jobId, upload.attempt ?? 0)
      await ctx.db.patch(uploadId, { status: 'staged', ...(indexedBytes !== undefined ? { indexedBytes, indexedCount } : {}) })
      return null
    }
    const capture = await requireCapture(ctx, upload.captureId)
    await ctx.db.patch(uploadId, { status: 'done' })
    if (manifestJson !== undefined) {
      const manifest = parseManifest(manifestJson)
      await ctx.db.patch(capture._id, { manifestJson: keepSplat(capture, manifestJson), title: manifest.title || capture.title, durationSec: manifest.video.durationSec ?? capture.durationSec })
    }
    const file = await registerFile(ctx, capture, {
      area: upload.area,
      name: upload.name,
      bytes,
      contentType: upload.contentType,
      ...(upload.contentEncoding ? { contentEncoding: upload.contentEncoding } : {}),
      ...(indexedBytes !== undefined ? { indexedBytes, indexedCount } : {}),
    })
    await afterFileRegistered(ctx, (await ctx.db.get(capture._id)) ?? capture, file, false)
    return null
  },
})

// ---- shared by uploads.* and worker.* -------------------------------------------------------

export type TargetInput = { captureId: string; area: Area; name: string; key: string; bytes: number; contentType: string; contentEncoding?: string; jobId?: Id<'jobs'>; attempt?: number }

/** One presigned PUT for small files, a multipart upload for bigger ones. */
export async function createTarget(ctx: ActionCtx, input: TargetInput): Promise<UploadTarget> {
  const cfg = r2Config()
  const now = Date.now()
  if (input.bytes <= SINGLE_MAX) {
    const single = putTarget(cfg, input.key, { contentType: input.contentType, contentEncoding: input.contentEncoding, contentLength: input.bytes, now })
    const uploadId = await ctx.runMutation(internal.uploads.open, input)
    return { uploadId, key: input.key, single }
  }
  const r2UploadId = await createMultipart(cfg, input.key, { contentType: input.contentType, contentEncoding: input.contentEncoding })
  let uploadId: Id<'uploads'>
  try {
    uploadId = await ctx.runMutation(internal.uploads.open, { ...input, r2UploadId, partSize: PART_SIZE })
  } catch (error) {
    // Refused (the job's lease moved on, the capture is being deleted): nothing will finish it.
    await abortMultipart(cfg, input.key, r2UploadId).catch(() => {})
    throw error
  }
  const parts = Array.from({ length: partCount(input.bytes) }, (_, i) => ({ partNumber: i + 1, url: partUrl(cfg, input.key, r2UploadId, i + 1, now) }))
  return { uploadId, key: input.key, partSize: PART_SIZE, parts }
}

export async function loadUpload(ctx: ActionCtx, uploadId: string): Promise<Doc<'uploads'>> {
  const upload = await ctx.runQuery(internal.uploads.getUpload, { uploadId })
  if (!upload) throw notFound(`No upload ${uploadId}.`)
  return upload
}

/** Fresh URLs for the parts R2 doesn't have yet. */
export async function resumeTarget(upload: Doc<'uploads'>): Promise<{ target: UploadTarget; done: { partNumber: number; etag: string }[] }> {
  if (upload.status !== 'open') throw invalid("This upload is already finished.")
  const cfg = r2Config()
  const now = Date.now()
  if (!upload.r2UploadId) {
    const single = putTarget(cfg, upload.key, { contentType: upload.contentType, contentEncoding: upload.contentEncoding, contentLength: upload.bytes, now })
    return { target: { uploadId: upload._id, key: upload.key, single }, done: [] }
  }
  const have = await listParts(cfg, upload.key, upload.r2UploadId)
  const partSize = upload.partSize ?? PART_SIZE
  const total = partCount(upload.bytes, partSize)
  const expectedSize = (n: number) => (n < total ? partSize : upload.bytes - partSize * (total - 1))
  const done = have.filter((p) => p.size === expectedSize(p.partNumber)).map(({ partNumber, etag }) => ({ partNumber, etag }))
  const doneSet = new Set(done.map((p) => p.partNumber))
  const parts = []
  for (let n = 1; n <= total; n++) if (!doneSet.has(n)) parts.push({ partNumber: n, url: partUrl(cfg, upload.key, upload.r2UploadId, n, now) })
  return { target: { uploadId: upload._id, key: upload.key, partSize, parts }, done }
}

/** Completes the upload in R2, checks the stored size, reads small JSON files Convex keeps, registers the file. */
export async function finishUpload(ctx: ActionCtx, upload: Doc<'uploads'>, parts: { partNumber: number; etag: string }[] | undefined): Promise<number> {
  // Finished by an earlier call whose answer was lost: the same answer again (its size was checked).
  if (upload.status === 'done' || upload.status === 'staged') return upload.bytes
  if (upload.status !== 'open') throw invalid('This upload was cancelled. Start it again.')
  const cfg = r2Config()
  if (upload.r2UploadId) {
    try {
      const list = parts ?? (await listParts(cfg, upload.key, upload.r2UploadId)).map(({ partNumber, etag }) => ({ partNumber, etag }))
      await completeMultipart(cfg, upload.key, upload.r2UploadId, list)
    } catch (error) {
      // Completed by an earlier finish that failed afterwards: the size check below decides.
      if (!(error instanceof R2Error && error.code === 'NoSuchUpload')) throw error
    }
  }
  const head = await headObject(cfg, upload.key)
  if (!head) throw invalid(`${upload.name} didn't arrive in storage. Upload it again.`)
  if (head.bytes !== upload.bytes) throw invalid(`${upload.name} arrived with ${head.bytes} bytes, but ${upload.bytes} were announced. Upload it again.`)

  const extra: { manifestJson?: string; indexedBytes?: number; indexedCount?: number } = {}
  if (upload.area === 'raw' && upload.name === 'manifest.json') {
    const text = await fetchText(cfg, upload.key)
    let manifest
    try {
      manifest = parseManifest(text)
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error))
    }
    if (manifest.id !== upload.captureId) throw invalid(`manifest.json is for capture ${manifest.id}, not ${upload.captureId}.`)
    extra.manifestJson = text
  }
  if (upload.area === 'raw' && upload.name === 'depth.index.json') {
    let json: unknown
    try {
      json = JSON.parse(await fetchText(cfg, upload.key))
    } catch {
      throw invalid("depth.index.json isn't valid JSON.")
    }
    const index = readDepthIndex(json)
    if ('error' in index) throw invalid(index.error)
    extra.indexedBytes = index.bytes
    extra.indexedCount = index.count
  }
  await ctx.runMutation(internal.uploads.register, { uploadId: upload._id, bytes: head.bytes, ...extra })
  return head.bytes
}

export const keysInUse = internalQuery({
  args: { keys: v.array(v.string()) },
  returns: v.array(v.string()),
  handler: async (ctx, { keys }) => {
    const used: string[] = []
    for (const key of keys) if (await ctx.db.query('files').withIndex('by_key', (q) => q.eq('key', key)).first()) used.push(key)
    return used
  },
})

/** Deletes objects (aborting their multipart uploads first); see stages.scheduleDiscard. */
export const discard = internalAction({
  args: { objects: v.array(v.object({ key: v.string(), r2UploadId: v.optional(v.string()) })) },
  returns: v.null(),
  handler: async (ctx, { objects }) => {
    const cfg = r2ConfigOrNull()
    if (!cfg) return null
    // Checked now, not when scheduled: a file registered at one of these keys meanwhile keeps it.
    const inUse = new Set(await ctx.runQuery(internal.uploads.keysInUse, { keys: objects.map((o) => o.key) }))
    for (const o of objects) {
      if (o.r2UploadId) await abortMultipart(cfg, o.key, o.r2UploadId)
      if (!inUse.has(o.key)) await deleteObject(cfg, o.key)
    }
    return null
  },
})

async function fetchText(cfg: R2Config, key: string): Promise<string> {
  // A fresh rev in the signed URL, so no cache can answer with older bytes.
  const res = await fetch(stableGetUrl(cfg, key, Date.now(), Date.now()))
  if (!res.ok) throw new ConvexError({ code: 'storage', message: `Couldn't read ${key} back from storage (HTTP ${res.status}).` })
  return res.text()
}

// ---- public API ----------------------------------------------------------------------------

/**
 * Starts uploading one file of a capture. Files ≤ 8 MiB get one presigned PUT (`single`, send its
 * `headers` exactly); bigger ones a multipart upload with presigned part URLs (`parts`,
 * `partSize` 16 MiB; the last part is shorter). `name` "source.<ext>" on a video capture goes to
 * videos/<id>/ and queues convert on finish.
 */
export const start = action({
  args: { captureId: v.string(), name: v.string(), bytes: v.number(), contentType: v.string() },
  returns: uploadTarget,
  handler: async (ctx, args): Promise<UploadTarget> => {
    const where = await ctx.runQuery(internal.uploads.prepare, { captureId: args.captureId, name: args.name, bytes: args.bytes })
    return shown(() => createTarget(ctx, { ...where, name: args.name, bytes: args.bytes, contentType: args.contentType || 'application/octet-stream' }))
  },
})

/** The same upload's remaining parts (those R2 doesn't have yet), with fresh URLs. */
export const resume = action({
  args: { uploadId: v.string() },
  returns: v.object({ target: uploadTarget, done: v.array(finishedPart) }),
  handler: async (ctx, { uploadId }): Promise<{ target: UploadTarget; done: { partNumber: number; etag: string }[] }> => shown(async () => resumeTarget(await loadUpload(ctx, uploadId))),
})

/** Completes the upload, checks the stored size, registers the file (→ stage triggers). */
export const finish = action({
  args: { uploadId: v.string(), parts: v.optional(v.array(finishedPart)) },
  returns: v.object({ ok: v.literal(true), bytes: v.number() }),
  handler: async (ctx, { uploadId, parts }): Promise<{ ok: true; bytes: number }> => {
    const upload = await loadUpload(ctx, uploadId)
    if (upload.jobId) throw invalid('This upload belongs to a worker job; finish it with worker.finishOutput.')
    return { ok: true as const, bytes: await shown(() => finishUpload(ctx, upload, parts)) }
  },
})
