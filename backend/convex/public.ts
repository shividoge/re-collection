// Read-only routes for the front page: only captures marked public, approved raisable facts in
// the family's wording, never status internals or the grounding log.
import { v } from 'convex/values'
import { query } from './_generated/server'
import { notImplemented } from './lib_stub'
import { namedFile } from './captures'
import { arrangement as arrangementV, derived, moment as momentV, progressReport, session as sessionV } from './validators'

export const captures = query({
  args: {},
  returns: v.array(
    v.object({ id: v.string(), title: v.string(), summary: v.string(), createdAt: v.string(), durationSec: v.number(), thumbUrl: v.union(v.string(), v.null()), facts: v.number() }),
  ),
  handler: async () => notImplemented('public.captures'),
})

export const capture = query({
  args: { captureId: v.string() },
  returns: v.union(
    v.object({ id: v.string(), manifestJson: v.string(), files: v.array(namedFile), derived: v.union(derived, v.null()), derivedFiles: v.array(namedFile) }),
    v.null(),
  ),
  handler: async () => notImplemented('public.capture'),
})

export const moment = query({
  args: { captureId: v.string() },
  returns: v.union(momentV, v.null()),
  handler: async () => notImplemented('public.moment'),
})

export const progress = query({
  args: { captureId: v.string() },
  returns: v.union(progressReport, v.null()),
  handler: async () => notImplemented('public.progress'),
})

export const session = query({
  args: { sessionId: v.string() },
  returns: v.union(sessionV, v.null()),
  handler: async () => notImplemented('public.session'),
})

export const arrangement = query({
  args: {},
  returns: v.union(arrangementV, v.null()),
  handler: async () => notImplemented('public.arrangement'),
})
