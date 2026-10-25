// What hangs in the museum. An exhibition is a title and a list of pictures and videos, in
// visiting order. The museum shows one: "Our visits", made from the family's captures (each
// visit's video and a few of its keyframes) the way the caretaker arranged it in the editor, or
// the automatic arrangement until they do. Nothing is invented: it only shows what was filmed.

import type { Arrangement, ArrangementItem } from '../api'
import type { CaptureAssets, Manifest } from '../data/assets'
import { arrangements, loadVisitSources } from '../data'

export type ArtworkKind = 'photo' | 'video'

export interface Artwork {
  id: string
  kind: ArtworkKind
  /** URL of the image or video. */
  src: string
  /** For a video: a still shown until it plays (or if this browser can't play it). */
  poster?: string
  title?: string
  /** Shown as written, e.g. "June 2019" or "Sunday, 3 March". */
  date?: string
  caption?: string
  /** For a visit: stepping in opens its 3D room, at second `t` of the visit (this picture's moment). */
  captureId?: string
  t?: number
  /** From a visit rebuilt from an ordinary video: its room is estimated, not measured. */
  estimated?: boolean
}

export interface Exhibition {
  id: string
  title: string
  subtitle?: string
  items: Artwork[]
}

const formatDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : ''

/** A finished visit, with what's needed to hang pieces of it. */
export interface Visit {
  id: string
  title: string
  date: string
  thumb: boolean
  manifest: Manifest
  /** The visit's files (the same object stepping in uses, so nothing loads twice). */
  assets: CaptureAssets
}

/** Every finished visit, oldest first (on the public site: the published ones). Manifests load in parallel. */
export async function loadVisits(): Promise<Visit[]> {
  try {
    const sources = await loadVisitSources()
    return sources.map((s) => ({ id: s.id, title: s.title || s.assets.manifest.title || 'A visit', date: formatDate(s.createdAt), thumb: s.hasThumb, manifest: s.assets.manifest, assets: s.assets }))
  } catch {
    return []
  }
}

/** The pieces of a visit that can hang: its video, its thumbnail, and a still every few seconds. */
export function piecesOf(v: Visit): string[] {
  const out: string[] = []
  if (v.manifest.video?.file) out.push('video')
  if (v.thumb) out.push('thumb')
  const kf = v.manifest.keyframes
  if (kf && kf.count > 0) {
    const step = Math.max(1, Math.round(kf.count / 10))
    for (let k = 0; k < kf.count; k += step) out.push(`k${String(k).padStart(4, '0')}`)
  }
  return out
}

/** One piece of a visit as a picture on the wall; null if the visit doesn't have that piece. */
export function pieceArtwork(v: Visit, piece: string, title = '', caption = '', n = 0): Artwork | null {
  const url = (name: string) => v.assets.rawUrl(name) ?? undefined
  const poster = v.thumb ? url('thumb.jpg') : undefined
  const base = { id: `${v.id}-${piece}-${n}`, title: title || v.title, date: v.date, caption: caption || undefined, captureId: v.id, estimated: v.manifest.source === 'video' || undefined }
  const video = v.manifest.video?.file ? url(v.manifest.video.file) : undefined
  if (piece === 'video') return video ? { ...base, kind: 'video', src: video, poster, t: 0 } : null
  if (piece === 'thumb') return poster ? { ...base, kind: 'photo', src: poster, t: 0 } : null
  const kf = v.manifest.keyframes
  const k = /^k(\d{4})$/.exec(piece)
  if (!k || !kf || Number(k[1]) >= kf.count) return null
  const src = url(`${kf.dir}/${piece}.jpg`)
  return src ? { ...base, kind: 'photo', src, t: Number(k[1]) * kf.everySec } : null
}

/** The museum the caretaker saved, or null for the automatic one. */
export const loadArrangement = (): Promise<Arrangement | null> => arrangements.load().catch(() => null)
export const saveArrangement = (a: Omit<Arrangement, 'updatedAt'>): Promise<Arrangement> => arrangements.save(a)
export const resetArrangement = (): Promise<void> => arrangements.clear()

/** The museum built from an arrangement: its pictures, in its order, with its words. */
export function arrangedExhibition(a: Arrangement, visits: Visit[]): Exhibition {
  const byId = new Map(visits.map((v) => [v.id, v]))
  const items = a.items.flatMap((item, n) => {
    const v = byId.get(item.capture)
    const art = v ? pieceArtwork(v, item.piece, item.title, item.caption, n) : null
    return art ? [art] : []
  })
  return { id: 'visits', title: a.title || 'Our visits', subtitle: a.subtitle || undefined, items }
}

/** Pictures that fill two rooms of the gallery (layout.ts: 8 in the first, 6 in the last). */
const TWO_ROOMS = 14

/**
 * The automatic museum, before a caretaker arranges one: every visit hangs once (its video),
 * then more stills from the visits fill a second room (repeats are fine for now). The editor
 * starts from this too.
 */
export function automaticArrangement(visits: Visit[]): Arrangement {
  const items: ArrangementItem[] = []
  const hang = (v: Visit, piece: string) => items.push({ capture: v.id, piece, title: '', caption: '' })
  for (const v of visits) {
    const pieces = piecesOf(v)
    const first = pieces.includes('video') ? 'video' : pieces.includes('thumb') ? 'thumb' : null
    if (first) hang(v, first)
  }
  const stills = visits.map((v) => piecesOf(v).filter((p) => p.startsWith('k')))
  for (let round = 0; items.length < TWO_ROOMS && stills.some((s) => s.length > round); round++) {
    for (const [i, s] of stills.entries()) if (s[round] && items.length < TWO_ROOMS) hang(visits[i], s[round])
  }
  for (let i = 0; items.length < TWO_ROOMS && items.length > 0; i++) items.push({ ...items[i] })
  return { title: 'Our visits', subtitle: 'Every visit the family filmed, oldest first', items }
}

/** "Our visits": the caretaker's arrangement if there is one, otherwise the automatic museum. */
export async function visits(): Promise<Exhibition | null> {
  const [all, arrangement] = await Promise.all([loadVisits(), loadArrangement()])
  if (all.length === 0) return null
  return arrangedExhibition(arrangement && arrangement.items.length > 0 ? arrangement : automaticArrangement(all), all)
}

/**
 * The piece a shared walk points at (Visit together): `at` when that piece is still the visit
 * `atId` names (the two screens' lists can differ), else the first piece of that visit, else
 * `at` itself; −1 for the entrance or a piece this museum doesn't have.
 */
export function followIndex(items: Artwork[], at: number, atId: string | null): number {
  const inRange = at >= 0 && at < items.length
  if (atId === null) return inRange ? at : -1
  if (inRange && items[at].captureId === atId) return at
  const first = items.findIndex((a) => a.captureId === atId)
  return first >= 0 ? first : inRange ? at : -1
}
