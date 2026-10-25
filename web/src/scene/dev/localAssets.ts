// Dev only: a CaptureAssets over folders on this machine, served by Vite's /@fs route
// (run Vite with scene/dev/vite.local.config.ts so those folders are allowed). Lets the viewer be
// checked against a real capture and its bake before the backend exists.
//   ?local=/path/to/capture&baked=/path/to/baked   (baked = the bake worker's output folder)
import { parseManifest } from '../../../../shared/manifest'
import type { CaptureAssets, Derived } from '../../data/assets'

const fsUrl = (dir: string, name: string) => `/@fs${dir.replace(/\/+$/, '')}/${name.split('/').map(encodeURIComponent).join('/')}`

export async function localAssetsFromQuery(id: string): Promise<CaptureAssets | null> {
  if (!import.meta.env.DEV) return null
  const q = new URLSearchParams(location.search)
  const dir = q.get('local')
  if (!dir) return null
  const baked = q.get('baked')
  const res = await fetch(fsUrl(dir, 'manifest.json'))
  if (!res.ok) throw new Error(`No manifest.json in ${dir} (HTTP ${res.status}).`)
  const manifest = parseManifest(await res.text())
  if (manifest.id !== id.toLowerCase()) throw new Error(`The folder holds capture ${manifest.id}, not ${id}.`)
  let derived: Derived | null = null
  if (baked) {
    const d = await fetch(fsUrl(baked, 'derived.json'))
    if (d.ok) derived = (await d.json()) as Derived
  }
  return {
    id: manifest.id,
    manifest,
    status: null,
    derived,
    rawUrl: (name) => fsUrl(dir, name),
    derivedUrl: (name) => (baked ? fsUrl(baked, name) : null),
  }
}
