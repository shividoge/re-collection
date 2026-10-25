import { describe, expect, it } from 'vitest'
import type { CaptureStatus, QueuedJob, WorkerInfo } from '../src/data/types'
import { aVideoOf, stageLines } from '../src/views/pipeline'

const base: CaptureStatus = {
  source: 'video', upload: 'receiving', uploadErrors: [], warnings: [], convert: 'queued', facts: 'not_started', bake: 'not_started', splat: 'not_started',
  errors: {}, progress: null, updatedAt: 0,
}
const gpu: WorkerInfo = { workerId: 'fedora', kinds: ['convert', 'splat'], gpu: true, maxFrames: 67, lastSeen: 0 }

describe('stageLines', () => {
  it('says a video job is waiting for a GPU when none online can take it', () => {
    const convert: QueuedJob[] = [{ kind: 'convert', needs: { gpu: true, frames: 60 } }]
    expect(stageLines(base, [], 240, convert)[0]).toEqual({ key: 'convert', label: 'Waiting for a GPU that can take a 4-minute video. None is online right now.', tone: 'working' })
    expect(stageLines(base, [gpu], 240, convert)[0].label).toBe('Waiting to turn the video into 3D')
  })

  it('counts the frame limit: a long video the only online GPU is too small for says so', () => {
    const long: QueuedJob[] = [{ kind: 'convert', needs: { gpu: true, frames: 240 } }]
    expect(stageLines(base, [gpu], 31, long)[0].label).toBe('Waiting for a GPU that can take a 31-second video. None is online right now.')
    expect(stageLines(base, [gpu, { ...gpu, workerId: 'gx10', maxFrames: 240 }], 31, long)[0].label).toBe('Waiting to turn the video into 3D')
    expect(stageLines(base, [{ ...gpu, maxFrames: null }], 31, long)[0].label).toBe('Waiting to turn the video into 3D') // no limit advertised
  })

  it('without the job’s needs, falls back to the kind and GPU check', () => {
    const queued: CaptureStatus = { ...base, source: 'phone', convert: 'skipped', upload: 'done', facts: 'done', bake: 'queued', splat: 'queued' }
    expect(stageLines(queued, [], 30, []).map((l) => l.label)).toEqual([
      'Facts ready',
      'Waiting for a worker to build the room. None is online right now.',
      'Waiting for a GPU to train the splat. None is online right now.',
    ])
    expect(stageLines(queued, [{ ...gpu, kinds: ['bake'], gpu: false }], 30, []).map((l) => l.label).slice(1)).toEqual([
      'Waiting to build the room',
      'Waiting for a GPU to train the splat. None is online right now.',
    ])
  })

  it('names the video length plainly', () => {
    expect([aVideoOf(31), aVideoOf(8.2), aVideoOf(18), aVideoOf(84), aVideoOf(240), aVideoOf(0), aVideoOf(null)]).toEqual([
      'a 31-second video', 'an 8-second video', 'an 18-second video', 'an 84-second video', 'a 4-minute video', 'this video', 'this video',
    ])
  })

  it('shows failures with their message and the running job’s progress once', () => {
    const lines = stageLines({ ...base, source: 'phone', upload: 'done', convert: 'skipped', splat: 'skipped', facts: 'failed', bake: 'running', errors: { facts: 'Claude timed out.' }, progress: { stage: 'surface', fraction: 0.42, message: 'Building the room surface' } }, [], 30, [])
    expect(lines).toEqual([
      { key: 'facts', label: 'Facts failed: Claude timed out.', tone: 'failed' },
      { key: 'bake', label: 'Building the room…', tone: 'working' },
      { key: 'progress', label: 'Building the room surface (42%)', tone: 'working' },
    ])
  })

  it('an invalid upload says what is wrong and nothing else', () => {
    expect(stageLines({ ...base, upload: 'invalid', uploadErrors: ['depth.bin is 10 bytes short.'] }, [], null, [])).toEqual([
      { key: 'upload', label: 'Incomplete: depth.bin is 10 bytes short.', tone: 'failed' },
    ])
  })
})
