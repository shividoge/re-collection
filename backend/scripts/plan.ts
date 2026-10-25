// Pure planning for the import and export scripts (tested in plan.test.ts): which files to upload,
// how guide JSON maps onto the v3 shapes, and how the static export lays out its files.
import type { Fact, Moment, Session } from '../convex/validators'

// ---- import (guide data folder → Convex + R2) ---------------------------------------------

/** Files the guide wrote itself, partial uploads and Mac litter: never uploaded. */
export function isPackageFile(name: string): boolean {
  const base = name.split('/').pop() ?? ''
  if (name === 'status.json' || name === 'moment.json') return false
  if (base.startsWith('.') || base.endsWith('.part') || base.endsWith('.tmp')) return false
  return /^(?:keyframes\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..')
}

const TYPES: Record<string, string> = {
  json: 'application/json', jsonl: 'application/x-ndjson', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  mp4: 'video/mp4', mov: 'video/quicktime', ply: 'application/octet-stream', bin: 'application/octet-stream', spz: 'application/octet-stream',
}
export const contentTypeOf = (name: string) => TYPES[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'

/** manifest.json first (so the capture is readable at once), then small files, then big ones; already-stored files with the same size are skipped. */
export function uploadPlan(local: { name: string; bytes: number }[], stored: { name: string; bytes: number }[]) {
  const have = new Map(stored.map((f) => [f.name, f.bytes]))
  return local
    .filter((f) => isPackageFile(f.name) && have.get(f.name) !== f.bytes)
    .sort((a, b) => (a.name === 'manifest.json' ? -1 : b.name === 'manifest.json' ? 1 : a.bytes - b.bytes || a.name.localeCompare(b.name)))
    .map((f) => ({ ...f, contentType: contentTypeOf(f.name) }))
}

type Json = Record<string, unknown>
const obj = (x: unknown): Json => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Json) : {})
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : [])
const str = (x: unknown) => (typeof x === 'string' ? x : '')
const strOrNull = (x: unknown) => (typeof x === 'string' ? x : null)
const strings = (x: unknown) => arr(x).filter((s): s is string => typeof s === 'string')

function toEvidence(raw: unknown): Fact['evidence'][number] | null {
  const e = obj(raw)
  if (e.type === 'frame' && typeof e.t === 'number' && typeof e.keyframe === 'string') return { type: 'frame', t: e.t, keyframe: e.keyframe }
  if (e.type === 'transcript' && typeof e.tStart === 'number' && typeof e.tEnd === 'number' && typeof e.quote === 'string') {
    return { type: 'transcript', tStart: e.tStart, tEnd: e.tEnd, quote: e.quote }
  }
  return null
}

const KINDS = ['person', 'object', 'action', 'speech', 'place', 'feeling'] as const
const STATUSES = ['pending', 'approved', 'rejected'] as const

/** guide moment.json → the v3 Moment (unknown fields such as reviewedAt are dropped). */
export function toMoment(captureId: string, raw: unknown): Moment {
  const m = obj(raw)
  const header = obj(m.moment)
  const inputs = obj(m.inputs)
  return {
    captureId,
    moment: { title: str(header.title), place: str(header.place), occasion: str(header.occasion), summary: str(header.summary) },
    facts: arr(m.facts).map((rawFact): Fact => {
      const f = obj(rawFact)
      const kind = KINDS.find((k) => k === f.kind) ?? 'object'
      const status = STATUSES.find((s) => s === f.status) ?? 'pending'
      const salience = f.salience === 2 || f.salience === 3 ? f.salience : 1
      return {
        id: str(f.id), text: str(f.text), kind, salience, cue: str(f.cue), status,
        editedText: strOrNull(f.editedText), doNotRaise: f.doNotRaise === true,
        evidence: arr(f.evidence).map(toEvidence).filter((e): e is Fact['evidence'][number] => e !== null),
      }
    }),
    chapters: arr(m.chapters).map((c) => obj(c)).map((c) => ({ tStart: Number(c.tStart) || 0, tEnd: Number(c.tEnd) || 0, label: str(c.label) })),
    dropped: arr(m.dropped).map((d) => obj(d)).map((d) => ({ text: str(d.text), reason: str(d.reason) })),
    inputs: { keyframes: Number(inputs.keyframes) || 0, transcriptSegments: typeof inputs.transcriptSegments === 'number' ? inputs.transcriptSegments : null },
    extractedAt: str(m.extractedAt),
    model: str(m.model),
  }
}

const END_REASONS = ['complete', 'caregiver', 'distress', 'timeout'] as const
const RESULTS = ['unprompted', 'after_cue', 'not_mentioned'] as const
const TURN_KINDS = ['welcome', 'narration', 'reply'] as const

/** guide sessions/<id>.json → the v3 Session (id → sessionId, momentId → captureId). */
export function toSession(raw: unknown): Session {
  const s = obj(raw)
  const person = obj(s.person)
  const endReason = END_REASONS.find((r) => r === s.endReason) ?? null
  return {
    sessionId: str(s.id),
    captureId: str(s.momentId).toLowerCase(),
    person: { displayName: str(person.displayName), preferredAddress: str(person.preferredAddress) },
    startedAt: str(s.startedAt),
    endedAt: strOrNull(s.endedAt),
    endReason,
    allowedFactIds: strings(s.allowedFactIds),
    said: strings(s.said),
    turns: arr(s.turns).map((rawTurn) => {
      const t = obj(rawTurn)
      const kind = TURN_KINDS.find((k) => k === t.kind)
      const focus = obj(t.focus)
      return {
        t: str(t.t),
        speaker: t.speaker === 'patient' ? ('patient' as const) : ('claude' as const),
        text: str(t.text),
        ...(kind ? { kind } : {}),
        ...(Array.isArray(t.factIds) ? { factIds: strings(t.factIds) } : {}),
        ...(typeof t.chapterIndex === 'number' ? { chapterIndex: t.chapterIndex } : {}),
        ...(t.focus ? { focus: { label: str(focus.label), factIds: strings(focus.factIds) } } : {}),
        ...(Array.isArray(t.dropped) ? { dropped: arr(t.dropped).map((d) => obj(d)).map((d) => ({ sentence: str(d.sentence), reason: str(d.reason) })) } : {}),
      }
    }),
    dropped: arr(s.dropped).map((d) => obj(d)).map((d) => ({ t: str(d.t), sentence: str(d.sentence), reason: str(d.reason) })),
    branches: arr(s.branches).map((b) => obj(b)).map((b) => ({ t: str(b.t), quote: str(b.quote), note: str(b.note) })),
    alerts: arr(s.alerts).map((a) => obj(a)).map((a) => ({ t: str(a.t), kind: 'distress' as const, note: str(a.note) })),
    scores: Array.isArray(s.scores)
      ? s.scores.map((x) => obj(x)).map((x) => ({
          factId: str(x.factId),
          result: RESULTS.find((r) => r === x.result) ?? 'not_mentioned',
          ...(typeof x.line === 'number' ? { line: x.line } : {}),
        }))
      : null,
    note: strOrNull(s.note),
  }
}

// ---- static export (public data → .static-site/data) -------------------------------------

type NamedFile = { name: string; url: string; bytes: number; rev: number }

/**
 * The raw files the static site serves (§8): the video, keyframes, thumbnail, poses, transcript,
 * depth v2 files and the splat. Bulky raw data the web never reads in v3 (room.bin, depth v1,
 * confidence.bin, room.ply) stays out; the derived files replace it.
 */
export function staticRawFiles(manifest: Json): Set<string> {
  const video = obj(manifest.video)
  const depth = obj(manifest.depth)
  const splat = obj(obj(manifest.room).splat)
  const keep = new Set(['thumb.jpg', 'frames.jsonl', 'transcript.json'])
  if (typeof video.file === 'string') keep.add(video.file)
  if (depth.encoding === 'v2') for (const n of [depth.file, depth.index]) if (typeof n === 'string') keep.add(n)
  if (typeof splat.file === 'string') keep.add(splat.file)
  return keep
}

export type Download = { url: string; path: string; bytes: number }

/**
 * One public capture → its JSON (URLs relative to data/captures/<id>.json) and the downloads.
 * Raw files go to data/files/<id>/<name>, derived ones to data/files/<id>/derived/<name>
 * (derived depth.bin would otherwise collide with a raw one).
 */
export function exportCapture(capture: { id: string; manifestJson: string; files: NamedFile[]; derived: unknown; derivedFiles: NamedFile[] }) {
  const keep = staticRawFiles(obj(JSON.parse(capture.manifestJson)))
  const downloads: Download[] = []
  const place = (f: NamedFile, sub: string) => {
    const path = `files/${capture.id}/${sub}${f.name}`
    downloads.push({ url: f.url, path, bytes: f.bytes })
    return { ...f, url: `../${path}` }
  }
  const json = {
    ...capture,
    files: capture.files.filter((f) => keep.has(f.name) || f.name.startsWith('keyframes/')).map((f) => place(f, '')),
    derivedFiles: capture.derivedFiles.map((f) => place(f, 'derived/')),
  }
  return { json, downloads }
}

/** data/captures.json: thumbnails relative to data/. */
export function exportList<C extends { id: string; thumbUrl: string | null }>(list: C[]): C[] {
  return list.map((c) => ({ ...c, thumbUrl: c.thumbUrl ? `files/${c.id}/thumb.jpg` : null }))
}
