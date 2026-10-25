// Revisit sessions. Claude is called from actions; every reply is grounded again inside the
// mutation that saves it, against the moment as it is at that instant, so a fact the family
// rejects or marks "don't bring this up" during a call can never be spoken.
import { ConvexError, v, type Infer } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import { action, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import { claudeConfig, claudeFromEnv } from './lib/claude'
import { attendeesOf, conflict, getCapture, getMomentDoc, getPerson, invalid, momentOf, notFound, requireCapture } from './lib/data'
import { soundsDistressed, words } from './lib/grounding'
import {
  NOTHING_SAID_NOTE,
  addSaid,
  applyScores,
  cleanFocus,
  finalReply,
  groundingContext,
  mergeBranches,
  narrationRequest,
  readReply,
  replyText,
  scoringLines,
  scoringRequest,
  turnRequest,
  welcomeSentence,
} from './lib/session'
import { endReason, endSummary, focus, reply, score, session, type Reply } from './validators'

const proposed = v.array(v.object({ sentence: v.string(), factIds: v.array(v.string()), free: v.optional(v.boolean()) }))

async function loadSession(ctx: QueryCtx | MutationCtx, sessionId: string): Promise<Doc<'sessions'>> {
  const doc = await ctx.db.query('sessions').withIndex('by_sessionId', (q) => q.eq('sessionId', sessionId)).unique()
  if (!doc) throw notFound(`No session ${sessionId}.`)
  return doc
}

/** The session, its moment and capture as they are now. */
async function sessionContext(ctx: QueryCtx | MutationCtx, sessionId: string) {
  const s = await loadSession(ctx, sessionId)
  const capture = await getCapture(ctx, s.captureId)
  const moment = capture && momentOf(await getMomentDoc(ctx, s.captureId))
  if (!capture || !moment) throw conflict('This capture has no facts any more.')
  return { session: s, capture, moment, ground: groundingContext(moment, attendeesOf(capture), s.person.preferredAddress) }
}

function summaryOf(s: Doc<'sessions'>) {
  return { scores: s.scores ?? [], branches: s.branches, note: s.note ?? '', alerts: s.alerts }
}

function publicFields(s: Doc<'sessions'>) {
  const { _id, _creationTime, ...rest } = s
  return rest
}

/** 409-equivalent ConvexError({ code: 'no_facts' }) when no facts are approved yet. */
export const start = mutation({
  args: { captureId: v.string() },
  returns: v.object({ sessionId: v.string(), welcome: reply }),
  handler: async (ctx, { captureId }) => {
    const capture = await requireCapture(ctx, captureId)
    const moment = momentOf(await getMomentDoc(ctx, capture.captureId))
    if (!moment) throw new ConvexError({ code: 'no_facts', message: 'This capture has no facts yet. Extract and review them first.' })
    const who = await getPerson(ctx)
    const { allowed } = groundingContext(moment, attendeesOf(capture), who.preferredAddress)
    if (allowed.size === 0) {
      throw new ConvexError({ code: 'no_facts', message: 'No facts are approved yet. Approve some in the review screen before starting a session.' })
    }
    const greeting = welcomeSentence(who.preferredAddress)
    const sessionId = crypto.randomUUID()
    const now = new Date().toISOString()
    await ctx.db.insert('sessions', {
      sessionId,
      captureId: capture.captureId,
      person: who,
      startedAt: now,
      endedAt: null,
      endReason: null,
      allowedFactIds: [...allowed.keys()],
      said: [],
      turns: [{ t: now, speaker: 'claude', text: greeting, kind: 'welcome', factIds: [] }],
      dropped: [],
      branches: [],
      alerts: [],
      scores: null,
      note: null,
    })
    return { sessionId, welcome: { sentences: [{ sentence: greeting, factIds: [], free: true }], dropped: [] } }
  },
})

// ---- narration ----------------------------------------------------------------------------

export const narrationInput = internalQuery({
  args: { sessionId: v.string(), chapterIndex: v.union(v.number(), v.null()) },
  handler: async (ctx, { sessionId, chapterIndex }) => {
    const { session: s, moment, ground } = await sessionContext(ctx, sessionId)
    if (s.endedAt) throw conflict('This session has ended.')
    const chapter = chapterIndex !== null && Number.isInteger(chapterIndex) ? moment.chapters[chapterIndex] : null
    if (chapterIndex !== null && Number.isInteger(chapterIndex) && !chapter) throw invalid(`This moment has no chapter ${chapterIndex}.`)
    return { address: s.person.preferredAddress, allowed: [...ground.allowed.values()], chapter: chapter ?? null, said: s.said }
  },
})

export const commitNarration = internalMutation({
  args: { sessionId: v.string(), chapterIndex: v.union(v.number(), v.null()), sentences: proposed },
  returns: reply,
  handler: async (ctx, { sessionId, chapterIndex, sentences }) => {
    const { session: s, ground } = await sessionContext(ctx, sessionId)
    if (s.endedAt) throw conflict('This session has ended.')
    const grounded = finalReply(sentences, ground)
    const t = new Date().toISOString()
    await ctx.db.patch(s._id, {
      said: addSaid(s.said, grounded),
      dropped: [...s.dropped, ...grounded.dropped.map((d) => ({ t, ...d }))],
      turns: [...s.turns, {
        t,
        speaker: 'claude' as const,
        text: replyText(grounded),
        kind: 'narration' as const,
        ...(chapterIndex !== null ? { chapterIndex } : {}),
        factIds: grounded.sentences.flatMap((x) => x.factIds),
      }],
    })
    return grounded
  },
})

/** chapterIndex null (or not a whole number): narrate the moment as a whole, e.g. one without chapters. */
export const narrate = action({
  args: { sessionId: v.string(), chapterIndex: v.union(v.number(), v.null()) },
  returns: v.object({ reply: reply }),
  handler: async (ctx, { sessionId, chapterIndex }): Promise<{ reply: Reply }> => {
    const input = await ctx.runQuery(internal.sessions.narrationInput, { sessionId, chapterIndex })
    const allowed = new Map(input.allowed.map((f) => [f.id, f]))
    const { data } = await claudeFromEnv().json(narrationRequest({ models: claudeConfig().models, address: input.address, allowed, chapter: input.chapter, said: input.said }))
    const grounded = await ctx.runMutation(internal.sessions.commitNarration, {
      sessionId,
      chapterIndex: input.chapter ? chapterIndex : null,
      sentences: readReply(data).sentences.map((s) => ({ sentence: s.sentence ?? '', factIds: s.factIds ?? [], free: s.free })),
    })
    return { reply: grounded }
  },
})

// ---- conversation -------------------------------------------------------------------------

export const turnInput = internalQuery({
  args: { sessionId: v.string() },
  handler: async (ctx, { sessionId }) => {
    const { session: s, ground } = await sessionContext(ctx, sessionId)
    if (s.endedAt) throw conflict('This session has ended.')
    return { address: s.person.preferredAddress, allowed: [...ground.allowed.values()], history: s.turns.slice(-16) }
  },
})

export const commitTurn = internalMutation({
  args: {
    sessionId: v.string(),
    text: v.string(),
    saidAt: v.string(),
    focus: v.union(focus, v.null()),
    sentences: proposed,
    branch: v.union(v.string(), v.null()),
    distress: v.boolean(),
  },
  returns: v.object({ reply: reply, branch: v.union(v.string(), v.null()), distress: v.boolean() }),
  handler: async (ctx, args) => {
    const { session: s, ground } = await sessionContext(ctx, args.sessionId)
    if (s.endedAt) throw conflict('This session has ended.')
    const flagged = soundsDistressed(args.text)
    const distress = flagged || args.distress
    const cleanedFocus = cleanFocus(args.focus, ground.allowed)
    const grounded = finalReply(args.sentences, ground, { distress, branch: Boolean(args.branch), echo: words(args.text) })
    const t = new Date().toISOString()
    await ctx.db.patch(s._id, {
      said: addSaid(s.said, grounded),
      dropped: [...s.dropped, ...grounded.dropped.map((d) => ({ t, ...d }))],
      turns: [
        ...s.turns,
        { t: args.saidAt, speaker: 'patient' as const, text: args.text, ...(cleanedFocus ? { focus: cleanedFocus } : {}) },
        { t, speaker: 'claude' as const, text: replyText(grounded), kind: 'reply' as const, factIds: grounded.sentences.flatMap((x) => x.factIds) },
      ],
      branches: args.branch ? [...s.branches, { t, quote: args.branch, note: '' }] : s.branches,
      alerts: distress
        ? [...s.alerts, { t, kind: 'distress' as const, note: `They said: "${args.text}"${flagged ? ' (matched a distress phrase)' : ''}.` }]
        : s.alerts,
    })
    return { reply: grounded, branch: args.branch, distress }
  },
})

export const turn = action({
  args: { sessionId: v.string(), text: v.string(), focus: v.optional(focus) },
  returns: v.object({ reply: reply, branch: v.union(v.string(), v.null()), distress: v.boolean() }),
  handler: async (ctx, { sessionId, text, focus: rawFocus }): Promise<{ reply: Reply; branch: string | null; distress: boolean }> => {
    const said = text.trim()
    if (!said) throw invalid('text is required: what the person said.')
    const saidAt = new Date().toISOString()
    const input = await ctx.runQuery(internal.sessions.turnInput, { sessionId })
    const allowed = new Map(input.allowed.map((f) => [f.id, f]))
    const cleanedFocus = cleanFocus(rawFocus, allowed)
    const { data } = await claudeFromEnv().json(turnRequest({ models: claudeConfig().models, address: input.address, allowed, history: input.history, latest: said, focus: cleanedFocus }))
    const r = readReply(data)
    return ctx.runMutation(internal.sessions.commitTurn, {
      sessionId,
      text: said,
      saidAt,
      focus: cleanedFocus,
      sentences: r.sentences.map((s) => ({ sentence: s.sentence ?? '', factIds: s.factIds ?? [], free: s.free })),
      branch: r.branch,
      distress: r.distress,
    })
  },
})

// ---- end and scoring ----------------------------------------------------------------------

export const endInput = internalQuery({
  args: { sessionId: v.string() },
  handler: async (ctx, { sessionId }) => {
    const s = await loadSession(ctx, sessionId)
    if (s.endedAt) return { ended: true as const, summary: summaryOf(s) }
    const moment = momentOf(await getMomentDoc(ctx, s.captureId))
    if (!moment) throw conflict('This capture has no facts any more.')
    const allowedIds = s.allowedFactIds.filter((id) => moment.facts.some((f) => f.id === id))
    return { ended: false as const, moment, allowedIds, turns: s.turns }
  },
})

export const commitEnd = internalMutation({
  args: {
    sessionId: v.string(),
    endedAt: v.string(),
    reason: endReason,
    scores: v.array(score),
    branches: v.array(v.object({ quote: v.string(), note: v.string() })),
    note: v.string(),
  },
  returns: endSummary,
  handler: async (ctx, args) => {
    const s = await loadSession(ctx, args.sessionId)
    if (s.endedAt) return summaryOf(s)
    const next = {
      endedAt: args.endedAt,
      endReason: args.reason,
      scores: args.scores,
      note: args.note,
      branches: mergeBranches(s.branches, args.branches, args.endedAt),
    }
    await ctx.db.patch(s._id, next)
    return summaryOf({ ...s, ...next })
  },
})

/** Runs scoring once; calling it again returns the same result. */
export const end = action({
  args: { sessionId: v.string(), reason: endReason },
  returns: endSummary,
  handler: async (ctx, { sessionId, reason }): Promise<Infer<typeof endSummary>> => {
    const input = await ctx.runQuery(internal.sessions.endInput, { sessionId })
    if (input.ended) return input.summary
    const endedAt = new Date().toISOString()
    const { lines, patientLines } = scoringLines(input.turns)
    let scored: ReturnType<typeof applyScores>
    if (patientLines.size === 0) {
      scored = { scores: input.allowedIds.map((factId) => ({ factId, result: 'not_mentioned' as const })), branches: [], note: NOTHING_SAID_NOTE }
    } else {
      const { data } = await claudeFromEnv().json(scoringRequest(claudeConfig().models, input.moment, input.allowedIds, lines))
      scored = applyScores(data, input.allowedIds, input.turns, patientLines)
    }
    return ctx.runMutation(internal.sessions.commitEnd, { sessionId, endedAt, reason, ...scored })
  },
})

export const get = query({
  args: { sessionId: v.string() },
  returns: v.union(session, v.null()),
  handler: async (ctx, { sessionId }) => {
    const s = await ctx.db.query('sessions').withIndex('by_sessionId', (q) => q.eq('sessionId', sessionId)).unique()
    return s ? publicFields(s) : null
  },
})

