// The live visit's calls (architecture-v3.md §6.6 "Live visit"; live mode only). Reactive
// queries arrive through `watch`, which hands on every new answer until stopped.
import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server'
import { api, convex } from './convex'
import type { IceServer, LiveMember, LiveRole, LiveView, LiveViewState } from './types'

/** Calls `onValue` with the query's answer now and on every change; returns stop. */
function watch<Q extends FunctionReference<'query'>>(query: Q, args: FunctionArgs<Q>, onValue: (value: FunctionReturnType<Q>) => void, onError: (error: unknown) => void): () => void {
  const w = convex().watchQuery(query, args)
  const read = () => {
    let value: FunctionReturnType<Q> | undefined
    try {
      value = w.localQueryResult()
    } catch (error) {
      return onError(error)
    }
    if (value !== undefined) onValue(value)
  }
  const stop = w.onUpdate(read)
  read()
  return stop
}

export type LiveSignal = { id: string; from: string; data: string }
export type LiveAudio = { latest: number; chunks: { seq: number; from: string; data: ArrayBuffer }[] }

export const palaceLive = {
  /** The caretaker's editor: the current visit key, or null until one is made. */
  visitKey: async (): Promise<string | null> => (await convex().query(api.palace.visitKey, {})).key,
  /** The current key, or a new one (`replace` ends the visit and stops the old link working). */
  makeVisitKey: async (replace = false): Promise<string> => (await convex().action(api.palace.makeVisitKey, { replace })).key,

  join: (key: string, role: LiveRole, name?: string): Promise<{ me: string; iceServers: IceServer[] }> => convex().mutation(api.palace.join, { key, role, name }),
  heartbeat: (key: string, me: string) => convex().mutation(api.palace.heartbeat, { key, me }),
  leave: (key: string, me: string) => convex().mutation(api.palace.leave, { key, me }),
  setView: (key: string, me: string, view: LiveView) => convex().mutation(api.palace.setView, { key, me, view }),
  signal: (key: string, me: string, to: string, data: string) => convex().mutation(api.palace.signal, { key, me, to, data }),
  ackSignals: (key: string, me: string, ids: string[]) => convex().mutation(api.palace.ackSignals, { key, me, ids }),
  sendAudio: (key: string, me: string, data: ArrayBuffer) => convex().mutation(api.palace.sendAudio, { key, me, data }),

  watchMembers: (key: string, me: string, on: (v: { here: boolean; members: LiveMember[] }) => void, err: (e: unknown) => void) => watch(api.palace.members, { key, me }, on, err),
  watchView: (key: string, on: (v: LiveViewState | null) => void, err: (e: unknown) => void) => watch(api.palace.view, { key }, on, err),
  watchSignals: (key: string, me: string, on: (v: LiveSignal[]) => void, err: (e: unknown) => void) => watch(api.palace.signals, { key, me }, on, err),
  watchAudio: (key: string, me: string, on: (v: LiveAudio) => void, err: (e: unknown) => void) => watch(api.palace.audio, { key, me }, on, err),
}
