// The worker functions of the Convex backend (docs/architecture-v3.md §7), typed from the
// committed generated api. The job loop takes this interface, so tests pass a fake.
import { ConvexHttpClient } from 'convex/browser'
import { anyApi, type FunctionArgs, type FunctionReturnType } from 'convex/server'
import type { api as Api } from '../../../backend/convex/_generated/api'
import type { UploadTarget } from '../../../backend/convex/validators'

// The generated api.js is just `anyApi`; importing it at run time would need backend/'s packages.
const api = anyApi as unknown as typeof Api
type W = typeof Api.worker
type Name = 'claim' | 'heartbeat' | 'inputs' | 'outputUrls' | 'finishOutput' | 'complete' | 'fail'

// Return shapes, as the `returns` validators in backend/convex/worker.ts declare them. (While the
// handlers are stubs, the generated types say `never`; the check below catches drift once they're real.)
export interface Claim {
  jobId: FunctionArgs<W['heartbeat']>['jobId']
  kind: 'facts' | 'bake' | 'convert' | 'splat'
  captureId: string
  attempt: number
}
export interface Inputs {
  manifestJson: string | null
  files: { name: string; area: 'raw' | 'derived' | 'video'; url: string; bytes: number }[]
}
interface Returns {
  claim: Claim | null
  heartbeat: { ok: boolean; cancelled: boolean }
  inputs: Inputs
  outputUrls: { name: string; target: UploadTarget }[]
  finishOutput: { ok: true; bytes: number }
  complete: { ok: true }
  fail: { ok: true }
}
type Assignable<A extends B, B> = A
export type GeneratedReturnsFit = { [K in Name]: Assignable<FunctionReturnType<W[K]>, Returns[K]> }

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

/** system.health, to see whether the backend is deployed. */
export function health(url: string): Promise<{ ok: true; mock: boolean; workers: unknown[] }> {
  return new ConvexHttpClient(url).query(api.system.health, {})
}
