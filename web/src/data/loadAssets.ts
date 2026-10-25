// CaptureAssets for one capture: once (loadCaptureAssets) or live (useCaptureAssets).
import { useEffect, useMemo, useState } from 'react'
import type { CaptureAssets } from './assets'
import { assetsKey, resolveFiles, staticPaths, toCaptureAssets, type AssetsSource } from './captureAssets'
import { api, convex } from './convex'
import { errorMessage } from './errors'
import { dataMode } from './mode'
import { readStaticJson } from './public'
import { useLive } from './useLive'
import { localAssetsFromQuery } from '../scene/dev/localAssets'
import type { PublicCaptureDetail } from './types'

export type AssetsState = { status: 'loading' } | { status: 'ready'; assets: CaptureAssets } | { status: 'missing' } | { status: 'error'; message: string }
type Opts = { public?: boolean }

export class MissingCaptureError extends Error {
  constructor() {
    super('This visit isn’t here any more, or it isn’t shared.')
  }
}


async function staticSource(id: string): Promise<AssetsSource | null> {
  const found = await readStaticJson<PublicCaptureDetail>(staticPaths.capture(id))
  if (!found) return null
  const { body, url } = found
  return {
    ...body, files: resolveFiles(body.files, url), derivedFiles: resolveFiles(body.derivedFiles, url),
    ...(body.reconstruction ? { reconstruction: { ...body.reconstruction, files: resolveFiles(body.reconstruction.files, url), derivedFiles: resolveFiles(body.reconstruction.derivedFiles, url) } } : {}),
  }
}

async function liveSource(id: string, opts: Opts): Promise<AssetsSource | null> {
  return opts.public ? convex().query(api.public.capture, { captureId: id }) : convex().query(api.captures.get, { captureId: id })
}

/** One capture's assets. Rejects with MissingCaptureError when it doesn't exist (or isn't public). */
export async function loadCaptureAssets(id: string, opts: Opts = {}): Promise<CaptureAssets> {
  const source = dataMode === 'static' ? await staticSource(id) : await liveSource(id, opts)
  if (!source) throw new MissingCaptureError()
  return toCaptureAssets(source)
}

/** A new CaptureAssets only when its content changes (see assetsKey), never per status tick. */
function useStableAssets(source: AssetsSource | null | undefined): AssetsState | null {
  const key = source ? assetsKey(source) : null
  return useMemo(() => {
    if (source === undefined) return null
    if (source === null) return { status: 'missing' }
    try {
      return { status: 'ready', assets: toCaptureAssets(source) }
    } catch (e) {
      return { status: 'error', message: errorMessage(e) }
    }
    // Keyed on content on purpose: `source` is a fresh object on every update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, source === null, source === undefined])
}

function useLiveCaptureAssets(id: string | null, opts: Opts = {}): AssetsState {
  const family = useLive(api.captures.get, id && !opts.public ? { captureId: id } : 'skip')
  const visitor = useLive(api.public.capture, id && opts.public ? { captureId: id } : 'skip')
  const result = opts.public ? visitor : family
  const stable = useStableAssets(result.status === 'ready' ? result.data : undefined)
  if (!id) return { status: 'loading' }
  if (result.status === 'error') return { status: 'error', message: result.message }
  return stable ?? { status: 'loading' }
}

function useStaticCaptureAssets(id: string | null): AssetsState {
  const [state, setState] = useState<{ id: string; state: AssetsState } | null>(null)
  useEffect(() => {
    if (!id) return
    let cancelled = false
    loadCaptureAssets(id)
      .then((assets) => !cancelled && setState({ id, state: { status: 'ready', assets } }))
      .catch((e: unknown) => {
        if (cancelled) return
        setState({ id, state: e instanceof MissingCaptureError ? { status: 'missing' } : { status: 'error', message: errorMessage(e) } })
      })
    return () => {
      cancelled = true
    }
  }, [id])
  return state && state.id === id ? state.state : { status: 'loading' }
}

/** Dev only: a capture folder on this machine (`?local=<dir>&baked=<dir>`, scene/dev/localAssets.ts). */
function useLocalCaptureAssets(id: string | null): AssetsState {
  const [state, setState] = useState<{ id: string; state: AssetsState } | null>(null)
  useEffect(() => {
    if (!id) return
    let cancelled = false
    localAssetsFromQuery(id)
      .then((assets) => !cancelled && setState({ id, state: assets ? { status: 'ready', assets } : { status: 'missing' } }))
      .catch((e: unknown) => !cancelled && setState({ id, state: { status: 'error', message: errorMessage(e) } }))
    return () => {
      cancelled = true
    }
  }, [id])
  return state && state.id === id ? state.state : { status: 'loading' }
}

const localDev =
  import.meta.env.DEV && typeof location !== 'undefined' && new URLSearchParams(location.search).has('local')

/**
 * One capture's assets, kept up to date in live mode (a finished bake swaps in `derived`).
 * `assets.status` is the status when the content last changed; for live pipeline status use
 * useCaptureStatus.
 */
export const useCaptureAssets: (id: string | null, opts?: Opts) => AssetsState = localDev
  ? useLocalCaptureAssets
  : dataMode === 'live' ? useLiveCaptureAssets : useStaticCaptureAssets
