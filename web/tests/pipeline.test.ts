import { describe, expect, it } from 'vitest'
import type { CaptureStatus, WorkerInfo } from '../src/data/types'
import { stageLines } from '../src/views/pipeline'

const base: CaptureStatus = {
  source: 'video', upload: 'receiving', uploadErrors: [], warnings: [], convert: 'queued', facts: 'not_started', bake: 'not_started', splat: 'not_started',
  errors: {}, progress: null, updatedAt: 0,
}
const gpu: WorkerInfo = { workerId: 'fedora', kinds: ['convert', 'splat'], gpu: true, maxFrames: 67, lastSeen: 0 }

describe('stageLines', () => {
  it('says a video job is waiting for a GPU worker when none online can take it', () => {
    expect(stageLines(base, [], 240)[0]).toEqual({ key: 'convert', label: 'Waiting for a GPU worker that can handle a 4-minute video', tone: 'working' })
    expect(stageLines(base, [gpu], 240)[0].label).toBe('Waiting to turn the video into 3D')
  })

  it('shows failures with their message and the running job’s progress once', () => {
    const lines = stageLines({ ...base, source: 'phone', upload: 'done', convert: 'skipped', splat: 'skipped', facts: 'failed', bake: 'running', errors: { facts: 'Claude timed out.' }, progress: { stage: 'surface', fraction: 0.42, message: 'Building the room surface' } }, [], 30)
    expect(lines).toEqual([
      { key: 'facts', label: 'Facts failed: Claude timed out.', tone: 'failed' },
      { key: 'bake', label: 'Building the room…', tone: 'working' },
      { key: 'progress', label: 'Building the room surface (42%)', tone: 'working' },
    ])
  })

  it('an invalid upload says what is wrong and nothing else', () => {
    expect(stageLines({ ...base, upload: 'invalid', uploadErrors: ['depth.bin is 10 bytes short.'] }, [], null)).toEqual([
      { key: 'upload', label: 'Incomplete: depth.bin is 10 bytes short.', tone: 'failed' },
    ])
  })
})
