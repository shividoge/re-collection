// Read-only routes for the front page: only captures marked public, approved raisable facts in
// the family's wording, never status internals or the grounding log. A private capture looks
// exactly like a missing one (null).
import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { query, type QueryCtx } from './_generated/server'
import { namedFile, preferredReconstruction, reconstructionAssets, signFiles, thumbUrl } from './captures'
import { getCapture, getMomentDoc, listFiles, momentOf } from './lib/data'
import { allowedFacts } from './lib/grounding'
import { publicArrangement } from './lib/museum'
import { r2Config } from './lib/r2'
import { progressFor } from './progress'
import { arrangement as arrangementV, derived, moment as momentV, progressReport, publicSession } from './validators'

/** Raw files that never leave the family's side, even for a public capture. */
export const PRIVATE_FILES = new Set(['room.ply'])

async function visibleCapture(ctx: QueryCtx, captureId: string): Promise<Doc<'captures'> | null> {
  const capture = await getCapture(ctx, captureId)
  return capture?.public ? capture : null
}

async function publicCaptures(ctx: QueryCtx): Promise<Doc<'captures'>[]> {
  return (await ctx.db.query('captures').withIndex('by_createdAt').order('desc').collect()).filter((c) => c.public && !c.deleting && !c.reconstructionOf)
}

export const captures = query({
  args: {},
  returns: v.array(
    v.object({ id: v.string(), title: v.string(), summary: v.string(), createdAt: v.string(), durationSec: v.number(), thumbUrl: v.union(v.string(), v.null()), facts: v.number() }),
  ),
  handler: async (ctx) =>
    Promise.all(
      (await publicCaptures(ctx)).map(async (c) => {
        const moment = momentOf(await getMomentDoc(ctx, c.captureId))
        return {
          id: c.captureId,
          title: moment?.moment.title || c.title || '',
          summary: moment?.moment.summary ?? '',
          createdAt: c.createdAt,
          durationSec: c.durationSec,
          thumbUrl: await thumbUrl(ctx, c.captureId),
          facts: allowedFacts(moment).size,
        }
      }),
    ),
})

export const capture = query({
  args: { captureId: v.string() },
  returns: v.union(
    v.object({ id: v.string(), manifestJson: v.string(), files: v.array(namedFile), derived: v.union(derived, v.null()), derivedFiles: v.array(namedFile), reconstruction: v.optional(reconstructionAssets) }),
    v.null(),
  ),
  handler: async (ctx, { captureId }) => {
    const c = await visibleCapture(ctx, captureId)
    if (!c) return null
    const raw = (await listFiles(ctx, c.captureId, 'raw')).filter((f) => !PRIVATE_FILES.has(f.name))
    const derivedRows = await listFiles(ctx, c.captureId, 'derived')
    const cfg = raw.length || derivedRows.length ? r2Config() : null
    // Nobody typed a title on the phone? Use the one Claude gave the moment.
    const manifest = JSON.parse(c.manifestJson) as { title?: string }
    if (!manifest.title) manifest.title = momentOf(await getMomentDoc(ctx, c.captureId))?.moment.title ?? ''
    return {
      id: c.captureId,
      manifestJson: JSON.stringify(manifest),
      files: cfg ? signFiles(cfg, raw) : [],
      derived: c.derived,
      derivedFiles: cfg ? signFiles(cfg, derivedRows) : [],
      reconstruction: await preferredReconstruction(ctx, c),
    }
  },
})

/** Only approved facts that aren't "don't bring this up", in the family's wording; the extraction log is left out. */
export const moment = query({
  args: { captureId: v.string() },
  returns: v.union(momentV, v.null()),
  handler: async (ctx, { captureId }) => {
    const c = await visibleCapture(ctx, captureId)
    const full = c && momentOf(await getMomentDoc(ctx, c.captureId))
    if (!full) return null
    const allowed = allowedFacts(full)
    const facts = full.facts
      .filter((f) => allowed.has(f.id))
      .map((f) => ({ ...f, text: allowed.get(f.id)?.text ?? f.text, status: 'approved' as const, editedText: null, doNotRaise: false }))
    return { ...full, facts, dropped: [] }
  },
})

export const progress = query({
  args: { captureId: v.string() },
  returns: v.union(progressReport, v.null()),
  handler: async (ctx, { captureId }) => {
    const c = await visibleCapture(ctx, captureId)
    return c ? progressFor(ctx, c) : null
  },
})

/** A finished session of a public capture: turns, held-back sentences, branches, scores, note (no person details). */
export const session = query({
  args: { sessionId: v.string() },
  returns: v.union(publicSession, v.null()),
  handler: async (ctx, { sessionId }) => {
    const s = await ctx.db.query('sessions').withIndex('by_sessionId', (q) => q.eq('sessionId', sessionId)).unique()
    if (!s?.endedAt || !(await visibleCapture(ctx, s.captureId))) return null
    return {
      sessionId: s.sessionId,
      captureId: s.captureId,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      endReason: s.endReason,
      turns: s.turns.map(({ t, speaker, text, kind, factIds }) => ({ t, speaker, text, ...(kind ? { kind } : {}), ...(factIds ? { factIds } : {}) })),
      dropped: s.dropped,
      branches: s.branches,
      scores: s.scores ?? [],
      note: s.note ?? '',
    }
  },
})

/** The caretaker's museum, with only the pictures from public captures. */
export const arrangement = query({
  args: {},
  returns: v.union(arrangementV, v.null()),
  handler: async (ctx) => {
    const row = await ctx.db.query('museumArrangement').first()
    if (!row) return null
    const { _id, _creationTime, ...value } = row
    return publicArrangement(value, (await publicCaptures(ctx)).map((c) => c.captureId))
  },
})
