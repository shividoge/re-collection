// The room's selection index, built and queried off the main thread: one per capture. Takes the
// points as points.pack keeps them (quantized) or as floats (a room.bin opened locally).
import { roomSelection, buildRoomIndex, type RoomIndex, type RoomPointsInput, type SelectionData } from './roomQuery'
import type { PoseFrame } from './spatial'

export type RoomWorkerRequest =
  | { kind: 'init'; points: RoomPointsInput; frames: PoseFrame[]; videoW: number; videoH: number }
  | { kind: 'pick'; id: number; origin: [number, number, number]; dir: [number, number, number] }

export type RoomWorkerReply =
  /** `sizes`: the splat sizes worked out here for a float cloud that came without them. */
  | { kind: 'ready'; grid: { origin: [number, number, number]; size: number; dims: [number, number, number] }; sizes: Float32Array | null }
  | { kind: 'failed'; message: string }
  | { kind: 'pick'; id: number; selection: SelectionData | null }

let room: RoomIndex | null = null
let frames: PoseFrame[] = []
let video = { w: 1920, h: 1440 }

const post = (m: RoomWorkerReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer)

self.onmessage = (e: MessageEvent<RoomWorkerRequest>) => {
  const m = e.data
  if (m.kind === 'init') {
    try {
      frames = m.frames
      video = { w: m.videoW, h: m.videoH }
      room = buildRoomIndex(m.points)
      const { origin, size, dims } = room.index
      const sizes = m.points.kind === 'float' && !m.points.sizes ? room.sizes.slice() : null
      post({ kind: 'ready', grid: { origin, size, dims }, sizes }, sizes ? [sizes.buffer] : [])
    } catch (err) {
      post({ kind: 'failed', message: err instanceof Error ? err.message : String(err) })
    }
    return
  }
  const selection = room ? roomSelection(room, frames, video.w, video.h, m.origin, m.dir) : null
  const transfer: Transferable[] = selection
    ? [selection.cloud.positions.buffer, selection.cloud.colors.buffer, selection.sizes.buffer, selection.points.buffer, selection.voxelCoords.buffer]
    : []
  post({ kind: 'pick', id: m.id, selection }, transfer)
}
