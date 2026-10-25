import { describe, expect, it } from 'vitest'
import type { UploadTarget } from '../src/data/types'
import {
  alreadyThere,
  backoffMs,
  contentType,
  findResumable,
  mergeParts,
  partCount,
  partRange,
  pendingParts,
  pool,
  skipFile,
  uploadOrder,
  type SavedUpload,
} from '../src/data/uploadPlan'
import { RESUMES, uploadFile, type UploadDeps } from '../src/upload'

describe('upload plan', () => {
  it('sends what facts need first, then the room, then video and depth', () => {
    const names = ['depth.bin', 'video.mp4', 'frames.jsonl', 'keyframes/k0001.jpg', 'room.bin', 'transcript.json', 'thumb.jpg', 'keyframes/k0000.jpg', 'manifest.json', 'depth.index.json', 'room.spz']
    expect(uploadOrder(names.map((name) => ({ name }))).map((f) => f.name)).toEqual([
      'manifest.json', 'thumb.jpg', 'transcript.json', 'keyframes/k0000.jpg', 'keyframes/k0001.jpg', 'room.bin', 'frames.jsonl', 'room.spz', 'video.mp4', 'depth.bin', 'depth.index.json',
    ])
  })

  it('skips macOS junk, room.ply and the old guide files', () => {
    for (const junk of ['._video.mp4', 'keyframes/._k0001.jpg', '__MACOSX/x/manifest.json', '.DS_Store', 'room.ply', 'status.json', 'moment.json', 'keyframes/'])
      expect(skipFile(junk), junk).toBe(true)
    for (const ok of ['manifest.json', 'room.bin', 'keyframes/k0001.jpg', 'depth.index.json']) expect(skipFile(ok), ok).toBe(false)
  })

  it('splits a file into parts with a short last part', () => {
    expect(partCount(25, 10)).toBe(3)
    expect(partCount(0, 10)).toBe(1)
    expect(partRange(1, 10, 25)).toEqual({ start: 0, end: 10 })
    expect(partRange(3, 10, 25)).toEqual({ start: 20, end: 25 })
  })

  it('lists only the parts still to send, and merges done parts in order without duplicates', () => {
    const target: UploadTarget = { uploadId: 'u', key: 'k', partSize: 10, parts: [1, 2, 3].map((n) => ({ partNumber: n, url: `p${n}` })) }
    expect(pendingParts(target, 25, [{ partNumber: 2, etag: 'b' }])).toEqual([
      { partNumber: 1, url: 'p1', start: 0, end: 10 },
      { partNumber: 3, url: 'p3', start: 20, end: 25 },
    ])
    expect(mergeParts([{ partNumber: 3, etag: 'c' }, { partNumber: 1, etag: 'a' }], [{ partNumber: 1, etag: 'a2' }])).toEqual([
      { partNumber: 1, etag: 'a2' },
      { partNumber: 3, etag: 'c' },
    ])
  })

  it('finds the newest saved upload of the same file, and files the server already has', () => {
    const saved: SavedUpload[] = [
      { uploadId: 'old', captureId: 'c', name: 'video.mp4', bytes: 9, parts: [], updatedAt: 1 },
      { uploadId: 'new', captureId: 'c', name: 'video.mp4', bytes: 9, parts: [], updatedAt: 2 },
      { uploadId: 'other', captureId: 'c', name: 'video.mp4', bytes: 8, parts: [], updatedAt: 3 },
    ]
    expect(findResumable(saved, 'c', 'video.mp4', 9)?.uploadId).toBe('new')
    expect(findResumable(saved, 'd', 'video.mp4', 9)).toBeNull()
    expect(alreadyThere([{ name: 'room.bin', bytes: 5 }], 'room.bin', 5)).toBe(true)
    expect(alreadyThere([{ name: 'room.bin', bytes: 5 }], 'room.bin', 6)).toBe(false)
  })

  it('backs off and names content types', () => {
    expect([1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([500, 1000, 2000, 4000, 8000, 8000])
    expect(contentType('manifest.json')).toBe('application/json')
    expect(contentType('keyframes/k0001.jpg')).toBe('image/jpeg')
    expect(contentType('source.MOV')).toBe('video/quicktime')
    expect(contentType('depth.bin')).toBe('application/octet-stream')
  })

  it('pool keeps at most `limit` running and stops on a failure', async () => {
    let running = 0
    let peak = 0
    await pool([1, 2, 3, 4, 5, 6], 3, async () => {
      peak = Math.max(peak, ++running)
      await new Promise((r) => setTimeout(r, 1))
      running--
    })
    expect(peak).toBe(3)
    await expect(pool([1, 2], 2, async (n) => { if (n === 2) throw new Error('no') })).rejects.toThrow('no')
  })
})

/** A storage + Convex double: part URLs fail while `broken` holds them, and resume reissues URLs. */
function fakes({ bytes = 25, partSize = 10, broken = new Set<string>(), saved = [] as SavedUpload[] } = {}) {
  const puts: string[] = []
  const finished: { uploadId: string; parts?: { partNumber: number; etag: string }[] }[] = []
  const store = new Map(saved.map((s) => [s.uploadId, s]))
  let round = 0
  const target = (): UploadTarget => ({
    uploadId: 'up1',
    key: 'captures/c/raw/video.mp4',
    partSize,
    parts: Array.from({ length: Math.ceil(bytes / partSize) }, (_, i) => ({ partNumber: i + 1, url: `r${round}-p${i + 1}` })),
  })
  const deps: UploadDeps = {
    api: {
      start: async () => target(),
      resume: async () => {
        round++
        return { target: target(), done: [] }
      },
      finish: async (uploadId, parts) => {
        finished.push({ uploadId, parts })
        return { ok: true, bytes }
      },
    },
    put: async (url, body) => {
      if (broken.has(url)) throw new Error('network')
      puts.push(`${url}:${body.size}`)
      return `etag-${url.split('-p')[1]}`
    },
    saved: {
      all: async () => [...store.values()],
      put: async (u) => void store.set(u.uploadId, { ...u, parts: [...u.parts] }),
      remove: async (id) => void store.delete(id),
    },
    sleep: async () => {},
  }
  return { deps, puts, finished, store }
}

const blob = (n: number) => new Blob([new Uint8Array(n)])

describe('uploadFile', () => {
  it('sends every part, finishes with the ETags in order, and forgets the saved upload', async () => {
    const { deps, puts, finished, store } = fakes()
    const seen: number[] = []
    await uploadFile(deps, { captureId: 'c', name: 'video.mp4', body: blob(25) }, (n) => seen.push(n))
    expect(puts.sort()).toEqual(['r0-p1:10', 'r0-p2:10', 'r0-p3:5'])
    expect(finished[0].parts).toEqual([1, 2, 3].map((n) => ({ partNumber: n, etag: `etag-${n}` })))
    expect(seen.at(-1)).toBe(25)
    expect(store.size).toBe(0)
  })

  it('gets fresh URLs after a part keeps failing, and sends only what is left', async () => {
    const { deps, puts, finished } = fakes({ broken: new Set(['r0-p2']) })
    await uploadFile(deps, { captureId: 'c', name: 'video.mp4', body: blob(25) }, () => {})
    expect(puts.filter((p) => p.startsWith('r1'))).toEqual(['r1-p2:10'])
    expect(finished[0].parts?.map((p) => p.partNumber)).toEqual([1, 2, 3])
  })

  it('resumes a saved upload after a reload without resending finished parts', async () => {
    const saved: SavedUpload = { uploadId: 'up1', captureId: 'c', name: 'video.mp4', bytes: 25, parts: [{ partNumber: 1, etag: 'etag-1' }], updatedAt: 1 }
    const { deps, puts, finished } = fakes({ saved: [saved] })
    await uploadFile(deps, { captureId: 'c', name: 'video.mp4', body: blob(25) }, () => {})
    expect(puts.sort()).toEqual(['r1-p2:10', 'r1-p3:5'])
    expect(finished[0].parts?.map((p) => p.partNumber)).toEqual([1, 2, 3])
  })

  it('gives up after a few rounds of fresh URLs, keeping the saved upload for next time', async () => {
    const all = new Set(Array.from({ length: RESUMES + 1 }, (_, r) => `r${r}-p3`))
    const { deps, finished, store } = fakes({ broken: all })
    await expect(uploadFile(deps, { captureId: 'c', name: 'video.mp4', body: blob(25) }, () => {})).rejects.toThrow('network')
    expect(finished).toHaveLength(0)
    expect(store.get('up1')?.parts.map((p) => p.partNumber).sort()).toEqual([1, 2])
  })

  it('uses one PUT for a small file', async () => {
    const { deps, puts, finished } = fakes()
    deps.api.start = async () => ({ uploadId: 's1', key: 'k', single: { url: 'single', headers: { 'Content-Type': 'image/jpeg' } } })
    await uploadFile(deps, { captureId: 'c', name: 'thumb.jpg', body: blob(7) }, () => {})
    expect(puts).toEqual(['single:7'])
    expect(finished).toEqual([{ uploadId: 's1', parts: undefined }])
  })
})
