'use node'
// The AI guide's calls out: Moss (index and search each memory's notes), Claude (write and
// answer, grounded by lib/guide.ts) and Cartesia (a short-lived token so the palace can speak
// and listen without ever seeing the API key). Runs in Convex's Node runtime, which Moss's SDK
// needs (it has a native search engine).
//
// Deployment environment: MOSS_PROJECT_ID, MOSS_PROJECT_KEY, CARTESIA_API_KEY, and optionally
// CARTESIA_VOICE_ID (the guide's voice). Claude uses the existing ANTHROPIC_API_KEY.
import { MossClient } from '@moss-js/moss'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import { action, internalAction } from './_generated/server'
import { claudeConfig, claudeFromEnv, list, obj } from './lib/claude'
import {
  ANSWER_SCHEMA,
  ASK_TOP_K,
  MOSS_INDEX,
  NARRATION_SCHEMA,
  SAID_PREFIX,
  answerPrompt,
  groundGuide,
  mossDocs,
  narrationPrompt,
  saidDoc,
  sourceIdOf,
  sourcesOf,
  spoken,
  worthRemembering,
  type MemoryContext,
  type Source,
} from './lib/guide'
import { soundsDistressed } from './lib/grounding'

/** Cartesia's API version for the token and the browser's WebSockets (the Cal Hacks guide's default). */
const CARTESIA_VERSION = '2026-08-14'
/** The voice from Cartesia's Cal Hacks guide; CARTESIA_VOICE_ID picks another (play.cartesia.ai/voices). */
const DEFAULT_VOICE = 'a0e99841-438c-4a64-b679-ae501e7d6091'

// ---- Moss -------------------------------------------------------------------------------------

let moss: MossClient | null = null
/** Whether this process holds the index in memory (queries then run locally, in milliseconds). */
let loaded = false

function mossClient(): MossClient | null {
  const id = process.env.MOSS_PROJECT_ID
  const key = process.env.MOSS_PROJECT_KEY
  if (!id || !key) return null
  moss ??= new MossClient(id, key)
  return moss
}

/** Adds or replaces documents, creating the palace's index the first time. */
async function indexDocs(client: MossClient, docs: { id: string; text: string; metadata: Record<string, string> }[]) {
  const exists = await client
    .getIndex(MOSS_INDEX)
    .then(() => true)
    .catch(() => false)
  if (exists) await client.addDocs(MOSS_INDEX, docs, { upsert: true })
  else await client.createIndex(MOSS_INDEX, docs)
  loaded = false
}

/**
 * The sources Moss finds for a question, within this memory only: the caretaker's notes and facts,
 * and what the person said earlier in the visit. The index is held in this process and refreshes
 * itself every few seconds, so what was just remembered can be found.
 */
async function search(client: MossClient, key: string, question: string): Promise<{ hits: { id: string; text: string }[]; ms: number }> {
  if (!loaded) {
    await client.loadIndex(MOSS_INDEX, { autoRefresh: true, pollingIntervalInSeconds: 5 })
    loaded = true
  }
  const result = await client.query(MOSS_INDEX, question, { topK: ASK_TOP_K, filter: { field: 'memory', condition: { $eq: key } } })
  return { hits: result.docs.map((d) => ({ id: sourceIdOf(d), text: d.text })), ms: result.timeTakenInMs ?? 0 }
}

// ---- Claude -----------------------------------------------------------------------------------

type Sentences = { sentence: string; sources: string[] }[]
const sentencesOf = (x: unknown): Sentences => list(x).map((s) => ({ sentence: String(obj(s).sentence ?? ''), sources: list(obj(s).sources).map(String) }))

async function writeNarration(context: MemoryContext, sources: Source[]) {
  const { system, text } = narrationPrompt(context, sources)
  const claude = claudeFromEnv()
  const { data } = await claude.json({
    model: claudeConfig().models.live,
    system,
    content: [{ type: 'text', text }],
    schema: NARRATION_SCHEMA,
    effort: 'medium',
    maxTokens: 2000,
    timeoutMs: 60_000,
    mock: () => ({
      intro: [{ sentence: `[mock] This is ${context.title || 'a memory'}.`, sources: ['label'] }],
      story: [{ sentence: `[mock] ${sources[1]?.text ?? sources[0]?.text ?? 'A day with family.'}`, sources: [sources[1]?.id ?? 'label'] }],
    }),
  })
  const intro = groundGuide(sentencesOf(obj(data).intro), context, sources)
  const story = groundGuide(sentencesOf(obj(data).story), context, sources)
  return { intro: spoken(intro), story: spoken(story), dropped: [...intro.dropped, ...story.dropped] }
}

// ---- actions ----------------------------------------------------------------------------------

type Prepared = { context: MemoryContext; fingerprint: string; mossDocs: string[] } | null

/** Indexes one memory's notes in Moss and writes its intro and story. Scheduled on save. */
export const prepare = internalAction({
  args: { key: v.string() },
  returns: v.null(),
  handler: async (ctx, { key }) => {
    const found = (await ctx.runQuery(internal.guide.memoryContext, { key })) as Prepared
    if (!found) return null
    const { context, fingerprint } = found
    const sources = sourcesOf(context)
    const docs = mossDocs(key, sources)
    let error: string | null = null
    const client = mossClient()
    if (client) {
      try {
        await indexDocs(client, docs)
        const stale = found.mossDocs.filter((id) => !docs.some((d) => d.id === id))
        if (stale.length > 0) await client.deleteDocs(MOSS_INDEX, stale)
      } catch (e) {
        error = `Moss couldn't index this memory: ${e instanceof Error ? e.message : String(e)}`
      }
    } else error = "Moss isn't configured (MOSS_PROJECT_ID, MOSS_PROJECT_KEY), so questions use every note instead of a search."
    try {
      const words = await writeNarration(context, sources)
      await ctx.runMutation(internal.guide.saveNarration, { key, fingerprint, status: 'ready', intro: words.intro, story: words.story, mossDocs: client && !error ? docs.map((d) => d.id) : [], error })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      await ctx.runMutation(internal.guide.saveNarration, { key, fingerprint, status: 'failed', intro: '', story: '', mossDocs: [], error: message })
    }
    return null
  },
})

/** Adds something the person said to Moss, under the memory they were in. */
export const remember = internalAction({
  args: { key: v.string(), said: v.string(), at: v.number() },
  returns: v.null(),
  handler: async (_ctx, { key, said, at }) => {
    const client = mossClient()
    if (client) await client.addDocs(MOSS_INDEX, [saidDoc(key, said, at)], { upsert: true }).catch(() => {})
    return null
  },
})

/** Removes a memory's documents from Moss once it's taken off the walls. */
export const forget = internalAction({
  args: { docIds: v.array(v.string()) },
  returns: v.null(),
  handler: async (_ctx, { docIds }) => {
    const client = mossClient()
    if (client && docIds.length > 0) await client.deleteDocs(MOSS_INDEX, docIds).catch(() => {})
    loaded = false
    return null
  },
})

/**
 * Something the person said while the guide is on, about the memory in front of them (`key`).
 * Moss finds the few notes that answer it, Claude answers from only those, and code drops any
 * sentence that doesn't trace back to them. Frightened or lost words get plain reassurance.
 */
export const ask = action({
  args: { key: v.string(), question: v.string() },
  returns: v.object({ say: v.string(), distress: v.boolean(), retrieval: v.union(v.literal('moss'), v.literal('all')), mossMs: v.number(), dropped: v.number() }),
  handler: async (ctx, { key, question }) => {
    const said = question.slice(0, 500)
    if (soundsDistressed(said)) return { say: "You're safe. I'm right here with you.", distress: true, retrieval: 'all' as const, mossMs: 0, dropped: 0 }
    const found = (await ctx.runQuery(internal.guide.memoryContext, { key })) as Prepared
    if (!found) return { say: "I'm not sure about that one.", distress: false, retrieval: 'all' as const, mossMs: 0, dropped: 0 }
    const all = sourcesOf(found.context)
    let given = all
    let retrieval: 'moss' | 'all' = 'all'
    let mossMs = 0
    const client = mossClient()
    if (client && found.mossDocs.length > 0) {
      try {
        const found = await search(client, key, said)
        const ids = found.hits.map((h) => h.id)
        const picked = all.filter((s) => ids.includes(s.id))
        // What they told the guide earlier in the visit comes back as a source of its own.
        const remembered: Source[] = found.hits.filter((h) => h.id.startsWith(SAID_PREFIX)).map((h) => ({ id: h.id, text: h.text, kind: 'note' }))
        if (picked.length + remembered.length > 0) {
          // Always keep the label, so the guide knows which memory this is.
          given = [...all.filter((s) => s.id === 'label' && !ids.includes('label')), ...picked, ...remembered]
          retrieval = 'moss'
          mossMs = found.ms
        }
      } catch {
        loaded = false
      }
      // Remember what they said, for the rest of the visit (and the next one).
      if (worthRemembering(said)) await ctx.scheduler.runAfter(0, internal.guideNode.remember, { key, said, at: Date.now() })
    }
    const { system, text } = answerPrompt(found.context, given, said)
    const { data } = await claudeFromEnv().json({
      model: claudeConfig().models.live,
      system,
      content: [{ type: 'text', text }],
      schema: ANSWER_SCHEMA,
      effort: 'low',
      maxTokens: 800,
      timeoutMs: 30_000,
      mock: () => ({ sentences: [{ sentence: `[mock] ${given[1]?.text ?? "I'm not sure about that."}`, sources: given[1] ? [given[1].id] : [] }] }),
    })
    const result = groundGuide(sentencesOf(obj(data).sentences), found.context, given, said)
    return { say: spoken(result) || "I'm not sure about that.", distress: false, retrieval, mossMs, dropped: result.dropped.length }
  },
})

/**
 * A Cartesia access token for the palace (good for a few minutes, speech in and out only), so
 * the browser talks to Cartesia directly without the API key.
 */
export const voiceToken = action({
  args: {},
  returns: v.object({ token: v.string(), expiresAt: v.number(), voice: v.string(), version: v.string(), keyterms: v.array(v.string()) }),
  handler: async (ctx): Promise<{ token: string; expiresAt: number; voice: string; version: string; keyterms: string[] }> => {
    const key = process.env.CARTESIA_API_KEY
    if (!key) throw new Error("CARTESIA_API_KEY isn't set in the Convex deployment, so the guide can't speak.")
    const response = await fetch('https://api.cartesia.ai/access-token', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Cartesia-Version': CARTESIA_VERSION, 'Content-Type': 'application/json' },
      body: JSON.stringify({ grants: { tts: true, stt: true }, expires_in: 600 }),
    })
    if (!response.ok) throw new Error(`Cartesia refused the token request (${response.status}).`)
    const body = (await response.json()) as { token?: string; expires_in?: number }
    if (!body.token) throw new Error('Cartesia sent no token.')
    const keyterms: string[] = await ctx.runQuery(internal.guide.keyterms, {})
    return { token: body.token, expiresAt: Date.now() + (body.expires_in ?? 600) * 1000, voice: process.env.CARTESIA_VOICE_ID || DEFAULT_VOICE, version: CARTESIA_VERSION, keyterms }
  },
})
