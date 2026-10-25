// The shapes views work with, taken from the backend's validators and function return types so
// they can't drift from what Convex sends. Types only: importing this file costs nothing at runtime.
// Shapes come from the validators (not FunctionReturnType), so they stay exact while the backend's
// functions are still stubs.
import type { Infer } from 'convex/values'
import type { captureDetail, captureSummary, namedFile } from '../../../backend/convex/captures'
import type {
  alert,
  arrangement,
  arrangementItem,
  branch,
  endReason,
  endSummary,
  evidence,
  focus,
  peers,
  progressReport,
  roomState,
  score,
  sentence,
} from '../../../backend/convex/validators'
import type { Derived } from '../../../backend/convex/validators'

export type { CaptureStatus, Fact, Moment, Person, Reply, Session, UploadTarget } from '../../../backend/convex/validators'
export type { Manifest, RoomSplat, DepthInfo } from '../../../shared/manifest'

export type Stage = 'not_started' | 'queued' | 'running' | 'done' | 'failed' | 'skipped'
export type CaptureSummary = Infer<typeof captureSummary>
export type CaptureDetail = Infer<typeof captureDetail>
/** A file entry as captures.get / public.capture list it. */
export type NamedFile = Infer<typeof namedFile>
/** public.captures (backend/convex/public.ts). */
export type PublicCapture = { id: string; title: string; summary: string; createdAt: string; durationSec: number; thumbUrl: string | null; facts: number }
/** public.capture: captures.get without status or the public flag. */
export type PublicCaptureDetail = { id: string; manifestJson: string; files: NamedFile[]; derived: Derived | null; derivedFiles: NamedFile[] }
export type WorkerInfo = { workerId: string; kinds: string[]; gpu: boolean; maxFrames: number | null; lastSeen: number }
/** system.health (backend/convex/system.ts). */
export type Health = { ok: true; mock: boolean; models: { offline: string; live: string }; workers: WorkerInfo[] }

export type Evidence = Infer<typeof evidence>
export type FactChange = { status?: 'pending' | 'approved' | 'rejected'; editedText?: string | null; doNotRaise?: boolean }
export type Sentence = Infer<typeof sentence>
export type Score = Infer<typeof score>
export type Branch = Infer<typeof branch>
export type Alert = Infer<typeof alert>
export type EndReason = Infer<typeof endReason>
export type SessionEnd = Infer<typeof endSummary>
export type Focus = Infer<typeof focus>
export type Progress = Infer<typeof progressReport>

/** "Visit together" (architecture-v3.md §6.6). */
export type RoomRole = 'patient' | 'helper'
export type RoomState = Infer<typeof roomState>
export type RoomPeers = Infer<typeof peers>
export type RoomChange = { at: number; atId: string | null; window: string | null; by: RoomRole; name?: string | null }
/** What a screen sees of a room: its state and who's there. */
export type Room = { code: string; state: RoomState; peers: RoomPeers }
/** Who a screen is: `client` is one id per browser tab. */
export type RoomWho = { as: RoomRole; name: string | null; client: string }

/** One picture the caretaker hung: a piece of a capture ("video", "thumb" or a keyframe "k0012"). */
export type ArrangementItem = Infer<typeof arrangementItem>
/** The museum as the caretaker set it up. `updatedAt` is absent on a draft. */
export type Arrangement = Omit<Infer<typeof arrangement>, 'updatedAt'> & { updatedAt?: string }
