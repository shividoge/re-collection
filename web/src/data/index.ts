// The data layer: everything the web reads or changes goes through here (Convex in live mode,
// the static export in static mode). Views and 3D code never fetch on their own.
import type { FetchBytes } from './assets'
import { pageCache } from './cache'

export type { CaptureAssets, FetchBytes } from './assets'
export * from './types'
export { dataMode, type DataMode } from './mode'
export { DataProvider } from './DataProvider'
export { loadCaptureAssets, useCaptureAssets, MissingCaptureError, type AssetsState } from './loadAssets'
export { publicData } from './public'
export { errorMessage, errorCode, errorList } from './errors'
export type { Loadable } from './useLive'

/** Cached (~512 MB LRU by bytes), de-duplicated while in flight, ranges cached per range. */
export const fetchBytes: FetchBytes = pageCache.fetchBytes
export const fetchText = (url: string): Promise<string> => pageCache.fetchText(url)

// Live mode only (family tools, Revisit sessions, Visit together).
export { useHealth, useCaptures, useMoment, useProgress, useProgressMany, usePerson, useCaptureStatus, useNow, family, sessions, uploadsApi, onlineWorkers, WORKER_ONLINE_MS, type UploadsApi } from './live'
export { loadVisitSources, arrangements, rooms, guide, type GuideWords, type GuideAnswer, type VisitSource } from './museum'
export { palaceLive, type LiveAudio, type LiveSignal } from './palace'
