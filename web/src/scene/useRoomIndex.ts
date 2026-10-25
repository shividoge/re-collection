import { useCallback, useEffect, useRef, useState } from 'react'
import type { FrameRecord, PointCloud } from './formats'
import type { PointsData } from './packs'
import type { RoomPointsInput, SelectionData } from './roomQuery'
import type { RoomWorkerReply, RoomWorkerRequest } from './roomWorker'
import type { Vec3 } from './spatial'

export type Selection = SelectionData

export interface SelectionGrid {
  origin: [number, number, number]
  size: number
  dims: [number, number, number]
}

export type IndexState = { status: 'idle' } | { status: 'building' } | { status: 'ready'; grid: SelectionGrid } | { status: 'failed'; message: string }

/** The room's points, as the backend bakes them or as a local room.bin. */
export type RoomSource = { kind: 'pack'; points: PointsData } | { kind: 'cloud'; cloud: PointCloud }

export interface RoomQuery {
  state: IndexState
  /** Splat sizes the worker worked out for a local room.bin (null for baked points, which carry them). */
  sizes: Float32Array | null
  /** What a click along this ray selects; waits for the index if it's still building. */
  pick: (origin: Vec3, dir: Vec3) => Promise<Selection | null>
}

function workerInput(source: RoomSource): RoomPointsInput {
  // Copies: the originals stay with the page (fetch cache, GPU upload).
  if (source.kind === 'cloud') return { kind: 'float', positions: source.cloud.positions.slice(), colors: source.cloud.colors.slice(), sizes: null }
  const p = source.points
  return { kind: 'quantized', positions: p.positions.slice(), min: p.min, max: p.max, colors: p.colors.slice(), sizes: p.sizes.slice(), sizeMin: p.sizeMin, sizeMax: p.sizeMax }
}

/**
 * One selection index per room, built and queried in a worker (roomWorker.ts), so neither the
 * build nor a click blocks the page. `null` until the room's points are loaded.
 */
export function useRoomQuery(source: RoomSource | null, frames: FrameRecord[], videoW: number, videoH: number): RoomQuery {
  const [state, setState] = useState<IndexState>({ status: 'idle' })
  const [sizes, setSizes] = useState<Float32Array | null>(null)
  const worker = useRef<Worker | null>(null)
  const pending = useRef(new Map<number, (s: Selection | null) => void>())
  const nextId = useRef(1)

  useEffect(() => {
    if (!source) return
    const w = new Worker(new URL('./roomWorker.ts', import.meta.url), { type: 'module' })
    worker.current = w
    const waiting = pending.current
    setState({ status: 'building' })
    setSizes(null)
    w.onmessage = (e: MessageEvent<RoomWorkerReply>) => {
      const m = e.data
      if (m.kind === 'ready') {
        setState({ status: 'ready', grid: m.grid })
        setSizes(m.sizes)
      } else if (m.kind === 'failed') setState({ status: 'failed', message: m.message })
      else {
        waiting.get(m.id)?.(m.selection)
        waiting.delete(m.id)
      }
    }
    w.onerror = (e) => setState({ status: 'failed', message: e.message || 'the selection worker failed' })
    const input = workerInput(source)
    const transfer = [input.positions.buffer, input.colors.buffer, ...(input.kind === 'quantized' ? [input.sizes.buffer] : [])]
    const msg: RoomWorkerRequest = {
      kind: 'init',
      points: input,
      frames: frames.map((f) => ({ t: f.t, T: f.T, K: f.K })),
      videoW,
      videoH,
    }
    w.postMessage(msg, transfer)
    return () => {
      w.terminate()
      worker.current = null
      for (const resolve of waiting.values()) resolve(null)
      waiting.clear()
    }
  }, [source, frames, videoW, videoH])

  const pick = useCallback((origin: Vec3, dir: Vec3) => {
    const w = worker.current
    if (!w) return Promise.resolve(null)
    const id = nextId.current++
    return new Promise<Selection | null>((resolve) => {
      pending.current.set(id, resolve)
      const msg: RoomWorkerRequest = { kind: 'pick', id, origin, dir }
      w.postMessage(msg)
    })
  }, [])

  return { state: source ? state : { status: 'idle' }, sizes, pick }
}
