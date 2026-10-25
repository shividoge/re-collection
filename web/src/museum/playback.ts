// Which of the museum's videos play, and the one <video> element each file gets.

/** Videos play while the visitor is this close (m). */
export const PLAY_DISTANCE = 7

export type Piece = { index: number; video: boolean; center: readonly [number, number, number] }

/**
 * The pieces whose videos play: the one in focus, plus at most one other, the nearest within
 * PLAY_DISTANCE of the visitor. Everything else rests on its poster (or its last frame).
 */
export function choosePlaying(pieces: Piece[], focus: number, at: readonly [number, number, number]): number[] {
  const out: number[] = []
  if (pieces.some((p) => p.index === focus && p.video)) out.push(focus)
  let near = -1
  let best = PLAY_DISTANCE
  for (const p of pieces) {
    if (!p.video || p.index === focus) continue
    const d = Math.hypot(p.center[0] - at[0], p.center[1] - at[1], p.center[2] - at[2])
    if (d < best) {
      best = d
      near = p.index
    }
  }
  if (near >= 0) out.push(near)
  return out
}

/** The set of playing pieces, for Artwork to subscribe to (only changes notify). */
export class Playlist {
  private now = new Set<number>()
  private listeners = new Set<() => void>()
  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  has = (index: number) => this.now.has(index)
  set(indices: number[]) {
    if (indices.length === this.now.size && indices.every((i) => this.now.has(i))) return
    this.now = new Set(indices)
    this.listeners.forEach((l) => l())
  }
}

type Entry = { el: HTMLVideoElement; users: number; wants: number }
const elements = new Map<string, Entry>()

/**
 * The one <video> element for a file, however many pieces show it. Nothing downloads until it
 * plays (`preload="none"`), unless there's no poster to show meanwhile.
 */
export function acquireVideo(src: string, hasPoster: boolean): HTMLVideoElement {
  let e = elements.get(src)
  if (!e) {
    const el = document.createElement('video')
    el.crossOrigin = 'anonymous'
    el.muted = true
    el.loop = true
    el.playsInline = true
    el.preload = hasPoster ? 'none' : 'metadata'
    el.src = src
    elements.set(src, (e = { el, users: 0, wants: 0 }))
  }
  e.users++
  return e.el
}

/** One piece wants this file playing (or no longer does); it plays while anyone wants it. */
export function wantPlaying(src: string, on: boolean) {
  const e = elements.get(src)
  if (!e) return
  e.wants = Math.max(0, e.wants + (on ? 1 : -1))
  if (e.wants > 0 && e.el.paused) void e.el.play().catch(() => {})
  if (e.wants === 0 && !e.el.paused) e.el.pause()
}

export function releaseVideo(src: string) {
  const e = elements.get(src)
  if (!e || --e.users > 0) return
  elements.delete(src)
  e.el.pause()
  e.el.removeAttribute('src')
  e.el.load()
}
