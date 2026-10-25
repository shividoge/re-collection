// The family's tools and the Revisit session (live mode only: these need Convex). Hooks are
// reactive; the plain functions are one-off calls. Every failure surfaces as a plain message.
import { useQueries } from 'convex/react'
import { useEffect, useState } from 'react'
import { api, convex, convexUrl } from './convex'
import { useLive, type Loadable } from './useLive'
import type { CaptureDetail, CaptureStatus, CaptureSummary, EndReason, Fact, FactChange, Focus, Health, Moment, Person, Progress, Reply, SessionEnd } from './types'

// Return types are spelled out so they're checked against the validators' shapes.
export const useHealth = (): Loadable<Health> => useLive(api.system.health, {})
export const useCaptures = (): Loadable<CaptureSummary[]> => useLive(api.captures.list, {})
export const useMoment = (captureId: string): Loadable<{ moment: Moment | null; status: CaptureStatus | null }> => useLive(api.moments.get, { captureId })
export const useProgress = (captureId: string): Loadable<Progress> => useLive(api.progress.get, { captureId })
export const usePerson = (): Loadable<Person> => useLive(api.people.get, {})

/** The capture's live pipeline status (shares useCaptureAssets' subscription). */
export function useCaptureStatus(captureId: string | null): Loadable<CaptureStatus | null> {
  const detail: Loadable<CaptureDetail | null> = useLive(api.captures.get, captureId ? { captureId } : 'skip')
  return detail.status === 'ready' ? { status: 'ready', data: detail.data?.status ?? null } : detail
}

/** Progress for several captures at once: undefined while loading, null when it failed. */
export function useProgressMany(ids: string[]): Record<string, Progress | null | undefined> {
  const requests = Object.fromEntries(ids.map((id) => [id, { query: api.progress.get, args: { captureId: id } }]))
  const results: Record<string, unknown> = useQueries(requests)
  return Object.fromEntries(ids.map((id) => [id, results[id] instanceof Error ? null : (results[id] as Progress | undefined)]))
}

/** A clock for "is that worker still online?", ticking every `ms`. */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [ms])
  return now
}

export const family = {
  patchFact: (captureId: string, factId: string, change: FactChange): Promise<Fact> => convex().mutation(api.moments.patchFact, { captureId, factId, ...change }),
  reextract: (captureId: string) => convex().mutation(api.moments.reextract, { captureId }),
  setPublic: (captureId: string, on: boolean) => convex().mutation(api.captures.setPublic, { captureId, public: on }),
  setPerson: (person: Person) => convex().mutation(api.people.set, person),
}

export const sessions = {
  start: (captureId: string): Promise<{ sessionId: string; welcome: Reply }> => convex().mutation(api.sessions.start, { captureId }),
  narrate: (sessionId: string, chapterIndex: number): Promise<{ reply: Reply }> => convex().action(api.sessions.narrate, { sessionId, chapterIndex }),
  turn: (sessionId: string, text: string, focus?: Focus): Promise<{ reply: Reply; branch: string | null; distress: boolean }> =>
    convex().action(api.sessions.turn, focus ? { sessionId, text, focus } : { sessionId, text }),
  end: (sessionId: string, reason: EndReason): Promise<SessionEnd> => convex().action(api.sessions.end, { sessionId, reason }),
  /**
   * Ends a session while the page unloads (a reload or a closed tab). The websocket dies with the
   * page, so this goes over Convex's HTTP API with `keepalive`. Best effort: scoring is
   * idempotent, so a later end() returns the same result.
   */
  endOnUnload(sessionId: string, reason: EndReason) {
    if (!convexUrl) return
    void fetch(`${convexUrl}/api/action`, {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'sessions:end', args: { sessionId, reason }, format: 'json' }),
    }).catch(() => {})
  },
}

/** A worker counts as online when it checked in within this long. */
export const WORKER_ONLINE_MS = 60_000
export const onlineWorkers = (health: Health | null, now: number) => (health?.workers ?? []).filter((w) => now - w.lastSeen < WORKER_ONLINE_MS)
