// Uploads, stage triggers, fact extraction and review, end to end through the Convex functions
// (convex-test, fake R2, stub Claude).
import { ConvexError } from 'convex/values'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { goodReply } from './lib/facts.fixture'
import { CAPTURE_ID, api, bucket, claude, internal, runScheduled, setup, statusOf, tinyCapture, upload, uploadCapture } from './test.helpers'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const jobsOf = (t: ReturnType<typeof setup>, kind?: string) =>
  t.run(async (ctx) => (await ctx.db.query('jobs').collect()).filter((j) => !kind || j.kind === kind))

describe('uploads and stage triggers', () => {
  test('a single PUT lands under raw/ with immutable caching, and registers the file', async () => {
    const t = setup()
    const capture = tinyCapture()
    await t.mutation(api.captures.begin, { manifestJson: capture.manifestJson })
    const target = await t.action(api.uploads.start, { captureId: CAPTURE_ID, name: 'thumb.jpg', bytes: 4, contentType: 'image/jpeg' })
    expect(target.key).toBe(`captures/${CAPTURE_ID}/raw/thumb.jpg`)
    expect(target.single?.headers).toEqual({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Length': '4' })
    await fetch(target.single!.url, { method: 'PUT', headers: target.single!.headers, body: capture.files['thumb.jpg'] })
    expect(await t.action(api.uploads.finish, { uploadId: target.uploadId })).toEqual({ ok: true, bytes: 4 })
    const detail = await t.query(api.captures.get, { captureId: CAPTURE_ID })
    expect(detail?.files.map((f) => [f.name, f.bytes, f.rev])).toEqual([['thumb.jpg', 4, 1]])
    expect(detail?.files[0].url).toMatch(/X-Amz-Expires=604800/)
    expect(detail?.files[0].url).toMatch(/x-id=1/)

    // A re-upload bumps rev, so the URL changes.
    await upload(t, CAPTURE_ID, 'thumb.jpg', capture.files['thumb.jpg'])
    const again = await t.query(api.captures.get, { captureId: CAPTURE_ID })
    expect(again?.files[0].rev).toBe(2)
    expect(again?.files[0].url).not.toBe(detail?.files[0].url)
  })

  test('a short or missing upload is refused at finish', async () => {
    const t = setup()
    await t.mutation(api.captures.begin, { manifestJson: tinyCapture().manifestJson })
    const target = await t.action(api.uploads.start, { captureId: CAPTURE_ID, name: 'room.bin', bytes: 34, contentType: 'application/octet-stream' })
    await expect(t.action(api.uploads.finish, { uploadId: target.uploadId })).rejects.toThrow(/didn't arrive/)
    await fetch(target.single!.url, { method: 'PUT', body: new Uint8Array(10) })
    await expect(t.action(api.uploads.finish, { uploadId: target.uploadId })).rejects.toThrow(/arrived with 10 bytes, but 34/)
    await expect(t.action(api.uploads.start, { captureId: CAPTURE_ID, name: '../x', bytes: 1, contentType: 'x' })).rejects.toThrow(/allowed file name/)
  })

  test('a retried or concurrent finish returns the recorded success and registers the file once', async () => {
    const t = setup()
    const capture = tinyCapture()
    await t.mutation(api.captures.begin, { manifestJson: capture.manifestJson })
    const target = await t.action(api.uploads.start, { captureId: CAPTURE_ID, name: 'thumb.jpg', bytes: 4, contentType: 'image/jpeg' })
    await fetch(target.single!.url, { method: 'PUT', headers: target.single!.headers, body: capture.files['thumb.jpg'] })
    const results = await Promise.all([t.action(api.uploads.finish, { uploadId: target.uploadId }), t.action(api.uploads.finish, { uploadId: target.uploadId })])
    expect(results).toEqual([{ ok: true, bytes: 4 }, { ok: true, bytes: 4 }])
    // The answer was lost; the phone asks again.
    expect(await t.action(api.uploads.finish, { uploadId: target.uploadId })).toEqual({ ok: true, bytes: 4 })
    const detail = await t.query(api.captures.get, { captureId: CAPTURE_ID })
    expect(detail?.files.map((f) => [f.name, f.rev])).toEqual([['thumb.jpg', 1]])
  })

  test('a big file gets a multipart upload with 16 MiB parts', async () => {
    const t = setup()
    await t.mutation(api.captures.begin, { manifestJson: tinyCapture().manifestJson })
    // The fake bucket can't do multipart; check the target only (multipart is tested against a real S3 server in lib/r2.test.ts).
    vi.stubGlobal('fetch', async () => new Response('<InitiateMultipartUploadResult><UploadId>up-1</UploadId></InitiateMultipartUploadResult>'))
    const target = await t.action(api.uploads.start, { captureId: CAPTURE_ID, name: 'video.mov', bytes: 40 * 1024 ** 2, contentType: 'video/quicktime' })
    expect(target.partSize).toBe(16 * 1024 ** 2)
    expect(target.parts?.map((p) => p.partNumber)).toEqual([1, 2, 3])
    expect(target.parts?.[0].url).toMatch(/uploadId=up-1/)
  })

  test("facts start as soon as manifest, keyframes and transcript are in, without waiting for video or depth", async () => {
    const t = setup()
    const capture = tinyCapture()
    await t.mutation(api.captures.begin, { manifestJson: capture.manifestJson })
    await upload(t, CAPTURE_ID, 'manifest.json', capture.files['manifest.json'])
    await upload(t, CAPTURE_ID, 'keyframes/k0000.jpg', capture.files['keyframes/k0000.jpg'])
    await upload(t, CAPTURE_ID, 'keyframes/k0001.jpg', capture.files['keyframes/k0001.jpg'])
    expect((await statusOf(t))?.facts).toBe('not_started')
    expect(await jobsOf(t, 'facts')).toEqual([])

    await upload(t, CAPTURE_ID, 'transcript.json', capture.files['transcript.json'])
    const status = await statusOf(t)
    expect(status?.facts).toBe('running') // leased to Convex itself, action scheduled
    expect(status?.upload).toBe('receiving')

    claude.next = () => goodReply
    await runScheduled(t)
    const { moment, status: after } = await t.query(api.moments.get, { captureId: CAPTURE_ID })
    expect(after?.facts).toBe('done')
    expect(moment?.facts.map((f) => [f.id, f.text, f.status])).toEqual([['f1', 'Priya brought a mango cake.', 'pending']])
    expect(moment?.dropped.map((d) => d.text)).toEqual(['Grandpa played the piano.'])
    expect(moment?.model).toBe('stub-model')
    const call = claude.calls[0]
    expect(call.model).toBe('opus')
    expect(call.content.filter((b) => b.type === 'image').length).toBe(2)
  })

  test('complete: invalid saves the reasons and throws; valid queues bake', async () => {
    const t = setup()
    const capture = tinyCapture()
    await uploadCapture(t, capture, { skip: ['depth.bin'] })
    const error = await t.action(api.captures.complete, { captureId: CAPTURE_ID }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConvexError)
    expect((error as ConvexError<{ code: string; errors: string[] }>).data.code).toBe('invalid')
    expect((error as ConvexError<{ code: string; errors: string[] }>).data.errors).toEqual(['depth.bin is missing (2 depth frames of 4x3 UInt16).'])
    const invalid = await statusOf(t)
    expect(invalid?.upload).toBe('invalid')
    expect(invalid?.uploadErrors[0]).toMatch(/depth\.bin is missing/)

    await upload(t, CAPTURE_ID, 'depth.bin', capture.files['depth.bin'])
    expect((await statusOf(t))?.upload).toBe('receiving') // a re-upload re-opens the upload
    expect(await t.action(api.captures.complete, { captureId: CAPTURE_ID })).toEqual({ ok: true })
    const done = await statusOf(t)
    expect(done).toMatchObject({ upload: 'done', uploadErrors: [], bake: 'queued' })
    expect((await jobsOf(t, 'bake')).map((j) => [j.status, j.needs])).toEqual([['queued', { gpu: false }]])
  })

  test('an old capture without keyframes extracts from the thumbnail at complete', async () => {
    const t = setup()
    await uploadCapture(t, tinyCapture({ keyframes: 0, transcript: false }))
    expect((await statusOf(t))?.facts).toBe('not_started')
    await t.action(api.captures.complete, { captureId: CAPTURE_ID })
    claude.next = () => ({ moment: {}, facts: [], chapters: [] })
    await runScheduled(t)
    const intro = claude.calls[0].content[0]
    expect(intro.type === 'text' && intro.text).toMatch(/Transcript: none/)
    expect(claude.calls[0].content.some((b) => b.type === 'text' && b.text === 'thumb.jpg (t = 2 s)')).toBe(true)
    expect((await statusOf(t))?.facts).toBe('done')
  })

  test('a rate limit is retried after a pause instead of failing at once', async () => {
    const t = setup()
    const { ClaudeError } = await import('./lib/claude')
    let calls = 0
    claude.next = () => {
      calls += 1
      if (calls === 1) throw new ClaudeError('Claude is rate-limited right now. Try again in a minute.', true)
      return goodReply
    }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await uploadCapture(t, tinyCapture())
    vi.runOnlyPendingTimers() // start the first run only
    await t.finishInProgressScheduledFunctions()
    expect(calls).toBe(1)
    expect((await statusOf(t))?.facts).toBe('queued') // waiting out the back-off, not "running"
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    vi.useRealTimers()
    expect((await statusOf(t))?.facts).toBe('done')
    expect(calls).toBe(2)
  })

  test('a Claude failure shows up in the status, in words', async () => {
    const t = setup()
    claude.next = () => {
      throw new Error('Claude is rate-limited right now. Try again in a minute.')
    }
    await uploadCapture(t, tinyCapture())
    await runScheduled(t)
    const status = await statusOf(t)
    expect(status?.facts).toBe('failed')
    expect(status?.errors.facts).toMatch(/rate-limited/)
  })
})

describe('review', () => {
  async function extracted() {
    const t = setup()
    claude.next = () => goodReply
    await uploadCapture(t, tinyCapture())
    await runScheduled(t)
    return t
  }

  test('the family can approve, reword and mark a fact', async () => {
    const t = await extracted()
    const fact = await t.mutation(api.moments.patchFact, { captureId: CAPTURE_ID, factId: 'f1', status: 'approved', editedText: '  Priya brought Mom a mango cake. ', doNotRaise: false })
    expect(fact).toMatchObject({ status: 'approved', editedText: 'Priya brought Mom a mango cake.' })
    expect((await t.mutation(api.moments.patchFact, { captureId: CAPTURE_ID, factId: 'f1', editedText: '   ' })).editedText).toBeNull()
    await expect(t.mutation(api.moments.patchFact, { captureId: CAPTURE_ID, factId: 'f9', status: 'approved' })).rejects.toThrow(/No fact f9/)
  })

  test('review made while Claude re-extracts survives (the old read-modify-write race)', async () => {
    const t = await extracted()
    await t.mutation(api.moments.patchFact, { captureId: CAPTURE_ID, factId: 'f1', status: 'approved' })
    // Second extraction adds a pending fact f2 we can review during the third.
    claude.next = () => ({ ...goodReply, facts: [{ ...goodReply.facts[0], text: 'There was a cake on the table.' }] })
    await t.mutation(api.moments.reextract, { captureId: CAPTURE_ID })
    await runScheduled(t)
    expect((await t.query(api.moments.get, { captureId: CAPTURE_ID })).moment?.facts.map((f) => [f.id, f.status])).toEqual([['f1', 'approved'], ['f2', 'pending']])

    // While Claude works on the third extraction, the family edits f1 and marks f2.
    claude.next = () => ({ ...goodReply, facts: [{ ...goodReply.facts[0], text: 'Mom smiled at the cake.' }] })
    claude.during = async () => {
      await t.mutation(api.moments.patchFact, { captureId: CAPTURE_ID, factId: 'f1', editedText: 'Priya brought Mom her favorite cake.' })
      await t.mutation(api.moments.patchFact, { captureId: CAPTURE_ID, factId: 'f2', doNotRaise: true })
    }
    await t.mutation(api.moments.reextract, { captureId: CAPTURE_ID })
    await expect(t.mutation(api.moments.reextract, { captureId: CAPTURE_ID })).rejects.toThrow(/already being extracted/)
    await runScheduled(t)
    const { moment } = await t.query(api.moments.get, { captureId: CAPTURE_ID })
    expect(moment?.facts.map((f) => [f.id, f.status, f.editedText, f.doNotRaise])).toEqual([
      ['f1', 'approved', 'Priya brought Mom her favorite cake.', false],
      ['f2', 'pending', null, true],
      ['f3', 'pending', null, false],
    ])
    const prompt = claude.calls.at(-1)?.content[0]
    expect(prompt?.type === 'text' && prompt.text).toMatch(/already reviewed these facts[\s\S]*- Priya brought a mango cake\./)
  })
})

describe('capture removal', () => {
  test('rows go now, R2 objects in a scheduled action, and the arrangement forgets it', async () => {
    const t = setup()
    await uploadCapture(t, tinyCapture())
    await t.mutation(api.museum.setArrangement, { title: 'M', subtitle: '', items: [{ capture: CAPTURE_ID, piece: 'video', title: '', caption: '' }] })
    expect(bucket.size).toBeGreaterThan(5)
    await t.mutation(api.captures.remove, { captureId: CAPTURE_ID })
    expect(await t.query(api.captures.get, { captureId: CAPTURE_ID })).toBeNull()
    expect((await t.query(api.museum.getArrangement, {}))?.items).toEqual([])
    await runScheduled(t)
    expect(bucket.size).toBe(0)
    expect(await t.run(async (ctx) => (await ctx.db.query('files').collect()).length)).toBe(0)
  })
})

describe('capture removal (tombstone)', () => {
  test('the id is refused until the purge has run, so it can never erase a recreated capture', async () => {
    const t = setup()
    const capture = tinyCapture()
    await uploadCapture(t, capture)
    await t.mutation(api.captures.remove, { captureId: CAPTURE_ID })
    await expect(t.mutation(api.captures.begin, { manifestJson: capture.manifestJson })).rejects.toThrow(/still being removed/)
    expect(await t.query(api.captures.list, {})).toEqual([])
    await runScheduled(t)
    // Purged and the tombstone dropped: the same capture uploads again and keeps its files.
    await uploadCapture(t, capture)
    await runScheduled(t)
    expect((await t.query(api.captures.get, { captureId: CAPTURE_ID }))?.files.length).toBe(Object.keys(capture.files).length)
    expect([...bucket.keys()].filter((k) => k.startsWith(`captures/${CAPTURE_ID}/raw/`)).length).toBe(Object.keys(capture.files).length)
  })

  test('a failed purge keeps the tombstone and tries again', async () => {
    const t = setup()
    const capture = tinyCapture()
    await uploadCapture(t, capture)
    await t.mutation(api.captures.remove, { captureId: CAPTURE_ID })
    const realFetch = globalThis.fetch
    let failures = 1
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => (failures-- > 0 ? Promise.reject(new TypeError('network down')) : realFetch(input, init)))
    await runScheduled(t)
    expect(bucket.size).toBe(0)
    expect(await t.run(async (ctx) => ctx.db.query('captures').collect())).toEqual([])
  })
})

test('without R2 settings, URL functions say so instead of returning fake URLs', async () => {
  const t = setup()
  await uploadCapture(t, tinyCapture({ keyframes: 0, transcript: false }))
  vi.stubEnv('R2_ENDPOINT', '')
  vi.stubEnv('R2_BUCKET', '')
  await expect(t.query(api.captures.get, { captureId: CAPTURE_ID })).rejects.toThrow(/R2 isn't configured/)
  await expect(t.action(api.uploads.start, { captureId: CAPTURE_ID, name: 'x.bin', bytes: 1, contentType: 'x' })).rejects.toThrow(/R2_BUCKET/)
  void internal
})
