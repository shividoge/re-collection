// Shared shapes for the v3 backend (docs/architecture-v3.md). Tables and function return
// values use these, so the web gets exact types from the generated api.
import { v, type Infer } from 'convex/values'

export const stage = v.union(
  v.literal('not_started'),
  v.literal('queued'),
  v.literal('running'),
  v.literal('done'),
  v.literal('failed'),
  v.literal('skipped'),
)

export const progress = v.object({ stage: v.string(), fraction: v.union(v.number(), v.null()), message: v.string() })

export const captureStatus = v.object({
  source: v.union(v.literal('phone'), v.literal('video')),
  upload: v.union(v.literal('receiving'), v.literal('done'), v.literal('invalid')),
  uploadErrors: v.array(v.string()),
  warnings: v.array(v.string()),
  convert: stage,
  facts: stage,
  bake: stage,
  splat: stage,
  errors: v.object({
    convert: v.optional(v.string()),
    facts: v.optional(v.string()),
    bake: v.optional(v.string()),
    splat: v.optional(v.string()),
  }),
  progress: v.union(progress, v.null()),
  updatedAt: v.number(),
})
export type CaptureStatus = Infer<typeof captureStatus>

export const area = v.union(v.literal('raw'), v.literal('derived'), v.literal('video'))
export type Area = Infer<typeof area>

/** derived/derived.json (architecture-v3.md §4). */
export const derived = v.object({
  format: v.literal('braindance.derived'),
  version: v.number(),
  captureId: v.string(),
  bakedAt: v.string(),
  bakeVersion: v.string(),
  files: v.object({
    points: v.string(),
    surface: v.optional(v.string()),
    timeline: v.optional(v.string()),
    depth: v.optional(v.string()),
    depthIndex: v.optional(v.string()),
  }),
  stats: v.object({
    points: v.number(),
    surfaceTriangles: v.optional(v.number()),
    timelineVoxels: v.optional(v.number()),
    bakeMs: v.number(),
  }),
})
export type Derived = Infer<typeof derived>

export const fileUrl = v.object({ url: v.string(), bytes: v.number(), rev: v.number() })

// ---- facts ------------------------------------------------------------------------------

export const evidence = v.union(
  v.object({ type: v.literal('frame'), t: v.number(), keyframe: v.string() }),
  v.object({ type: v.literal('transcript'), tStart: v.number(), tEnd: v.number(), quote: v.string() }),
)

export type Evidence = Infer<typeof evidence>

export const fact = v.object({
  id: v.string(),
  text: v.string(),
  kind: v.union(
    v.literal('person'),
    v.literal('object'),
    v.literal('action'),
    v.literal('speech'),
    v.literal('place'),
    v.literal('feeling'),
  ),
  salience: v.union(v.literal(1), v.literal(2), v.literal(3)),
  evidence: v.array(evidence),
  cue: v.string(),
  status: v.union(v.literal('pending'), v.literal('approved'), v.literal('rejected')),
  editedText: v.union(v.string(), v.null()),
  doNotRaise: v.boolean(),
})
export type Fact = Infer<typeof fact>

export const momentFields = {
  captureId: v.string(),
  moment: v.object({ title: v.string(), place: v.string(), occasion: v.string(), summary: v.string() }),
  facts: v.array(fact),
  chapters: v.array(v.object({ tStart: v.number(), tEnd: v.number(), label: v.string() })),
  dropped: v.array(v.object({ text: v.string(), reason: v.string() })),
  inputs: v.object({ keyframes: v.number(), transcriptSegments: v.union(v.number(), v.null()) }),
  extractedAt: v.string(),
  model: v.string(),
}
export const moment = v.object(momentFields)
export type Moment = Infer<typeof moment>

// ---- sessions ---------------------------------------------------------------------------

export const sentence = v.object({ sentence: v.string(), factIds: v.array(v.string()), free: v.optional(v.boolean()) })
export const droppedSentence = v.object({ sentence: v.string(), reason: v.string() })
export const reply = v.object({ sentences: v.array(sentence), dropped: v.array(droppedSentence) })
export type Reply = Infer<typeof reply>

export const score = v.object({
  factId: v.string(),
  result: v.union(v.literal('unprompted'), v.literal('after_cue'), v.literal('not_mentioned')),
  line: v.optional(v.number()),
})
export const branch = v.object({ t: v.string(), quote: v.string(), note: v.string() })
export const alert = v.object({ t: v.string(), kind: v.literal('distress'), note: v.string() })
export const focus = v.object({ label: v.string(), factIds: v.array(v.string()) })

export const person = v.object({ displayName: v.string(), preferredAddress: v.string() })
export type Person = Infer<typeof person>

export const turn = v.object({
  t: v.string(),
  speaker: v.union(v.literal('claude'), v.literal('patient')),
  text: v.string(),
  kind: v.optional(v.union(v.literal('welcome'), v.literal('narration'), v.literal('reply'))),
  factIds: v.optional(v.array(v.string())),
  chapterIndex: v.optional(v.number()),
  focus: v.optional(focus),
  dropped: v.optional(v.array(droppedSentence)),
})

export const endReason = v.union(v.literal('complete'), v.literal('caregiver'), v.literal('distress'), v.literal('timeout'))

export const sessionFields = {
  captureId: v.string(),
  person: person,
  startedAt: v.string(),
  endedAt: v.union(v.string(), v.null()),
  endReason: v.union(endReason, v.null()),
  allowedFactIds: v.array(v.string()),
  said: v.array(v.string()),
  turns: v.array(turn),
  dropped: v.array(v.object({ t: v.string(), sentence: v.string(), reason: v.string() })),
  branches: v.array(branch),
  alerts: v.array(alert),
  scores: v.union(v.array(score), v.null()),
  note: v.union(v.string(), v.null()),
}
export const session = v.object({ sessionId: v.string(), ...sessionFields })
export type Session = Infer<typeof session>

/** A finished session as visitors see it: no person details, no alerts, no focus (guide-api.md "Public routes"). */
export const publicSession = v.object({
  sessionId: v.string(),
  captureId: v.string(),
  startedAt: v.string(),
  endedAt: v.string(),
  endReason: v.union(endReason, v.null()),
  turns: v.array(
    v.object({
      t: v.string(),
      speaker: v.union(v.literal('claude'), v.literal('patient')),
      text: v.string(),
      kind: v.optional(v.union(v.literal('welcome'), v.literal('narration'), v.literal('reply'))),
      factIds: v.optional(v.array(v.string())),
    }),
  ),
  dropped: v.array(v.object({ t: v.string(), sentence: v.string(), reason: v.string() })),
  branches: v.array(branch),
  scores: v.array(score),
  note: v.string(),
})

export const endSummary = v.object({
  scores: v.array(score),
  branches: v.array(branch),
  note: v.string(),
  alerts: v.array(alert),
})

export const progressReport = v.object({
  captureId: v.string(),
  facts: v.array(v.object({ id: v.string(), text: v.string() })),
  sessions: v.array(
    v.object({
      sessionId: v.string(),
      startedAt: v.string(),
      endedAt: v.string(),
      endReason: v.string(),
      unprompted: v.number(),
      afterCue: v.number(),
      notMentioned: v.number(),
      scores: v.array(score),
      branches: v.array(branch),
      alerts: v.array(alert),
      note: v.string(),
    }),
  ),
  nextRevisit: v.array(v.string()),
})

// ---- museum -----------------------------------------------------------------------------

export const roomState = v.object({
  at: v.number(),
  atId: v.union(v.string(), v.null()),
  window: v.union(v.string(), v.null()),
  by: v.union(v.literal('patient'), v.literal('helper')),
  name: v.union(v.string(), v.null()),
  rev: v.number(),
  updatedAt: v.string(),
})
export const peers = v.object({ patient: v.number(), helpers: v.array(v.string()) })

export const arrangementItem = v.object({
  capture: v.string(),
  piece: v.string(),
  title: v.string(),
  caption: v.string(),
  /** For the AI guide only (never shown, never public): what the caretaker tells it about this memory. */
  notes: v.optional(v.string()),
  /** For the AI guide only: what it must never bring up. */
  avoid: v.optional(v.string()),
})
export const arrangement = v.object({
  title: v.string(),
  subtitle: v.string(),
  items: v.array(arrangementItem),
  updatedAt: v.string(),
})

// ---- jobs -------------------------------------------------------------------------------

export const jobKind = v.union(v.literal('facts'), v.literal('bake'), v.literal('convert'), v.literal('splat'))
export type JobKind = Infer<typeof jobKind>

/** An upload target: one presigned PUT, or a multipart upload's part URLs. */
export const uploadTarget = v.object({
  uploadId: v.string(),
  key: v.string(),
  partSize: v.optional(v.number()),
  parts: v.optional(v.array(v.object({ partNumber: v.number(), url: v.string() }))),
  single: v.optional(v.object({ url: v.string(), headers: v.record(v.string(), v.string()) })),
})
export type UploadTarget = Infer<typeof uploadTarget>
export const finishedPart = v.object({ partNumber: v.number(), etag: v.string() })
