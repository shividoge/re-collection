// Test setup for convex-test: a stub Claude, a fake R2 behind fetch, and capture fixtures.
// (Two dots in the name, so Convex never deploys this file.)
/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { vi } from 'vitest'
import { api, internal } from './_generated/api'
import { testing, type JsonRequest } from './lib/claude'
import schema from './schema'
import type { Moment } from './validators'

/** Every deployable module (Convex skips names with more than one dot, so tests skip them too). */
export const modules = Object.fromEntries(
  Object.entries(import.meta.glob('./**/*.*s')).filter(([path]) => (path.split('/').pop() ?? '').split('.').length === 2 || path.includes('/_generated/')),
)

export const CAPTURE_ID = '11111111-2222-4333-8444-555555555555'
export const TOKEN = 'test-worker-token'
const R2_ORIGIN = 'https://r2.test'
const BUCKET = 'braindance-test'

/** Objects in the fake bucket, by key. */
export type Bytes = Uint8Array<ArrayBuffer>
export const bucket = new Map<string, { bytes: Bytes; headers: Record<string, string> }>()

/** Answers presigned and header-signed S3 requests from `bucket` (multipart included). */
async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.origin !== R2_ORIGIN) throw new Error(`Unexpected fetch to ${url.origin} in a test.`)
  const key = decodeURIComponent(url.pathname.slice(`/${BUCKET}/`.length))
  const method = init?.method ?? 'GET'
  const headers = Object.fromEntries(new Headers(init?.headers).entries())
  const body = init?.body ? new Uint8Array(await new Response(init.body).arrayBuffer()) : new Uint8Array()
  if (method === 'PUT') {
    bucket.set(key, { bytes: body, headers })
    return new Response(null, { status: 200, headers: { ETag: '"etag"' } })
  }
  if (method === 'HEAD') {
    const obj = bucket.get(key)
    return obj ? new Response(null, { status: 200, headers: { 'Content-Length': String(obj.bytes.length), ETag: '"etag"' } }) : new Response(null, { status: 404 })
  }
  if (method === 'DELETE') {
    bucket.delete(key)
    return new Response(null, { status: 204 })
  }
  if (method === 'GET' && url.searchParams.get('list-type') === '2') {
    const prefix = url.searchParams.get('prefix') ?? ''
    const keys = [...bucket.keys()].filter((k) => k.startsWith(prefix))
    return new Response(`<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`)
  }
  const obj = bucket.get(key)
  return obj ? new Response(obj.bytes, { status: 200 }) : new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 })
}

export type Reply = (request: JsonRequest) => unknown
export const claude = {
  calls: [] as JsonRequest[],
  next: (() => ({})) as Reply,
  /** Runs inside the stub's call, before it answers (to race against it). */
  during: null as null | (() => Promise<void>),
}

/** A real S3-compatible server for end-to-end tests (see lib/r2.test.ts), or null. */
export function realS3() {
  const e = process.env
  if (!e.R2_TEST_ENDPOINT || !e.R2_TEST_ACCESS_KEY_ID || !e.R2_TEST_SECRET_ACCESS_KEY) return null
  return { endpoint: e.R2_TEST_ENDPOINT, accessKeyId: e.R2_TEST_ACCESS_KEY_ID, secretAccessKey: e.R2_TEST_SECRET_ACCESS_KEY, bucket: e.R2_TEST_BUCKET || 'braindance-test', region: e.R2_TEST_REGION || 'us-east-1' }
}

/** convex-test with a stub Claude and the fake bucket (or a real S3 server when given). */
export function setup(s3: ReturnType<typeof realS3> = null) {
  vi.stubEnv('R2_ENDPOINT', s3?.endpoint ?? R2_ORIGIN)
  vi.stubEnv('R2_ACCESS_KEY_ID', s3?.accessKeyId ?? 'test-key')
  vi.stubEnv('R2_SECRET_ACCESS_KEY', s3?.secretAccessKey ?? 'test-secret')
  vi.stubEnv('R2_BUCKET', s3?.bucket ?? BUCKET)
  if (s3) vi.stubEnv('R2_REGION', s3.region)
  vi.stubEnv('WORKER_TOKEN', TOKEN)
  vi.stubEnv('MOCK_CLAUDE', '0')
  vi.stubEnv('MODEL_OFFLINE', 'opus')
  vi.stubEnv('MODEL_LIVE', 'sonnet')
  if (!s3) vi.stubGlobal('fetch', fakeFetch)
  bucket.clear()
  claude.calls = []
  claude.next = () => ({})
  claude.during = null
  testing.client = {
    mock: false,
    async json(request) {
      claude.calls.push(request)
      if (claude.during) await claude.during()
      return { data: claude.next(request), model: 'stub-model' }
    },
  }
  return convexTest(schema, modules)
}
export type T = ReturnType<typeof setup>

export const JPEG: Bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
const enc = (s: string): Bytes => new Uint8Array(new TextEncoder().encode(s))

/** The guide's tiny capture (2 room points, 3 frames, 2 depth frames of 4x3) plus keyframes and a transcript. */
export function tinyCapture({ id = CAPTURE_ID, keyframes = 2, transcript = true, attendees = ['Priya'] } = {}) {
  const manifest: Record<string, unknown> = {
    format: 'braindance.capture',
    version: 1,
    id,
    createdAt: '2026-10-24T13:34:58Z',
    device: 'test',
    title: 'Test visit',
    attendees,
    video: { file: 'video.mov', width: 1920, height: 1440, fps: 30, durationSec: 2, frameCount: 3 },
    depth: { file: 'depth.bin', confidenceFile: 'confidence.bin', width: 4, height: 3, unit: 'mm', rateHz: 10, count: 2 },
    room: { ply: 'room.ply', bin: 'room.bin', points: 2, voxelMeters: 0.01, source: 'on-device' },
    warnings: [],
    ...(keyframes ? { keyframes: { dir: 'keyframes', everySec: 1, count: keyframes } } : {}),
    ...(transcript ? { transcript: { file: 'transcript.json', locale: 'en-US', onDevice: true } } : {}),
  }
  const files: Record<string, Bytes> = {
    'manifest.json': enc(JSON.stringify(manifest)),
    'room.bin': new Uint8Array(4 + 2 * 15),
    'room.ply': enc('ply\nformat binary_little_endian 1.0\nend_header\n'),
    'video.mov': enc('not really a video'),
    'frames.jsonl': enc('{}\n{}\n{}\n'),
    'depth.bin': new Uint8Array(2 * 4 * 3 * 2),
    'confidence.bin': new Uint8Array(2 * 4 * 3),
    'thumb.jpg': JPEG,
  }
  for (let k = 0; k < keyframes; k++) files[`keyframes/k${String(k).padStart(4, '0')}.jpg`] = JPEG
  if (transcript) files['transcript.json'] = enc(JSON.stringify({ locale: 'en-US', segments: [{ start: 0.4, end: 1.6, text: 'Mom, I brought the mango cake!', words: [] }] }))
  return { manifest, manifestJson: JSON.stringify(manifest), files }
}

/** Uploads one file the way a client does: start, PUT (or parts), finish. */
export async function upload(t: T, captureId: string, name: string, bytes: Bytes, contentType = 'application/octet-stream') {
  const target = await t.action(api.uploads.start, { captureId, name, bytes: bytes.length, contentType })
  if (!target.single) throw new Error('test files are small')
  await fetch(target.single.url, { method: 'PUT', headers: target.single.headers, body: bytes })
  return t.action(api.uploads.finish, { uploadId: target.uploadId })
}

/** begin + every file in order (manifest first), optionally without some. */
export async function uploadCapture(t: T, capture: ReturnType<typeof tinyCapture>, { skip = [] as string[] } = {}) {
  const { captureId } = await t.mutation(api.captures.begin, { manifestJson: capture.manifestJson })
  for (const [name, bytes] of Object.entries(capture.files)) if (!skip.includes(name)) await upload(t, captureId, name, bytes)
  return captureId
}

export async function runScheduled(t: T) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
  } finally {
    vi.useRealTimers()
  }
}

/** A moment row straight into the database (facts already reviewed). */
export async function putMoment(t: T, moment: Moment) {
  await t.run(async (ctx) => {
    await ctx.db.insert('moments', moment)
  })
}

export const statusOf = async (t: T, captureId = CAPTURE_ID) => (await t.query(api.moments.get, { captureId })).status
export { api, internal }
