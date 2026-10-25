// Tables for the v3 backend (docs/architecture-v3.md §6.1). Capture ids are the manifest's UUID
// (string `captureId`), not Convex document ids, so they stay the same across imports.
import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'
import {
  area,
  arrangementItem,
  captureStatus,
  derived,
  jobKind,
  momentFields,
  person,
  progress,
  roomState,
  sessionFields,
} from './validators'

export default defineSchema({
  captures: defineTable({
    captureId: v.string(),
    /** manifest.json exactly as uploaded (parsed by the web with shared/manifest.ts). */
    manifestJson: v.string(),
    title: v.string(),
    createdAt: v.string(),
    durationSec: v.number(),
    status: captureStatus,
    public: v.boolean(),
    derived: v.union(derived, v.null()),
    /** Set when the capture is being deleted; everything ignores it from then on. */
    deleting: v.optional(v.boolean()),
  })
    .index('by_captureId', ['captureId'])
    .index('by_createdAt', ['createdAt']),

  files: defineTable({
    captureId: v.string(),
    area: area,
    name: v.string(),
    key: v.string(),
    bytes: v.number(),
    contentType: v.string(),
    contentEncoding: v.optional(v.string()),
    rev: v.number(),
    createdAt: v.number(),
    /** depth.index.json only: total chunk bytes and frame count it lists (checked by captures.complete). */
    indexedBytes: v.optional(v.number()),
    indexedCount: v.optional(v.number()),
  })
    .index('by_capture', ['captureId', 'area', 'name']),

  uploads: defineTable({
    captureId: v.string(),
    area: area,
    name: v.string(),
    key: v.string(),
    bytes: v.number(),
    contentType: v.string(),
    contentEncoding: v.optional(v.string()),
    /** R2 multipart upload id; absent for a single PUT. */
    r2UploadId: v.optional(v.string()),
    partSize: v.optional(v.number()),
    status: v.union(v.literal('open'), v.literal('done'), v.literal('aborted')),
    /** Set when a worker writes this file for a job. */
    jobId: v.optional(v.id('jobs')),
    createdAt: v.number(),
  })
    .index('by_capture', ['captureId'])
    .index('by_status', ['status', 'createdAt']),

  moments: defineTable(momentFields).index('by_captureId', ['captureId']),

  sessions: defineTable({
    sessionId: v.string(),
    ...sessionFields,
    /** Set while `end` scores the session: new turns are refused, a second `end` waits. */
    endingAt: v.optional(v.number()),
  })
    .index('by_sessionId', ['sessionId'])
    .index('by_capture', ['captureId', 'startedAt']),

  /** One row: who the sessions are for. */
  people: defineTable(person),

  jobs: defineTable({
    captureId: v.string(),
    kind: jobKind,
    status: v.union(v.literal('queued'), v.literal('leased'), v.literal('done'), v.literal('failed')),
    needs: v.object({ gpu: v.boolean(), frames: v.optional(v.number()) }),
    attempts: v.number(),
    leaseUntil: v.union(v.number(), v.null()),
    workerId: v.union(v.string(), v.null()),
    progress: v.union(progress, v.null()),
    error: v.union(v.string(), v.null()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_status', ['status', 'createdAt'])
    .index('by_capture', ['captureId', 'kind'])
    .index('by_lease', ['status', 'leaseUntil']),

  workers: defineTable({
    workerId: v.string(),
    kinds: v.array(jobKind),
    gpu: v.boolean(),
    maxFrames: v.optional(v.number()),
    lastSeen: v.number(),
  }).index('by_workerId', ['workerId']),

  museumRooms: defineTable({
    code: v.string(),
    state: roomState,
    lastChange: v.number(),
  }).index('by_code', ['code']),

  museumPresence: defineTable({
    code: v.string(),
    client: v.string(),
    as: v.union(v.literal('patient'), v.literal('helper')),
    name: v.union(v.string(), v.null()),
    lastSeen: v.number(),
  })
    .index('by_code', ['code', 'lastSeen'])
    .index('by_client', ['code', 'client']),

  /** One row: the caretaker's museum arrangement. */
  museumArrangement: defineTable({
    title: v.string(),
    subtitle: v.string(),
    items: v.array(arrangementItem),
    updatedAt: v.string(),
  }),
})
