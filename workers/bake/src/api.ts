// The worker functions of the Convex backend (docs/architecture-v3.md §7), typed from the
// committed generated api. The job loop takes this interface, so tests pass a fake.
import { ConvexHttpClient } from 'convex/browser'
import { anyApi, type FunctionArgs, type FunctionReturnType } from 'convex/server'
import type { api as Api } from '../../../backend/convex/_generated/api'

// The generated api.js is just `anyApi`; importing it at run time would need backend/'s packages.
const api = anyApi as unknown as typeof Api
type W = typeof Api.worker
type Name = 'claim' | 'heartbeat' | 'inputs' | 'outputUrls' | 'finishOutput' | 'complete' | 'fail'

export type Claim = NonNullable<FunctionReturnType<W['claim']>>
export type Inputs = FunctionReturnType<W['inputs']>
type Returns = { [K in Name]: FunctionReturnType<W[K]> }

export type WorkerApi = { [K in Name]: (args: Omit<FunctionArgs<W[K]>, 'token'>) => Promise<Returns[K]> }

export function convexWorkerApi(url: string, token: string): WorkerApi {
  const c = new ConvexHttpClient(url)
  const w = api.worker
  return {
    claim: (a) => c.mutation(w.claim, { ...a, token }),
    heartbeat: (a) => c.mutation(w.heartbeat, { ...a, token }),
    inputs: (a) => c.action(w.inputs, { ...a, token }),
    outputUrls: (a) => c.action(w.outputUrls, { ...a, token }),
    finishOutput: (a) => c.action(w.finishOutput, { ...a, token }),
    complete: (a) => c.mutation(w.complete, { ...a, token }),
    fail: (a) => c.mutation(w.fail, { ...a, token }),
  }
}

/** The backend refused a call because this attempt no longer holds the job's lease. */
export function isCancelled(error: unknown): boolean {
  const data = (error as { data?: unknown } | null)?.data
  return typeof data === 'object' && data !== null && (data as { code?: unknown }).code === 'cancelled'
}

/** A Convex call that took longer than its deadline. */
export class CallTimeout extends Error {}

/**
 * Waits for `call` at most `ms`, and no longer once `signal` aborts (rejecting with its reason).
 * ConvexHttpClient can't cancel a request, so this only stops waiting: a lease the call may have
 * changed meanwhile is left to the backend's reaper.
 */
export function bounded<T>(call: Promise<T>, what: string, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const onAbort = () => finish(() => reject(signal!.reason))
    const timer = setTimeout(() => finish(() => reject(new CallTimeout(`${what} didn't answer within ${Math.round(ms / 1000)} s.`))), ms)
    function finish(settle: () => void) {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      settle()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    call.then((v) => finish(() => resolve(v)), (e: unknown) => finish(() => reject(e)))
  })
}

/** system.health, to see whether the backend is deployed. */
export function health(url: string): Promise<{ ok: true; mock: boolean; workers: unknown[] }> {
  return new ConvexHttpClient(url).query(api.system.health, {})
}
