// Pure: turns what Convex (captures.get / public.capture) or the static site sends into the
// CaptureAssets the 3D code reads. No network here.
import { parseManifest } from '../../../shared/manifest'
import type { CaptureAssets, CaptureStatus, Derived } from './assets'
import type { NamedFile } from './types'

/** The part of captures.get and public.capture that CaptureAssets is built from. */
export type AssetsSource = {
  id: string
  manifestJson: string
  files: NamedFile[]
  derived: Derived | null
  derivedFiles: NamedFile[]
  status?: CaptureStatus
  public?: boolean
}

const lookup = (files: NamedFile[]) => {
  const byName = new Map(files.map((f) => [f.name, f.url]))
  return (name: string): string | null => byName.get(name.replace(/^\/+/, '')) ?? null
}

export function toCaptureAssets(source: AssetsSource): CaptureAssets {
  return {
    id: source.id,
    manifest: parseManifest(source.manifestJson),
    status: source.status ?? null,
    derived: source.derived,
    rawUrl: lookup(source.files),
    derivedUrl: lookup(source.derivedFiles),
    ...(source.public === undefined ? {} : { public: source.public }),
  }
}

/**
 * Changes only when something the 3D code reads changes (manifest, a file's rev, derived), not on
 * every status or progress tick, so a scene doesn't reload while a job reports progress. URLs are
 * left out: they're re-signed each day, and yesterday's stay valid for a week (§6.4).
 */
export function assetsKey(source: AssetsSource): string {
  const files = (list: NamedFile[]) => list.map((f) => `${f.name}@${f.rev}`).join('|')
  return [source.id, String(source.public), source.manifestJson, files(source.files), JSON.stringify(source.derived), files(source.derivedFiles)].join('\n')
}

/**
 * The static site (architecture-v3.md §8): every URL inside a data/*.json file is relative to
 * that JSON file, so the export works from any folder or sub-path (GitHub Pages project sites).
 */
export const staticPaths = {
  captures: () => 'data/captures.json',
  capture: (id: string) => `data/captures/${encodeURIComponent(id)}.json`,
  moment: (id: string) => `data/moments/${encodeURIComponent(id)}.json`,
  progress: (id: string) => `data/progress/${encodeURIComponent(id)}.json`,
  session: (id: string) => `data/sessions/${encodeURIComponent(id)}.json`,
  arrangement: () => 'data/museum/arrangement.json',
}

/** A URL from a static JSON file, made absolute against that file's own URL. */
export const resolveFrom = (jsonUrl: string, url: string): string => new URL(url, jsonUrl).href

export function resolveFiles(files: NamedFile[], jsonUrl: string): NamedFile[] {
  return files.map((f) => ({ ...f, url: resolveFrom(jsonUrl, f.url) }))
}
