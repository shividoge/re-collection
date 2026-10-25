// The boundary between the data layer (web/src/data/, talks to Convex or the static site) and
// the 3D code (web/src/scene/, museum/, window/). Scene code gets a CaptureAssets and never
// knows where the bytes come from. docs/architecture-v3.md §2, §4.
import type { Manifest } from '../../../shared/manifest'
import type { Derived, CaptureStatus } from '../../../backend/convex/validators'

export type { Manifest, Derived, CaptureStatus }

export interface CaptureAssets {
  id: string
  manifest: Manifest
  /** Null on the public/static site, which doesn't expose pipeline status. */
  status: CaptureStatus | null
  /** Derived manifest once the bake is done; null while it isn't (show the status instead). */
  derived: Derived | null
  /** URL of a raw file by its capture-format name ("video.mp4", "keyframes/k0003.jpg"), or null if absent. */
  rawUrl(name: string): string | null
  /** URL of a derived file by its name in derived.files ("points.pack"), or null if absent. */
  derivedUrl(name: string): string | null
}

/**
 * Fetches a file once per URL for the page's lifetime (shared by every view: capture view,
 * museum step-in, Memory Window). Implemented in data/fetchCache.ts.
 */
export type FetchBytes = (url: string, init?: { range?: [start: number, length: number]; signal?: AbortSignal }) => Promise<ArrayBuffer>
