import { afterEach, describe, expect, test, vi } from 'vitest'
import { CAPTURE_ID, TOKEN, api, setup, tinyCapture } from '../convex/test.helpers'
import { exportCapture, exportList, isPackageFile, toMoment, toSession, uploadPlan } from './plan'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('import planning', () => {
  test("the guide's own files, partial uploads and Mac litter are never uploaded", () => {
    for (const name of ['status.json', 'moment.json', 'room.ply', 'video.mp4.part', 'x.tmp', '._room.bin', '.DS_Store', 'keyframes/._k0001.jpg', '../x']) expect(isPackageFile(name), name).toBe(false)
    for (const name of ['manifest.json', 'room.bin', 'keyframes/k0001.jpg', 'room.splat.ply']) expect(isPackageFile(name), name).toBe(true)
  })

  test('manifest first, small before big, already-stored files skipped', () => {
    const plan = uploadPlan(
      [{ name: 'video.mp4', bytes: 900 }, { name: 'thumb.jpg', bytes: 10 }, { name: 'manifest.json', bytes: 500 }, { name: 'room.bin', bytes: 34 }, { name: 'moment.json', bytes: 3 }],
      [{ name: 'room.bin', bytes: 34 }, { name: 'thumb.jpg', bytes: 9 }],
    )
    expect(plan.map((f) => [f.name, f.contentType])).toEqual([['manifest.json', 'application/json'], ['thumb.jpg', 'image/jpeg'], ['video.mp4', 'video/mp4']])
  })

  test('guide moment.json and session files import through the admin mutations (validators accept them)', async () => {
    const guideMoment = {
      captureId: CAPTURE_ID,
      moment: { title: 'MLH table', place: 'a hall', occasion: '', summary: 'A table.' },
      facts: [{ id: 'f4', text: 'MLH letters.', kind: 'object', salience: 2, evidence: [{ type: 'frame', t: 3, keyframe: 'keyframes/k0003.jpg' }], cue: 'Letters.', status: 'approved', editedText: null, doNotRaise: false, reviewedAt: '2026-10-24T15:08:17.926Z' }],
      chapters: [{ tStart: 0, tEnd: 10, label: 'Arriving' }],
      dropped: [],
      inputs: { keyframes: 29, transcriptSegments: null },
      extractedAt: '2026-10-24T15:00:00.000Z',
      model: 'claude-opus-5-5',
    }
    const guideSession = {
      id: '1aceea30-ac44-4936-a5f3-b4d3496ae1ed', momentId: CAPTURE_ID, person: { displayName: 'Grandma', preferredAddress: 'Mom' },
      startedAt: '2026-10-24T17:32:47.457Z', endedAt: '2026-10-24T17:40:00.000Z', endReason: 'complete', allowedFactIds: ['f4'],
      turns: [
        { t: '2026-10-24T17:32:47.457Z', speaker: 'claude', text: 'Hello, Mom.', kind: 'welcome', factIds: [] },
        { t: '2026-10-24T17:32:49.627Z', speaker: 'claude', text: 'Look.', kind: 'narration', chapterIndex: null, factIds: ['f4'] },
        { t: '2026-10-24T17:33:00.000Z', speaker: 'patient', text: 'Nice', focus: { label: 'a table', factIds: ['f4'] }, extra: 1 },
      ],
      said: ['f4'], dropped: [], branches: [], alerts: [], scores: [{ factId: 'f4', result: 'not_mentioned' }], note: 'Calm.',
    }
    const session = toSession(guideSession)
    expect(session.turns[1]).not.toHaveProperty('chapterIndex')
    expect(session.turns[2]).toEqual({ t: '2026-10-24T17:33:00.000Z', speaker: 'patient', text: 'Nice', focus: { label: 'a table', factIds: ['f4'] } })

    const t = setup()
    await t.mutation(api.captures.begin, { manifestJson: tinyCapture().manifestJson })
    expect(await t.mutation(api.admin.importMoment, { token: TOKEN, moment: toMoment(CAPTURE_ID, guideMoment) })).toEqual({ ok: true, replaced: false })
    expect(await t.mutation(api.admin.importMoment, { token: TOKEN, moment: toMoment(CAPTURE_ID, guideMoment) })).toEqual({ ok: true, replaced: true })
    await expect(t.mutation(api.admin.importSession, { token: 'nope', session })).rejects.toThrow(/Wrong worker token/)
    await t.mutation(api.admin.importSession, { token: TOKEN, session })
    const progress = await t.query(api.progress.get, { captureId: CAPTURE_ID })
    expect(progress.sessions.map((s) => [s.sessionId, s.startedAt, s.notMentioned])).toEqual([[guideSession.id, guideSession.startedAt, 1]])
    expect((await t.query(api.moments.get, { captureId: CAPTURE_ID })).status?.facts).toBe('done')
  })
})

describe('static export layout', () => {
  test('URLs relative to each JSON file; raw and derived kept apart; bulky raw data left out', () => {
    const file = (name: string) => ({ name, url: `https://r2.test/${name}?sig`, bytes: 1, rev: 1 })
    const manifest = { video: { file: 'video.mp4' }, depth: { encoding: 'v1', file: 'depth.bin' }, room: { bin: 'room.bin' } }
    const { json, downloads } = exportCapture({
      id: 'abc', manifestJson: JSON.stringify(manifest), derived: null,
      files: ['video.mp4', 'thumb.jpg', 'frames.jsonl', 'keyframes/k0001.jpg', 'room.bin', 'depth.bin', 'confidence.bin', 'transcript.json'].map(file),
      derivedFiles: ['points.pack', 'depth.bin', 'depth.index.json'].map(file),
    })
    expect(json.files.map((f) => f.url)).toEqual(['../files/abc/video.mp4', '../files/abc/thumb.jpg', '../files/abc/frames.jsonl', '../files/abc/keyframes/k0001.jpg', '../files/abc/transcript.json'])
    expect(json.derivedFiles.map((f) => f.url)).toEqual(['../files/abc/derived/points.pack', '../files/abc/derived/depth.bin', '../files/abc/derived/depth.index.json'])
    expect(downloads[0]).toEqual({ url: 'https://r2.test/video.mp4?sig', path: 'files/abc/video.mp4', bytes: 1 })
    expect(exportList([{ id: 'abc', thumbUrl: 'https://x' }, { id: 'def', thumbUrl: null }])).toEqual([{ id: 'abc', thumbUrl: 'files/abc/thumb.jpg' }, { id: 'def', thumbUrl: null }])
  })
})
