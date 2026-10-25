import { existsSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readJsonBody, sendError, sendJson } from './http.mjs';

/**
 * The museum the caretaker sets up for the patient: which pictures hang, in what order, and
 * the title and short caption on each one's label. One arrangement per guide, in
 * <dataDir>/museum.json. Without one, the museum hangs every visit automatically.
 *
 * An item points at a piece of a capture, never at a file path: `piece` is "video", "thumb"
 * or a keyframe "k0012", so nothing outside a capture's own files can be hung.
 */
export const MAX_ITEMS = 60;
export const TITLE_MAX = 80;
export const CAPTION_MAX = 240;
const PIECE = /^(video|thumb|k\d{4})$/;
const UUID = /^[0-9a-f-]{36}$/i;

const text = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/**
 * Checks a body from the editor against the captures that exist. Returns { value } with the
 * cleaned arrangement, or { error } saying what's wrong.
 */
export function validateArrangement(body, captureIds) {
  if (!body || typeof body !== 'object') return { error: 'Send { title, subtitle, items: [...] }.' };
  if (!Array.isArray(body.items)) return { error: '"items" must be a list.' };
  if (body.items.length > MAX_ITEMS) return { error: `At most ${MAX_ITEMS} pictures.` };
  const items = [];
  for (const [i, item] of body.items.entries()) {
    if (!item || typeof item !== 'object') return { error: `Item ${i + 1} isn't an object.` };
    if (typeof item.capture !== 'string' || !UUID.test(item.capture) || !captureIds.has(item.capture)) {
      return { error: `Item ${i + 1} points at a capture that doesn't exist.` };
    }
    if (typeof item.piece !== 'string' || !PIECE.test(item.piece)) return { error: `Item ${i + 1}: "piece" must be video, thumb or kNNNN.` };
    items.push({ capture: item.capture, piece: item.piece, title: text(item.title, TITLE_MAX), caption: text(item.caption, CAPTION_MAX) });
  }
  return { value: { title: text(body.title, TITLE_MAX) || 'Our visits', subtitle: text(body.subtitle, TITLE_MAX), items } };
}

/** What a visitor may see: only the pictures from captures the family made public. */
export function publicArrangement(arrangement, publicIds) {
  if (!arrangement) return null;
  const visible = new Set(publicIds);
  return { ...arrangement, items: arrangement.items.filter((item) => visible.has(item.capture)) };
}

export function createArrangement({ store, dataDir }) {
  const file = join(dataDir, 'museum.json');

  async function read() {
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch {
      return null;
    }
  }

  async function get(req, res) {
    sendJson(res, 200, { arrangement: await read() });
  }

  async function put(req, res) {
    const body = await readJsonBody(req);
    const { value, error } = validateArrangement(body, new Set(await store.listIds()));
    if (error) return sendError(res, 400, error);
    const arrangement = { ...value, updatedAt: new Date().toISOString() };
    // Write then rename, so a reader never sees half a file.
    await writeFile(`${file}.tmp`, JSON.stringify(arrangement, null, 2));
    await rename(`${file}.tmp`, file);
    sendJson(res, 200, { arrangement });
  }

  /** Back to hanging every visit automatically. */
  async function reset(req, res) {
    await rm(file, { force: true });
    sendJson(res, 200, { arrangement: null });
  }

  const routes = [
    ['GET', /^\/api\/museum\/arrangement$/, get],
    ['PUT', /^\/api\/museum\/arrangement$/, put],
    ['DELETE', /^\/api\/museum\/arrangement$/, reset],
  ];
  return { routes, read };
}
