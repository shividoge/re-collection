// The AI guide in the Memory Palace (lib/guide.ts has the rules, guideNode.ts the calls to Moss,
// Claude and Cartesia). The palace reads each memory's intro and story from here, reactively;
// saving the arrangement rewrites those whose notes changed.
import { v } from 'convex/values'
import { internal } from './_generated/api'
import { internalMutation, internalQuery, query, type MutationCtx, type QueryCtx } from './_generated/server'
import { getMomentDoc, getPerson, momentOf } from './lib/data'
import { fingerprint, memoryKey, type MemoryContext } from './lib/guide'
import { allowedFacts } from './lib/grounding'

const narrationRow = v.object({
  key: v.string(),
  status: v.union(v.literal('preparing'), v.literal('ready'), v.literal('failed')),
  intro: v.string(),
  story: v.string(),
  error: v.union(v.string(), v.null()),
})

/** Every memory's guide words (the palace speaks `intro` at the frame and `story` inside). */
export const narration = query({
  args: {},
  returns: v.array(narrationRow),
  handler: async (ctx) =>
    (await ctx.db.query('guideNarration').collect()).map(({ key, status, intro, story, error }) => ({ key, status, intro, story, error })),
})

/** What the guide may use for one memory, from the saved arrangement; null if it no longer hangs. */
async function contextOf(ctx: QueryCtx, key: string): Promise<MemoryContext | null> {
  const arrangement = await ctx.db.query('museumArrangement').first()
  const item = arrangement?.items.find((i) => memoryKey(i) === key)
  if (!item) return null
  const moment = momentOf(await getMomentDoc(ctx, item.capture))
  const facts = moment ? [...allowedFacts(moment).values()].map((f) => ({ id: f.id, text: f.text })) : []
  const person = await getPerson(ctx)
  return { key, title: item.title, caption: item.caption, notes: item.notes ?? '', avoid: item.avoid ?? '', facts, address: person.preferredAddress ?? '' }
}

export const memoryContext = internalQuery({
  args: { key: v.string() },
  returns: v.any(),
  handler: async (ctx, { key }) => {
    const context = await contextOf(ctx, key)
    const row = await ctx.db.query('guideNarration').withIndex('by_key', (q) => q.eq('key', key)).unique()
    return context ? { context, fingerprint: fingerprint(context), mossDocs: row?.mossDocs ?? [] } : null
  },
})

export const saveNarration = internalMutation({
  args: {
    key: v.string(),
    fingerprint: v.string(),
    status: v.union(v.literal('ready'), v.literal('failed')),
    intro: v.string(),
    story: v.string(),
    mossDocs: v.array(v.string()),
    error: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.query('guideNarration').withIndex('by_key', (q) => q.eq('key', args.key)).unique()
    // Written from notes that changed again meanwhile: a newer run is on its way.
    if (row && row.fingerprint !== args.fingerprint) return null
    const value = { ...args, updatedAt: new Date().toISOString() }
    if (row) await ctx.db.replace(row._id, value)
    else await ctx.db.insert('guideNarration', value)
    return null
  },
})

/**
 * After the arrangement is saved: rewrite the guide's words for every memory whose notes (or
 * title, caption, approved facts) changed, and forget memories no longer on the walls.
 */
export async function refreshGuide(ctx: MutationCtx) {
  const arrangement = await ctx.db.query('museumArrangement').first()
  const rows = new Map((await ctx.db.query('guideNarration').collect()).map((r) => [r.key, r]))
  const hanging = new Set<string>()
  for (const item of arrangement?.items ?? []) {
    const key = memoryKey(item)
    if (hanging.has(key)) continue
    hanging.add(key)
    const context = await contextOf(ctx, key)
    if (!context) continue
    const print = fingerprint(context)
    const row = rows.get(key)
    if (row && row.fingerprint === print && row.status !== 'failed') continue
    const value = { key, fingerprint: print, status: 'preparing' as const, intro: row?.intro ?? '', story: row?.story ?? '', mossDocs: row?.mossDocs ?? [], error: null, updatedAt: new Date().toISOString() }
    if (row) await ctx.db.replace(row._id, value)
    else await ctx.db.insert('guideNarration', value)
    await ctx.scheduler.runAfter(0, internal.guideNode.prepare, { key })
  }
  for (const [key, row] of rows) {
    if (hanging.has(key)) continue
    await ctx.db.delete(row._id)
    if (row.mossDocs.length > 0) await ctx.scheduler.runAfter(0, internal.guideNode.forget, { docIds: row.mossDocs })
  }
}
