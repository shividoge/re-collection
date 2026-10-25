import type { CaptureStatus } from '../data/assets'

type Stage = CaptureStatus['bake']

const STAGE_LABEL: Record<Stage, string> = {
  not_started: 'not started',
  queued: 'waiting',
  running: 'running',
  done: 'done',
  failed: 'failed',
  skipped: 'skipped',
}

/** The steps that stand between an upload and its 3D room, in order, for this capture. */
export function roomSteps(s: CaptureStatus): { name: string; stage: Stage; error?: string }[] {
  const steps: { name: string; stage: Stage; error?: string }[] = []
  steps.push({ name: 'Upload', stage: s.upload === 'done' ? 'done' : s.upload === 'invalid' ? 'failed' : 'running', error: s.uploadErrors.join(' ') || undefined })
  if (s.source === 'video') steps.push({ name: 'Rebuilding the room from the video', stage: s.convert, error: s.errors.convert })
  steps.push({ name: 'Preparing the 3D room', stage: s.bake, error: s.errors.bake })
  return steps
}

/**
 * Shown instead of the 3D view until the bake is done: where the capture is, with the running
 * job's own progress. Never a stand-in picture of the room.
 */
export function ProcessingStatus({ status }: { status: CaptureStatus | null }) {
  if (!status) return <div className="viewer-processing">This capture's 3D room isn't ready yet.</div>
  const p = status.progress
  return (
    <div className="viewer-processing" role="status">
      <strong>The 3D room is being prepared</strong>
      <ol>
        {roomSteps(status).map((step) => (
          <li key={step.name} className={step.stage}>
            <span>{step.name}</span> <em>{STAGE_LABEL[step.stage]}</em>
            {step.stage === 'failed' && step.error && <div className="err">{step.error}</div>}
          </li>
        ))}
      </ol>
      {p && (
        <div className="viewer-progress">
          <div>
            {p.stage}: {p.message}
          </div>
          {p.fraction !== null && (
            <div className="bar" aria-label={`${Math.round(p.fraction * 100)}%`}>
              <span style={{ width: `${Math.round(Math.max(0, Math.min(1, p.fraction)) * 100)}%` }} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
