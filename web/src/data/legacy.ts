// Transitional: the old scene code fetches by (capture id, file name). These map that onto the
// capture's presigned URLs and the shared cache. Delete once scene/ takes `assets` (render worker).
import { pageCache } from './cache'
import { knownAssets } from './loadAssets'

function urlOf(id: string, name: string): string {
  const url = knownAssets(id)?.rawUrl(name)
  if (!url) throw new Error(`This capture has no ${name}.`)
  return url
}

export const fetchCaptureFile = (id: string, name: string, signal?: AbortSignal) => pageCache.fetchBytes(urlOf(id, name), { signal })
export const fetchCaptureRange = (id: string, name: string, start: number, length: number, signal?: AbortSignal) =>
  pageCache.fetchBytes(urlOf(id, name), { range: [start, length], signal })
