import { describe, expect, it } from 'vitest'
import { assetsKey, resolveFiles, resolveFrom, staticPaths, toCaptureAssets, type AssetsSource } from '../src/data/captureAssets'
import type { CaptureStatus } from '../src/data/types'

const ID = '0b5e3a3c-1d2e-4f50-9a6b-7c8d9e0f1a2b'
const manifest = {
  format: 'braindance.capture',
  id: ID.toUpperCase(),
  createdAt: '2026-10-24T18:00:00Z',
  title: 'Sunday',
  attendees: ['Priya'],
  video: { file: 'video.mp4', width: 1920, height: 1440, fps: 30, durationSec: 12, frameCount: 360 },
  depth: { encoding: 'v2', file: 'depth.bin', index: 'depth.index.json', width: 256, height: 192, rateHz: 10, count: 120 },
}
const status: CaptureStatus = {
  source: 'phone', upload: 'done', uploadErrors: [], warnings: [], convert: 'skipped', facts: 'running', bake: 'running', splat: 'skipped',
  errors: {}, progress: { stage: 'surface', fraction: 0.4, message: 'Building the room' }, updatedAt: 1,
}
const source = (over: Partial<AssetsSource> = {}): AssetsSource => ({
  id: ID,
  manifestJson: JSON.stringify(manifest),
  files: [
    { name: 'video.mp4', url: 'https://r2/raw/video.mp4?x-id=1', bytes: 10, rev: 1 },
    { name: 'keyframes/k0003.jpg', url: 'https://r2/raw/keyframes/k0003.jpg?x-id=1', bytes: 5, rev: 1 },
  ],
  derived: null,
  derivedFiles: [],
  status,
  ...over,
})

describe('CaptureAssets mapping', () => {
  it('parses the manifest and maps file names to their URLs', () => {
    const a = toCaptureAssets(source())
    expect(a.manifest.id).toBe(ID)
    expect(a.manifest.warnings).toEqual([])
    expect(a.rawUrl('video.mp4')).toBe('https://r2/raw/video.mp4?x-id=1')
    expect(a.rawUrl('keyframes/k0003.jpg')).toContain('k0003')
    expect(a.rawUrl('/keyframes/k0003.jpg')).toContain('k0003')
    expect(a.rawUrl('room.bin')).toBeNull()
    expect(a.derivedUrl('points.pack')).toBeNull()
    expect(a.status?.bake).toBe('running')
  })

  it('maps derived files by their name in derived.files', () => {
    const derived = {
      format: 'braindance.derived' as const, version: 1, captureId: ID, bakedAt: 'x', bakeVersion: '1',
      files: { points: 'points.pack', depth: 'depth.bin', depthIndex: 'depth.index.json' }, stats: { points: 9, bakeMs: 1 },
    }
    const a = toCaptureAssets(source({ derived, derivedFiles: [{ name: 'points.pack', url: 'https://r2/derived/points.pack', bytes: 9, rev: 2 }] }))
    expect(a.derived?.files.points).toBe('points.pack')
    expect(a.derivedUrl(a.derived!.files.points)).toBe('https://r2/derived/points.pack')
  })

  it('has no status on the public site', () => {
    expect(toCaptureAssets(source({ status: undefined })).status).toBeNull()
  })

  it('throws a plain message for a broken manifest', () => {
    expect(() => toCaptureAssets(source({ manifestJson: '{' }))).toThrow(/isn't valid JSON/)
  })

  it('keeps the same key through status ticks and re-signed URLs, and changes it for a new rev or a bake', () => {
    const base = assetsKey(source())
    expect(assetsKey(source({ status: { ...status, progress: { stage: 'surface', fraction: 0.9, message: '' } } }))).toBe(base)
    expect(assetsKey(source({ files: source().files.map((f) => ({ ...f, url: f.url + '&day=2' })) }))).toBe(base)
    expect(assetsKey(source({ files: source().files.map((f, i) => (i === 0 ? { ...f, rev: 2 } : f)) }))).not.toBe(base)
    expect(assetsKey(source({ derivedFiles: [{ name: 'points.pack', url: 'u', bytes: 1, rev: 1 }] }))).not.toBe(base)
  })
})

describe('static site URLs', () => {
  const site = 'https://shividoge.github.io/braindance-site/'
  it('lays files out as the export writes them', () => {
    expect(staticPaths.captures()).toBe('data/captures.json')
    expect(staticPaths.capture(ID)).toBe(`data/captures/${ID}.json`)
    expect(staticPaths.moment(ID)).toBe(`data/moments/${ID}.json`)
    expect(staticPaths.progress(ID)).toBe(`data/progress/${ID}.json`)
    expect(staticPaths.session('s1')).toBe('data/sessions/s1.json')
    expect(staticPaths.arrangement()).toBe('data/museum/arrangement.json')
  })

  it('resolves file URLs against the JSON file they are in, under any sub-path', () => {
    const json = `${site}data/captures/${ID}.json`
    expect(resolveFrom(json, `../files/${ID}/video.mp4`)).toBe(`${site}data/files/${ID}/video.mp4`)
    expect(resolveFrom(`${site}data/captures.json`, `files/${ID}/thumb.jpg`)).toBe(`${site}data/files/${ID}/thumb.jpg`)
    const [k] = resolveFiles([{ name: 'keyframes/k0001.jpg', url: `../files/${ID}/keyframes/k0001.jpg`, bytes: 1, rev: 0 }], json)
    expect(k.url).toBe(`${site}data/files/${ID}/keyframes/k0001.jpg`)
    expect(resolveFrom(json, 'https://elsewhere/x.jpg')).toBe('https://elsewhere/x.jpg')
  })
})
