// Package checks from registered file sizes (ported from guide/test/validate.test.mjs where the
// check doesn't need the bytes), the facts trigger, and job routing.
import { describe, expect, test } from 'vitest'
import { parseManifest, type Manifest } from '../../../shared/manifest'
import { canRun, tokenMatches } from './jobs'
import { convertFrames, factsInputsReady, readDepthIndex, validatePackage, type RegisteredFile } from './validate'

export const CAPTURE_ID = '11111111-2222-4333-8444-555555555555'

/** The guide's tinyCapture manifest: 2 room points, 3 moment frames, 2 depth frames of 4x3. */
export function tinyManifest(id = CAPTURE_ID): Manifest {
  return parseManifest(JSON.stringify({
    format: 'braindance.capture',
    version: 1,
    id,
    createdAt: '2026-10-24T13:34:58Z',
    device: 'test',
    title: 'Test visit',
    attendees: [],
    video: { file: 'video.mov', width: 1920, height: 1440, fps: 30, durationSec: 0.1, frameCount: 3 },
    depth: { file: 'depth.bin', confidenceFile: 'confidence.bin', width: 4, height: 3, unit: 'mm', rateHz: 10, count: 2 },
    room: { ply: 'room.ply', bin: 'room.bin', points: 2, voxelMeters: 0.01, source: 'on-device' },
    warnings: [],
  }))
}

export function tinyFiles(): RegisteredFile[] {
  return [
    { name: 'manifest.json', bytes: 600 },
    { name: 'room.bin', bytes: 4 + 2 * 15 },
    { name: 'room.ply', bytes: 40 },
    { name: 'video.mov', bytes: 55 },
    { name: 'frames.jsonl', bytes: 400 },
    { name: 'depth.bin', bytes: 2 * 4 * 3 * 2 },
    { name: 'confidence.bin', bytes: 2 * 4 * 3 },
    { name: 'thumb.jpg', bytes: 4 },
  ]
}

const errorsOf = (m: Manifest, files: RegisteredFile[]) => validatePackage(CAPTURE_ID, m, files).errors.join(' ')

describe('package checks', () => {
  test('a complete capture passes, with warnings for what is missing', () => {
    const result = validatePackage(CAPTURE_ID, tinyManifest(), tinyFiles())
    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.warnings).toEqual(['No transcript: facts can only come from what the keyframes show.'])
  })

  test('depth.bin with the wrong size is caught with the expected size', () => {
    const files = tinyFiles().map((f) => (f.name === 'depth.bin' ? { ...f, bytes: 10 } : f))
    expect(errorsOf(tinyManifest(), files)).toMatch(/depth\.bin is 10 bytes, but the manifest implies 48/)
  })

  test('a missing video is named', () => {
    expect(errorsOf(tinyManifest(), tinyFiles().filter((f) => f.name !== 'video.mov'))).toMatch(/video\.mov is missing/)
  })

  test('room.bin must be 4 + 15 bytes per point', () => {
    const files = tinyFiles().map((f) => (f.name === 'room.bin' ? { ...f, bytes: 30 } : f))
    expect(errorsOf(tinyManifest(), files)).toMatch(/room\.bin is 30 bytes, but the manifest implies 34/)
  })

  test('declared keyframes must all be there', () => {
    const m = { ...tinyManifest(), keyframes: { dir: 'keyframes', everySec: 1, count: 2 } }
    expect(errorsOf(m, tinyFiles())).toMatch(/keyframes\/ has 0 images, but manifest\.keyframes\.count is 2/)
  })

  test('a manifest for another capture is rejected', () => {
    expect(errorsOf(tinyManifest('aaaaaaaa-2222-4333-8444-555555555555'), tinyFiles())).toMatch(/doesn't match the upload id/)
  })

  test('a listed transcript and splat must be there; an unknown splat format is named', () => {
    const m = tinyManifest()
    m.transcript = { file: 'transcript.json', locale: 'en-US' }
    m.room = { ...m.room!, splat: { file: 'room.spz', format: 'spz', count: 2, shDegree: 0, source: 'trained-from-video' } }
    expect(errorsOf(m, tinyFiles())).toMatch(/transcript\.json is missing[\s\S]*|room\.spz is missing/)
    expect(errorsOf(m, tinyFiles())).toMatch(/room\.spz is missing \(the room splat\)/)
    m.room.splat = { ...m.room.splat!, format: 'png' as 'spz' }
    expect(errorsOf(m, tinyFiles())).toMatch(/format is "png"/)
  })

  test('depth v2: index present and depth.bin exactly the chunks it lists', () => {
    const m = tinyManifest()
    m.depth = { encoding: 'v2', file: 'depth.bin', index: 'depth.index.json', width: 4, height: 3, rateHz: 10, count: 2 }
    const base = tinyFiles().filter((f) => f.name !== 'confidence.bin' && f.name !== 'depth.bin')
    expect(errorsOf(m, [...base, { name: 'depth.bin', bytes: 30 }])).toMatch(/depth\.index\.json is missing/)
    const index = { name: 'depth.index.json', bytes: 120, indexedBytes: 30, indexedCount: 2 }
    expect(errorsOf(m, [...base, index, { name: 'depth.bin', bytes: 30 }])).toBe('')
    expect(errorsOf(m, [...base, index, { name: 'depth.bin', bytes: 31 }])).toMatch(/depth\.bin is 31 bytes, but the manifest implies 30/)
    expect(errorsOf(m, [...base, { ...index, indexedCount: 3 }, { name: 'depth.bin', bytes: 30 }])).toMatch(/lists 3 depth frames/)
  })

  test('readDepthIndex sums back-to-back chunks and rejects gaps', () => {
    const index = { format: 'braindance.depth', version: 2, width: 4, height: 3, count: 12, framesPerChunk: 10, chunks: [[0, 100], [100, 50]] }
    expect(readDepthIndex(index)).toEqual({ bytes: 150, count: 12 })
    expect(readDepthIndex({ ...index, chunks: [[0, 100], [101, 50]] })).toMatchObject({ error: expect.stringMatching(/back to back/) })
    expect(readDepthIndex({ ...index, version: 1 })).toMatchObject({ error: expect.any(String) })
  })
})

describe('facts trigger', () => {
  test('waits for the manifest, every listed keyframe and the transcript', () => {
    const m = { ...tinyManifest(), keyframes: { dir: 'keyframes', everySec: 1, count: 2 }, transcript: { file: 'transcript.json', locale: 'en-US' } }
    const files = [{ name: 'manifest.json' }, { name: 'keyframes/k0000.jpg' }]
    expect(factsInputsReady(m, files)).toBe(false)
    files.push({ name: 'keyframes/k0001.jpg' })
    expect(factsInputsReady(m, files)).toBe(false)
    files.push({ name: 'transcript.json' })
    expect(factsInputsReady(m, files)).toBe(true)
    expect(factsInputsReady(m, files.filter((f) => f.name !== 'manifest.json'))).toBe(false)
    expect(factsInputsReady(tinyManifest(), [{ name: 'manifest.json' }]), 'no keyframes listed: wait for complete').toBe(false)
  })
})

describe('jobs', () => {
  test('routing by kind, GPU and frames; facts never go to a worker', () => {
    const bake = { kind: 'bake' as const, needs: { gpu: false } }
    const convert = { kind: 'convert' as const, needs: { gpu: true, frames: 120 } }
    const fedora = { kinds: ['convert', 'splat'], gpu: true, maxFrames: 67 }
    const gx10 = { kinds: ['convert', 'splat', 'bake'], gpu: true, maxFrames: 240 }
    const cpu = { kinds: ['bake'], gpu: false }
    expect(canRun(bake, cpu)).toBe(true)
    expect(canRun(convert, cpu)).toBe(false)
    expect(canRun(convert, fedora)).toBe(false)
    expect(canRun(convert, gx10)).toBe(true)
    expect(canRun({ kind: 'facts', needs: { gpu: false } }, { kinds: ['facts'], gpu: false })).toBe(false)
  })

  test("frames follow the converter's formula, capped", () => {
    expect(convertFrames(0.5)).toBe(16)
    expect(convertFrames(6.6)).toBe(67)
    expect(convertFrames(240)).toBe(240)
    expect(convertFrames(undefined)).toBe(240)
  })

  test('token comparison', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true)
    expect(tokenMatches('abd', 'abc')).toBe(false)
    expect(tokenMatches('ab', 'abc')).toBe(false)
    expect(tokenMatches('', undefined)).toBe(false)
  })
})
