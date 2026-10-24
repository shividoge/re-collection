// Client for the guide server (docs/guide-api.md). In production the guide
// serves this app, so requests are same-origin; in dev, Vite proxies them.

const KEY_STORAGE = 'braindance.guideKey';
const base = (import.meta.env.VITE_GUIDE_URL as string | undefined)?.replace(/\/+$/, '') ?? '';

export type CaptureStatus = {
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

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return memoryKey ? { 'X-Braindance-Key': memoryKey, ...extra } : extra;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(base + path, { ...init, headers: headers(init.headers as Record<string, string>) });
  } catch {
    throw new GuideError(0, "Can't reach the guide server. Is it running (npm start in guide/)?");
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new GuideError(response.status, body.error ?? `HTTP ${response.status}`);
  return body as T;
}

export const guide = {
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
  reextract: (id: string) => request<{ ok: true }>(`/api/moments/${id}/extract`, { method: 'POST' }),
};

/** URL for a capture file. <video> and <img> can't send headers, so the key rides as ?key=. */
export function fileUrl(path: string): string {
  return base + path + (memoryKey ? `?key=${encodeURIComponent(memoryKey)}` : '');
}

export function captureFileUrl(id: string, name: string): string {
  return fileUrl(`/files/${id}/${name}`);
}

/** Fetches a byte range of a capture file (used for depth frames). */
export async function fetchRange(id: string, name: string, start: number, length: number): Promise<ArrayBuffer> {
  const response = await fetch(base + `/files/${id}/${name}`, {
    headers: headers({ Range: `bytes=${start}-${start + length - 1}` }),
  });
  if (!response.ok) throw new GuideError(response.status, `${name}: HTTP ${response.status}`);
  return response.arrayBuffer();
}

export async function fetchBytes(id: string, name: string): Promise<ArrayBuffer> {
  const response = await fetch(base + `/files/${id}/${name}`, { headers: headers() });
  if (!response.ok) throw new GuideError(response.status, `${name}: HTTP ${response.status}`);
  return response.arrayBuffer();
}

export async function fetchText(id: string, name: string): Promise<string> {
  const response = await fetch(base + `/files/${id}/${name}`, { headers: headers() });
  if (!response.ok) throw new GuideError(response.status, `${name}: HTTP ${response.status}`);
  return response.text();
}
