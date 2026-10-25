// The upload flow through the Convex functions against a real S3-compatible server that checks
// signatures. Skipped unless R2_TEST_* is set (see lib/r2.test.ts for how to run one).
import { afterEach, describe, expect, test, vi } from 'vitest'
import { listKeys, r2Config } from './lib/r2'
import { api, realS3, setup, tinyCapture, uploadCapture } from './test.helpers'

const s3 = realS3()

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe.skipIf(!s3)('uploads against a real S3 server', () => {
  test('multipart: start, upload one part, resume lists it, upload the rest, finish, read back through captures.get', async () => {
    const t = setup(s3)
    const capture = tinyCapture({ id: crypto.randomUUID() })
    const id = String(capture.manifest.id)
    await t.mutation(api.captures.begin, { manifestJson: capture.manifestJson })
    const bytes = 17 * 1024 * 1024 + 123
    const data = new Uint8Array(bytes).map((_, i) => i % 251)
    const target = await t.action(api.uploads.start, { captureId: id, name: 'video.mov', bytes, contentType: 'video/quicktime' })
    expect(target.parts?.length).toBe(2)
    const part = (n: number) => data.subarray((n - 1) * target.partSize!, Math.min(bytes, n * target.partSize!))
    const first = await fetch(target.parts![0].url, { method: 'PUT', body: part(1) })
    expect(first.status).toBe(200)

    const resumed = await t.action(api.uploads.resume, { uploadId: target.uploadId })
    expect(resumed.done.map((p) => p.partNumber)).toEqual([1])
    expect(resumed.target.parts?.map((p) => p.partNumber)).toEqual([2])
    const second = await fetch(resumed.target.parts![0].url, { method: 'PUT', body: part(2) })
    const parts = [...resumed.done, { partNumber: 2, etag: second.headers.get('etag') ?? '' }]
    expect(await t.action(api.uploads.finish, { uploadId: target.uploadId, parts })).toEqual({ ok: true, bytes })

    const detail = await t.query(api.captures.get, { captureId: id })
    const video = detail?.files.find((f) => f.name === 'video.mov')
    const res = await fetch(video!.url)
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    const back = new Uint8Array(await res.arrayBuffer())
    expect(back.length).toBe(bytes)
    expect(back.every((b, i) => b === data[i])).toBe(true)
    const range = await fetch(video!.url, { headers: { Range: 'bytes=0-9' } })
    expect(range.status).toBe(206)

    await t.mutation(api.captures.remove, { captureId: id })
  }, 60_000)

  test('a whole small capture uploads, reads manifest.json back, completes and is removed from the bucket', async () => {
    const t = setup(s3)
    const capture = tinyCapture({ id: crypto.randomUUID(), keyframes: 0, transcript: false })
    const id = await uploadCapture(t, capture)
    expect(await t.action(api.captures.complete, { captureId: id })).toEqual({ ok: true })
    const detail = await t.query(api.captures.get, { captureId: id })
    expect(detail?.manifestJson).toBe(capture.manifestJson)
    expect(detail?.status).toMatchObject({ upload: 'done', bake: 'queued' })
    await t.mutation(api.captures.remove, { captureId: id })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    vi.useRealTimers()
    expect(await listKeys(r2Config(), `captures/${id}/`)).toEqual([])
  }, 60_000)
})
