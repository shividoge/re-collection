// Fact extraction as a job run by Convex itself (architecture-v3.md §7): a mutation leases the
// facts job and schedules `run`; `run` calls Claude and finishes through a mutation that merges
// against the moment as it is *then*, so approvals and edits made during the call survive. A
// crashed run's 15-minute lease runs out and the reaper re-queues it.
import { v } from 'convex/values'
import { parseManifest } from '../../shared/manifest'
import { internal } from './_generated/api'
import { internalAction, internalMutation, internalQuery } from './_generated/server'
import { ClaudeError, claudeConfig, claudeFromEnv } from './lib/claude'
import { getCapture, getMomentDoc, listFiles } from './lib/data'
import { chooseKeyframes, groundFacts, keyframeSecond, mergeFacts, mockFactsReply, momentHeader, parseSegments, reviewedFacts } from './lib/facts'
import { dispatchFacts, markDone, markFailed } from './lib/jobs'
import { FACTS_SCHEMA, FACTS_SYSTEM, factsContent, type FrameInput, type Segment } from './lib/prompts'
import { R2Error, r2Config, stableGetUrl, type R2Config } from './lib/r2'
import { fact, momentFields } from './validators'

const freshFact = v.object({ text: fact.fields.text, kind: fact.fields.kind, salience: fact.fields.salience, evidence: fact.fields.evidence, cue: fact.fields.cue })

export const inputs = internalQuery({
  args: { jobId: v.id('jobs') },
  handler: async (ctx, { jobId }) => {
    const job = await ctx.db.get(jobId)
    if (!job || job.kind !== 'facts' || job.status !== 'leased') return null
    const capture = await getCapture(ctx, job.captureId)
    if (!capture) return null
    const files = (await listFiles(ctx, capture.captureId, 'raw')).map((f) => ({ name: f.name, key: f.key, rev: f.rev }))
    const moment = await getMomentDoc(ctx, capture.captureId)
    return { captureId: capture.captureId, manifestJson: capture.manifestJson, files, reviewed: reviewedFacts(moment?.facts).map((f) => f.editedText ?? f.text) }
  },
})

export const run = internalAction({
  args: { jobId: v.id('jobs') },
  returns: v.null(),
  handler: async (ctx, { jobId }): Promise<null> => {
    const input = await ctx.runQuery(internal.factsJob.inputs, { jobId })
    if (!input) return null
    try {
      const manifest = parseManifest(input.manifestJson)
      const cfg = r2Config()
      const files = new Map(input.files.map((f) => [f.name, f]))
      const read = async (name: string) => {
        const file = files.get(name)
        if (!file) throw new Error(`${name} is missing.`)
        return fetchBytes(cfg, file.key, file.rev)
      }

      let segments: Segment[] | null = null
      if (manifest.transcript?.file) segments = parseSegments(JSON.parse(new TextDecoder().decode(await read(manifest.transcript.file))) as unknown)

      let names = chooseKeyframes([...files.keys()], segments)
      // Captures from before keyframes existed still have the thumbnail.
      if (names.length === 0 && files.has('thumb.jpg')) names = ['thumb.jpg']
      if (names.length === 0 && (segments ?? []).length === 0) {
        throw new Error('This capture has no keyframes, thumbnail or speech, so there is nothing for Claude to read.')
      }
      const frames: FrameInput[] = await Promise.all(names.map(async (name) => ({ name, t: keyframeSecond(name) ?? 2, base64: toBase64(await read(name)) })))

      const durationSec = manifest.video.durationSec ?? 0
      const { data, model } = await claudeFromEnv().json({
        model: claudeConfig().models.offline,
        system: FACTS_SYSTEM,
        content: factsContent({ title: manifest.title ?? '', attendees: manifest.attendees ?? [], durationSec }, segments, frames, input.reviewed),
        schema: FACTS_SCHEMA,
        effort: 'high',
        mock: () => mockFactsReply(frames),
      })
      const grounded = groundFacts(data, new Set(names), segments, durationSec)
      await ctx.runMutation(internal.factsJob.finish, {
        jobId,
        moment: momentHeader(data, manifest.title ?? ''),
        facts: grounded.facts,
        chapters: grounded.chapters,
        dropped: grounded.dropped,
        inputs: { keyframes: frames.length, transcriptSegments: segments?.length ?? null },
        model,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`facts ${input.captureId}: ${message}`)
      const retryable = (error instanceof ClaudeError || error instanceof R2Error) ? error.retryable : error instanceof TypeError // fetch's network failure
      await ctx.runMutation(internal.factsJob.fail, { jobId, error: message, retryable })
    }
    return null
  },
})

/** Writes the moment, merged against its current review state, and finishes the job. */
export const finish = internalMutation({
  args: {
    jobId: v.id('jobs'),
    moment: momentFields.moment,
    facts: v.array(freshFact),
    chapters: momentFields.chapters,
    dropped: momentFields.dropped,
    inputs: momentFields.inputs,
    model: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { jobId, facts, ...rest }) => {
    const job = await ctx.db.get(jobId)
    if (!job || job.status === 'done') return null
    const capture = await getCapture(ctx, job.captureId)
    if (!capture) return null
    const current = await getMomentDoc(ctx, capture.captureId)
    const doc = { captureId: capture.captureId, ...rest, facts: mergeFacts(current?.facts, facts), extractedAt: new Date().toISOString() }
    if (current) await ctx.db.replace(current._id, doc)
    else await ctx.db.insert('moments', doc)
    await markDone(ctx, job)
    return null
  },
})

/** A retry after its back-off: lease the job to Convex again and run it. */
export const dispatch = internalMutation({
  args: { jobId: v.id('jobs') },
  returns: v.null(),
  handler: async (ctx, { jobId }) => {
    await dispatchFacts(ctx, jobId)
    return null
  },
})

export const fail = internalMutation({
  args: { jobId: v.id('jobs'), error: v.string(), retryable: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { jobId, error, retryable }) => {
    const job = await ctx.db.get(jobId)
    if (job && job.status === 'leased') await markFailed(ctx, job, error, retryable)
    return null
  },
})

async function fetchBytes(cfg: R2Config, key: string, rev: number): Promise<Uint8Array> {
  const res = await fetch(stableGetUrl(cfg, key, rev, Date.now()))
  if (!res.ok) throw new R2Error(`Couldn't read ${key} from storage (HTTP ${res.status}).`, res.status, null)
  return new Uint8Array(await res.arrayBuffer())
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}
