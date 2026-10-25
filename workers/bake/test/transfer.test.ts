import { expect, test } from 'bun:test'
import { download, inParallel, transferTimeoutMs, type Fetch } from '../src/transfer'

test('a stalled download is abandoned and retried instead of hanging the job', async () => {
  let calls = 0
  const fetch: Fetch = (_url, init) => {
    calls++
    if (calls === 1) {
      // Never answers; only the per-try timeout can end it.
      return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }))
    }
    return Promise.resolve(new Response(new Uint8Array([1, 2, 3])))
  }
  const path = `/tmp/bd-transfer-test-${process.pid}.bin`
  await download('https://example.invalid/x', path, 3, { fetch, timeoutMs: 50, backoffMs: 1 })
  expect(calls).toBe(2)
  expect(new Uint8Array(await Bun.file(path).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  await Bun.file(path).delete()
})

test('the per-try timeout grows with the file size', () => {
  expect(transferTimeoutMs(0)).toBe(30_000)
  expect(transferTimeoutMs(100_000_000)).toBeGreaterThan(200_000)
})

test('inParallel: the first failure stops scheduling, aborts the running items and waits for them before throwing', async () => {
  const events: string[] = []
  const run = async (item: string, signal: AbortSignal) => {
    events.push(`start ${item}`)
    if (item === 'a') {
      await Bun.sleep(10)
      throw new Error('a broke')
    }
    // b runs until aborted, then takes a moment to clean up (a temp file, a socket).
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    await Bun.sleep(20)
    events.push(`settled ${item}`)
  }
  const error = await inParallel(['a', 'b', 'c', 'd'], 2, run).catch((e: Error) => e)
  events.push('threw')
  expect((error as Error).message).toBe('a broke')
  expect(events).toEqual(['start a', 'start b', 'settled b', 'threw'])
})

test('inParallel: a parent abort stops it the same way', async () => {
  const parent = new AbortController()
  const started: string[] = []
  const done = inParallel(['a', 'b', 'c'], 1, async (item, signal) => {
    started.push(item)
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
  }, parent.signal)
  parent.abort(new Error('shutting down'))
  expect(((await done.catch((e: Error) => e)) as Error).message).toBe('shutting down')
  expect(started).toEqual(['a'])
})
