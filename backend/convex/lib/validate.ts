// Checks an upload against its manifest from the registered file sizes (architecture-v3.md §5
// trigger 2). The bake worker re-checks what needs the bytes (frames.jsonl lines, room.bin header,
// depth chunks, the splat header). Messages are shown to people as is. From guide/src/validate.mjs.
import type { Manifest } from '../../../shared/manifest'

export type RegisteredFile = { name: string; bytes: number; indexedBytes?: number; indexedCount?: number }
export type Check = { ok: boolean; errors: string[]; warnings: string[] }

export function validatePackage(captureId: string, manifest: Manifest, files: readonly RegisteredFile[]): Check {
  const errors: string[] = []
  const warnings: string[] = []
  const byName = new Map(files.map((f) => [f.name, f]))

  if (manifest.format !== 'braindance.capture') errors.push(`manifest.format is "${manifest.format}", expected "braindance.capture".`)
  if (manifest.version !== 1) errors.push(`manifest.version is ${manifest.version}; this backend reads version 1.`)
  if (manifest.id.toLowerCase() !== captureId.toLowerCase()) errors.push(`manifest.id "${manifest.id}" doesn't match the upload id "${captureId}".`)

  /** Adds an error unless `name` is registered (optionally with an exact size). */
  function requireFile(name: string | undefined, expected: number | undefined, what: string): RegisteredFile | null {
    if (!name) {
      errors.push(`The manifest doesn't name ${what}.`)
      return null
    }
    const file = byName.get(name)
    if (!file) errors.push(`${name} is missing (${what}).`)
    else if (expected !== undefined && file.bytes !== expected) errors.push(`${name} is ${file.bytes} bytes, but the manifest implies ${expected} (${what}).`)
    else if (file.bytes === 0) errors.push(`${name} is empty (${what}).`)
    return file ?? null
  }

  requireFile('manifest.json', undefined, 'the manifest')
  requireFile(manifest.video?.file, undefined, 'the recorded video')
  requireFile('frames.jsonl', undefined, 'camera poses')

  const depth = manifest.depth
  if (depth.encoding === 'v2') {
    const index = requireFile(depth.index, undefined, 'the depth chunk index')
    const expected = index?.indexedBytes
    requireFile(depth.file, expected, `${depth.count} depth frames in compressed chunks`)
    if (index && index.indexedCount !== undefined && index.indexedCount !== depth.count) {
      errors.push(`${depth.index} lists ${index.indexedCount} depth frames, but manifest.depth.count is ${depth.count}.`)
    }
  } else {
    const pixels = depth.count * depth.width * depth.height
    requireFile(depth.file, pixels * 2, `${depth.count} depth frames of ${depth.width}x${depth.height} UInt16`)
    requireFile(depth.confidenceFile, pixels, `${depth.count} confidence frames of ${depth.width}x${depth.height} UInt8`)
  }

  const room = manifest.room
  if (room) {
    requireFile(room.bin, 4 + room.points * 15, `${room.points} room points`)
    if (room.ply) requireFile(room.ply, undefined, 'the room cloud for desktop viewers')
    if (room.splat) {
      if (room.splat.format !== 'spz' && room.splat.format !== '3dgs-ply') {
        errors.push(`manifest.room.splat.format is "${String(room.splat.format)}", expected "spz" or "3dgs-ply".`)
      } else {
        requireFile(room.splat.file, undefined, 'the room splat')
      }
    }
  } else {
    warnings.push('This capture has no room scan, so there is no 3D room to show.')
  }

  if (manifest.transcript?.file) requireFile(manifest.transcript.file, undefined, 'the transcript')
  if (manifest.keyframes?.count) {
    const have = keyframesRegistered(manifest, files)
    if (have !== manifest.keyframes.count) {
      errors.push(`${manifest.keyframes.dir ?? 'keyframes'}/ has ${have} images, but manifest.keyframes.count is ${manifest.keyframes.count}.`)
    }
  }
  if (!manifest.transcript) warnings.push('No transcript: facts can only come from what the keyframes show.')
  for (const warning of manifest.warnings ?? []) warnings.push(`From the phone: ${warning}`)

  return { ok: errors.length === 0, errors, warnings }
}

/** Registered images in the manifest's keyframes folder. */
export function keyframesRegistered(manifest: Manifest, files: readonly { name: string }[]): number {
  const dir = `${manifest.keyframes?.dir ?? 'keyframes'}/`
  return files.filter((f) => f.name.startsWith(dir)).length
}

/**
 * Facts can start once Claude's inputs are here (§5 trigger 1): manifest.json, every keyframe the
 * manifest lists, and the transcript if it lists one. A manifest without keyframes waits for
 * `captures.complete` (old captures use the thumbnail).
 */
export function factsInputsReady(manifest: Manifest, files: readonly { name: string }[]): boolean {
  const names = new Set(files.map((f) => f.name))
  if (!names.has('manifest.json') || !manifest.keyframes?.count) return false
  if (manifest.transcript?.file && !names.has(manifest.transcript.file)) return false
  return keyframesRegistered(manifest, files) >= manifest.keyframes.count
}

/** depth.index.json (§3) → total chunk bytes and frame count, or an error message. */
export function readDepthIndex(json: unknown): { bytes: number; count: number } | { error: string } {
  const index = json as { format?: unknown; version?: unknown; count?: unknown; chunks?: unknown }
  if (!index || index.format !== 'braindance.depth' || index.version !== 2) return { error: 'depth.index.json isn\'t a braindance.depth version 2 index.' }
  if (!Array.isArray(index.chunks) || typeof index.count !== 'number') return { error: 'depth.index.json needs "count" and "chunks".' }
  let end = 0
  for (const [i, chunk] of index.chunks.entries()) {
    if (!Array.isArray(chunk) || chunk.length !== 2 || !chunk.every((n) => Number.isInteger(n) && n >= 0)) return { error: `depth.index.json chunk ${i} isn't [offset, length].` }
    if (chunk[0] !== end) return { error: `depth.index.json chunk ${i} starts at ${chunk[0]}, expected ${end} (chunks must be back to back).` }
    end += chunk[1]
  }
  return { bytes: end, count: index.count }
}

/** File names inside a capture: plain names, plus one folder level for keyframes/. */
const NAME_PATTERN = /^(?:keyframes\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/
export function isFileName(name: string): boolean {
  return NAME_PATTERN.test(name) && !name.includes('..')
}

/** The source of an old video: "source.mp4" and the like. */
export function isSourceName(name: string): boolean {
  return /^source\.[a-z0-9]{1,5}$/.test(name)
}

/**
 * Model frames a convert/splat job needs for a video, with video2capture.py's formula:
 * max(16, ⌊duration · 10⌋ + 1) at the default 10 fps sampling, capped at 240 (the largest worker).
 * Unknown length → the cap.
 */
export const CONVERT_MAX_FRAMES = 240
export function convertFrames(durationSec: number | null | undefined): number {
  if (!durationSec || !Number.isFinite(durationSec) || durationSec <= 0) return CONVERT_MAX_FRAMES
  return Math.max(2, Math.min(CONVERT_MAX_FRAMES, Math.max(16, Math.floor(durationSec * 10) + 1)))
}
