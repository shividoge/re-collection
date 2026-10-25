// The museum's data: which visits can hang (with their files), the caretaker's arrangement, and
// the "Visit together" rooms (reactive Convex queries replace the guide's SSE and polling).
import type { CaptureAssets } from './assets'
import { api, convex } from './convex'
import { loadCaptureAssets } from './loadAssets'
import { dataMode } from './mode'
import { publicData } from './public'
import type { Arrangement, CaptureSummary, Room, RoomChange, RoomState, RoomWho } from './types'

/** A finished visit and its files. */
export type VisitSource = { id: string; title: string; createdAt: string; hasThumb: boolean; assets: CaptureAssets }

/** Every visit whose upload finished, oldest first (on the static site: the published ones). */
export async function loadVisitSources(): Promise<VisitSource[]> {
  type Listed = { id: string; title: string; createdAt: string; thumbUrl: string | null }
  let list: Listed[]
  if (dataMode === 'static') list = await publicData.captures()
  else {
    const all: CaptureSummary[] = await convex().query(api.captures.list, {})
    list = all.filter((c) => c.status.upload === 'done')
  }
  const sorted = [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const loaded = await Promise.all(
    sorted.map(async (c) => {
      try {
        const assets = await loadCaptureAssets(c.id)
        return { id: c.id, title: c.title, createdAt: c.createdAt, hasThumb: c.thumbUrl !== null, assets }
      } catch {
        // A capture whose manifest can't be read is left out, not guessed at.
        return null
      }
    }),
  )
  return loaded.filter((v): v is VisitSource => v !== null)
}

/**
 * The static site has no server to save to, so a caretaker trying the editor there saves into
 * this browser only (and the museum in this browser shows it).
 */
const LOCAL_ARRANGEMENT = 'braindance.museum.arrangement'

export const arrangements = {
  /** The museum the caretaker saved, or null for the automatic one. */
  async load(): Promise<Arrangement | null> {
    if (dataMode === 'live') return convex().query(api.museum.getArrangement, {})
    try {
      const local = localStorage.getItem(LOCAL_ARRANGEMENT)
      if (local) return JSON.parse(local) as Arrangement
    } catch {
      /* no storage: fall through to the published one */
    }
    return publicData.arrangement()
  },
  async save(a: Omit<Arrangement, 'updatedAt'>): Promise<Arrangement> {
    if (dataMode === 'live') return convex().mutation(api.museum.setArrangement, { title: a.title, subtitle: a.subtitle, items: a.items })
    const saved = { ...a, updatedAt: new Date().toISOString() }
    localStorage.setItem(LOCAL_ARRANGEMENT, JSON.stringify(saved))
    return saved
  },
  async clear(): Promise<void> {
    if (dataMode === 'live') {
      await convex().mutation(api.museum.clearArrangement, {})
      return
    }
    try {
      localStorage.removeItem(LOCAL_ARRANGEMENT)
    } catch {
      /* nothing saved */
    }
  },
}

export const rooms = {
  create: (at: number) => convex().mutation(api.museum.createRoom, { at }),
  setState: (code: string, change: RoomChange): Promise<{ state: RoomState }> => convex().mutation(api.museum.setState, { ...change, code }),
  heartbeat: async (code: string, who: RoomWho) => {
    await convex().mutation(api.museum.heartbeat, { code, client: who.client, as: who.as, name: who.name })
  },
  /** Calls `onRoom` with the room now and on every change (null: no such room). Returns stop. */
  watch(code: string, onRoom: (room: Room | null) => void, onError: (error: unknown) => void): () => void {
    const watch = convex().watchQuery(api.museum.room, { code })
    const read = () => {
      let room: Room | null | undefined
      try {
        room = watch.localQueryResult()
      } catch (error) {
        return onError(error)
      }
      if (room !== undefined) onRoom(room)
    }
    const stop = watch.onUpdate(read)
    read()
    return stop
  },
  /** Calls `onChange(connected)` when the connection to Convex drops or comes back. */
  connection(onChange: (connected: boolean) => void): () => void {
    const client = convex()
    let last = client.connectionState().isWebSocketConnected
    return client.subscribeToConnectionState((s) => {
      if (s.isWebSocketConnected === last) return
      last = s.isWebSocketConnected
      onChange(last)
    })
  },
}

/** One memory's words from the AI guide (backend guide.ts): `intro` at the frame, `story` inside. */
export type GuideWords = { key: string; status: 'preparing' | 'ready' | 'failed'; intro: string; story: string; error: string | null }
/** What the guide says back to something the person said. */
export type GuideAnswer = { say: string; distress: boolean; retrieval: 'moss' | 'all'; mossMs: number; dropped: number }

/**
 * The AI guide (live mode only: it needs Convex, Moss, Claude and Cartesia). A memory is keyed
 * "<capture>/<piece>", like the arrangement item it comes from.
 */
export const guide = {
  available: () => dataMode === 'live',
  key: (item: { capture: string; piece: string }) => `${item.capture}/${item.piece}`,
  /** Every memory's guide words, kept up to date as the caretaker saves. Returns a stop function. */
  watch(onWords: (words: GuideWords[]) => void): () => void {
    const watch = convex().watchQuery(api.guide.narration, {})
    const read = () => {
      try {
        const words = watch.localQueryResult()
        if (words) onWords(words)
      } catch {
        /* a failed query: the guide stays quiet */
      }
    }
    read()
    return watch.onUpdate(read)
  },
  ask: (key: string, question: string): Promise<GuideAnswer> => convex().action(api.guideNode.ask, { key, question }),
  voiceToken: (): Promise<{ token: string; expiresAt: number; voice: string; version: string; keyterms: string[] }> => convex().action(api.guideNode.voiceToken, {}),
}
