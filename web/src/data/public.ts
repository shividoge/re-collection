// What visitors can read: the public.* queries in live mode, the static export's JSON files in
// static mode. Read once (the front page doesn't need live updates). Never status internals.
import { api, convex } from './convex'
import { resolveFrom, staticPaths } from './captureAssets'
import { dataMode, staticUrl } from './mode'
import type { Arrangement, Moment, Progress, PublicCapture, Session } from './types'

/** A static JSON file, or null when the export doesn't have it. Always asks whether it changed. */
export async function readStaticJson<T>(path: string): Promise<{ url: string; body: T } | null> {
  const url = staticUrl(path)
  let response: Response
  try {
    response = await fetch(url, { cache: 'no-cache' })
  } catch {
    throw new Error('Can’t reach the site right now.')
  }
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Couldn’t load ${path} (HTTP ${response.status}).`)
  return { url, body: (await response.json()) as T }
}

const live = dataMode === 'live'

export const publicData = {
  async captures(): Promise<PublicCapture[]> {
    if (live) return convex().query(api.public.captures, {})
    const found = await readStaticJson<PublicCapture[]>(staticPaths.captures())
    if (!found) return []
    return found.body.map((c) => ({ ...c, thumbUrl: c.thumbUrl ? resolveFrom(found.url, c.thumbUrl) : null }))
  },
  async moment(id: string): Promise<Moment | null> {
    if (live) return convex().query(api.public.moment, { captureId: id })
    return (await readStaticJson<Moment>(staticPaths.moment(id)))?.body ?? null
  },
  async progress(id: string): Promise<Progress | null> {
    if (live) return convex().query(api.public.progress, { captureId: id })
    return (await readStaticJson<Progress>(staticPaths.progress(id)))?.body ?? null
  },
  async session(sessionId: string): Promise<Session | null> {
    if (live) return convex().query(api.public.session, { sessionId })
    return (await readStaticJson<Session>(staticPaths.session(sessionId)))?.body ?? null
  },
  /** The caretaker's museum, public pictures only; null when none was saved. */
  async arrangement(): Promise<Arrangement | null> {
    if (live) return convex().query(api.public.arrangement, {})
    return (await readStaticJson<Arrangement>(staticPaths.arrangement()))?.body ?? null
  },
}
