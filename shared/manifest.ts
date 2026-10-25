// manifest.json (docs/capture-format.md, depth v2 in docs/architecture-v3.md §3). Parsed once by
// whoever reads a capture; unknown fields are kept but not typed.

export type DepthInfo =
  | { encoding?: 'v1'; file: string; confidenceFile: string; width: number; height: number; unit?: 'mm'; rateHz: number; count: number; estimated?: boolean; model?: string }
  | { encoding: 'v2'; file: string; index: string; width: number; height: number; unit?: 'mm'; rateHz: number; count: number; estimated?: boolean; model?: string }

export type RoomSplat = {
  file: string
  format: 'spz' | '3dgs-ply'
  count: number
  shDegree: number
  source: 'trained-from-video' | 'trained-from-lidar-capture'
}

export type RoomCompletion = Omit<RoomSplat, 'source'> & {
  source: 'generated'
  report: string
}

export type Manifest = {
  format?: 'braindance.capture'
  version?: number
  id: string
  createdAt: string
  device?: string
  title: string
  attendees: string[]
  coordinates?: string
  imageOrientation?: string
  video: { file: string; width: number; height: number; fps: number; durationSec: number; frameCount: number }
  audio?: { inVideo: boolean; sampleRate: number; channels: number }
  depth: DepthInfo
  /** "video" when rebuilt from an ordinary video (estimated); absent for LiDAR scans. */
  source?: string
  room?: { bin: string; ply?: string; points: number; voxelMeters: number; source?: string; splat?: RoomSplat; completion?: RoomCompletion }
  phases?: { scan?: { tStart: number; tEnd: number }; moment: { tStart: number; tEnd: number } }
  transcript?: { file: string; locale: string; onDevice?: boolean }
  keyframes?: { dir: string; everySec: number; count: number }
  warnings: string[]
}

export class ManifestError extends Error {}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

/** Parses and checks the fields everything relies on. Throws ManifestError with a plain message. */
export function parseManifest(json: string): Manifest {
  let m: unknown
  try {
    m = JSON.parse(json)
  } catch (e) {
    throw new ManifestError(`manifest.json isn't valid JSON: ${(e as Error).message}`)
  }
  if (!isObj(m)) throw new ManifestError('manifest.json must be an object.')
  if (typeof m.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(m.id)) throw new ManifestError('manifest.json needs an "id" that is a UUID.')
  if (!isObj(m.video) || typeof m.video.file !== 'string') throw new ManifestError('manifest.json needs "video.file".')
  if (!isObj(m.depth) || typeof m.depth.file !== 'string' || typeof m.depth.count !== 'number') throw new ManifestError('manifest.json needs "depth.file" and "depth.count".')
  if (isObj(m.room) && m.room.completion !== undefined) {
    const c = m.room.completion
    const fileName = (s: unknown) => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s) && !s.includes('..')
    if (!isObj(c) || c.source !== 'generated' || !fileName(c.file) || !fileName(c.report)
      || !['spz', '3dgs-ply'].includes(String(c.format)) || !Number.isInteger(c.count) || Number(c.count) <= 0 || c.shDegree !== 0)
      throw new ManifestError('room.completion needs generated provenance, safe file names, a positive count and degree-0 splats.')
  }
  const out = m as unknown as Manifest
  out.id = out.id.toLowerCase()
  out.title ??= ''
  out.attendees ??= []
  out.warnings ??= []
  return out
}

export function depthEncoding(d: DepthInfo): 'v1' | 'v2' {
  return d.encoding === 'v2' ? 'v2' : 'v1'
}
