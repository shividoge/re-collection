// Client for the guide server (docs/guide-api.md). In production the guide
// serves this app, so requests are same-origin; in dev, Vite proxies them.

const KEY_STORAGE = 'braindance.guideKey'
const base = (import.meta.env.VITE_GUIDE_URL as string | undefined)?.replace(/\/+$/, '') ?? ''

export type CaptureStatus = {
  /** True when the family marked this capture public (visitors see it without a key). */
  public?: boolean
  upload: 'receiving' | 'done' | 'invalid'
  uploadErrors?: string[]
  warnings?: string[]
  facts: string
  factsError: string | null
}

export type CaptureSummary = {
  /** \"video\" for scenes rebuilt from an ordinary video (estimated). */
  source?: string | null
  id: string
  title: string
  createdAt: string | null
  durationSec: number | null
  thumb: string | null
  status: CaptureStatus
}

export type Manifest = {
  id: string
  createdAt: string
  title: string
  attendees: string[]
  video: { file: string; width: number; height: number; fps: number; durationSec: number; frameCount: number }
  depth: { file: string; confidenceFile: string; width: number; height: number; rateHz: number; count: number; estimated?: boolean; model?: string }
  /** "video" when rebuilt from an ordinary video (estimated); absent for LiDAR scans. */
  source?: string
  room?: { bin: string; ply: string; points: number; voxelMeters: number }
  transcript?: { file: string; locale: string }
  keyframes?: { dir: string; everySec: number; count: number }
  warnings: string[]
}

export type CaptureDetail = {
  id: string
  manifest: Manifest
  status: CaptureStatus
  files: Record<string, string>
}

export type Evidence = { type: 'frame'; t: number; keyframe: string } | { type: 'transcript'; tStart: number; tEnd: number; quote: string }

export type Fact = {
  id: string
  text: string
  kind: 'person' | 'object' | 'action' | 'speech' | 'place' | 'feeling'
  salience: 1 | 2 | 3
  evidence: Evidence[]
  cue: string
  status: 'pending' | 'approved' | 'rejected'
  editedText: string | null
  doNotRaise: boolean
}

export type Moment = {
  captureId: string
  moment: { title: string; place: string; occasion: string; summary: string }
  facts: Fact[]
  chapters: { tStart: number; tEnd: number; label: string }[]
  dropped: { text: string; reason: string }[]
  inputs: { keyframes: number; transcriptSegments: number | null }
  extractedAt: string
  model: string
}

export type FactChange = Partial<Pick<Fact, 'status' | 'editedText' | 'doNotRaise'>>

export type Sentence = { sentence: string; factIds: string[]; free?: boolean }
export type Reply = { sentences: Sentence[]; dropped: { sentence: string; reason: string }[] }
export type Score = { factId: string; result: 'unprompted' | 'after_cue' | 'not_mentioned'; line?: number }
export type Branch = { t: string; quote: string; note: string }
export type Alert = { t: string; kind: 'distress'; note: string }
export type EndReason = 'complete' | 'caregiver' | 'distress' | 'timeout'
export type SessionEnd = { scores: Score[]; branches: Branch[]; note: string; alerts: Alert[] }
export type Progress = {
  momentId: string
  facts: { id: string; text: string }[]
  sessions: {
    sessionId: string
    startedAt: string
    endedAt: string
    endReason: string
    unprompted: number
    afterCue: number
    notMentioned: number
    scores: Score[]
    branches: Branch[]
    alerts: Alert[]
    note: string
  }[]
  nextRevisit: string[]
}

export class GuideError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function getKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? ''
  } catch {
    return ''
  }
}

export function setKey(key: string) {
  try {
    localStorage.setItem(KEY_STORAGE, key)
  } catch {
    // Private mode: the key lasts for this page only.
  }
  memoryKey = key
}

let memoryKey = getKey()

/**
 * A static build (VITE_STATIC=1) has no server: everything a visitor reads was exported to plain
 * files under data/ (guide/scripts/export-static.mjs), so the same /public paths are mapped onto
 * those files. It is always public.
 */
export const STATIC = import.meta.env.VITE_STATIC === '1'

/**
 * Public mode is for visitors: every request goes to the read-only /public routes, no key is
 * sent, and nothing can change. The viewer is the same code either way; only the paths differ.
 */
let publicMode = STATIC
export function setPublicMode(on: boolean) {
  publicMode = on
}

function route(path: string): string {
  if (!publicMode) return path
  return path
    .replace(/^\/api\/captures\/([^/?]+)$/, '/public/captures/$1')
    .replace(/^\/api\/moments\/([^/?]+)$/, '/public/moments/$1')
    .replace(/^\/files\//, '/public/files/')
}

/** Where a request really goes: the guide, or an exported file in a static build. */
function url(path: string): string {
  const routed = route(path)
  if (!STATIC) return base + routed
  const file = routed
    .replace(/^\/public\/captures$/, 'data/captures.json')
    .replace(/^\/public\/(captures|moments|progress|sessions)\/([^/?]+)$/, 'data/$1/$2.json')
    .replace(/^\/public\/files\//, 'data/files/')
  return import.meta.env.BASE_URL + file
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return memoryKey && !publicMode ? { 'X-Braindance-Key': memoryKey, ...extra } : extra
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    // A static host lets browsers reuse files for minutes; always ask whether the data changed.
    response = await fetch(url(path), { ...init, ...(STATIC ? { cache: 'no-cache' as const } : {}), headers: headers(init.headers as Record<string, string>) })
  } catch {
    throw new GuideError(0, "Can't reach the guide server. Is it running (npm start in guide/)?")
  }
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new GuideError(response.status, body.error ?? `HTTP ${response.status}`)
  return body as T
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json' },
})

/** What visitors can see (docs/guide-api.md "Public routes"). No key, read-only. */
export type PublicCapture = {
  id: string
  title: string
  summary: string
  createdAt: string | null
  durationSec: number | null
  thumb: string | null
  facts: number
}
export type PublicSession = {
  id: string
  momentId: string
  startedAt: string
  endedAt: string
  endReason: string
  turns: { t: string; speaker: string; text: string; kind?: string; factIds?: string[] }[]
  dropped: { t: string; sentence: string; reason: string }[]
  branches: Branch[]
  scores: Score[]
  note: string
}

async function publicGet<T>(path: string): Promise<T> {
  let response: Response
  try {
    // A static host lets browsers reuse files for minutes; always ask whether the data changed.
    response = await fetch(url(path), STATIC ? { cache: 'no-cache' } : undefined)
  } catch {
    throw new GuideError(0, "Can't reach the site's server right now.")
  }
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new GuideError(response.status, body.error ?? `HTTP ${response.status}`)
  return body as T
}

export const publicGuide = {
  captures: () => publicGet<PublicCapture[]>('/public/captures'),
  moment: (id: string) => publicGet<Moment>(`/public/moments/${id}`),
  progress: (id: string) => publicGet<Progress>(`/public/progress/${id}`),
  session: (sid: string) => publicGet<PublicSession>(`/public/sessions/${sid}`),
  file: (id: string, name: string) => url(`/public/files/${id}/${name}`),
}

export const guide = {
  /** The family's switch: only a public capture is visible to visitors. Needs the key. */
  setPublic: (id: string, on: boolean) =>
    request<{ ok: true; public: boolean }>(`/api/captures/${id}/public`, {
      method: 'PUT',
      body: JSON.stringify({ public: on }),
      headers: { 'Content-Type': 'application/json' },
    }),
  health: () => request<{ ok: boolean; mock: boolean; keyRequired?: boolean }>('/health'),
  captures: () => request<CaptureSummary[]>('/api/captures'),
  capture: (id: string) => request<CaptureDetail>(`/api/captures/${id}`),
  putFile: (id: string, name: string, data: Uint8Array) =>
    request<{ ok: true; bytes: number }>(`/api/captures/${id}/files/${name.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'PUT',
      body: data as BodyInit,
      headers: { 'Content-Type': 'application/octet-stream' },
    }),
  complete: (id: string) => request<{ ok: true }>(`/api/captures/${id}/complete`, { method: 'POST' }),
  moment: (id: string) => request<Moment>(`/api/moments/${id}`),
  updateFact: (id: string, factId: string, change: FactChange) =>
    request<Fact>(`/api/moments/${id}/facts/${factId}`, {
      method: 'PATCH',
      body: JSON.stringify(change),
      headers: { 'Content-Type': 'application/json' },
    }),
  person: () => request<{ displayName: string; preferredAddress: string }>('/api/person'),
  startSession: (momentId: string) => request<{ sessionId: string; welcome: Reply }>('/api/sessions', post({ momentId })),
  /** `chapterIndex: null` narrates the whole moment (for moments without chapters). */
  narrate: (sid: string, chapterIndex: number | null) => request<{ reply: Reply }>(`/api/sessions/${sid}/narrate`, post({ chapterIndex })),
  /** `focus`: what they're pointing at in the room and the approved facts seen with it (optional). */
  turn: (sid: string, text: string, focus?: { label: string; factIds: string[] }) =>
    request<{ reply: Reply; branch: string | null; distress: boolean }>(`/api/sessions/${sid}/turn`, post({ text, focus })),
  /** `keepalive` lets the request finish while the page unloads (a visit left open by a reload). */
  endSession: (sid: string, reason: EndReason, keepalive = false) =>
    request<SessionEnd>(`/api/sessions/${sid}/end`, { ...post({ reason }), keepalive }),
  session: (sid: string) => request<{ turns: unknown[]; dropped?: unknown[] }>(`/api/sessions/${sid}`),
  progress: (momentId: string) => request<Progress>(`/api/progress?momentId=${encodeURIComponent(momentId)}`),
  reextract: (id: string) => request<{ ok: true }>(`/api/moments/${id}/extract`, { method: 'POST' }),
}

/** URL for a capture file. <video> and <img> can't send headers, so the key rides as ?key=. */
export function fileUrl(path: string): string {
  return url(path) + (memoryKey && !publicMode ? `?key=${encodeURIComponent(memoryKey)}` : '')
}

export function captureFileUrl(id: string, name: string): string {
  return fileUrl(`/files/${id}/${name}`)
}

/** Fetches a byte range of a capture file (used for depth frames). */
export async function fetchRange(id: string, name: string, start: number, length: number): Promise<ArrayBuffer> {
  const response = await fetch(url(`/files/${id}/${name}`), {
    headers: headers({ Range: `bytes=${start}-${start + length - 1}` }),
  })
  if (!response.ok) throw new GuideError(response.status, `${name}: HTTP ${response.status}`)
  return response.arrayBuffer()
}

export async function fetchBytes(id: string, name: string): Promise<ArrayBuffer> {
  const response = await fetch(url(`/files/${id}/${name}`), { headers: headers() })
  if (!response.ok) throw new GuideError(response.status, `${name}: HTTP ${response.status}`)
  return response.arrayBuffer()
}

export async function fetchText(id: string, name: string): Promise<string> {
  const response = await fetch(url(`/files/${id}/${name}`), { headers: headers() })
  if (!response.ok) throw new GuideError(response.status, `${name}: HTTP ${response.status}`)
  return response.text()
}

/** "Visit together" (docs/guide-api.md "Visit together (museum rooms)"). */
export type RoomRole = 'patient' | 'helper'
export type RoomState = { at: number; window: string | null; by: RoomRole; name: string | null; rev: number; updatedAt: string }
export type RoomChange = { at: number; window: string | null; by: RoomRole; name?: string | null }
export type RoomPeers = { patient: number; helpers: string[] }
export type Room = { code: string; state: RoomState; peers: RoomPeers }

export const museumRooms = {
  create: (at: number) => request<Room>('/api/museum/rooms', post({ at })),
  get: (code: string) => request<Room>(`/api/museum/rooms/${encodeURIComponent(code)}`),
  setState: (code: string, change: RoomChange) =>
    request<{ ok: true; state: RoomState }>(`/api/museum/rooms/${encodeURIComponent(code)}/state`, post(change)),
  /** EventSource can't send headers, so the key rides as ?key= here too. */
  eventsUrl: (code: string, as: RoomRole, name: string | null) => {
    const query = new URLSearchParams({ as })
    if (name) query.set('name', name)
    if (memoryKey) query.set('key', memoryKey)
    return `${base}/api/museum/rooms/${encodeURIComponent(code)}/events?${query}`
  },
}
