// The live visit: family join her Memory Palace from anywhere, follow her walk and talk
// (docs/architecture-v3.md §6.6 "Live visit"). Reactive queries replace the guide's polling.
// Every function needs the palace's visit key; rules in lib/palace.ts.
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { action, internalMutation, mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import { forbidden, getPerson, invalid, notFound } from './lib/data'
import {
  AUDIO_KEEP_MS,
  AUDIO_MAX_BYTES,
  AUDIO_RECENT,
  GONE_MS,
  KEY_PATTERN,
  SIGNAL_BACKLOG,
  SIGNAL_MAX_BYTES,
  cleanName,
  encodeKey,
  iceServersFrom,
  parseView,
  sameKey,
} from './lib/palace'
import { iceServer, palaceMember, palaceRole, palaceView } from './validators'

/** More screens than this make the voice mesh too heavy for a phone. */
const MAX_MEMBERS = 8
const BAD_KEY = 'This visit link no longer works. Ask the family for the new link.'
const NOT_HERE = 'Not in the visit any more. Join again.'

// ---- the visit key ---------------------------------------------------------------------------

async function palaceRow(ctx: QueryCtx) {
  return ctx.db.query('palace').first()
}

/** Throws unless `key` is the palace's current visit key. */
async function requireKey(ctx: QueryCtx, key: string): Promise<void> {
  const row = await palaceRow(ctx)
  if (!row || !KEY_PATTERN.test(key) || !sameKey(row.key, key)) throw notFound(BAD_KEY)
}

/** The caretaker's editor shows the link (no login, like the rest of the family's tools). */
export const visitKey = query({
  args: {},
  returns: v.object({ key: v.union(v.string(), v.null()) }),
  handler: async (ctx) => ({ key: (await palaceRow(ctx))?.key ?? null }),
})

/** The current key, or a new one (none yet, or `replace`). An action, for real crypto randomness. */
export const makeVisitKey = action({
  args: { replace: v.optional(v.boolean()) },
  returns: v.object({ key: v.string() }),
  handler: async (ctx, { replace = false }): Promise<{ key: string }> => {
    const fresh = encodeKey(crypto.getRandomValues(new Uint8Array(24)))
    return ctx.runMutation(internal.palace.storeKey, { key: fresh, replace })
  },
})

export const storeKey = internalMutation({
  args: { key: v.string(), replace: v.boolean() },
  returns: v.object({ key: v.string() }),
  handler: async (ctx, { key, replace }) => {
    const row = await ctx.db.query('palace').first()
    if (row && !replace) return { key: row.key }
    if (row) await ctx.db.replace(row._id, { key, createdAt: Date.now() })
    else await ctx.db.insert('palace', { key, createdAt: Date.now() })
    // A new key ends the visit: everyone on the old link is out.
    for (const m of await ctx.db.query('palaceMembers').collect()) await removeMember(ctx, m._id)
    for (const a of await ctx.db.query('palaceAudio').collect()) await ctx.db.delete(a._id)
    return { key }
  },
})

// ---- members -------------------------------------------------------------------------------

const fresh = (m: Doc<'palaceMembers'>, now: number) => now - m.lastSeen <= GONE_MS

/** This screen's member row, or null (unknown id, or already removed). */
async function memberOf(ctx: QueryCtx, me: string): Promise<Doc<'palaceMembers'> | null> {
  const id = ctx.db.normalizeId('palaceMembers', me)
  return id ? ctx.db.get(id) : null
}

async function requireMember(ctx: QueryCtx, key: string, me: string): Promise<Doc<'palaceMembers'>> {
  await requireKey(ctx, key)
  const member = await memberOf(ctx, me)
  if (!member) throw notFound(NOT_HERE)
  return member
}

/** Removes a member with its unread call setup, and its view if it was leading. */
async function removeMember(ctx: MutationCtx, id: Id<'palaceMembers'>) {
  for (const s of await ctx.db.query('palaceSignals').withIndex('by_to', (q) => q.eq('to', id)).collect()) await ctx.db.delete(s._id)
  const view = await ctx.db.query('palaceView').first()
  if (view && view.member === id) await ctx.db.delete(view._id)
  if (await ctx.db.get(id)) await ctx.db.delete(id)
}

/** Drops members gone for a while (bounded, so a join never does much). */
async function dropGone(ctx: MutationCtx, now: number, limit: number) {
  const gone = await ctx.db
    .query('palaceMembers')
    .withIndex('by_lastSeen', (q) => q.lt('lastSeen', now - GONE_MS))
    .take(limit)
  for (const m of gone) await removeMember(ctx, m._id)
}

export const join = mutation({
  args: { key: v.string(), role: palaceRole, name: v.optional(v.string()) },
  returns: v.object({ me: v.string(), iceServers: v.array(iceServer) }),
  handler: async (ctx, { key, role, name }) => {
    await requireKey(ctx, key)
    const now = Date.now()
    await dropGone(ctx, now, 20)
    let clean = cleanName(name)
    if (!clean && role === 'patient') clean = cleanName((await getPerson(ctx)).displayName) || 'Grandma'
    if (!clean) throw invalid('Family members join with a name.')
    const here = (await ctx.db.query('palaceMembers').collect()).filter((m) => fresh(m, now))
    if (here.length >= MAX_MEMBERS) throw invalid(`The visit is full (${MAX_MEMBERS} screens). Try again when someone leaves.`)
    const me = await ctx.db.insert('palaceMembers', { role, name: clean, lastSeen: now })
    return { me, iceServers: iceServersFrom(process.env.ICE_SERVERS) }
  },
})

export const heartbeat = mutation({
  args: { key: v.string(), me: v.string() },
  returns: v.object({ ok: v.literal(true) }),
  handler: async (ctx, { key, me }) => {
    const member = await requireMember(ctx, key, me)
    await ctx.db.patch(member._id, { lastSeen: Date.now() })
    return { ok: true as const }
  },
})

export const leave = mutation({
  args: { key: v.string(), me: v.string() },
  returns: v.null(),
  handler: async (ctx, { key, me }) => {
    await requireKey(ctx, key)
    const member = await memberOf(ctx, me)
    if (member) await removeMember(ctx, member._id)
    return null
  },
})

/** Who's here (heard from in the last 10 s), oldest first. `here` false: this screen was dropped. */
export const members = query({
  args: { key: v.string(), me: v.string() },
  returns: v.object({ here: v.boolean(), members: v.array(palaceMember) }),
  handler: async (ctx, { key, me }) => {
    await requireKey(ctx, key)
    const now = Date.now()
    const list = (await ctx.db.query('palaceMembers').collect()).filter((m) => fresh(m, now))
    return {
      here: list.some((m) => m._id === me),
      members: list.map((m) => ({ id: m._id as string, role: m.role, name: m.name })),
    }
  },
})

// ---- her view ------------------------------------------------------------------------------

/** Where she is, while a patient is in the visit. */
export const view = query({
  args: { key: v.string() },
  returns: v.union(v.object({ ...palaceView.fields, rev: v.number(), updatedAt: v.string() }), v.null()),
  handler: async (ctx, { key }) => {
    await requireKey(ctx, key)
    const row = await ctx.db.query('palaceView').first()
    if (!row) return null
    const leader = await ctx.db.get(row.member)
    if (!leader || !fresh(leader, Date.now())) return null
    const { x, z, yaw, pitch, inside, music, rev, updatedAt } = row
    return { x, z, yaw, pitch, inside, music, rev, updatedAt }
  },
})

export const setView = mutation({
  args: { key: v.string(), me: v.string(), view: palaceView },
  returns: v.object({ rev: v.number() }),
  handler: async (ctx, { key, me, view }) => {
    const member = await requireMember(ctx, key, me)
    if (member.role !== 'patient') throw forbidden('Only the person the palace is for leads the visit.')
    const parsed = parseView(view)
    if (!parsed.ok) throw invalid(parsed.error)
    const row = await ctx.db.query('palaceView').first()
    const rev = (row?.rev ?? 0) + 1
    const next = { ...parsed.value, member: member._id, rev, updatedAt: new Date().toISOString() }
    if (row) await ctx.db.replace(row._id, next)
    else await ctx.db.insert('palaceView', next)
    return { rev }
  },
})

// ---- call setup ----------------------------------------------------------------------------

export const signal = mutation({
  args: { key: v.string(), me: v.string(), to: v.string(), data: v.string() },
  returns: v.null(),
  handler: async (ctx, { key, me, to, data }) => {
    const member = await requireMember(ctx, key, me)
    if (data.length > SIGNAL_MAX_BYTES) throw invalid(`A call setup message is at most ${SIGNAL_MAX_BYTES / 1024} KB.`)
    const target = await memberOf(ctx, to)
    if (!target) throw notFound('That person has left the visit.')
    await ctx.db.insert('palaceSignals', { to: target._id, from: member._id, data, createdAt: Date.now() })
    // Keep the newest few hundred for a screen that isn't reading.
    const waiting = await ctx.db.query('palaceSignals').withIndex('by_to', (q) => q.eq('to', target._id)).order('desc').take(SIGNAL_BACKLOG + 20)
    for (const old of waiting.slice(SIGNAL_BACKLOG)) await ctx.db.delete(old._id)
    return null
  },
})

export const signals = query({
  args: { key: v.string(), me: v.string() },
  returns: v.array(v.object({ id: v.string(), from: v.string(), data: v.string() })),
  handler: async (ctx, { key, me }) => {
    await requireKey(ctx, key)
    const id = ctx.db.normalizeId('palaceMembers', me)
    if (!id) return []
    const list = await ctx.db.query('palaceSignals').withIndex('by_to', (q) => q.eq('to', id)).take(100)
    return list.map((s) => ({ id: s._id as string, from: s.from as string, data: s.data }))
  },
})

export const ackSignals = mutation({
  args: { key: v.string(), me: v.string(), ids: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, { key, me, ids }) => {
    await requireKey(ctx, key)
    for (const raw of ids.slice(0, 100)) {
      const id = ctx.db.normalizeId('palaceSignals', raw)
      const s = id ? await ctx.db.get(id) : null
      if (s && s.to === me) await ctx.db.delete(s._id)
    }
    return null
  },
})

// ---- relayed voice -------------------------------------------------------------------------

export const sendAudio = mutation({
  args: { key: v.string(), me: v.string(), data: v.bytes() },
  returns: v.object({ seq: v.number() }),
  handler: async (ctx, { key, me, data }) => {
    const member = await requireMember(ctx, key, me)
    if (data.byteLength === 0) throw invalid('Empty audio chunk.')
    if (data.byteLength > AUDIO_MAX_BYTES) throw invalid(`Audio chunks are at most ${AUDIO_MAX_BYTES / 1024} KB.`)
    const now = Date.now()
    const last = await ctx.db.query('palaceAudio').withIndex('by_seq').order('desc').first()
    const seq = (last?.seq ?? 0) + 1
    await ctx.db.insert('palaceAudio', { seq, from: member._id, data, createdAt: now })
    for (const old of await ctx.db.query('palaceAudio').withIndex('by_createdAt', (q) => q.lt('createdAt', now - AUDIO_KEEP_MS)).take(20)) await ctx.db.delete(old._id)
    return { seq }
  },
})

/** The last few chunks from everyone else (newest last), and the newest seq from anyone. */
export const audio = query({
  args: { key: v.string(), me: v.string() },
  returns: v.object({ latest: v.number(), chunks: v.array(v.object({ seq: v.number(), from: v.string(), data: v.bytes() })) }),
  handler: async (ctx, { key, me }) => {
    await requireKey(ctx, key)
    const recent = await ctx.db.query('palaceAudio').withIndex('by_seq').order('desc').take(AUDIO_RECENT * 3)
    const chunks = recent
      .filter((c) => c.from !== me)
      .slice(0, AUDIO_RECENT)
      .reverse()
      .map((c) => ({ seq: c.seq, from: c.from as string, data: c.data }))
    return { latest: recent[0]?.seq ?? 0, chunks }
  },
})

// ---- cleanup -------------------------------------------------------------------------------

/** Cron: screens that left without saying so, call setup nobody read, and old voice. */
export const sweep = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now()
    await dropGone(ctx, now, 200)
    for (const s of await ctx.db.query('palaceSignals').withIndex('by_createdAt', (q) => q.lt('createdAt', now - 60_000)).take(500)) await ctx.db.delete(s._id)
    for (const a of await ctx.db.query('palaceAudio').withIndex('by_createdAt', (q) => q.lt('createdAt', now - AUDIO_KEEP_MS)).take(500)) await ctx.db.delete(a._id)
    return null
  },
})
