import { readFile } from 'node:fs/promises';

import { FACTS_SCHEMA, FACTS_SYSTEM, factsContent } from './prompts.mjs';

/** Claude sees at most this many frames per moment (CLAUDE.md 6.2). */
export const MAX_FRAMES = 30;
const KINDS = new Set(['person', 'object', 'action', 'speech', 'place', 'feeling']);

/** "keyframes/k0012.jpg" -> 12, anything else -> null. */
export function keyframeSecond(name) {
  const match = /^keyframes\/k(\d{4})\.jpg$/.exec(name);
  return match ? Number(match[1]) : null;
}

/** Up to `max` keyframe names, evenly spread over the moment, in time order. */
export function chooseKeyframes(names, max = MAX_FRAMES) {
  const frames = names.filter((n) => keyframeSecond(n) !== null).sort();
  if (frames.length <= max) return frames;
  const picked = new Set();
  for (let k = 0; k < max; k++) picked.add(frames[Math.round((k * (frames.length - 1)) / (max - 1))]);
  return [...picked];
}

/** Lowercase, drop punctuation and extra spaces, so quotes can be matched loosely. */
function normalize(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Checks Claude's facts against what it was actually shown. Evidence that
 * points at a keyframe it wasn't given, or quotes words that aren't in the
 * transcript, is removed; a fact left with no evidence is dropped. Returns
 * the kept facts (with ids and review fields) and what was dropped and why.
 *
 * @param {object} reply      Claude's structured reply
 * @param {Set<string>} shownFrames  keyframe names Claude saw
 * @param {{ start: number, end: number, text: string }[] | null} segments
 * @param {number} durationSec
 */
export function groundFacts(reply, shownFrames, segments, durationSec) {
  const transcript = normalize((segments ?? []).map((s) => s.text).join(' '));
  const kept = [];
  const dropped = [];

  for (const fact of reply.facts ?? []) {
    const text = String(fact.text ?? '').trim();
    if (!text) continue;
    const evidence = [];
    for (const item of fact.evidence ?? []) {
      if (item.type === 'frame') {
        const second = keyframeSecond(item.keyframe ?? '');
        const isThumb = item.keyframe === 'thumb.jpg' && shownFrames.has('thumb.jpg');
        if ((second !== null && shownFrames.has(item.keyframe)) || isThumb) {
          evidence.push({ type: 'frame', t: isThumb ? 2 : second, keyframe: item.keyframe });
        }
      } else if (item.type === 'transcript') {
        const quote = String(item.quote ?? '').trim();
        const start = Number(item.tStart);
        const end = Number(item.tEnd);
        const inRange = Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start && start <= durationSec + 1;
        if (quote && inRange && transcript.includes(normalize(quote))) {
          evidence.push({ type: 'transcript', tStart: start, tEnd: end, quote });
        }
      }
    }
    if (evidence.length === 0) {
      dropped.push({ text, reason: 'none of its evidence matched a keyframe Claude was shown or words in the transcript' });
      continue;
    }
    kept.push({
      text,
      kind: KINDS.has(fact.kind) ? fact.kind : 'object',
      salience: [1, 2, 3].includes(fact.salience) ? fact.salience : 1,
      evidence,
      cue: String(fact.cue ?? '').trim(),
    });
  }

  const chapters = (reply.chapters ?? [])
    .map((c) => ({ tStart: Math.max(0, Number(c.tStart)), tEnd: Math.min(durationSec, Number(c.tEnd)), label: String(c.label ?? '').trim() }))
    .filter((c) => Number.isFinite(c.tStart) && Number.isFinite(c.tEnd) && c.tEnd > c.tStart && c.label)
    .sort((a, b) => a.tStart - b.tStart);

  return { facts: kept, dropped, chapters };
}

/**
 * New extraction merged with the family's earlier review: facts they already
 * approved, edited or rejected are kept as they are; pending ones are
 * replaced. New facts get ids after the highest existing one.
 */
export function mergeFacts(previous, fresh) {
  const reviewed = (previous?.facts ?? []).filter((f) => f.status !== 'pending' || f.editedText || f.doNotRaise);
  let next = Math.max(0, ...reviewed.map((f) => Number(String(f.id).replace(/^f/, '')) || 0)) + 1;
  const added = fresh.map((f) => ({ id: `f${next++}`, ...f, status: 'pending', editedText: null, doNotRaise: false }));
  return [...reviewed, ...added];
}

/** Loads what Claude needs for one capture: manifest, transcript segments, chosen frames. */
async function loadInputs(store, id) {
  const manifest = await store.readJson(id, 'manifest.json');
  if (!manifest) throw new Error('manifest.json is missing.');

  let segments = null;
  if (manifest.transcript?.file) {
    const transcript = await store.readJson(id, manifest.transcript.file);
    segments = (transcript?.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: s.text }));
  }

  const files = await store.listFiles(id);
  let names = chooseKeyframes(files);
  // Captures from before keyframes existed still have the thumbnail.
  if (names.length === 0 && files.includes('thumb.jpg')) names = ['thumb.jpg'];
  if (names.length === 0 && (segments ?? []).length === 0) {
    throw new Error('This capture has no keyframes, thumbnail or speech, so there is nothing for Claude to read.');
  }

  const frames = [];
  for (const name of names) {
    const data = await readFile(store.filePath(id, name));
    frames.push({ name, t: keyframeSecond(name) ?? 2, base64: data.toString('base64') });
  }
  return { manifest, segments, frames };
}

/**
 * Runs fact extraction for one capture and writes moment.json.
 * @param {{ store, claude, model: string }} deps
 */
export async function extractFacts({ store, claude, model }, id) {
  const { manifest, segments, frames } = await loadInputs(store, id);
  const durationSec = manifest.video?.durationSec ?? 0;
  const shown = new Set(frames.map((f) => f.name));

  const { data, model: usedModel } = await claude.json({
    model,
    system: FACTS_SYSTEM,
    content: factsContent({ title: manifest.title ?? '', attendees: manifest.attendees ?? [], durationSec }, segments, frames),
    schema: FACTS_SCHEMA,
    effort: 'high',
    mock: () => mockReply(frames),
  });

  const { facts, dropped, chapters } = groundFacts(data, shown, segments, durationSec);
  const previous = await store.readJson(id, 'moment.json');
  const moment = {
    captureId: id,
    moment: {
      title: String(data.moment?.title ?? manifest.title ?? ''),
      place: String(data.moment?.place ?? ''),
      occasion: String(data.moment?.occasion ?? ''),
      summary: String(data.moment?.summary ?? ''),
    },
    facts: mergeFacts(previous, facts),
    chapters,
    dropped,
    inputs: { keyframes: frames.length, transcriptSegments: segments?.length ?? null },
    extractedAt: new Date().toISOString(),
    model: usedModel,
  };
  await store.writeJson(id, 'moment.json', moment);
  return moment;
}

/** Canned reply for MOCK_CLAUDE=1: clearly marked, built only from what exists. */
function mockReply(frames) {
  const first = frames[0];
  return {
    moment: { title: '[mock] Untitled moment', place: '', occasion: '', summary: '[mock] Mock mode is on; no real facts were extracted.' },
    facts: first
      ? [{ text: `[mock] Something is visible in ${first.name}.`, kind: 'object', salience: 1, cue: '[mock] cue', evidence: [{ type: 'frame', keyframe: first.name, tStart: null, tEnd: null, quote: null }] }]
      : [],
    chapters: [],
  };
}
