// bun src/worker.ts [--concurrency N] [--check]
// The bake worker: pulls bake jobs from Convex until stopped (SIGINT/SIGTERM: stop claiming,
// let the running job finish for up to 90 s, then fail it as retryable; a second signal ends it now,
// and the process exits within 15 s even if something can't be interrupted).
import { hostname } from 'node:os'
import { parseArgs } from 'node:util'
import { convexWorkerApi, health } from './api'
import { bakeCapture } from './bake'
import { loadConfig } from './config'
import { runLoop } from './loop'
import { bakeVersion } from './version'

const { values } = parseArgs({ options: { concurrency: { type: 'string', default: '1' }, check: { type: 'boolean', default: false } } })
const concurrency = Number(values.concurrency)
if (!Number.isInteger(concurrency) || concurrency < 1) {
  console.error('--concurrency must be a whole number of at least 1.')
  process.exit(2)
}
const { convexUrl, token } = await loadConfig()
const workerId = `${hostname()}-${process.pid}`
const version = bakeVersion()

if (values.check) {
  // Is the backend deployed? Calls system.health only.
  try {
    const h = await health(convexUrl)
    console.log(`Backend is up: ${JSON.stringify({ ok: h.ok, mock: h.mock, workers: h.workers.length })}`)
  } catch (e) {
    console.error(`Backend not reachable or not deployed: ${(e as Error).message}`)
    process.exit(1)
  }
  process.exit(0)
}

const stop = new AbortController()
const kill = new AbortController()
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    if (!stop.signal.aborted) {
      console.log(`${sig}: no new jobs; finishing the current one`)
      stop.abort()
    } else {
      console.log(`${sig} again: ending the current job now`)
      kill.abort()
      // If something can't be interrupted, don't hang: the backend re-queues the job when its lease expires.
      setTimeout(() => {
        console.log('the job did not end in 15 s; exiting')
        process.exit(1)
      }, 15_000).unref()
    }
  })

console.log(`bake worker ${workerId} (${version}), ${concurrency} at a time, backend ${new URL(convexUrl).host}`)
await runLoop({ api: convexWorkerApi(convexUrl, token), bake: bakeCapture, workerId, bakeVersion: version, concurrency, stop: stop.signal, kill: kill.signal })
console.log('bake worker stopped')
