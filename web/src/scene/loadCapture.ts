// Load the parts of a capture the viewer needs: from the data layer, or a room.bin opened
// from this computer. Every missing or broken file becomes an error the UI shows; nothing is
// substituted.

import { fetchBytes, fetchText, loadCaptureAssets, type CaptureAssets } from '../data'
import type { Manifest, RoomSplat } from '../api'
import { parseFramesJsonl, parseRoomBin, type FrameLog, type PointCloud } from './formats'

export interface LoadedCapture {
  /** Capture id; null for a room.bin opened from this computer. */
  id: string | null
  label: string
  manifest: Manifest | null
  cloud: PointCloud | null
  frames: FrameLog | null
  /** The recorded video. Its frames are stored sensor-landscape; the viewer turns them upright. */
  videoUrl: string | null
  /** The room as 3D Gaussians, when the capture has one; the points stay available as the raw view. */
  splat: (RoomSplat & { url: string }) | null
  errors: string[]
  /** True when the family marked this capture public (only meaningful for server captures). */
  isPublic: boolean
  /** Where its files are (null for a room.bin opened from this computer). */
  assets: CaptureAssets | null
}

const FRAMES_FILE = 'frames.jsonl'

export async function loadGuideCapture(id: string, opts: { public?: boolean } = {}): Promise<LoadedCapture> {
  return loadFromAssets(await loadCaptureAssets(id, opts))
}

export async function loadFromAssets(assets: CaptureAssets): Promise<LoadedCapture> {
  const { id, manifest } = assets
  const file = (name: string) => {
    const url = assets.rawUrl(name)
    if (!url) throw new Error('not uploaded')
    return url
  }
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
    manifest.room ? attempt('room.bin', async () => parseRoomBin(await fetchBytes(file(manifest.room!.bin)))) : Promise.resolve(null),
    attempt(FRAMES_FILE, async () => parseFramesJsonl(await fetchText(file(FRAMES_FILE)))),
  ])
  if (!manifest.room) errors.push('This capture has no room scan (room.bin).')
  const from = manifest.source === 'video' ? 'Note' : 'Warning from the phone'
  for (const w of manifest.warnings ?? []) errors.push(`${from}: ${w}`)
  return {
    id,
    label: manifest.title || 'Untitled visit',
    manifest,
    cloud,
    frames,
    videoUrl: manifest.video?.file ? assets.rawUrl(manifest.video.file) : null,
    splat: manifest.room?.splat && assets.rawUrl(manifest.room.splat.file) ? { ...manifest.room.splat, url: assets.rawUrl(manifest.room.splat.file)! } : null,
    errors,
    isPublic: assets.public === true,
    assets,
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
    splat: null,
    errors: [],
    isPublic: false,
    assets: null,
  }
}
