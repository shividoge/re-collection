// Tests for lib/r2.ts. The unit tests need no network.
//
// The end-to-end block runs only when R2_TEST_ENDPOINT is set, against any S3 server
// that verifies SigV4 (versitygw, MinIO, or a real R2 dev bucket):
//   R2_TEST_ENDPOINT           e.g. http://127.0.0.1:5191
//   R2_TEST_ACCESS_KEY_ID      access key
//   R2_TEST_SECRET_ACCESS_KEY  secret key
//   R2_TEST_BUCKET             bucket (created if missing; default braindance-test)
//   R2_TEST_REGION             region (default us-east-1; use auto for R2)
import { ConvexError } from 'convex/values'
import { beforeAll, describe, expect, test } from 'vitest'
import {
  CACHE_CONTROL,
  PART_SIZE,
  type R2Config,
  abortMultipart,
  canonicalRequest,
  completeMultipart,
  createMultipart,
  credentialScope,
  deleteObject,
  deletePrefix,
  encodeKey,
  headObject,
  hmacSha256,
  listKeys,
  listParts,
  partCount,
  partUrl,
  presign,
  presignQuery,
  putTarget,
  r2Config,
  r2ConfigOrNull,
  sha256Hex,
  signHeaders,
  stableGetUrl,
  stringToSign,
  toHex,
  uriEncode,
} from './r2'

const hex = (s: string) => new Uint8Array(s.match(/../g)!.map((b) => parseInt(b, 16)))
const fill = (n: number, b: number) => new Uint8Array(n).fill(b)

describe('sha256', () => {
  test('NIST vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
    expect(
      sha256Hex(
        'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
      ),
    ).toBe('cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1')
  })

  test('a million a', () => {
    expect(sha256Hex(fill(1000000, 0x61))).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0')
  })

  test('strings are UTF-8', () => {
    expect(sha256Hex('ü')).toBe(sha256Hex(new Uint8Array([0xc3, 0xbc])))
  })
})

describe('hmacSha256 (RFC 4231)', () => {
  test('case 1', () => {
    expect(toHex(hmacSha256(fill(20, 0x0b), 'Hi There'))).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    )
  })
  test('case 2', () => {
    expect(toHex(hmacSha256('Jefe', 'what do ya want for nothing?'))).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    )
  })
  test('case 6 (key longer than a block)', () => {
    expect(toHex(hmacSha256(fill(131, 0xaa), 'Test Using Larger Than Block-Size Key - Hash Key First'))).toBe(
      '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54',
    )
  })
})

// AWS docs, "Authenticating Requests: Using Query Parameters" and "Examples of signature calculations".
const aws = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
}
const awsDate = '20130524T000000Z'
const awsHost = 'examplebucket.s3.amazonaws.com'

describe('SigV4 (AWS published vectors)', () => {
  test('presigned GET', () => {
    const qs = presignQuery(aws, { method: 'GET', host: awsHost, path: '/test.txt', date: awsDate, expiresSec: 86400 })
    expect(qs).toBe(
      'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
        '&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host' +
        '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    )
  })

  test('presigned GET string to sign', () => {
    const creq = canonicalRequest(
      'GET',
      '/test.txt',
      {
        'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
        'X-Amz-Credential': `${aws.accessKeyId}/20130524/us-east-1/s3/aws4_request`,
        'X-Amz-Date': awsDate,
        'X-Amz-Expires': '86400',
        'X-Amz-SignedHeaders': 'host',
      },
      { host: awsHost },
      'UNSIGNED-PAYLOAD',
    )
    expect(stringToSign(awsDate, credentialScope(awsDate, 'us-east-1'), creq)).toBe(
      'AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/us-east-1/s3/aws4_request\n' +
        '3bfa292879f6447bbcda7001decf97f4a54dc650c8942174ae0a9121cf58ad04',
    )
  })

  test('header-signed GET with Range', () => {
    const empty = sha256Hex('')
    const h = signHeaders(aws, {
      method: 'GET',
      host: awsHost,
      path: '/test.txt',
      headers: { Range: 'bytes=0-9' },
      date: awsDate,
      payloadHash: empty,
    })
    expect(h.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    )
    expect(h['x-amz-date']).toBe(awsDate)
    expect(h['x-amz-content-sha256']).toBe(empty)
    const creq = canonicalRequest('GET', '/test.txt', {}, { host: awsHost, range: 'bytes=0-9', 'x-amz-content-sha256': empty, 'x-amz-date': awsDate }, empty)
    expect(sha256Hex(creq)).toBe('7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972')
  })
})

describe('encoding', () => {
  test('RFC 3986', () => {
    expect(uriEncode("a b+c/d!'()*~._-")).toBe('a%20b%2Bc%2Fd%21%27%28%29%2A~._-')
    expect(encodeKey('captures/a b/ü+k0001.jpg')).toBe('captures/a%20b/%C3%BC%2Bk0001.jpg')
  })
})

const cfg: R2Config = {
  ...aws,
  bucket: 'braindance-dev',
  endpoint: 'https://acct.r2.cloudflarestorage.com',
  region: 'auto',
}
const noon = Date.UTC(2026, 9, 24, 12, 0, 0)

describe('presigned URLs', () => {
  test('presign is path style with sorted query', () => {
    const url = presign(cfg, { method: 'GET', key: 'captures/c1/raw/room.bin', expiresSec: 60, now: noon, query: { b: '2', a: '1' } })
    expect(url.startsWith('https://acct.r2.cloudflarestorage.com/braindance-dev/captures/c1/raw/room.bin?X-Amz-Algorithm=')).toBe(true)
    expect(url).toContain('X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20261024%2Fauto%2Fs3%2Faws4_request')
    expect(url).toMatch(/&a=1&b=2&X-Amz-Signature=[0-9a-f]{64}$/)
  })

  test('stableGetUrl is identical all UTC day and changes with day and rev', () => {
    const key = 'captures/c1/derived/points.pack'
    const start = Date.UTC(2026, 9, 24, 0, 0, 0)
    const a = stableGetUrl(cfg, key, 3, start)
    expect(stableGetUrl(cfg, key, 3, noon)).toBe(a)
    expect(stableGetUrl(cfg, key, 3, start + 86399999)).toBe(a)
    expect(stableGetUrl(cfg, key, 3, start + 86400000)).not.toBe(a)
    expect(stableGetUrl(cfg, key, 4, noon)).not.toBe(a)
    expect(a).toContain('X-Amz-Expires=604800')
    expect(a).toContain('X-Amz-Date=20261024T000000Z')
    expect(a).toContain('&x-id=3&')
  })

  test('putTarget signs the headers it returns', () => {
    const t = putTarget(cfg, 'captures/c1/derived/surface.pack', { contentType: 'application/octet-stream', contentEncoding: 'gzip', now: noon })
    expect(t.headers).toEqual({ 'Content-Type': 'application/octet-stream', 'Cache-Control': CACHE_CONTROL, 'Content-Encoding': 'gzip' })
    expect(t.url).toContain('X-Amz-SignedHeaders=cache-control%3Bcontent-encoding%3Bcontent-type%3Bhost')
    expect(t.url).toContain('X-Amz-Expires=3600')
    const plain = putTarget(cfg, 'k', { contentType: 'image/jpeg', now: noon })
    expect(Object.keys(plain.headers)).toEqual(['Content-Type', 'Cache-Control'])
  })

  test('partUrl', () => {
    const url = partUrl(cfg, 'videos/c1/source.mp4', 'up/id=1', 2, noon)
    expect(url).toContain('&partNumber=2&uploadId=up%2Fid%3D1&')
    expect(url).toContain('X-Amz-Expires=3600')
    expect(() => partUrl(cfg, 'k', 'u', 0, noon)).toThrow()
  })
})

describe('r2Config', () => {
  test('missing vars are named', () => {
    expect(() => r2Config({})).toThrow(ConvexError)
    expect(() => r2Config({})).toThrow(
      "R2 isn't configured: set R2_ACCOUNT_ID (or R2_ENDPOINT), R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET.",
    )
    expect(() => r2Config({ R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'k', R2_BUCKET: 'b' })).toThrow(
      "R2 isn't configured: set R2_SECRET_ACCESS_KEY.",
    )
    expect(r2ConfigOrNull({ R2_ACCOUNT_ID: 'a' })).toBeNull()
  })

  test('endpoint derivation and region', () => {
    const base = { R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: 'b' }
    expect(r2Config({ ...base, R2_ACCOUNT_ID: 'abc' })).toEqual({
      accessKeyId: 'k',
      secretAccessKey: 's',
      bucket: 'b',
      endpoint: 'https://abc.r2.cloudflarestorage.com',
      region: 'auto',
    })
    const c = r2Config({ ...base, R2_ACCOUNT_ID: 'abc', R2_ENDPOINT: 'http://127.0.0.1:5191/', R2_REGION: 'us-east-1' })
    expect(c.endpoint).toBe('http://127.0.0.1:5191')
    expect(c.region).toBe('us-east-1')
  })
})

describe('partCount', () => {
  test('edges', () => {
    expect(partCount(0)).toBe(1)
    expect(partCount(1)).toBe(1)
    expect(partCount(PART_SIZE)).toBe(1)
    expect(partCount(PART_SIZE + 1)).toBe(2)
    expect(partCount(10, 3)).toBe(4)
    expect(() => partCount(-1)).toThrow()
    expect(() => partCount(Number.NaN)).toThrow()
    expect(() => partCount(10, 0)).toThrow()
    expect(() => partCount(PART_SIZE * 10001)).toThrow()
  })
})

// ---------- End to end against a real S3 server ----------

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}

describe.skipIf(!env.R2_TEST_ENDPOINT)('end to end (S3 server)', () => {
  const s3: R2Config = {
    endpoint: (env.R2_TEST_ENDPOINT ?? '').replace(/\/+$/, ''),
    accessKeyId: env.R2_TEST_ACCESS_KEY_ID ?? '',
    secretAccessKey: env.R2_TEST_SECRET_ACCESS_KEY ?? '',
    bucket: env.R2_TEST_BUCKET ?? 'braindance-test',
    region: env.R2_TEST_REGION ?? 'us-east-1',
  }
  const prefix = `e2e-${Date.now()}/`
  const now = () => Date.now()

  beforeAll(async () => {
    const res = await fetch(presign(s3, { method: 'PUT', key: '', expiresSec: 60, now: now() }), { method: 'PUT' })
    if (!res.ok && res.status !== 409) throw new Error(`create bucket: HTTP ${res.status} ${await res.text()}`)
  })

  async function put(key: string, body: string | Uint8Array<ArrayBuffer>, contentType = 'text/plain') {
    const t = putTarget(s3, key, { contentType, now: now() })
    const res = await fetch(t.url, { method: 'PUT', headers: t.headers, body })
    expect(res.status).toBe(200)
  }

  test('presigned PUT then stable GET', async () => {
    const key = `${prefix}raw/hello world.txt`
    await put(key, 'hello braindance')
    const res = await fetch(stableGetUrl(s3, key, 1, now()))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hello braindance')
    expect(res.headers.get('cache-control')).toBe(CACHE_CONTROL)
    expect(res.headers.get('content-type')).toBe('text/plain')
    expect((await headObject(s3, key))?.bytes).toBe(16)
  })

  test('PUT without the signed headers is rejected', async () => {
    const t = putTarget(s3, `${prefix}raw/x.txt`, { contentType: 'text/plain', now: now() })
    const res = await fetch(t.url, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'x' })
    expect(res.status).toBe(403)
  })

  test('a tampered signature is rejected', async () => {
    const key = `${prefix}raw/tamper.txt`
    await put(key, 'secret')
    const url = stableGetUrl(s3, key, 1, now())
    const bad = url.slice(0, -1) + (url.endsWith('0') ? '1' : '0')
    expect((await fetch(bad)).status).toBe(403)
    const otherRev = url.replace('x-id=1', 'x-id=2')
    expect((await fetch(otherRev)).status).toBe(403)
  })

  test('header-signed requests with the wrong secret are rejected', async () => {
    const wrong = { ...s3, secretAccessKey: `${s3.secretAccessKey}x` }
    await expect(listKeys(wrong, prefix)).rejects.toThrow(/HTTP 403/)
  })

  test('multipart: create, two parts, list, complete, head, get', async () => {
    const key = `${prefix}raw/video.mp4`
    const id = await createMultipart(s3, key, { contentType: 'video/mp4' })
    const p1 = new Uint8Array(5 * 1024 * 1024).map((_, i) => i % 251)
    const p2 = fill(1000, 7)
    const etags: { partNumber: number; etag: string }[] = []
    for (const [i, body] of [p1, p2].entries()) {
      const res = await fetch(partUrl(s3, key, id, i + 1, now()), { method: 'PUT', body })
      expect(res.status).toBe(200)
      etags.push({ partNumber: i + 1, etag: res.headers.get('etag') ?? '' })
    }
    const listed = await listParts(s3, key, id)
    expect(listed.map((p) => [p.partNumber, p.size])).toEqual([[1, p1.length], [2, 1000]])
    expect(listed.map((p) => p.etag)).toEqual(etags.map((p) => p.etag))
    await completeMultipart(s3, key, id, [...etags].reverse())
    expect((await headObject(s3, key))?.bytes).toBe(p1.length + p2.length)
    const res = await fetch(stableGetUrl(s3, key, 1, now()))
    const got = new Uint8Array(await res.arrayBuffer())
    expect(got.length).toBe(p1.length + p2.length)
    expect(got[12345]).toBe(12345 % 251)
    expect(got[got.length - 1]).toBe(7)
    expect(res.headers.get('cache-control')).toBe(CACHE_CONTROL)
    expect(res.headers.get('content-type')).toBe('video/mp4')
  })

  test('multipart sets Content-Encoding', async () => {
    const key = `${prefix}derived/points.pack`
    const id = await createMultipart(s3, key, { contentType: 'application/octet-stream', contentEncoding: 'gzip' })
    const res = await fetch(partUrl(s3, key, id, 1, now()), { method: 'PUT', body: fill(10, 1) })
    await completeMultipart(s3, key, id, [{ partNumber: 1, etag: res.headers.get('etag') ?? '' }])
    const head = await fetch(presign(s3, { method: 'HEAD', key, expiresSec: 60, now: now() }), { method: 'HEAD' })
    expect(head.headers.get('content-encoding')).toBe('gzip')
    expect(head.headers.get('cache-control')).toBe(CACHE_CONTROL)
  })

  test('complete with a bad ETag fails with the S3 code', async () => {
    const key = `${prefix}raw/bad.bin`
    const id = await createMultipart(s3, key, { contentType: 'application/octet-stream' })
    await fetch(partUrl(s3, key, id, 1, now()), { method: 'PUT', body: fill(10, 1) })
    await expect(completeMultipart(s3, key, id, [{ partNumber: 1, etag: '"0000"' }])).rejects.toThrow(/CompleteMultipartUpload failed .*HTTP \d+ \w+/)
    await abortMultipart(s3, key, id)
  })

  test('abort', async () => {
    const key = `${prefix}raw/aborted.bin`
    const id = await createMultipart(s3, key, { contentType: 'application/octet-stream' })
    await fetch(partUrl(s3, key, id, 1, now()), { method: 'PUT', body: fill(10, 1) })
    await abortMultipart(s3, key, id)
    await expect(listParts(s3, key, id)).rejects.toThrow(/NoSuchUpload/)
    await abortMultipart(s3, key, id) // already gone is fine
    expect(await headObject(s3, key)).toBeNull()
  })

  test('delete', async () => {
    const key = `${prefix}raw/gone.txt`
    await put(key, 'bye')
    await deleteObject(s3, key)
    expect(await headObject(s3, key)).toBeNull()
    await deleteObject(s3, key) // missing is fine
  })

  test('listKeys and deletePrefix', async () => {
    const sub = `${prefix}list/`
    const keys = [`${sub}a.txt`, `${sub}b c.txt`, `${sub}k/ü.jpg`]
    for (const k of keys) await put(k, k)
    expect((await listKeys(s3, sub)).sort()).toEqual([...keys].sort())
    expect(await deletePrefix(s3, sub)).toBe(3)
    expect(await listKeys(s3, sub)).toEqual([])
  })

  test('cleanup', async () => {
    await deletePrefix(s3, prefix)
    expect(await listKeys(s3, prefix)).toEqual([])
  })
})
