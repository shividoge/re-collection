// The job protocol: tokens, leases, heartbeats, expiry, retries, routing, worker outputs, and
// the video flow (convert → package → bake/facts/splat).
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Id } from './_generated/dataModel'
import { STOPPED_RESPONDING } from './lib/jobs'
import { CAPTURE_ID, TOKEN, api, bucket, internal, runScheduled, setup, statusOf, tinyCapture, uploadCapture, type Bytes, type T } from './test.helpers'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const cpu = { token: TOKEN, workerId: 'fedora-bake', kinds: ['bake' as const], gpu: false }
const fedoraGpu = { token: TOKEN, workerId: 'fedora-gpu', kinds: ['convert' as const, 'splat' as const], gpu: true, maxFrames: 67 }
const gx10 = { token: TOKEN, workerId: 'gx10', kinds: ['convert' as const, 'splat' as const, 'bake' as const], gpu: true, maxFrames: 240 }

async function completedCapture(): Promise<T> {
  const t = setup()
  await uploadCapture(t, tinyCapture())
  await t.action(api.captures.complete, { captureId: CAPTURE_ID })
  return t
}

const jobRow = (t: T, jobId: Id<'jobs'>) => t.run(async (ctx) => ctx.db.get(jobId))

/** What every worker call after claim carries: the token, the job and the attempt. */
type Claimed = { jobId: Id<'jobs'>; attempt: number }
const as = (c: Claimed | null) => ({ token: TOKEN, jobId: c!.jobId, attempt: c!.attempt })

/** PUTs every target a worker got and finishes it. */
async function writeOutputs(t: T, c: Claimed, files: { name: string; area: 'raw' | 'derived'; bytes: Bytes; contentType: string; contentEncoding?: string }[]) {
  const targets = await t.action(api.worker.outputUrls, { ...as(c), files: files.map(({ bytes, ...f }) => ({ ...f, bytes: bytes.length })) })
  for (const [i, { target }] of targets.entries()) {
    await fetch(target.single!.url, { method: 'PUT', headers: target.single!.headers, body: files[i].bytes })
    await t.action(api.worker.finishOutput, { ...as(c), uploadId: target.uploadId })
  }
  return targets
}

describe('worker protocol', () => {
  test('a wrong or missing token is rejected everywhere', async () => {
    const t = await completedCapture()
    await expect(t.mutation(api.worker.claim, { ...cpu, token: 'nope' })).rejects.toThrow(/Wrong worker token/)
    const job = await t.mutation(api.worker.claim, cpu)
    await expect(t.mutation(api.worker.heartbeat, { ...as(job), token: 'nope' })).rejects.toThrow(/Wrong worker token/)
    await expect(t.action(api.worker.inputs, { ...as(job), token: '' })).rejects.toThrow(/Wrong worker token/)
    await expect(t.mutation(api.worker.fail, { ...as(job), token: 'x', error: 'e', retryable: false })).rejects.toThrow(/token/)
    vi.stubEnv('WORKER_TOKEN', '')
    await expect(t.mutation(api.worker.claim, cpu)).rejects.toThrow(/WORKER_TOKEN isn't set/)
  })

  test('claim → inputs → heartbeat progress → outputs → complete bake', async () => {
    const t = await completedCapture()
    expect(await t.mutation(api.worker.claim, fedoraGpu)).toBeNull() // a GPU worker without bake takes nothing
    const claimed = await t.mutation(api.worker.claim, cpu)
    expect(claimed).toMatchObject({ kind: 'bake', captureId: CAPTURE_ID, attempt: 1 })
    expect(await t.mutation(api.worker.claim, cpu)).toBeNull() // leased, not handed out twice
    expect((await statusOf(t))?.bake).toBe('running')
    const jobId = claimed!.jobId

    const inputs = await t.action(api.worker.inputs, as(claimed))
    expect(inputs.files.map((f) => f.name)).toContain('depth.bin')
    expect(inputs.files.every((f) => f.area === 'raw' && f.url.startsWith('https://r2.test/'))).toBe(true)

    const progress = { stage: 'surface', fraction: 0.5, message: 'Building the room surface' }
    expect(await t.mutation(api.worker.heartbeat, { ...as(claimed), progress })).toEqual({ ok: true, cancelled: false })
    expect((await statusOf(t))?.progress).toEqual(progress)
    expect((await t.query(api.system.health, {})).workers.map((w) => w.workerId)).toEqual(['fedora-bake', 'fedora-gpu'])

    const derivedMeta = {
      format: 'braindance.derived' as const, version: 1, captureId: CAPTURE_ID, bakedAt: '2026-10-24T23:00:00Z', bakeVersion: 'test',
      files: { points: 'points.pack' }, stats: { points: 2, bakeMs: 5 },
    }
    await expect(t.mutation(api.worker.complete, { ...as(claimed), result: { kind: 'bake', derived: derivedMeta } })).rejects.toThrow(/points\.pack wasn't uploaded by this attempt/)
    const targets = await writeOutputs(t, claimed!, [{ name: 'points.pack', area: 'derived', bytes: new Uint8Array(64), contentType: 'application/octet-stream', contentEncoding: 'gzip' }])
    expect(targets[0].target.key).toBe(`captures/${CAPTURE_ID}/derived/${jobId}.1/points.pack`)
    expect(targets[0].target.single?.headers['Content-Encoding']).toBe('gzip')
    expect((await t.query(api.captures.get, { captureId: CAPTURE_ID }))?.derivedFiles).toEqual([]) // staged, not published yet
    await t.mutation(api.worker.complete, { ...as(claimed), result: { kind: 'bake', derived: derivedMeta } })
    // A retried complete (its answer was lost) gets the same answer.
    expect(await t.mutation(api.worker.complete, { ...as(claimed), result: { kind: 'bake', derived: derivedMeta } })).toEqual({ ok: true })

    const detail = await t.query(api.captures.get, { captureId: CAPTURE_ID })
    expect(detail?.status).toMatchObject({ bake: 'done', progress: null, upload: 'done' }) // worker outputs don't re-open the upload
    expect(detail?.derived?.files.points).toBe('points.pack')
    expect(detail?.derivedFiles.map((f) => f.name)).toEqual(['points.pack'])
    expect(await t.mutation(api.worker.heartbeat, as(claimed))).toEqual({ ok: false, cancelled: true })
  })

  test('an expired lease is re-queued by the cron; three strikes fail the job', async () => {
    const t = await completedCapture()
    vi.useFakeTimers({ toFake: ['Date'] })
    let now = Date.now()
    for (let attempt = 1; attempt <= 3; attempt++) {
      const job = await t.mutation(api.worker.claim, cpu)
      expect(job?.attempt).toBe(attempt)
      now += 60_000
      vi.setSystemTime(now)
      expect(await t.mutation(internal.jobsCron.reap, {})).toBe(0) // still inside the 120 s lease
      now += 61_000
      vi.setSystemTime(now)
      expect(await t.mutation(internal.jobsCron.reap, {})).toBe(1)
    }
    const status = await statusOf(t)
    expect(status?.bake).toBe('failed')
    expect(status?.errors.bake).toBe(STOPPED_RESPONDING)
    expect(await t.mutation(api.worker.claim, cpu)).toBeNull()
  })

  test('heartbeats keep a long job alive', async () => {
    const t = await completedCapture()
    vi.useFakeTimers({ toFake: ['Date'] })
    let now = Date.now()
    const job = await t.mutation(api.worker.claim, cpu)
    for (let i = 0; i < 5; i++) {
      now += 100_000
      vi.setSystemTime(now)
      await t.mutation(api.worker.heartbeat, as(job))
      expect(await t.mutation(internal.jobsCron.reap, {})).toBe(0)
    }
    expect((await jobRow(t, job!.jobId))?.status).toBe('leased')
  })

  test('fail: retryable re-queues until the third attempt; not retryable fails at once', async () => {
    const t = await completedCapture()
    for (let attempt = 1; attempt <= 3; attempt++) {
      const job = await t.mutation(api.worker.claim, cpu)
      await t.mutation(api.worker.fail, { ...as(job), error: `disk full (${attempt})`, retryable: true })
    }
    const status = await statusOf(t)
    expect(status?.bake).toBe('failed')
    expect(status?.errors.bake).toBe('disk full (3)')

    // A new upload completion queues a fresh bake; a non-retryable failure ends it at once.
    await t.action(api.captures.complete, { captureId: CAPTURE_ID })
    expect((await statusOf(t))?.bake).toBe('queued')
    expect((await statusOf(t))?.errors.bake).toBeUndefined()
    const job = await t.mutation(api.worker.claim, cpu)
    await t.mutation(api.worker.fail, { ...as(job), error: 'frames.jsonl has 2 moment lines, expected 3.', retryable: false })
    expect(await statusOf(t)).toMatchObject({ bake: 'failed', errors: { bake: 'frames.jsonl has 2 moment lines, expected 3.' } })
  })

  test('a worker whose lease was taken over can no longer heartbeat, fail or complete the job', async () => {
    const t = await completedCapture()
    vi.useFakeTimers({ toFake: ['Date'] })
    const stale = await t.mutation(api.worker.claim, cpu)
    vi.setSystemTime(Date.now() + 121_000)
    await t.mutation(internal.jobsCron.reap, {})
    const fresh = await t.mutation(api.worker.claim, gx10)
    expect(fresh).toMatchObject({ jobId: stale!.jobId, attempt: 2 })
    expect(await t.mutation(api.worker.heartbeat, as(stale))).toEqual({ ok: false, cancelled: true })
    await expect(t.mutation(api.worker.fail, { ...as(stale), error: 'stale', retryable: false })).rejects.toThrow(/doesn't hold the lease/)
    expect((await jobRow(t, stale!.jobId))?.status).toBe('leased')
    const derivedMeta = { format: 'braindance.derived' as const, version: 1, captureId: CAPTURE_ID, bakedAt: 'x', bakeVersion: 'x', files: { points: 'p.pack' }, stats: { points: 1, bakeMs: 1 } }
    await expect(t.mutation(api.worker.complete, { ...as(stale), result: { kind: 'bake', derived: derivedMeta } })).rejects.toThrow(/doesn't hold the lease/)
    await expect(t.action(api.worker.inputs, as(stale))).rejects.toThrow(/doesn't hold the lease/)
    await expect(t.action(api.worker.outputUrls, { ...as(stale), files: [] })).rejects.toThrow(/doesn't hold the lease/)
    expect((await t.query(api.captures.get, { captureId: CAPTURE_ID }))?.derived).toBeNull()
    expect(await t.mutation(api.worker.heartbeat, as(fresh))).toEqual({ ok: true, cancelled: false })
  })

  test('every call after claim needs the attempt', async () => {
    const t = await completedCapture()
    const job = await t.mutation(api.worker.claim, cpu)
    const noAttempt = { token: TOKEN, jobId: job!.jobId }
    // The validators refuse a call without `attempt` (the old protocol skipped the ownership check).
    await expect(t.mutation(api.worker.heartbeat, noAttempt as never)).rejects.toThrow(/attempt/)
    await expect(t.mutation(api.worker.fail, { ...noAttempt, error: 'e', retryable: true } as never)).rejects.toThrow(/attempt/)
    await expect(t.action(api.worker.inputs, noAttempt as never)).rejects.toThrow(/attempt/)
    expect((await jobRow(t, job!.jobId))?.status).toBe('leased')
  })

  test("a stale attempt's late upload can't touch the winner's files, and its outputs are deleted", async () => {
    const t = await completedCapture()
    vi.useFakeTimers({ toFake: ['Date'] })
    const stale = await t.mutation(api.worker.claim, cpu)
    const file = (bytes: Bytes) => [{ name: 'points.pack', area: 'derived' as const, bytes, contentType: 'application/octet-stream' }]
    const [staleOut] = await t.action(api.worker.outputUrls, { ...as(stale), files: [{ name: 'points.pack', area: 'derived', bytes: 64, contentType: 'application/octet-stream' }] })
    vi.setSystemTime(Date.now() + 121_000)
    await t.mutation(internal.jobsCron.reap, {})
    const fresh = await t.mutation(api.worker.claim, gx10)
    const winner = new Uint8Array(64).fill(7)
    const [freshOut] = await writeOutputs(t, fresh!, file(winner))
    expect(freshOut.target.key).not.toBe(staleOut.target.key)
    const derivedMeta = { format: 'braindance.derived' as const, version: 1, captureId: CAPTURE_ID, bakedAt: 'x', bakeVersion: 'x', files: { points: 'points.pack' }, stats: { points: 1, bakeMs: 1 } }
    await t.mutation(api.worker.complete, { ...as(fresh), result: { kind: 'bake', derived: derivedMeta } })

    // The stale worker's PUT lands late, then it tries to finish and complete.
    await fetch(staleOut.target.single!.url, { method: 'PUT', headers: staleOut.target.single!.headers, body: new Uint8Array(64).fill(1) })
    // (The reap already dropped its upload, so there's nothing left to finish.)
    await expect(t.action(api.worker.finishOutput, { ...as(stale), uploadId: staleOut.target.uploadId })).rejects.toThrow(/No upload/)
    await expect(t.mutation(api.worker.complete, { ...as(stale), result: { kind: 'bake', derived: derivedMeta } })).rejects.toThrow(/doesn't hold the lease/)

    const detail = await t.query(api.captures.get, { captureId: CAPTURE_ID })
    const published = await t.run(async (ctx) => ctx.db.query('files').filter((q) => q.eq(q.field('name'), 'points.pack')).unique())
    expect(published?.key).toBe(freshOut.target.key)
    expect(detail?.derivedFiles.map((f) => f.name)).toEqual(['points.pack'])
    expect(bucket.get(freshOut.target.key)?.bytes).toEqual(winner)

    // The losing attempt's object is deleted, also after a late PUT (a second pass once its URLs expired).
    vi.useRealTimers()
    await runScheduled(t)
    expect(bucket.has(staleOut.target.key)).toBe(false)
    expect(bucket.get(freshOut.target.key)?.bytes).toEqual(winner)
    const left = await t.run(async (ctx) => ctx.db.query('uploads').collect())
    expect(left.filter((u) => u.jobId === stale!.jobId && u.attempt === 1)).toEqual([])
  })

  test('a re-bake replaces the derived files and deletes the old objects later', async () => {
    const t = await completedCapture()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) // so the delayed delete can be run
    const derivedMeta = { format: 'braindance.derived' as const, version: 1, captureId: CAPTURE_ID, bakedAt: 'x', bakeVersion: 'x', files: { points: 'points.pack' }, stats: { points: 1, bakeMs: 1 } }
    const keys: string[] = []
    for (let i = 0; i < 2; i++) {
      if (i) await t.action(api.captures.complete, { captureId: CAPTURE_ID })
      const job = await t.mutation(api.worker.claim, cpu)
      const [out] = await writeOutputs(t, job!, [{ name: 'points.pack', area: 'derived', bytes: new Uint8Array(8).fill(i), contentType: 'application/octet-stream' }])
      await t.mutation(api.worker.complete, { ...as(job), result: { kind: 'bake', derived: derivedMeta } })
      keys.push(out.target.key)
    }
    const [file] = (await t.query(api.captures.get, { captureId: CAPTURE_ID }))!.derivedFiles
    expect(file.rev).toBe(2)
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    expect(bucket.has(keys[0])).toBe(false)
    expect(bucket.has(keys[1])).toBe(true)
  })

  test('a new upload completion supersedes a running bake', async () => {
    const t = await completedCapture()
    const old = await t.mutation(api.worker.claim, cpu)
    await t.action(api.captures.complete, { captureId: CAPTURE_ID })
    expect(await t.mutation(api.worker.heartbeat, as(old))).toEqual({ ok: false, cancelled: true })
    const derivedMeta = { format: 'braindance.derived' as const, version: 1, captureId: CAPTURE_ID, bakedAt: 'x', bakeVersion: 'x', files: { points: 'p.pack' }, stats: { points: 1, bakeMs: 1 } }
    await expect(t.mutation(api.worker.complete, { ...as(old), result: { kind: 'bake', derived: derivedMeta } })).rejects.toThrow(/doesn't hold the lease/)
    expect(await statusOf(t)).toMatchObject({ bake: 'queued' })
    const next = await t.mutation(api.worker.claim, cpu)
    expect(next?.jobId).not.toBe(old!.jobId)
  })

  test('a deleted capture cancels its running job', async () => {
    const t = await completedCapture()
    const job = await t.mutation(api.worker.claim, cpu)
    await t.mutation(api.captures.remove, { captureId: CAPTURE_ID })
    expect(await t.mutation(api.worker.heartbeat, as(job))).toEqual({ ok: false, cancelled: true })
  })
})

describe('old video → capture', () => {
  test('create, upload the source, convert (routed by length), package, bake + facts + splat', async () => {
    const t = setup()
    const { captureId } = await t.mutation(api.videos.create, { title: ' Sunday lunch ', attendees: ['Priya'], fileName: 'IMG_0001.MOV', bytes: 18, durationSec: 30 })
    let status = await statusOf(t, captureId)
    expect(status).toMatchObject({ source: 'video', convert: 'not_started', splat: 'not_started', facts: 'not_started' })

    const target = await t.action(api.uploads.start, { captureId, name: 'source.mov', bytes: 18, contentType: 'video/quicktime' })
    expect(target.key).toBe(`videos/${captureId}/source.mov`)
    await fetch(target.single!.url, { method: 'PUT', headers: target.single!.headers, body: new Uint8Array(18) })
    await t.action(api.uploads.finish, { uploadId: target.uploadId })
    status = await statusOf(t, captureId)
    expect(status?.convert).toBe('queued')

    // 30 s → 240 model frames: too many for the 16 GB card, fine for the GX10.
    expect(await t.mutation(api.worker.claim, fedoraGpu)).toBeNull()
    const job = await t.mutation(api.worker.claim, gx10)
    expect(job).toMatchObject({ kind: 'convert', captureId })
    const inputs = await t.action(api.worker.inputs, as(job))
    expect(inputs.files.map((f) => [f.name, f.area])).toEqual([['source.mov', 'video']])
    expect(JSON.parse(inputs.manifestJson ?? '{}')).toMatchObject({ id: captureId, title: 'Sunday lunch', attendees: ['Priya'], source: 'video' })

    // The converter writes a package for this capture id, like a phone upload.
    const pkg = tinyCapture({ id: captureId })
    const manifest = { ...pkg.manifest, source: 'video', title: '' }
    pkg.files['manifest.json'] = new Uint8Array(new TextEncoder().encode(JSON.stringify(manifest)))
    await writeOutputs(t, job!, Object.entries(pkg.files).map(([name, bytes]) => ({ name, area: 'raw' as const, bytes, contentType: 'application/octet-stream' })))
    expect((await statusOf(t, captureId))?.facts).toBe('not_started') // staged until the conversion completes
    await t.mutation(api.worker.complete, { ...as(job), result: { kind: 'convert', manifestJson: JSON.stringify(manifest) } })
    status = await statusOf(t, captureId)
    expect(status).toMatchObject({ convert: 'done', upload: 'done', bake: 'queued', splat: 'queued' })
    expect((await t.query(api.captures.list, {}))[0]).toMatchObject({ id: captureId, title: 'Sunday lunch', source: 'video' })

    const splatJob = await t.mutation(api.worker.claim, gx10)
    expect(splatJob?.kind).toBe('bake') // oldest first: bake was queued before splat
    const next = await t.mutation(api.worker.claim, gx10)
    expect(next?.kind).toBe('splat')
    await writeOutputs(t, next!, [{ name: 'room.spz', area: 'raw', bytes: new Uint8Array(100), contentType: 'application/octet-stream' }])
    const splat = { file: 'room.spz', format: 'spz' as const, count: 1000, shDegree: 0, source: 'trained-from-video' as const }
    await t.mutation(api.worker.complete, { ...as(next), result: { kind: 'splat', splat } })
    const detail = await t.query(api.captures.get, { captureId })
    expect(JSON.parse(detail!.manifestJson).room.splat).toEqual(splat)
    expect(detail?.status.splat).toBe('done')
    await runScheduled(t)
  })

  test('a converted package that is incomplete fails the conversion with the reasons', async () => {
    const t = setup()
    const { captureId } = await t.mutation(api.videos.create, { title: 'Clip', attendees: [], fileName: 'clip.mp4', bytes: 4 })
    const target = await t.action(api.uploads.start, { captureId, name: 'source.mp4', bytes: 4, contentType: 'video/mp4' })
    await fetch(target.single!.url, { method: 'PUT', body: new Uint8Array(4) })
    await t.action(api.uploads.finish, { uploadId: target.uploadId })
    const job = await t.mutation(api.worker.claim, gx10) // unknown length → the cap
    const pkg = tinyCapture({ id: captureId, keyframes: 0, transcript: false })
    await writeOutputs(t, job!, [{ name: 'manifest.json', area: 'raw', bytes: pkg.files['manifest.json'], contentType: 'application/json' }])
    await t.mutation(api.worker.complete, { ...as(job), result: { kind: 'convert', manifestJson: pkg.manifestJson } })
    const status = await statusOf(t, captureId)
    expect(status?.convert).toBe('failed')
    expect(status?.errors.convert).toMatch(/incomplete: .*video\.mov is missing/)
    expect(status?.upload).toBe('invalid')
  })
})
