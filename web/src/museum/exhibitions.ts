// What hangs in the museum. An exhibition is a title and a list of pictures and videos, in
// visiting order. Exhibitions come from three places:
// - web/public/museum/exhibitions.json, curated by hand (format in docs/museum.md);
// - "Our visits", made from the captures on the guide: each visit's video and a few of its
//   keyframes, with the title and date the family gave it;
// - photos and videos dropped onto the museum page, kept in this browser (IndexedDB) so they
//   are still there after a reload.
// Nothing is invented: an exhibition only shows what was put into it.

import { captureFileUrl, guide } from '../api'

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

/**
 * "Our visits": every finished capture on the guide, oldest first. Each visit hangs as its video
 * (the moment itself), followed by up to two of its keyframes as photographs.
 */
async function visits(): Promise<Exhibition | null> {
  let list
  try {
    list = await guide.captures()
  } catch {
    return null
  }
  const done = list.filter((c) => c.status.upload === 'done').sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  if (done.length === 0) return null
  const items: Artwork[] = []
  for (const c of done) {
    try {
      const { manifest } = await guide.capture(c.id)
      const title = c.title || manifest.title || 'A visit'
      const date = formatDate(c.createdAt)
      if (manifest.video?.file) {
        const poster = c.thumb ? captureFileUrl(c.id, 'thumb.jpg') : undefined
        items.push({ id: `${c.id}-video`, kind: 'video', src: captureFileUrl(c.id, manifest.video.file), poster, title, date, captureId: c.id, t: 0 })
      }
      const kf = manifest.keyframes
      if (kf && kf.count > 0) {
        for (const s of [Math.floor(kf.count * 0.3), Math.floor(kf.count * 0.7)]) {
          items.push({
            id: `${c.id}-k${s}`,
            kind: 'photo',
            src: captureFileUrl(c.id, `${kf.dir}/k${String(s).padStart(4, '0')}.jpg`),
            title,
            date,
            captureId: c.id,
            t: s * kf.everySec,
          })
        }
      } else if (c.thumb) {
        items.push({ id: `${c.id}-thumb`, kind: 'photo', src: captureFileUrl(c.id, 'thumb.jpg'), title, date, captureId: c.id, t: 0 })
      }
    } catch {
      // A capture whose manifest can't be read is left out, not guessed at.
    }
  }
  return { id: 'visits', title: 'Our visits', subtitle: 'Every visit the family filmed, oldest first', items, source: 'visits' }
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
