// "Visit together" rooms (reactive query + 5 s heartbeats, replacing the guide's SSE and polling)
// and the caretaker's museum arrangement. Rules: docs/guide-api.md, lib/museum.ts.
import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import { getCapture, invalid, notFound } from './lib/data'
import {
  CLIENT_PATTERN,
  MAX_AT,
  PEER_TTL_MS,
  cleanName,
  countPeers,
  isExpired,
  isFrameIndex,
  makeCode,
  normalizeCode,
  parseState,
  validateArrangement,
} from './lib/museum'
import { arrangement, arrangementItem, peers, roomState } from './validators'

const who = v.union(v.literal('patient'), v.literal('helper'))
const NO_ROOM = 'No visit with that code. Check the code on the iPad.'

async function presenceOf(ctx: QueryCtx, code: string) {
  return ctx.db.query('museumPresence').withIndex('by_code', (q) => q.eq('code', code)).collect()
}

/** The live room for a typed code, or null (bad format, unknown or expired). */
async function findRoom(ctx: QueryCtx, rawCode: string): Promise<{ room: Doc<'museumRooms'>; presence: Doc<'museumPresence'>[] } | null> {
  const code = normalizeCode(rawCode)
  if (!code) return null
  const room = await ctx.db.query('museumRooms').withIndex('by_code', (q) => q.eq('code', code)).unique()
  if (!room) return null
  const presence = await presenceOf(ctx, code)
  return isExpired(room.lastChange, presence, Date.now()) ? null : { room, presence }
}

async function dropRoom(ctx: MutationCtx, room: Doc<'museumRooms'>) {
  for (const p of await presenceOf(ctx, room.code)) await ctx.db.delete(p._id)
  await ctx.db.delete(room._id)
}

export const createRoom = mutation({
  args: { at: v.optional(v.number()) },
  returns: v.object({ code: v.string() }),
  handler: async (ctx, { at = -1 }) => {
    if (!isFrameIndex(at)) throw invalid(`at must be a whole number from -1 to ${MAX_AT}.`)
    const now = Date.now()
    const rooms = new Map((await ctx.db.query('museumRooms').collect()).map((r) => [r.code, r]))
    const live = new Set<string>()
    for (const [code, room] of rooms) if (!isExpired(room.lastChange, await presenceOf(ctx, code), now)) live.add(code)
    const code = makeCode((c) => live.has(c), (n) => Math.floor(Math.random() * n))
    if (!code) throw invalid("Couldn't find a free code. Try again.")
    const old = rooms.get(code)
    if (old) await dropRoom(ctx, old)
    await ctx.db.insert('museumRooms', {
      code,
      state: { at, atId: null, window: null, by: 'patient', name: null, rev: 0, updatedAt: new Date(now).toISOString() },
      lastChange: now,
    })
    return { code }
  },
})

/** Reactive room state + peers (replaces the guide's SSE and polling). */
export const room = query({
  args: { code: v.string() },
  returns: v.union(v.object({ code: v.string(), state: roomState, peers: peers }), v.null()),
  handler: async (ctx, { code }) => {
    const found = await findRoom(ctx, code)
    if (!found) return null
    return { code: found.room.code, state: found.room.state, peers: countPeers(found.presence, Date.now()) }
  },
})

export const setState = mutation({
  args: { code: v.string(), at: v.number(), atId: v.optional(v.union(v.string(), v.null())), window: v.union(v.string(), v.null()), by: who, name: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ state: roomState }),
  handler: async (ctx, { code, ...body }) => {
    const found = await findRoom(ctx, code)
    if (!found) throw notFound(NO_ROOM)
    const parsed = parseState(body)
    if (!parsed.ok) throw invalid(parsed.error)
    if (parsed.value.window !== null && !(await getCapture(ctx, parsed.value.window))) throw invalid(`No capture with id ${parsed.value.window}.`)
    const now = Date.now()
    const state = { ...parsed.value, rev: found.room.state.rev + 1, updatedAt: new Date(now).toISOString() }
    await ctx.db.patch(found.room._id, { state, lastChange: now })
    return { state }
  },
})

/** Every 5 s per screen; peers count heartbeats newer than 12 s. */
export const heartbeat = mutation({
  args: { code: v.string(), client: v.string(), as: who, name: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ ok: v.literal(true) }),
  handler: async (ctx, args) => {
    if (!CLIENT_PATTERN.test(args.client)) throw invalid('client must be 8 to 64 letters, digits, - or _.')
    const found = await findRoom(ctx, args.code)
    if (!found) throw notFound(NO_ROOM)
    const name = cleanName(args.name)
    const row = { code: found.room.code, client: args.client, as: args.as, name: name.ok ? name.value : null, lastSeen: Date.now() }
    const existing = await ctx.db.query('museumPresence').withIndex('by_client', (q) => q.eq('code', row.code).eq('client', args.client)).unique()
    if (existing) await ctx.db.replace(existing._id, row)
    else await ctx.db.insert('museumPresence', row)
    return { ok: true as const }
  },
})

/** Cron: forget stale screens and expired rooms. */
export const sweep = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now()
    for (const room of await ctx.db.query('museumRooms').collect()) {
      const presence = await presenceOf(ctx, room.code)
      if (isExpired(room.lastChange, presence, now)) await dropRoom(ctx, room)
      else for (const p of presence) if (now - p.lastSeen > PEER_TTL_MS * 10) await ctx.db.delete(p._id)
    }
    return null
  },
})

// ---- arrangement --------------------------------------------------------------------------

async function readArrangement(ctx: QueryCtx) {
  const row = await ctx.db.query('museumArrangement').first()
  if (!row) return null
  const { _id, _creationTime, ...value } = row
  return value
}

export const getArrangement = query({
  args: {},
  returns: v.union(arrangement, v.null()),
  handler: async (ctx) => readArrangement(ctx),
})

export const setArrangement = mutation({
  args: { title: v.string(), subtitle: v.string(), items: v.array(arrangementItem) },
  returns: arrangement,
  handler: async (ctx, body) => {
    const ids = new Set<string>()
    for (const item of body.items) if (await getCapture(ctx, item.capture)) ids.add(item.capture)
    const result = validateArrangement(body, ids)
    if ('error' in result) throw invalid(result.error)
    const value = { ...result.value, updatedAt: new Date().toISOString() }
    const row = await ctx.db.query('museumArrangement').first()
    if (row) await ctx.db.replace(row._id, value)
    else await ctx.db.insert('museumArrangement', value)
    return value
  },
})

/** Back to hanging every visit automatically. */
export const clearArrangement = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const row = await ctx.db.query('museumArrangement').first()
    if (row) await ctx.db.delete(row._id)
    return null
  },
})
