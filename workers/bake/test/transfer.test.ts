import { expect, test } from 'bun:test'
import { download, transferTimeoutMs, type Fetch } from '../src/transfer'

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
})

test('the per-try timeout grows with the file size', () => {
  expect(transferTimeoutMs(0)).toBe(30_000)
  expect(transferTimeoutMs(100_000_000)).toBeGreaterThan(200_000)
})
