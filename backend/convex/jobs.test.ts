// The job protocol: tokens, leases, heartbeats, expiry, retries, routing, worker outputs, and
// the video flow (convert → package → bake/facts/splat).
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Id } from './_generated/dataModel'
import { STOPPED_RESPONDING } from './lib/jobs'
import { convertFrames } from './lib/validate'
import { CAPTURE_ID, JPEG, TOKEN, api, bucket, internal, runScheduled, setup, statusOf, tinyCapture, uploadCapture, type Bytes, type T } from './test.helpers'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const cpu = { token: TOKEN, workerId: 'fedora-bake', kinds: ['bake' as const], gpu: false, protocol: 2 }
const fedoraGpu = { token: TOKEN, workerId: 'fedora-gpu', kinds: ['convert' as const, 'splat' as const], gpu: true, maxFrames: 67, protocol: 2 }
const gx10 = { token: TOKEN, workerId: 'gx10', kinds: ['convert' as const, 'splat' as const, 'bake' as const], gpu: true, maxFrames: 240, protocol: 2 }

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
    expect(await t.mutation(api.worker.claim, { ...fedoraGpu, kinds: ['convert' as const] })).toBeNull() // a convert-only GPU worker takes nothing
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

  test('an outdated worker (no protocol 2) is refused at claim and takes nothing', async () => {
    const t = await completedCapture()
    const { protocol: _, ...old } = cpu
    await expect(t.mutation(api.worker.claim, old)).rejects.toThrow(/job protocol 1, but the backend needs 2/)
    expect((await statusOf(t))?.bake).toBe('queued')
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

  test("the sweep never deletes an object a file row uses (uploads from before attempt keys)", async () => {
    const t = await completedCapture()
    const job = await t.mutation(api.worker.claim, cpu)
    const [out] = await writeOutputs(t, job!, [{ name: 'points.pack', area: 'derived', bytes: new Uint8Array(8).fill(3), contentType: 'application/octet-stream' }])
    const derivedMeta = { format: 'braindance.derived' as const, version: 1, captureId: CAPTURE_ID, bakedAt: 'x', bakeVersion: 'x', files: { points: 'points.pack' }, stats: { points: 1, bakeMs: 1 } }
    await t.mutation(api.worker.complete, { ...as(job), result: { kind: 'bake', derived: derivedMeta } })
    // An old-protocol upload left open at the published key, for a job that's long done.
    await t.run(async (ctx) => {
      await ctx.db.insert('uploads', { captureId: CAPTURE_ID, area: 'derived', name: 'points.pack', key: out.target.key, bytes: 8, contentType: 'application/octet-stream', status: 'open', jobId: job!.jobId, createdAt: 0 })
    })
    await t.mutation(internal.jobsCron.reap, {})
    await runScheduled(t)
    expect(bucket.get(out.target.key)?.bytes).toEqual(new Uint8Array(8).fill(3))
    expect((await t.run(async (ctx) => ctx.db.query('uploads').collect())).filter((u) => u.status === 'open')).toEqual([])
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

describe('phone capture → room splat', () => {
  const lidarSplat = { file: 'room.spz', format: 'spz' as const, count: 1000, shDegree: 1, source: 'trained-from-lidar-capture' as const }

  test('a valid upload queues the splat for any GPU worker; done, it is in the manifest and never queued again', async () => {
    const t = await completedCapture()
    expect(await statusOf(t)).toMatchObject({ source: 'phone', upload: 'done', bake: 'queued', splat: 'queued' })
    expect(await t.mutation(api.worker.claim, cpu)).toMatchObject({ kind: 'bake' }) // the bake worker never gets it
    const job = await t.mutation(api.worker.claim, fedoraGpu) // no frame needs: the 16 GB card can take it
    expect(job).toMatchObject({ kind: 'splat', captureId: CAPTURE_ID })
    expect((await jobRow(t, job!.jobId))?.needs).toEqual({ gpu: true })
    await writeOutputs(t, job!, [{ name: 'room.spz', area: 'raw', bytes: new Uint8Array(100), contentType: 'application/octet-stream' }])
    await t.mutation(api.worker.complete, { ...as(job), result: { kind: 'splat', splat: lidarSplat } })
    const detail = await t.query(api.captures.get, { captureId: CAPTURE_ID })
    expect(JSON.parse(detail!.manifestJson).room.splat).toEqual(lidarSplat)
    expect(detail?.status.splat).toBe('done')

    // The phone sends the package again: re-baked, but the splat stays and isn't trained again.
    await uploadCapture(t, tinyCapture())
    await t.action(api.captures.complete, { captureId: CAPTURE_ID })
    expect(await statusOf(t)).toMatchObject({ splat: 'done', bake: 'queued' })
    expect(JSON.parse((await t.query(api.captures.get, { captureId: CAPTURE_ID }))!.manifestJson).room.splat).toEqual(lidarSplat)
    expect(await t.mutation(api.worker.claim, fedoraGpu)).toBeNull()
    await runScheduled(t)
  })

  test('backfill: dry run lists, the real run queues once, finished or unfinished captures are left alone', async () => {
    const t = await completedCapture()
    // As captures from before this change: complete, splat skipped, no job.
    await t.run(async (ctx) => {
      for (const job of await ctx.db.query('jobs').collect()) if (job.kind === 'splat') await ctx.db.delete(job._id)
      const c = (await ctx.db.query('captures').collect())[0]
      await ctx.db.patch(c._id, { status: { ...c.status, splat: 'skipped' } })
    })
    const OTHER = '99999999-2222-4333-8444-555555555555'
    const other = tinyCapture({ id: OTHER })
    await t.mutation(api.captures.begin, { manifestJson: other.manifestJson }) // still receiving

    const results = (r: { captureId: string; result: string }[]) => Object.fromEntries(r.map((x) => [x.captureId, x.result]))
    expect(results(await t.mutation(internal.splats.backfill, { dryRun: true }))).toEqual({ [CAPTURE_ID]: 'would queue', [OTHER]: 'upload receiving' })
    expect((await statusOf(t))?.splat).toBe('skipped')
    expect(results(await t.mutation(internal.splats.backfill, { dryRun: false }))[CAPTURE_ID]).toBe('queued')
    expect((await statusOf(t))?.splat).toBe('queued')
    expect(results(await t.mutation(internal.splats.backfill, { dryRun: false }))[CAPTURE_ID]).toBe('already queued')

    const job = await t.mutation(api.worker.claim, fedoraGpu)
    await writeOutputs(t, job!, [{ name: 'room.spz', area: 'raw', bytes: new Uint8Array(100), contentType: 'application/octet-stream' }])
    await t.mutation(api.worker.complete, { ...as(job), result: { kind: 'splat', splat: lidarSplat } })
    expect(results(await t.mutation(internal.splats.backfill, { dryRun: false }))[CAPTURE_ID]).toBe('has a splat')
    await runScheduled(t)
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

  test('reconvert: an imported video capture is converted again; facts stay, the old splat is dropped and retrained', async () => {
    const t = setup()
    // As the import made it: a converted package uploaded like a phone's (convert skipped), facts reviewed.
    const pkg = tinyCapture()
    const manifest = { ...pkg.manifest, source: 'video' }
    pkg.files['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest))
    await uploadCapture(t, { ...pkg, manifestJson: JSON.stringify(manifest) })
    await t.action(api.captures.complete, { captureId: CAPTURE_ID })
    await runScheduled(t) // facts extracted
    const facts = () => t.run(async (ctx) => (await ctx.db.query('moments').collect()).map((m) => m.facts))
    const before = await facts()
    expect(before).toHaveLength(1)
    expect(await statusOf(t)).toMatchObject({ source: 'video', convert: 'skipped', splat: 'skipped', facts: 'done' })
    await t.mutation(internal.splats.backfill, { dryRun: false })
    expect(await t.mutation(api.worker.claim, cpu)).toMatchObject({ kind: 'bake' })
    const oldSplat = await t.mutation(api.worker.claim, fedoraGpu) // training on the old conversion
    expect(oldSplat).toMatchObject({ kind: 'splat' })

    await expect(t.mutation(api.admin.reconvertVideo, { token: 'nope', captureId: CAPTURE_ID })).rejects.toThrow(/token/)
    await t.mutation(api.admin.reconvertVideo, { token: TOKEN, captureId: CAPTURE_ID })
    expect(await t.mutation(api.worker.heartbeat, { ...as(oldSplat) })).toEqual({ ok: false, cancelled: true })
    expect(await statusOf(t)).toMatchObject({ convert: 'not_started', splat: 'not_started' })

    const target = await t.action(api.uploads.start, { captureId: CAPTURE_ID, name: 'source.mov', bytes: 18, contentType: 'video/quicktime' })
    expect(target.key).toBe(`videos/${CAPTURE_ID}/source.mov`)
    await fetch(target.single!.url, { method: 'PUT', headers: target.single!.headers, body: new Uint8Array(18) })
    await t.action(api.uploads.finish, { uploadId: target.uploadId })
    expect((await statusOf(t))?.convert).toBe('queued')
    await expect(t.mutation(api.admin.reconvertVideo, { token: TOKEN, captureId: CAPTURE_ID })).rejects.toThrow(/already being converted/)

    const job = await t.mutation(api.worker.claim, fedoraGpu)
    expect(job).toMatchObject({ kind: 'convert', captureId: CAPTURE_ID })
    const inputs = await t.action(api.worker.inputs, as(job))
    expect(JSON.parse(inputs.manifestJson ?? '{}')).toMatchObject({ title: 'Test visit', attendees: ['Priya'] })
    await writeOutputs(t, job!, Object.entries(pkg.files).map(([name, bytes]) => ({ name, area: 'raw' as const, bytes, contentType: 'application/octet-stream' })))
    await t.mutation(api.worker.complete, { ...as(job), result: { kind: 'convert', manifestJson: JSON.stringify(manifest) } })
    expect(await statusOf(t)).toMatchObject({ convert: 'done', upload: 'done', facts: 'done', bake: 'queued', splat: 'queued' })
    expect(await facts()).toEqual(before) // the review is untouched
    expect(await t.mutation(api.admin.reconvertVideo, { token: TOKEN, captureId: CAPTURE_ID })).toEqual({ ok: true })
    await expect(t.mutation(api.admin.reconvertVideo, { token: TOKEN, captureId: 'nope' })).rejects.toThrow()
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

/** What workers/gpu/client.py and worker.py rely on (the Python worker runs against this backend). */
describe('GPU worker contract', () => {
  const codeOf = (e: unknown) => (e as { data?: { code?: string } }).data?.code
  // client.py LEASE_LOST_CODES: a refusal with one of these codes means "the job isn't ours any more".
  const LEASE_LOST_CODES = ['not_leased', 'lease_lost', 'lease_expired', 'not_found', 'cancelled']

  async function videoJob(t: T, durationSec?: number) {
    const { captureId } = await t.mutation(api.videos.create, { title: 'Sunday lunch', attendees: ['Priya', 'Dev'], fileName: 'clip.mp4', bytes: 4, ...(durationSec ? { durationSec } : {}) })
    const target = await t.action(api.uploads.start, { captureId, name: 'source.mp4', bytes: 4, contentType: 'video/mp4' })
    await fetch(target.single!.url, { method: 'PUT', headers: target.single!.headers, body: new Uint8Array(4) })
    await t.action(api.uploads.finish, { uploadId: target.uploadId })
    return { captureId, job: await t.mutation(api.worker.claim, gx10) }
  }

  test('convert inputs: the seed manifest has title and attendees, and the source video is listed', async () => {
    const t = setup()
    const { captureId, job } = await videoJob(t, 12)
    const inputs = await t.action(api.worker.inputs, as(job))
    expect(JSON.parse(inputs.manifestJson ?? '{}')).toMatchObject({ id: captureId, title: 'Sunday lunch', attendees: ['Priya', 'Dev'] })
    expect(inputs.files).toEqual([expect.objectContaining({ name: 'source.mp4', area: 'video', bytes: 4 })])
  })

  test('a job the worker no longer holds: heartbeat says ok false / cancelled, complete and fail throw a lease-lost code', async () => {
    const t = setup()
    vi.useFakeTimers({ toFake: ['Date'] })
    const { job } = await videoJob(t)
    vi.setSystemTime(Date.now() + 121_000)
    await t.mutation(internal.jobsCron.reap, {})
    expect(await t.mutation(api.worker.heartbeat, as(job))).toEqual({ ok: false, cancelled: true })
    const complete = await t.mutation(api.worker.complete, { ...as(job), result: { kind: 'convert', manifestJson: '{}' } }).catch((e: unknown) => e)
    const fail = await t.mutation(api.worker.fail, { ...as(job), error: 'x', retryable: true }).catch((e: unknown) => e)
    const outputs = await t.action(api.worker.outputUrls, { ...as(job), files: [] }).catch((e: unknown) => e)
    for (const e of [complete, fail, outputs]) expect(LEASE_LOST_CODES).toContain(codeOf(e))
  })

  test('finishOutput returns the stored size in bytes, also when asked again', async () => {
    const t = setup()
    const { job } = await videoJob(t)
    const [out] = await t.action(api.worker.outputUrls, { ...as(job), files: [{ name: 'thumb.jpg', bytes: 4, contentType: 'image/jpeg', area: 'raw' }] })
    await fetch(out.target.single!.url, { method: 'PUT', headers: out.target.single!.headers, body: JPEG })
    expect(await t.action(api.worker.finishOutput, { ...as(job), uploadId: out.target.uploadId })).toEqual({ ok: true, bytes: 4 })
    expect(await t.action(api.worker.finishOutput, { ...as(job), uploadId: out.target.uploadId })).toEqual({ ok: true, bytes: 4 })
  })

  test("needs.frames uses video2capture's sample_count: max(16, floor(10 s) + 1), capped at 240", async () => {
    // tools/video2capture/convert.py sample_count / job_frames, at 10 samples per second.
    const python = (d: number) => Math.min(240, Math.max(2, Math.max(16, Math.floor(d * 10) + 1)))
    for (const d of [0.4, 1, 1.55, 6.6, 12, 23.9, 24, 60]) expect(convertFrames(d), `${d} s`).toBe(python(d))
    expect(convertFrames(undefined)).toBe(240)
    const t = setup()
    await videoJob(t, 6.6)
    expect((await t.run(async (ctx) => ctx.db.query('jobs').collect())).find((j) => j.kind === 'convert')?.needs).toEqual({ gpu: true, frames: 67 })
  })
})
