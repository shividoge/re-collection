// Load the parts of a capture the viewer needs: from the guide server, or a room.bin opened
// from this computer. Every missing or broken file becomes an error the UI shows; nothing is
// substituted.

import { captureFileUrl, fetchBytes, fetchText, guide } from '../api'
import type { Manifest } from '../api'
import { parseFramesJsonl, parseRoomBin, type FrameLog, type PointCloud } from './formats'

export interface LoadedCapture {
  /** Guide capture id; null for a room.bin opened from this computer. */
  id: string | null
  label: string
  manifest: Manifest | null
  cloud: PointCloud | null
  frames: FrameLog | null
  /** The recorded video. Its frames are stored sensor-landscape; the viewer turns them upright. */
  videoUrl: string | null
  errors: string[]
}

const FRAMES_FILE = 'frames.jsonl'

export async function loadGuideCapture(id: string): Promise<LoadedCapture> {
  const { manifest } = await guide.capture(id)
  const errors: string[] = []
  const attempt = async <T>(what: string, load: () => Promise<T>): Promise<T | null> => {
    try {
      return await load()
    } catch (e) {
      errors.push(`${what}: ${e instanceof Error ? e.message : String(e)}`)
      return null
    }
  }
  const [cloud, frames] = await Promise.all([
    manifest.room ? attempt('room.bin', async () => parseRoomBin(await fetchBytes(id, manifest.room!.bin))) : Promise.resolve(null),
    attempt(FRAMES_FILE, async () => parseFramesJsonl(await fetchText(id, FRAMES_FILE))),
  ])
  if (!manifest.room) errors.push('This capture has no room scan (room.bin).')
  for (const w of manifest.warnings ?? []) errors.push(`Warning from the phone: ${w}`)
  return {
    id,
    label: manifest.title || 'Untitled visit',
    manifest,
    cloud,
    frames,
    videoUrl: manifest.video?.file ? captureFileUrl(id, manifest.video.file) : null,
    errors,
  }
}

/** A bare room scan picked on this computer. Nothing is uploaded. */
export async function loadRoomFile(file: File): Promise<LoadedCapture> {
  return {
    id: null,
    label: file.name,
    manifest: null,
    cloud: parseRoomBin(await file.arrayBuffer()),
    frames: null,
    videoUrl: null,
    errors: [],
  }
}
