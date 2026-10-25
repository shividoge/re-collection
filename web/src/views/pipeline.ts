// Pure: a capture's pipeline status (architecture-v3.md §5) as short plain-language lines.
import type { CaptureStatus, Stage, WorkerInfo } from '../data'

export type Tone = 'done' | 'working' | 'failed' | 'idle'
export type StageLine = { key: string; label: string; tone: Tone }

type Kind = 'convert' | 'facts' | 'bake' | 'splat'

const NAMES: Record<Kind, string> = { convert: '3D from the video', facts: 'Facts', bake: 'Room', splat: 'Splat' }
const VERBS: Record<Kind, Partial<Record<Stage, string>>> = {
  convert: { queued: 'Waiting to turn the video into 3D', running: 'Turning the video into 3D…', done: '3D from the video ready' },
  facts: { not_started: 'Facts start once the keyframes are in', queued: 'Waiting for Claude', running: 'Claude is reading it…', done: 'Facts ready' },
  bake: { not_started: 'Room is built once the upload is complete', queued: 'Waiting to build the room', running: 'Building the room…', done: 'Room ready' },
  splat: { queued: 'Waiting to train the splat', running: 'Training the splat…', done: 'Splat ready' },
}

const toneOf = (s: Stage): Tone => (s === 'done' ? 'done' : s === 'failed' ? 'failed' : s === 'queued' || s === 'running' ? 'working' : 'idle')

const minutes = (sec: number) => {
  const m = Math.max(1, Math.round(sec / 60))
  return `${m}-minute`
}

/** Can some online worker take a job of this kind? (Frame limits aren't in the status; see the report.) */
const canRun = (workers: WorkerInfo[], kind: Kind, gpu: boolean) => workers.some((w) => w.kinds.includes(kind) && (!gpu || w.gpu))

/**
 * One line per stage that applies, in pipeline order. `workers` are the ones online now; a queued
 * job nobody online can take says what it's waiting for.
 */
export function stageLines(status: CaptureStatus, workers: WorkerInfo[], durationSec: number | null): StageLine[] {
  if (status.upload === 'invalid') {
    return [{ key: 'upload', label: `Incomplete: ${status.uploadErrors[0] ?? 'the upload didn’t match its manifest'}`, tone: 'failed' }]
  }
  const kinds: Kind[] = status.source === 'video' ? ['convert', 'facts', 'bake', 'splat'] : ['facts', 'bake', 'splat']
  const lines: StageLine[] = []
  if (status.upload === 'receiving' && status.source === 'phone') lines.push({ key: 'upload', label: 'Still uploading', tone: 'working' })
  for (const kind of kinds) {
    const stage = status[kind]
    if (stage === 'skipped') continue
    if (stage === 'failed') {
      lines.push({ key: kind, label: `${NAMES[kind]} failed${status.errors[kind] ? `: ${status.errors[kind]}` : ''}`, tone: 'failed' })
      continue
    }
    let label = VERBS[kind][stage] ?? `${NAMES[kind]}: not started`
    const gpu = kind === 'convert' || kind === 'splat'
    if (stage === 'queued' && kind !== 'facts' && !canRun(workers, kind, gpu)) {
      label = gpu
        ? `Waiting for a GPU worker that can handle ${durationSec ? `a ${minutes(durationSec)} video` : 'this video'}`
        : 'Waiting for a worker to build the room'
    }
    lines.push({ key: kind, label, tone: toneOf(stage) })
  }
  // The running job's own report (which job isn't said when two run at once, so it gets its own line).
  if (status.progress && kinds.some((k) => status[k] === 'running')) {
    const { message, fraction, stage } = status.progress
    lines.push({ key: 'progress', label: `${message || stage}${fraction === null ? '' : ` (${Math.round(fraction * 100)}%)`}`, tone: 'working' })
  }
  return lines
}
