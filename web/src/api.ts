// Client for the guide server (docs/guide-api.md). In production the guide
// serves this app, so requests are same-origin; in dev, Vite proxies them.

const KEY_STORAGE = 'braindance.guideKey';
const base = (import.meta.env.VITE_GUIDE_URL as string | undefined)?.replace(/\/+$/, '') ?? '';

export type CaptureStatus = {
  public?: boolean;
  upload: 'receiving' | 'done' | 'invalid';
  uploadErrors?: string[];
  warnings?: string[];
  facts: string;
  factsError: string | null;
};

export type CaptureSummary = {
  id: string;
  title: string;
  createdAt: string | null;
  durationSec: number | null;
  thumb: string | null;
  status: CaptureStatus;
};

export type Manifest = {
  id: string;
  createdAt: string;
  title: string;
  attendees: string[];
  video: { file: string; width: number; height: number; fps: number; durationSec: number; frameCount: number };
  depth: { file: string; confidenceFile: string; width: number; height: number; rateHz: number; count: number };
  room?: { bin: string; ply: string; points: number; voxelMeters: number };
  transcript?: { file: string; locale: string };
  keyframes?: { dir: string; everySec: number; count: number };
  warnings: string[];
};

export type CaptureDetail = {
  id: string;
  manifest: Manifest;
  status: CaptureStatus;
  files: Record<string, string>;
};

export type Evidence =
  | { type: 'frame'; t: number; keyframe: string }
  | { type: 'transcript'; tStart: number; tEnd: number; quote: string };

export type Fact = {
  id: string;
  text: string;
  kind: 'person' | 'object' | 'action' | 'speech' | 'place' | 'feeling';
  salience: 1 | 2 | 3;
  evidence: Evidence[];
  cue: string;
  status: 'pending' | 'approved' | 'rejected';
  editedText: string | null;
  doNotRaise: boolean;
};

export type Moment = {
  captureId: string;
  moment: { title: string; place: string; occasion: string; summary: string };
  facts: Fact[];
  chapters: { tStart: number; tEnd: number; label: string }[];
  dropped: { text: string; reason: string }[];
  inputs: { keyframes: number; transcriptSegments: number | null };
  extractedAt: string;
  model: string;
};

export type FactChange = Partial<Pick<Fact, 'status' | 'editedText' | 'doNotRaise'>>;

export type Sentence = { sentence: string; factIds: string[]; free?: boolean };
export type Reply = { sentences: Sentence[]; dropped: { sentence: string; reason: string }[] };
export type Score = { factId: string; result: 'unprompted' | 'after_cue' | 'not_mentioned'; line?: number };
export type Branch = { t: string; quote: string; note: string };
export type Alert = { t: string; kind: 'distress'; note: string };
export type EndReason = 'complete' | 'caregiver' | 'distress' | 'timeout';
export type SessionEnd = { scores: Score[]; branches: Branch[]; note: string; alerts: Alert[] };
export type Progress = {
  momentId: string;
  facts: { id: string; text: string }[];
  sessions: {
    sessionId: string;
    startedAt: string;
    endedAt: string;
    endReason: string;
    unprompted: number;
    afterCue: number;
    notMentioned: number;
    scores: Score[];
    branches: Branch[];
    note: string;
  }[];
  nextRevisit: string[];
};

export class GuideError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function getKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

export function setKey(key: string) {
  try {
    localStorage.setItem(KEY_STORAGE, key);
  } catch {
    // Private mode: the key lasts for this page only.
  }
  memoryKey = key;
}

let memoryKey = getKey();

/**
 * Public mode is for visitors: every request goes to the read-only /public
 * routes, no key is sent, and nothing can change. The viewer is the same code
 * either way; only the paths differ.
 */
let publicMode = false;
export function setPublicMode(on: boolean) {
  publicMode = on;
}
export const isPublicMode = () => publicMode;

function route(path: string): string {
  if (!publicMode) return path;
  return path
    .replace(/^\/api\/captures\/([^/?]+)$/, '/public/captures/$1')
    .replace(/^\/api\/moments\/([^/?]+)$/, '/public/moments/$1')
    .replace(/^\/files\//, '/public/files/');
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return memoryKey && !publicMode ? { 'X-Braindance-Key': memoryKey, ...extra } : extra;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(base + route(path), { ...init, headers: headers(init.headers as Record<string, string>) });
  } catch {
    throw new GuideError(0, "Can't reach the guide server. Is it running (npm start in guide/)?");
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new GuideError(response.status, body.error ?? `HTTP ${response.status}`);
  return body as T;
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json' },
});

/** What visitors can see (docs/guide-api.md "Public routes"). No key, read-only. */
export type PublicCapture = {
  id: string;
  title: string;
  summary: string;
  createdAt: string | null;
  durationSec: number | null;
  thumb: string | null;
  facts: number;
};
export type PublicSession = {
  id: string;
  momentId: string;
  startedAt: string;
  endedAt: string;
  endReason: string;
  turns: { t: string; speaker: string; text: string; kind?: string; factIds?: string[] }[];
  dropped: { t: string; sentence: string; reason: string }[];
  branches: Branch[];
  scores: Score[];
  note: string;
};

async function publicGet<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(base + path);
  } catch {
    throw new GuideError(0, "Can't reach the site's server right now.");
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new GuideError(response.status, body.error ?? `HTTP ${response.status}`);
  return body as T;
}

export const publicGuide = {
  captures: () => publicGet<PublicCapture[]>('/public/captures'),
  moment: (id: string) => publicGet<Moment>(`/public/moments/${id}`),
  progress: (id: string) => publicGet<Progress>(`/public/progress/${id}`),
  session: (sid: string) => publicGet<PublicSession>(`/public/sessions/${sid}`),
  file: (id: string, name: string) => base + `/public/files/${id}/${name}`,
};

export const guide = {
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
  startSession: (momentId: string) =>
    request<{ sessionId: string; welcome: Reply }>('/api/sessions', post({ momentId })),
  narrate: (sid: string, chapterIndex: number) =>
    request<{ reply: Reply }>(`/api/sessions/${sid}/narrate`, post({ chapterIndex })),
  turn: (sid: string, text: string) =>
    request<{ reply: Reply; branch: string | null; distress: boolean }>(`/api/sessions/${sid}/turn`, post({ text })),
  endSession: (sid: string, reason: EndReason) => request<SessionEnd>(`/api/sessions/${sid}/end`, post({ reason })),
  session: (sid: string) => request<{ turns: unknown[]; dropped?: unknown[] }>(`/api/sessions/${sid}`),
  progress: (momentId: string) => request<Progress>(`/api/progress?momentId=${encodeURIComponent(momentId)}`),
  reextract: (id: string) => request<{ ok: true }>(`/api/moments/${id}/extract`, { method: 'POST' }),
};

/** URL for a capture file. <video> and <img> can't send headers, so the key rides as ?key=. */
export function fileUrl(path: string): string {
  return base + route(path) + (memoryKey && !publicMode ? `?key=${encodeURIComponent(memoryKey)}` : '');
}

export function captureFileUrl(id: string, name: string): string {
  return fileUrl(`/files/${id}/${name}`);
}

/** Fetches a byte range of a capture file (used for depth frames). */
export async function fetchRange(id: string, name: string, start: number, length: number): Promise<ArrayBuffer> {
  const response = await fetch(base + route(`/files/${id}/${name}`), {
    headers: headers({ Range: `bytes=${start}-${start + length - 1}` }),
  });
  if (!response.ok) throw new GuideError(response.status, `${name}: HTTP ${response.status}`);
  return response.arrayBuffer();
}

export async function fetchBytes(id: string, name: string): Promise<ArrayBuffer> {
  const response = await fetch(base + route(`/files/${id}/${name}`), { headers: headers() });
  if (!response.ok) throw new GuideError(response.status, `${name}: HTTP ${response.status}`);
  return response.arrayBuffer();
}

export async function fetchText(id: string, name: string): Promise<string> {
  const response = await fetch(base + route(`/files/${id}/${name}`), { headers: headers() });
  if (!response.ok) throw new GuideError(response.status, `${name}: HTTP ${response.status}`);
  return response.text();
}
