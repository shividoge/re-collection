// The backend's worker functions as JSON: each one's kind (mutation/action) and its real `args`
// and `returns` validators (Convex's own exportArgs/exportReturns), plus WORKER_PROTOCOL.
// tests/test_contract.py checks every call the GPU worker makes against this, so a mismatch
// can't hide behind the fake backend. Regenerate after changing backend/convex/worker.ts:
//   (cd backend && bun install) && bun workers/gpu/tests/worker_contract.ts > workers/gpu/tests/worker_contract.json
// An optional argument points at another checkout's backend/convex/worker.ts.
import { resolve } from 'node:path'

const file = resolve(process.argv[2] ?? `${import.meta.dir}/../../../backend/convex/worker.ts`)
const worker = await import(file)
const names = ['claim', 'heartbeat', 'inputs', 'outputUrls', 'finishOutput', 'complete', 'fail']
const functions: Record<string, unknown> = {}
for (const name of names) {
  const fn = worker[name]
  if (!fn?.exportArgs) throw new Error(`backend/convex/worker.ts has no registered function "${name}".`)
  functions[name] = {
    kind: fn.isMutation ? 'mutation' : fn.isAction ? 'action' : 'query',
    args: JSON.parse(fn.exportArgs()),
    returns: JSON.parse(fn.exportReturns()),
  }
}
console.log(JSON.stringify({ protocol: worker.WORKER_PROTOCOL ?? null, functions }, null, 2))
