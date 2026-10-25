// Pure rules for uploading a capture (architecture-v3.md §5, §6.2): which files go, in what
// order, how a file splits into parts, and what's left after a failure or a reload.
import type { UploadTarget } from './types'

/**
 * Not uploaded: macOS junk in zips (__MACOSX/, .DS_Store, "._name" AppleDouble files: any hidden
 * file), files the old guide wrote itself, and room.ply (room.bin has the same points).
 */
const SKIP = /(^|\/)(__MACOSX|\.[^/]*|status\.json|moment\.json)(\/|$)|(^|\/)room\.ply$/

export const skipFile = (name: string): boolean => SKIP.test(name) || name.endsWith('/')

/**
 * Upload order: what Claude needs for facts first (so facts start before the big files land),
 * then what the room needs, then the video and depth.
 */
export function uploadRank(name: string): number {
  if (name === 'manifest.json') return 0
  if (name === 'thumb.jpg') return 1
  if (name === 'transcript.json') return 2
  if (name.startsWith('keyframes/')) return 3
  if (name === 'room.bin') return 4
  if (name === 'frames.jsonl') return 5
  if (/^video\./.test(name)) return 7
  if (/^(depth|confidence)\./.test(name)) return 8
  return 6
}

export function uploadOrder<T extends { name: string }>(files: T[]): T[] {
  return [...files].sort((a, b) => uploadRank(a.name) - uploadRank(b.name) || a.name.localeCompare(b.name))
}

const TYPES: [RegExp, string][] = [
  [/\.json$/, 'application/json'],
  [/\.jsonl$/, 'application/x-ndjson'],
  [/\.jpe?g$/, 'image/jpeg'],
  [/\.png$/, 'image/png'],
  [/\.mp4$/, 'video/mp4'],
  [/\.(mov|qt)$/, 'video/quicktime'],
  [/\.m4v$/, 'video/x-m4v'],
  [/\.webm$/, 'video/webm'],
]

export function contentType(name: string): string {
  const lower = name.toLowerCase()
  return TYPES.find(([re]) => re.test(lower))?.[1] ?? 'application/octet-stream'
}

/** The byte range of part `partNumber` (1-based) of a file of `bytes` split every `partSize`. */
export function partRange(partNumber: number, partSize: number, bytes: number): { start: number; end: number } {
  const start = (partNumber - 1) * partSize
  return { start, end: Math.min(start + partSize, bytes) }
}

/** How many parts a file of `bytes` has at `partSize` (at least one). */
export const partCount = (bytes: number, partSize: number): number => Math.max(1, Math.ceil(bytes / partSize))

export type Part = { partNumber: number; etag: string }
export type PendingPart = { partNumber: number; url: string; start: number; end: number }

/** The parts of `target` still to send, given those already done. */
export function pendingParts(target: UploadTarget, bytes: number, done: Part[]): PendingPart[] {
  if (!target.parts || !target.partSize) return []
  const have = new Set(done.map((p) => p.partNumber))
  const size = target.partSize
  return target.parts.filter((p) => !have.has(p.partNumber)).map((p) => ({ ...p, ...partRange(p.partNumber, size, bytes) }))
}

/** Done parts merged without duplicates, in part order (what uploads.finish wants). */
export function mergeParts(a: Part[], b: Part[]): Part[] {
  const byNumber = new Map<number, Part>()
  for (const p of [...a, ...b]) byNumber.set(p.partNumber, p)
  return [...byNumber.values()].sort((x, y) => x.partNumber - y.partNumber)
}

/** Wait before retry `attempt` (1-based): 0.5 s, 1 s, 2 s, 4 s, then 8 s. */
export const backoffMs = (attempt: number): number => Math.min(8000, 500 * 2 ** (attempt - 1))

/** An unfinished multipart upload kept across reloads (IndexedDB, keyed by uploadId). */
export type SavedUpload = { uploadId: string; captureId: string; name: string; bytes: number; parts: Part[]; updatedAt: number }

/** The saved upload to resume for this file, if any: same capture, name and size. */
export function findResumable(saved: SavedUpload[], captureId: string, name: string, bytes: number): SavedUpload | null {
  return saved.filter((s) => s.captureId === captureId && s.name === name && s.bytes === bytes).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
}

/**
 * A video upload in progress, kept so dropping the same file again (same title and people) reuses
 * its capture instead of making a new one. Keyed by `videoKey`.
 */
export type SavedVideo = { key: string; captureId: string; updatedAt: number }

/** Same file (name, size, last change) and same title and people. */
export const videoKey = (file: { name: string; size: number; lastModified: number }, meta: { title: string; attendees: string[] }): string =>
  JSON.stringify([file.name, file.size, file.lastModified, meta.title, meta.attendees])

/** Saved state older than this is dropped: R2 aborts unfinished multipart uploads after 7 days. */
export const SAVED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export const isStale = (updatedAt: number, now: number): boolean => now - updatedAt > SAVED_MAX_AGE_MS

/** Files the server already has with the same size: a re-dropped zip skips them. */
export function alreadyThere(registered: { name: string; bytes: number }[], name: string, bytes: number): boolean {
  return registered.some((f) => f.name === name && f.bytes === bytes)
}

/** Runs `tasks` with at most `limit` at once, starting them in order. Rejects on the first failure. */
export async function pool<T>(items: T[], limit: number, run: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0
  let failed: unknown = null
  const worker = async () => {
    while (next < items.length && failed === null) {
      const i = next++
      try {
        await run(items[i], i)
      } catch (error) {
        failed ??= error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  if (failed !== null) throw failed
}
