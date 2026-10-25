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

  /** `me` is this screen's public id (others see it); `token` is its secret for its own calls. */
  join: (key: string, role: LiveRole, name?: string): Promise<{ me: string; token: string; iceServers: IceServer[] }> => convex().mutation(api.palace.join, { key, role, name }),
  heartbeat: (key: string, token: string) => convex().mutation(api.palace.heartbeat, { key, token }),
  leave: (key: string, token: string) => convex().mutation(api.palace.leave, { key, token }),
  setView: (key: string, token: string, view: LiveView) => convex().mutation(api.palace.setView, { key, token, view }),
  signal: (key: string, token: string, to: string, data: string) => convex().mutation(api.palace.signal, { key, token, to, data }),
  ackSignals: (key: string, token: string, ids: string[]) => convex().mutation(api.palace.ackSignals, { key, token, ids }),
  sendAudio: (key: string, token: string, data: ArrayBuffer) => convex().mutation(api.palace.sendAudio, { key, token, data }),

  watchMembers: (key: string, token: string, on: (v: { here: boolean; members: LiveMember[] }) => void, err: (e: unknown) => void) => watch(api.palace.members, { key, token }, on, err),
  watchView: (key: string, token: string, on: (v: LiveViewState | null) => void, err: (e: unknown) => void) => watch(api.palace.view, { key, token }, on, err),
  watchSignals: (key: string, token: string, on: (v: LiveSignal[]) => void, err: (e: unknown) => void) => watch(api.palace.signals, { key, token }, on, err),
  watchAudio: (key: string, token: string, on: (v: LiveAudio) => void, err: (e: unknown) => void) => watch(api.palace.audio, { key, token }, on, err),
}
