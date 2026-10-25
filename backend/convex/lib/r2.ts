// Cloudflare R2 through its S3 API (docs/architecture-v3.md §2, §6.4).
// Pure TypeScript with no dependencies and no Node APIs: SHA-256 and HMAC are
// implemented here (synchronous) so URL signing can run inside Convex queries.
// The fetch-based helpers at the bottom are for Convex actions.
import { ConvexError } from 'convex/values'

export type R2Config = {
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  endpoint: string
  region: string
}

type Env = Record<string, string | undefined>
type Creds = Pick<R2Config, 'accessKeyId' | 'secretAccessKey' | 'region'>
type Method = 'GET' | 'PUT' | 'HEAD' | 'DELETE' | 'POST'

export const CACHE_CONTROL = 'public, max-age=31536000, immutable'
export const PART_SIZE = 16 * 1024 * 1024
export const SINGLE_MAX = 8 * 1024 * 1024
export const MAX_PARTS = 10000
const PUT_EXPIRES = 3600
const STABLE_EXPIRES = 604800
const DAY_MS = 86400000
const UNSIGNED = 'UNSIGNED-PAYLOAD'

// ---------- Config ----------

function processEnv(): Env {
  const g = globalThis as { process?: { env?: Env } }
  return g.process?.env ?? {}
}

function readConfig(env: Env): { cfg: R2Config | null; missing: string[] } {
  const v = (name: string) => env[name]?.trim() || undefined
  const accountId = v('R2_ACCOUNT_ID')
  const endpoint = v('R2_ENDPOINT') ?? (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined)
  const accessKeyId = v('R2_ACCESS_KEY_ID')
  const secretAccessKey = v('R2_SECRET_ACCESS_KEY')
  const bucket = v('R2_BUCKET')
  const missing: string[] = []
  if (!endpoint) missing.push('R2_ACCOUNT_ID (or R2_ENDPOINT)')
  if (!accessKeyId) missing.push('R2_ACCESS_KEY_ID')
  if (!secretAccessKey) missing.push('R2_SECRET_ACCESS_KEY')
  if (!bucket) missing.push('R2_BUCKET')
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) return { cfg: null, missing }
  const region = v('R2_REGION') ?? 'auto'
  return { cfg: { accessKeyId, secretAccessKey, bucket, endpoint: endpoint.replace(/\/+$/, ''), region }, missing }
}

function listWords(items: string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** The R2 config from the environment; throws a ConvexError naming what's missing. */
export function r2Config(env: Env = processEnv()): R2Config {
  const { cfg, missing } = readConfig(env)
  if (!cfg) throw new ConvexError(`R2 isn't configured: set ${listWords(missing)}.`)
  return cfg
}

export function r2ConfigOrNull(env: Env = processEnv()): R2Config | null {
  return readConfig(env).cfg
}

// ---------- SHA-256 / HMAC-SHA256 (FIPS 180-4, RFC 2104) ----------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const utf8 = new TextEncoder()
const toBytes = (data: Uint8Array | string): Uint8Array => (typeof data === 'string' ? utf8.encode(data) : data)
const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))

export function sha256(data: Uint8Array | string): Uint8Array {
  const msg = toBytes(data)
  const len = msg.length
  const padded = new Uint8Array(Math.ceil((len + 9) / 64) * 64)
  padded.set(msg)
  padded[len] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(len / 0x20000000)) // high 32 bits of len * 8
  view.setUint32(padded.length - 4, (len << 3) >>> 0)

  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const W = new Uint32Array(64)
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15], b = W[i - 2]
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10)
      W[i] = W[i - 16] + s0 + W[i - 7] + s1
    }
    let [a, b, c, d, e, f, g, h] = H
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
      h = g; g = f; f = e; e = (d + t1) | 0
      d = c; c = b; b = a; a = (t1 + t2) | 0
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h
  }
  const out = new Uint8Array(32)
  const ov = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, H[i])
  return out
}

export const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

export function sha256Hex(data: Uint8Array | string): string {
  return toHex(sha256(data))
}

export function hmacSha256(key: Uint8Array | string, data: Uint8Array | string): Uint8Array {
  let k = toBytes(key)
  if (k.length > 64) k = sha256(k)
  const msg = toBytes(data)
  const inner = new Uint8Array(64 + msg.length)
  const outer = new Uint8Array(64 + 32)
  for (let i = 0; i < 64; i++) {
    const b = k[i] ?? 0
    inner[i] = b ^ 0x36
    outer[i] = b ^ 0x5c
  }
  inner.set(msg, 64)
  outer.set(sha256(inner), 64)
  return sha256(outer)
}

// ---------- SigV4 building blocks ----------

/** RFC 3986 encoding (unreserved A-Z a-z 0-9 - . _ ~ kept). '/' kept only when keepSlash. */
export function uriEncode(s: string, keepSlash = false): string {
  const e = encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return keepSlash ? e.replace(/%2F/g, '/') : e
}

/** An object key as a URI path: each segment encoded, '/' kept. */
export const encodeKey = (key: string): string => uriEncode(key, true)

/** 'YYYYMMDDTHHMMSSZ' for a time in ms. */
export function amzDate(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

export function canonicalQuery(query: Record<string, string>): string {
  return Object.entries(query)
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
}

const trimValue = (v: string) => v.trim().replace(/\s+/g, ' ')

/** Lowercased, sorted header names joined with ';'. */
export const signedHeaderNames = (headers: Record<string, string>): string =>
  Object.keys(headers).map((h) => h.toLowerCase()).sort().join(';')

/** `headers` must include host; `path` is the already-encoded canonical URI. */
export function canonicalRequest(
  method: string,
  path: string,
  query: Record<string, string>,
  headers: Record<string, string>,
  payloadHash: string,
): string {
  const lower = Object.entries(headers).map(([k, v]): [string, string] => [k.toLowerCase(), trimValue(v)])
  lower.sort(([a], [b]) => (a < b ? -1 : 1))
  const canonHeaders = lower.map(([k, v]) => `${k}:${v}\n`).join('')
  return [method, path, canonicalQuery(query), canonHeaders, signedHeaderNames(headers), payloadHash].join('\n')
}

export const credentialScope = (date: string, region: string, service = 's3') =>
  `${date.slice(0, 8)}/${region}/${service}/aws4_request`

export function stringToSign(date: string, scope: string, canonicalReq: string): string {
  return ['AWS4-HMAC-SHA256', date, scope, sha256Hex(canonicalReq)].join('\n')
}

export function signingKey(secret: string, date8: string, region: string, service = 's3'): Uint8Array {
  const kDate = hmacSha256(`AWS4${secret}`, date8)
  return hmacSha256(hmacSha256(hmacSha256(kDate, region), service), 'aws4_request')
}

const sign = (creds: Creds, date: string, scope: string, creq: string): string =>
  toHex(hmacSha256(signingKey(creds.secretAccessKey, date.slice(0, 8), creds.region), stringToSign(date, scope, creq)))

type SignInput = {
  method: string
  host: string
  path: string // encoded canonical URI
  query?: Record<string, string>
  headers?: Record<string, string> // signed in addition to host
  date: string // amzDate(...)
}

/** Query-string presigning; returns the full query string including X-Amz-Signature. */
export function presignQuery(creds: Creds, i: SignInput & { expiresSec: number }): string {
  const headers = { host: i.host, ...lowerKeys(i.headers ?? {}) }
  const scope = credentialScope(i.date, creds.region)
  const query = {
    ...i.query,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${creds.accessKeyId}/${scope}`,
    'X-Amz-Date': i.date,
    'X-Amz-Expires': String(i.expiresSec),
    'X-Amz-SignedHeaders': signedHeaderNames(headers),
  }
  const signature = sign(creds, i.date, scope, canonicalRequest(i.method, i.path, query, headers, UNSIGNED))
  return `${canonicalQuery(query)}&X-Amz-Signature=${signature}`
}

/** Header signing; returns the headers to send (x-amz-date, x-amz-content-sha256, authorization, plus the given ones). Host is signed but not returned. */
export function signHeaders(creds: Creds, i: SignInput & { payloadHash: string }): Record<string, string> {
  const extra = { ...lowerKeys(i.headers ?? {}), 'x-amz-content-sha256': i.payloadHash, 'x-amz-date': i.date }
  const headers = { host: i.host, ...extra }
  const scope = credentialScope(i.date, creds.region)
  const signature = sign(creds, i.date, scope, canonicalRequest(i.method, i.path, i.query ?? {}, headers, i.payloadHash))
  const authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope},SignedHeaders=${signedHeaderNames(headers)},Signature=${signature}`
  return { ...extra, authorization }
}

function lowerKeys(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]))
}

/** Path-style target: `${endpoint}/${bucket}/${key}` (key '' = the bucket itself). */
export function objectTarget(cfg: R2Config, key: string): { origin: string; host: string; path: string } {
  const u = new URL(cfg.endpoint)
  const base = u.pathname.replace(/\/+$/, '')
  const path = `${base}/${uriEncode(cfg.bucket)}${key ? `/${encodeKey(key)}` : ''}`
  return { origin: u.origin, host: u.host, path }
}

// ---------- Presigned URLs ----------

export function presign(
  cfg: R2Config,
  p: {
    method: 'GET' | 'PUT' | 'HEAD' | 'DELETE'
    key: string
    expiresSec: number
    now: number
    query?: Record<string, string>
    signedHeaders?: Record<string, string>
  },
): string {
  const t = objectTarget(cfg, p.key)
  const qs = presignQuery(cfg, {
    method: p.method,
    host: t.host,
    path: t.path,
    query: p.query,
    headers: p.signedHeaders,
    date: amzDate(p.now),
    expiresSec: p.expiresSec,
  })
  return `${t.origin}${t.path}?${qs}`
}

/** GET URL that's byte-identical all UTC day for the same key and rev (§6.4). */
export function stableGetUrl(cfg: R2Config, key: string, rev: number, now: number): string {
  const day = Math.floor(now / DAY_MS) * DAY_MS
  return presign(cfg, { method: 'GET', key, expiresSec: STABLE_EXPIRES, now: day, query: { 'x-id': String(rev) } })
}

/** Single presigned PUT; the client must send exactly `headers`. */
export function putTarget(
  cfg: R2Config,
  key: string,
  p: { contentType: string; contentEncoding?: string; now: number; contentLength?: number },
): { url: string; headers: Record<string, string> } {
  // Signing the length means a PUT of any other size is refused, so it can't replace the object.
  const headers = { ...objectHeaders(p), ...(p.contentLength !== undefined ? { 'Content-Length': String(p.contentLength) } : {}) }
  const url = presign(cfg, { method: 'PUT', key, expiresSec: PUT_EXPIRES, now: p.now, signedHeaders: headers })
  return { url, headers }
}

/** Presigned UploadPart URL. */
export function partUrl(cfg: R2Config, key: string, uploadId: string, partNumber: number, now: number): string {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PARTS) {
    throw new Error(`Part number must be 1–${MAX_PARTS}, got ${partNumber}.`)
  }
  return presign(cfg, { method: 'PUT', key, expiresSec: PUT_EXPIRES, now, query: { partNumber: String(partNumber), uploadId } })
}

export function partCount(bytes: number, partSize: number = PART_SIZE): number {
  if (!Number.isFinite(bytes) || bytes < 0) throw new Error(`Invalid byte count: ${bytes}.`)
  if (!Number.isFinite(partSize) || partSize <= 0) throw new Error(`Invalid part size: ${partSize}.`)
  const n = Math.max(1, Math.ceil(bytes / partSize))
  if (n > MAX_PARTS) throw new Error(`${bytes} bytes needs ${n} parts; the limit is ${MAX_PARTS}.`)
  return n
}

function objectHeaders(p: { contentType: string; contentEncoding?: string }): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': p.contentType, 'Cache-Control': CACHE_CONTROL }
  if (p.contentEncoding) h['Content-Encoding'] = p.contentEncoding
  return h
}

// ---------- Header-signed requests (Convex actions) ----------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function xmlDecode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
    return ENTITIES[e] ?? m
  })
}

const xmlEncode = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Inner text of every <tag>…</tag> (decoded). */
export function xmlAll(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g')
  return Array.from(xml.matchAll(re), (m) => xmlDecode(m[1]))
}

export const xmlOne = (xml: string, tag: string): string | null => xmlAll(xml, tag)[0] ?? null

async function s3(
  cfg: R2Config,
  op: string,
  method: Method,
  key: string,
  p: { query?: Record<string, string>; headers?: Record<string, string>; body?: string; ok?: number[] } = {},
): Promise<Response> {
  const t = objectTarget(cfg, key)
  const query = p.query ?? {}
  const body = p.body ?? ''
  const headers = signHeaders(cfg, {
    method,
    host: t.host,
    path: t.path,
    query,
    headers: p.headers,
    date: amzDate(Date.now()),
    payloadHash: sha256Hex(body),
  })
  const qs = canonicalQuery(query)
  const res = await fetch(`${t.origin}${t.path}${qs ? `?${qs}` : ''}`, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
  })
  if (res.ok || p.ok?.includes(res.status)) return res
  const text = method === 'HEAD' ? '' : await res.text().catch(() => '')
  throw s3Error(op, key, res.status, text)
}

/** A failed R2 request: HTTP status and S3 error code (e.g. NoSuchUpload). */
export class R2Error extends Error {
  readonly status: number
  readonly code: string | null
  constructor(message: string, status: number, code: string | null) {
    super(message)
    this.status = status
    this.code = code
  }
  /** Worth trying again (R2 overloaded or briefly failing). */
  get retryable(): boolean {
    return this.status >= 500 || this.status === 429
  }
}

function s3Error(op: string, key: string, status: number, xml: string): R2Error {
  const code = xmlOne(xml, 'Code')
  const message = xmlOne(xml, 'Message')
  return new R2Error(`R2 ${op} failed for ${key || '(bucket)'}: HTTP ${status}${code ? ` ${code}` : ''}${message ? ` (${message})` : ''}`, status, code)
}

/** Starts a multipart upload; the object gets Content-Type, Cache-Control and Content-Encoding. Returns the UploadId. */
export async function createMultipart(
  cfg: R2Config,
  key: string,
  p: { contentType: string; contentEncoding?: string },
): Promise<string> {
  const res = await s3(cfg, 'CreateMultipartUpload', 'POST', key, { query: { uploads: '' }, headers: objectHeaders(p) })
  const id = xmlOne(await res.text(), 'UploadId')
  if (!id) throw new Error(`R2 CreateMultipartUpload failed for ${key}: no UploadId in the response`)
  return id
}

export async function listParts(
  cfg: R2Config,
  key: string,
  uploadId: string,
): Promise<{ partNumber: number; etag: string; size: number }[]> {
  const parts: { partNumber: number; etag: string; size: number }[] = []
  let marker: string | null = null
  for (;;) {
    const query: Record<string, string> = { uploadId }
    if (marker) query['part-number-marker'] = marker
    const xml = await (await s3(cfg, 'ListParts', 'GET', key, { query })).text()
    for (const part of xmlAll(xml, 'Part')) {
      parts.push({
        partNumber: Number(xmlOne(part, 'PartNumber')),
        etag: xmlOne(part, 'ETag') ?? '',
        size: Number(xmlOne(part, 'Size')),
      })
    }
    marker = xmlOne(xml, 'NextPartNumberMarker')
    if (xmlOne(xml, 'IsTruncated') !== 'true' || !marker) return parts
  }
}

export async function completeMultipart(
  cfg: R2Config,
  key: string,
  uploadId: string,
  parts: { partNumber: number; etag: string }[],
): Promise<void> {
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber)
  const body = `<CompleteMultipartUpload>${sorted
    .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${xmlEncode(p.etag)}</ETag></Part>`)
    .join('')}</CompleteMultipartUpload>`
  const res = await s3(cfg, 'CompleteMultipartUpload', 'POST', key, {
    query: { uploadId },
    headers: { 'content-type': 'application/xml' },
    body,
  })
  // S3 can answer 200 and still put an <Error> in the body.
  const xml = await res.text()
  if (/<Error>/.test(xml)) throw s3Error('CompleteMultipartUpload', key, res.status, xml)
}

/** Aborts a multipart upload; an upload that's already gone (404) is fine. */
export async function abortMultipart(cfg: R2Config, key: string, uploadId: string): Promise<void> {
  await s3(cfg, 'AbortMultipartUpload', 'DELETE', key, { query: { uploadId }, ok: [404] })
}

/** Size and ETag of an object, or null when it doesn't exist. */
export async function headObject(cfg: R2Config, key: string): Promise<{ bytes: number; etag: string | null } | null> {
  const res = await s3(cfg, 'HeadObject', 'HEAD', key, { ok: [404] })
  if (res.status === 404) return null
  const etag = res.headers.get('etag')
  const length = res.headers.get('content-length')
  // R2 leaves out Content-Length (or could transform) for content-encoded objects; the listing has the stored size.
  if (length === null || res.headers.get('content-encoding')) {
    const listed = await listedSize(cfg, key)
    return listed === null ? null : { bytes: listed, etag }
  }
  return { bytes: Number(length), etag }
}

/** The stored size of one object from ListObjectsV2, or null if it isn't there. */
export async function listedSize(cfg: R2Config, key: string): Promise<number | null> {
  const xml = await (await s3(cfg, 'ListObjectsV2', 'GET', '', { query: { 'list-type': '2', prefix: key, 'max-keys': '1000' } })).text()
  for (const item of xmlAll(xml, 'Contents')) if (xmlOne(item, 'Key') === key) return Number(xmlOne(item, 'Size'))
  return null
}

export async function deleteObject(cfg: R2Config, key: string): Promise<void> {
  await s3(cfg, 'DeleteObject', 'DELETE', key, { ok: [404] })
}

/** Every key under `prefix` (ListObjectsV2, paginated). */
export async function listKeys(cfg: R2Config, prefix: string): Promise<string[]> {
  const keys: string[] = []
  let token: string | null = null
  for (;;) {
    const query: Record<string, string> = { 'list-type': '2', prefix }
    if (token) query['continuation-token'] = token
    const xml = await (await s3(cfg, 'ListObjectsV2', 'GET', '', { query })).text()
    for (const item of xmlAll(xml, 'Contents')) {
      const k = xmlOne(item, 'Key')
      if (k !== null) keys.push(k)
    }
    token = xmlOne(xml, 'NextContinuationToken')
    if (xmlOne(xml, 'IsTruncated') !== 'true' || !token) return keys
  }
}

/** Deletes every object under `prefix` (one DeleteObject each, 8 at a time); returns how many. */
export async function deletePrefix(cfg: R2Config, prefix: string): Promise<number> {
  if (!prefix) throw new Error('deletePrefix needs a non-empty prefix.')
  const keys = await listKeys(cfg, prefix)
  for (let i = 0; i < keys.length; i += 8) {
    await Promise.all(keys.slice(i, i + 8).map((k) => deleteObject(cfg, k)))
  }
  return keys.length
}
