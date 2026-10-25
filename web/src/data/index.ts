// TEMPORARY shim so web/render-v3 compiles on its own. The real data layer (web/data-v3) replaces
// this whole file at integration; nothing here is meant to survive it.
import { useEffect, useState } from 'react'
import type { CaptureAssets, FetchBytes } from './assets'

export type { CaptureAssets, FetchBytes } from './assets'

export type AssetsState = { status: 'loading' } | { status: 'ready'; assets: CaptureAssets } | { status: 'missing' } | { status: 'error'; message: string }

const bytes = new Map<string, Promise<ArrayBuffer>>()

/** Page-lifetime cache, one entry per URL (and per range). Returned buffers are shared: copy before transferring. */
export const fetchBytes: FetchBytes = (url, init = {}) => {
  const { range } = init
  const key = range ? `${url}#${range[0]}+${range[1]}` : url
  let hit = bytes.get(key)
  if (!hit) {
    const headers: Record<string, string> = range ? { Range: `bytes=${range[0]}-${range[0] + range[1] - 1}` } : {}
    hit = fetch(url, { headers }).then(async (r) => {
      if (!r.ok) throw new Error(`Couldn't download ${url} (HTTP ${r.status}).`)
      const buf = await r.arrayBuffer()
      return range && r.status !== 206 ? buf.slice(range[0], range[0] + range[1]) : buf
    })
    hit.catch(() => bytes.delete(key))
    bytes.set(key, hit)
  }
  return hit
}

export const fetchText = async (url: string): Promise<string> => new TextDecoder().decode(await fetchBytes(url))

/** Dev only: `?local=<capture folder>&baked=<baked folder>` serves a folder on this machine (scene/dev/localAssets.ts). */
export function useCaptureAssets(id: string | null, _opts?: { public?: boolean }): AssetsState {
  const [state, setState] = useState<AssetsState>({ status: 'loading' })
  useEffect(() => {
    if (!id) return
    let cancelled = false
    const run = async (): Promise<AssetsState> => {
      if (!import.meta.env.DEV) return { status: 'error', message: 'The v3 data layer is not merged into this branch yet.' }
      const { localAssetsFromQuery } = await import('../scene/dev/localAssets')
      const assets = await localAssetsFromQuery(id)
      return assets ? { status: 'ready', assets } : { status: 'error', message: 'Open with ?local=<capture folder>&baked=<baked folder> (dev only).' }
    }
    run()
      .then((s) => !cancelled && setState(s))
      .catch((e: Error) => !cancelled && setState({ status: 'error', message: e.message }))
    return () => {
      cancelled = true
    }
  }, [id])
  return state
}
