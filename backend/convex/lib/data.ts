// Small database helpers shared by the Convex functions.
import { ConvexError } from 'convex/values'
import { parseManifest, type Manifest } from '../../../shared/manifest'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import type { Area, CaptureStatus, Moment, Person } from '../validators'

type Ctx = QueryCtx | MutationCtx

export const notFound = (message: string) => new ConvexError({ code: 'not_found', message })
export const invalid = (message: string) => new ConvexError({ code: 'invalid', message })
export const conflict = (message: string) => new ConvexError({ code: 'conflict', message })
export const forbidden = (message: string) => new ConvexError({ code: 'forbidden', message })

export async function getCapture(ctx: Ctx, captureId: string): Promise<Doc<'captures'> | null> {
  const doc = await ctx.db.query('captures').withIndex('by_captureId', (q) => q.eq('captureId', captureId.toLowerCase())).unique()
  return doc && !doc.deleting ? doc : null
}

export async function requireCapture(ctx: Ctx, captureId: string): Promise<Doc<'captures'>> {
  const doc = await getCapture(ctx, captureId)
  if (!doc) throw notFound(`No capture with id ${captureId}.`)
  return doc
}

export async function listFiles(ctx: Ctx, captureId: string, area?: Area): Promise<Doc<'files'>[]> {
  return ctx.db
    .query('files')
    .withIndex('by_capture', (q) => (area ? q.eq('captureId', captureId).eq('area', area) : q.eq('captureId', captureId)))
    .collect()
}

export async function getFile(ctx: Ctx, captureId: string, area: Area, name: string): Promise<Doc<'files'> | null> {
  return ctx.db.query('files').withIndex('by_capture', (q) => q.eq('captureId', captureId).eq('area', area).eq('name', name)).unique()
}

export async function getMomentDoc(ctx: Ctx, captureId: string): Promise<Doc<'moments'> | null> {
  return ctx.db.query('moments').withIndex('by_captureId', (q) => q.eq('captureId', captureId)).unique()
}

/** The moment without Convex's own fields, as the API returns it. */
export function momentOf(doc: Doc<'moments'> | null): Moment | null {
  if (!doc) return null
  const { _id, _creationTime, ...moment } = doc
  return moment
}

export async function getPerson(ctx: Ctx): Promise<Person> {
  const row = await ctx.db.query('people').first()
  return row ? { displayName: row.displayName, preferredAddress: row.preferredAddress } : { displayName: '', preferredAddress: '' }
}

/** The capture's manifest, or null while a video capture is still waiting for its conversion. */
export function manifestOf(capture: Pick<Doc<'captures'>, 'manifestJson'>): Manifest | null {
  try {
    return parseManifest(capture.manifestJson)
  } catch {
    return null
  }
}

export function attendeesOf(capture: Pick<Doc<'captures'>, 'manifestJson'>): string[] {
  try {
    const m = JSON.parse(capture.manifestJson) as { attendees?: unknown }
    return Array.isArray(m.attendees) ? m.attendees.map(String) : []
  } catch {
    return []
  }
}

export async function patchStatus(ctx: MutationCtx, capture: Doc<'captures'>, patch: Partial<CaptureStatus>): Promise<CaptureStatus> {
  const current = (await ctx.db.get(capture._id))?.status ?? capture.status
  const status = { ...current, ...patch, updatedAt: Date.now() }
  await ctx.db.patch(capture._id, { status })
  return status
}

/** Raw files of a capture, then derived ones: R2 keys (architecture-v3.md §2). */
export function fileKey(captureId: string, area: Area, name: string): string {
  return area === 'video' ? `videos/${captureId}/${name}` : `captures/${captureId}/${area}/${name}`
}

/**
 * Where one attempt of a worker job writes an output. Every attempt has its own keys, so a stale
 * attempt's late PUT can never touch a published object; the file row points at the key.
 */
export function workerKey(captureId: string, area: 'raw' | 'derived', jobId: string, attempt: number, name: string): string {
  return `captures/${captureId}/${area}/${jobId}.${attempt}/${name}`
}

/** The status a new capture starts with. */
export function initialStatus(source: 'phone' | 'video', hasSplat: boolean): CaptureStatus {
  return {
    source,
    upload: 'receiving',
    uploadErrors: [],
    warnings: [],
    convert: 'skipped',
    facts: 'not_started',
    bake: 'not_started',
    splat: hasSplat ? 'done' : 'skipped',
    errors: {},
    progress: null,
    updatedAt: Date.now(),
  }
}
