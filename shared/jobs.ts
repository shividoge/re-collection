// The job routing rule (architecture-v3.md §7), shared so the scheduler and the web can't disagree
// on whether a worker can take a job. Pure: no Convex imports.

export type JobNeeds = { gpu: boolean; frames?: number }
export type WorkerAbility = { kinds: readonly string[]; gpu: boolean; maxFrames?: number | null }

/** Can this worker run the job? Facts run in Convex itself, never on a worker. */
export function canRun(job: { kind: string; needs: JobNeeds }, worker: WorkerAbility): boolean {
  if (job.kind === 'facts' || !worker.kinds.includes(job.kind)) return false
  if (job.needs.gpu && !worker.gpu) return false
  if (job.needs.frames !== undefined && job.needs.frames > (worker.maxFrames ?? Infinity)) return false
  return true
}
