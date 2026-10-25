// What hangs in the museum. An exhibition is a title and a list of pictures and videos, in
// visiting order. Exhibitions come from three places:
// - web/public/museum/exhibitions.json, curated by hand (format in docs/museum.md);
// - "Our visits", made from the captures on the guide: each visit's video and a few of its
//   keyframes, with the title and date the family gave it;
// - photos and videos dropped onto the museum page, kept in this browser (IndexedDB) so they
//   are still there after a reload.
// Nothing is invented: an exhibition only shows what was put into it.

import { captureFileUrl, fileUrl, guide, publicGuide, STATIC, type Arrangement, type ArrangementItem, type Manifest, type MuseumUpload } from '../api'

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
  /** Added on this device (can be removed again here). */
  local?: boolean
}

export interface Exhibition {
  id: string
  title: string
  subtitle?: string
  items: Artwork[]
  /** Where it came from, for the picker. */
  source: 'curated' | 'visits' | 'local'
}

/** Exhibitions from web/public/museum/exhibitions.json; none if the file isn't there. */
async function curated(): Promise<Exhibition[]> {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}museum/exhibitions.json`, { cache: 'no-cache' })
    if (!response.ok) return []
    const body = (await response.json()) as { exhibitions?: Partial<Exhibition>[] }
    return (body.exhibitions ?? []).flatMap((e, i) => {
      const items = (e.items ?? []).filter((a): a is Artwork => Boolean(a && a.src && (a.kind === 'photo' || a.kind === 'video')))
      if (!e.title) return []
      return [
        {
          id: e.id ?? `curated-${i}`,
          title: e.title,
          subtitle: e.subtitle,
          items: items.map((a, k) => ({ ...a, id: a.id ?? `${e.id ?? i}-${k}` })),
          source: 'curated' as const,
        },
      ]
    })
  } catch {
    return []
  }
}

const formatDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : ''

/** A finished visit on the guide, with what's needed to hang pieces of it. */
export interface Visit {
  id: string
  title: string
  date: string
  thumb: boolean
  manifest: Manifest
}

/** Every finished visit, oldest first (on the public site: the published ones). */
export async function loadVisits(): Promise<Visit[]> {
  let list
  try {
    // The public (static) site has only the visits the family published, all finished uploads.
    list = STATIC
      ? (await publicGuide.captures()).map((c) => ({ ...c, status: { upload: 'done' } }))
      : await guide.captures()
  } catch {
    return []
  }
  const done = list.filter((c) => c.status.upload === 'done').sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  const out: Visit[] = []
  for (const c of done) {
    try {
      const { manifest } = await guide.capture(c.id)
      out.push({ id: c.id, title: c.title || manifest.title || 'A visit', date: formatDate(c.createdAt), thumb: Boolean(c.thumb), manifest })
    } catch {
      // A capture whose manifest can't be read is left out, not guessed at.
    }
  }
  return out
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
  const poster = v.thumb ? captureFileUrl(v.id, 'thumb.jpg') : undefined
  const base = { id: `${v.id}-${piece}-${n}`, title: title || v.title, date: v.date, caption: caption || undefined, captureId: v.id }
  if (piece === 'video') return v.manifest.video?.file ? { ...base, kind: 'video', src: captureFileUrl(v.id, v.manifest.video.file), poster, t: 0 } : null
  if (piece === 'thumb') return poster ? { ...base, kind: 'photo', src: poster, t: 0 } : null
  const kf = v.manifest.keyframes
  const k = /^k(\d{4})$/.exec(piece)
  if (!k || !kf || Number(k[1]) >= kf.count) return null
  return { ...base, kind: 'photo', src: captureFileUrl(v.id, `${kf.dir}/${piece}.jpg`), t: Number(k[1]) * kf.everySec }
}

/**
 * The public site has no server to save to, so a caretaker trying the editor there saves into
 * this browser only (and the museum in this browser shows it).
 */
const LOCAL_ARRANGEMENT = 'braindance.museum.arrangement'

/** The museum the caretaker saved, or null for the automatic one. */
export async function loadArrangement(): Promise<Arrangement | null> {
  if (STATIC) {
    try {
      const local = localStorage.getItem(LOCAL_ARRANGEMENT)
      if (local) return JSON.parse(local) as Arrangement
    } catch {
      /* no storage: fall through to the published one */
    }
    return publicGuide.arrangement()
  }
  return guide.arrangement().catch(() => null)
}

export async function saveArrangement(a: Omit<Arrangement, 'updatedAt'>): Promise<Arrangement> {
  if (STATIC) {
    const saved = { ...a, updatedAt: new Date().toISOString() }
    localStorage.setItem(LOCAL_ARRANGEMENT, JSON.stringify(saved))
    return saved
  }
  return guide.saveArrangement(a)
}

export async function resetArrangement(): Promise<void> {
  if (STATIC) {
    try {
      localStorage.removeItem(LOCAL_ARRANGEMENT)
    } catch {
      /* nothing saved */
    }
    return
  }
  await guide.resetArrangement()
}

/** The caretaker's own photos and videos on the guide (none on the static site, which has no server). */
export async function loadUploads(): Promise<MuseumUpload[]> {
  if (STATIC) return []
  return guide.museumUploads().catch(() => [])
}

/** One of the caretaker's uploads as a picture on the wall. It has no 3D room to step into. */
export function uploadArtwork(u: MuseumUpload, title = '', caption = '', n = 0): Artwork {
  return { id: `${u.id}-${n}`, kind: u.kind, src: fileUrl(u.url), title: title || undefined, caption: caption || undefined }
}

/** The museum built from an arrangement: its pictures, in its order, with its words. */
export function arrangedExhibition(a: Arrangement, visits: Visit[], uploads: MuseumUpload[] = []): Exhibition {
  const byId = new Map(visits.map((v) => [v.id, v]))
  const uploadsById = new Map(uploads.map((u) => [u.id, u]))
  const items = a.items.flatMap((item, n) => {
    if (item.upload) {
      const u = uploadsById.get(item.upload)
      return u ? [uploadArtwork(u, item.title, item.caption, n)] : []
    }
    const v = item.capture ? byId.get(item.capture) : undefined
    const art = v && item.piece ? pieceArtwork(v, item.piece, item.title, item.caption, n) : null
    return art ? [art] : []
  })
  return { id: 'visits', title: a.title || 'Memory Palace', subtitle: a.subtitle || undefined, items, source: 'visits' }
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
  return { title: 'Memory Palace', subtitle: 'Moments with your family', items }
}

/** "Our visits": the caretaker's arrangement if there is one, otherwise the automatic museum. */
export async function visits(): Promise<Exhibition | null> {
  const [all, arrangement, uploads] = await Promise.all([loadVisits(), loadArrangement(), loadUploads()])
  if (arrangement && arrangement.items.length > 0) return arrangedExhibition(arrangement, all, uploads)
  if (all.length === 0) return null
  return arrangedExhibition(automaticArrangement(all), all, uploads)
}

// Files dropped onto the museum, kept in IndexedDB.

interface StoredItem {
  id: string
  exhibitionId: string
  kind: ArtworkKind
  blob: Blob
  title: string
  addedAt: number
}

const DB = 'relive-museum'
const STORE = 'items'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function storedItems(): Promise<StoredItem[]> {
  try {
    const db = await openDb()
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).getAll()
      req.onsuccess = () => resolve(req.result as StoredItem[])
      req.onerror = () => reject(req.error)
    })
  } catch {
    return []
  }
}

const objectUrls = new Map<string, string>()
function urlFor(item: StoredItem): string {
  let url = objectUrls.get(item.id)
  if (!url) objectUrls.set(item.id, (url = URL.createObjectURL(item.blob)))
  return url
}

const asArtwork = (s: StoredItem): Artwork => ({ id: s.id, kind: s.kind, src: urlFor(s), title: s.title, local: true })

/** The kind of a dropped file, or null for anything that isn't a photo or a video. */
export function kindOf(file: File): ArtworkKind | null {
  if (file.type.startsWith('image/')) return 'photo'
  if (file.type.startsWith('video/')) return 'video'
  return null
}

/** Keeps dropped files in this browser, added to `exhibitionId`. Returns them as artworks. */
export async function addFiles(exhibitionId: string, files: File[]): Promise<Artwork[]> {
  const items: StoredItem[] = files.flatMap((file) => {
    const kind = kindOf(file)
    if (!kind) return []
    const title = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ')
    return [{ id: `local-${crypto.randomUUID()}`, exhibitionId, kind, blob: file, title, addedAt: Date.now() }]
  })
  if (items.length === 0) return []
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    for (const item of items) tx.objectStore(STORE).put(item)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  return items.map(asArtwork)
}

export async function removeLocal(id: string): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  const url = objectUrls.get(id)
  if (url) URL.revokeObjectURL(url)
  objectUrls.delete(id)
}

/** The exhibition dropped files go to when nothing else is open. */
export const MY_EXHIBITION = 'mine'

/**
 * Every exhibition: curated ones, "Our visits", and "My exhibition" (only once something was
 * dropped). Dropped files also join whichever exhibition they were dropped into.
 */
export async function loadExhibitions(): Promise<Exhibition[]> {
  const [fromFile, fromGuide, local] = await Promise.all([curated(), visits(), storedItems()])
  const all = [...fromFile, ...(fromGuide ? [fromGuide] : [])]
  local.sort((a, b) => a.addedAt - b.addedAt)
  for (const ex of all) ex.items.push(...local.filter((s) => s.exhibitionId === ex.id).map(asArtwork))
  const mine = local.filter((s) => !all.some((ex) => ex.id === s.exhibitionId))
  if (mine.length > 0 || all.length === 0) {
    all.push({
      id: MY_EXHIBITION,
      title: 'My exhibition',
      subtitle: 'Drop photos and videos here to hang them',
      items: mine.map(asArtwork),
      source: 'local',
    })
  }
  return all
}
