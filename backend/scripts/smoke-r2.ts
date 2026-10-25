// A real round trip through Convex and R2 on a throwaway capture, then deletes it all:
// single PUT, multipart, a gzip multipart output through a worker job, HEAD size checks at
// finish, presigned GET with Range and cache headers, removal of rows and objects.
//   bun scripts/smoke-r2.ts
import { ConvexHttpClient } from 'convex/browser'
import { gzipSync } from 'node:zlib'
import { api } from '../convex/_generated/api'
import type { UploadTarget } from '../convex/validators'
import { scriptEnv } from './env'

const { convexUrl, token } = scriptEnv()
const client = new ConvexHttpClient(convexUrl)
const id = crypto.randomUUID()
const WORKER = `smoke-r2-${id.slice(0, 8)}`
const results: string[] = []
const check = (ok: boolean, what: string) => {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${what}`)
  if (!ok) process.exitCode = 1
}
const timed = async <R>(label: string, run: () => Promise<R>): Promise<R> => {
  const t0 = performance.now()
  const r = await run()
  results.push(`  ${label}: ${((performance.now() - t0) / 1000).toFixed(2)} s`)
  return r
}
const pattern = (n: number, seed: number): Uint8Array<ArrayBuffer> => {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff
  return b
}
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

type Bytes = Uint8Array<ArrayBuffer>
async function put(target: UploadTarget, data: Bytes) {
  if (target.single) {
    const res = await fetch(target.single.url, { method: 'PUT', headers: target.single.headers, body: data })
    if (!res.ok) throw new Error(`PUT: HTTP ${res.status} ${await res.text()}`)
    return undefined
  }
  const size = target.partSize ?? 0
  return Promise.all((target.parts ?? []).map(async (p) => {
    const res = await fetch(p.url, { method: 'PUT', body: data.subarray((p.partNumber - 1) * size, p.partNumber * size) })
    if (!res.ok) throw new Error(`part ${p.partNumber}: HTTP ${res.status} ${await res.text()}`)
    return { partNumber: p.partNumber, etag: res.headers.get('etag') ?? '' }
  }))
}

const thumb = pattern(1000, 1)
const video = pattern(17 * 1024 * 1024 + 4321, 2) // two 16 MiB parts
const pointsRaw = pattern(20 * 1024 * 1024, 3)
const points = new Uint8Array(gzipSync(pointsRaw, { level: 0 })) // stays > 8 MiB, so multipart
const manifest = {
  format: 'braindance.capture', version: 1, id, createdAt: new Date().toISOString(), title: '[smoke test] R2', attendees: [],
  video: { file: 'video.mov', width: 1920, height: 1440, fps: 30, durationSec: 1, frameCount: 1 },
  depth: { file: 'depth.bin', confidenceFile: 'confidence.bin', width: 4, height: 3, unit: 'mm', rateHz: 10, count: 1 },
  warnings: [],
}
const enc = (text: string): Bytes => new Uint8Array(new TextEncoder().encode(text))
const files: Record<string, Bytes> = {
  'manifest.json': enc(JSON.stringify(manifest)),
  'thumb.jpg': thumb,
  'video.mov': video,
  'frames.jsonl': enc('{}\n'),
  'depth.bin': new Uint8Array(24),
  'confidence.bin': new Uint8Array(12),
}
let urls: string[] = []

await client.mutation(api.captures.begin, { manifestJson: JSON.stringify(manifest) })
try {
  for (const [name, data] of Object.entries(files)) {
    const target = await timed(`uploads.start ${name}`, () => client.action(api.uploads.start, { captureId: id, name, bytes: data.length, contentType: 'application/octet-stream' }))
    if (name === 'video.mov') check(target.parts?.length === 2 && target.partSize === 16 * 1024 * 1024, 'multipart target: 2 parts of 16 MiB')
    if (name === 'thumb.jpg') check(Boolean(target.single?.headers['Cache-Control']), 'single PUT target with signed Cache-Control')
    const parts = await timed(`upload ${name} (${(data.length / 1024 ** 2).toFixed(1)} MB)`, () => put(target, data))
    const done = await timed(`uploads.finish ${name}`, () => client.action(api.uploads.finish, { uploadId: target.uploadId, ...(parts ? { parts } : {}) }))
    check(done.bytes === data.length, `finish ${name}: HEAD size ${done.bytes}`)
  }
  // A short upload is refused by the HEAD size check.
  const short = await client.action(api.uploads.start, { captureId: id, name: 'short.bin', bytes: 100, contentType: 'application/octet-stream' })
  const shortPut = await fetch(short.single!.url, { method: 'PUT', headers: { ...short.single!.headers, 'Content-Length': '50' }, body: new Uint8Array(50) })
  check(shortPut.status === 403, `a PUT of the wrong size is refused by R2 (HTTP ${shortPut.status}): the signed Content-Length`)
  check(await client.action(api.uploads.finish, { uploadId: short.uploadId }).then(() => false, (e: Error) => /didn't arrive/.test(e.message)), "finish refuses an upload that didn't arrive")

  await timed('captures.complete', () => client.action(api.captures.complete, { captureId: id }))
  const job = await client.mutation(api.worker.claim, { token, workerId: WORKER, kinds: ['bake'], gpu: false })
  if (!job || job.captureId !== id) {
    check(false, `claimed this capture's bake job (got ${job ? `${job.kind} for ${job.captureId}` : 'nothing'}; a live bake worker may have taken it)`)
    if (job) await client.mutation(api.worker.fail, { token, jobId: job.jobId, error: 'Claimed by the R2 smoke test by mistake; re-queued.', retryable: true })
  } else {
    const [out] = await client.action(api.worker.outputUrls, { token, jobId: job.jobId, files: [{ name: 'points.pack', bytes: points.length, contentType: 'application/octet-stream', contentEncoding: 'gzip', area: 'derived' }] })
    check(Boolean(out.target.parts?.length), `gzip output is multipart (${out.target.parts?.length} parts)`)
    const parts = await timed(`upload points.pack gzip (${(points.length / 1024 ** 2).toFixed(1)} MB)`, () => put(out.target, points))
    await client.action(api.worker.finishOutput, { token, jobId: job.jobId, uploadId: out.target.uploadId, ...(parts ? { parts } : {}) })
    await client.mutation(api.worker.fail, { token, jobId: job.jobId, error: 'R2 smoke test: not a real bake.', retryable: false })
  }

  const detail = await timed('captures.get (signs every URL in the query)', () => client.query(api.captures.get, { captureId: id }))
  const all = [...(detail?.files ?? []), ...(detail?.derivedFiles ?? [])]
  urls = all.map((f) => f.url)
  const again = await client.query(api.captures.get, { captureId: id })
  check(JSON.stringify(again?.files.map((f) => f.url)) === JSON.stringify(detail?.files.map((f) => f.url)), 'URLs are stable between calls (cacheable)')
  const v = all.find((f) => f.name === 'video.mov')
  const range = await timed('GET video.mov Range bytes=1000-1999', () => fetch(v!.url, { headers: { Range: 'bytes=1000-1999' } }))
  const rangeBytes = new Uint8Array(await range.arrayBuffer())
  check(range.status === 206 && same(rangeBytes, video.subarray(1000, 2000)), `Range GET: ${range.status}, ${range.headers.get('content-range')}`)
  check(range.headers.get('cache-control') === 'public, max-age=31536000, immutable', `Cache-Control on multipart object: ${range.headers.get('cache-control')}`)
  const full = await timed('GET video.mov (17 MB)', () => fetch(v!.url).then(async (r) => new Uint8Array(await r.arrayBuffer())))
  check(same(full, video), 'multipart object reads back byte for byte')
  const t = await fetch(all.find((f) => f.name === 'thumb.jpg')!.url)
  check(same(new Uint8Array(await t.arrayBuffer()), thumb) && t.headers.get('cache-control') === 'public, max-age=31536000, immutable', `single PUT object reads back with Cache-Control: ${t.headers.get('cache-control')}`)
  const p = all.find((f) => f.name === 'points.pack')
  if (p) {
    const res = await fetch(p.url, { headers: { 'Accept-Encoding': 'gzip' } })
    const enc = res.headers.get('content-encoding')
    const body = new Uint8Array(await res.arrayBuffer())
    check(enc === 'gzip', `gzip object served with Content-Encoding: ${enc}`)
    check(same(body, pointsRaw) || same(body, points), `gzip object body (${same(body, pointsRaw) ? 'decompressed by fetch' : 'raw gzip'})`)
    check(res.headers.get('cache-control') === 'public, max-age=31536000, immutable', 'Cache-Control on the gzip multipart object')
  }
} finally {
  await client.mutation(api.captures.remove, { captureId: id })
  await client.mutation(api.admin.forgetWorker, { token, workerId: WORKER })
  const t0 = performance.now()
  let left = urls.length
  for (let i = 0; i < 30 && left > 0; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    left = (await Promise.all(urls.map((u) => fetch(u, { headers: { Range: 'bytes=0-0' } }).then((r) => r.status !== 404)))).filter(Boolean).length
  }
  check(left === 0, `after captures.remove: ${urls.length - left}/${urls.length} objects gone in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
  check((await client.query(api.captures.get, { captureId: id })) === null, 'capture rows gone')
  let keys = ['?']
  for (let i = 0; i < 20 && keys.length > 0; i++) {
    keys = await client.action(api.admin.storageKeys, { token, prefix: `captures/${id}/` })
    if (keys.length) await new Promise((r) => setTimeout(r, 1000))
  }
  check(keys.length === 0, `no objects left under captures/${id}/ (${keys.length})`)
  console.log(results.join('\n'))
}
