import { v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { notImplemented } from './lib_stub'
import { arrangement, arrangementItem, peers, roomState } from './validators'

const who = v.union(v.literal('patient'), v.literal('helper'))

export const createRoom = mutation({
  args: { at: v.optional(v.number()) },
  returns: v.object({ code: v.string() }),
  handler: async () => notImplemented('museum.createRoom'),
})

/** Reactive room state + peers (replaces the guide's SSE and polling). */
export const room = query({
  args: { code: v.string() },
  returns: v.union(v.object({ code: v.string(), state: roomState, peers: peers }), v.null()),
  handler: async () => notImplemented('museum.room'),
})

export const setState = mutation({
  args: { code: v.string(), at: v.number(), atId: v.optional(v.union(v.string(), v.null())), window: v.union(v.string(), v.null()), by: who, name: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ state: roomState }),
  handler: async () => notImplemented('museum.setState'),
})

/** Every 5 s per screen; peers count heartbeats newer than 12 s. */
export const heartbeat = mutation({
  args: { code: v.string(), client: v.string(), as: who, name: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ ok: v.literal(true) }),
  handler: async () => notImplemented('museum.heartbeat'),
})

export const getArrangement = query({
  args: {},
  returns: v.union(arrangement, v.null()),
  handler: async () => notImplemented('museum.getArrangement'),
})

export const setArrangement = mutation({
  args: { title: v.string(), subtitle: v.string(), items: v.array(arrangementItem) },
  returns: arrangement,
  handler: async () => notImplemented('museum.setArrangement'),
})

export const clearArrangement = mutation({
  args: {},
  returns: v.null(),
  handler: async () => notImplemented('museum.clearArrangement'),
})
