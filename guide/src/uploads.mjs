import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { sendError, sendFile, sendJson } from './http.mjs';

/**
 * The caretaker's own photos and videos for the museum, uploaded from the editor. Each is kept
 * as <dataDir>/museum-uploads/<id>.<ext>, listed in index.json there. They are the family's
 * private pictures: nothing here is ever served under /public.
 */
export const TYPES = {
  'image/jpeg': { kind: 'photo', ext: 'jpg' },
  'image/png': { kind: 'photo', ext: 'png' },
  'image/webp': { kind: 'photo', ext: 'webp' },
  'image/gif': { kind: 'photo', ext: 'gif' },
  'video/mp4': { kind: 'video', ext: 'mp4' },
  'video/quicktime': { kind: 'video', ext: 'mov' },
  'video/webm': { kind: 'video', ext: 'webm' },
};
export const MAX_BYTES = { photo: 40 * 1024 ** 2, video: 1024 ** 3 };
export const NAME_MAX = 120;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isUploadId = (id) => typeof id === 'string' && UUID.test(id);

/** The original file name, tidied for a label: no folders, no control characters, not too long. */
export function cleanName(name) {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  return base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX) || 'untitled';
}

/** What the editor gets back for an upload (the index entry, plus where to fetch it). */
const view = (u) => ({ ...u, url: `/files/museum/${u.id}` });

/**
 * `inUse()` resolves to the set of upload ids the saved arrangement hangs (they can't be
 * deleted until they're taken down).
 */
export function createUploads({ dataDir, inUse = async () => new Set() }) {
  const dir = join(dataDir, 'museum-uploads');
  const indexFile = join(dir, 'index.json');
  let queue = Promise.resolve();
  /** Index changes one at a time, so two uploads finishing together don't lose one. */
  const serial = (fn) => (queue = queue.then(fn, fn));

  async function list() {
    if (!existsSync(indexFile)) return [];
    try {
      return JSON.parse(await readFile(indexFile, 'utf8'));
    } catch {
      return [];
    }
  }
  async function writeIndex(entries) {
    await writeFile(`${indexFile}.tmp`, JSON.stringify(entries, null, 2));
    await rename(`${indexFile}.tmp`, indexFile);
  }
  const fileOf = (u) => join(dir, `${u.id}.${TYPES[u.type].ext}`);

  async function ids() {
    return new Set((await list()).map((u) => u.id));
  }

  /** Streams the body to a .part file and renames it once it's all there, like capture files. */
  async function upload(req, res) {
    const url = new URL(req.url, 'http://guide.local');
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const known = TYPES[type];
    if (!known) return sendError(res, 415, `Photos (JPEG, PNG, WebP, GIF) or videos (MP4, MOV, WebM) only; this was "${type || 'unknown'}".`);
    const limit = MAX_BYTES[known.kind];
    const declared = Number(req.headers['content-length'] ?? NaN);
    const too = () => `That ${known.kind} is larger than the ${known.kind === 'photo' ? '40 MB' : '1 GB'} limit.`;
    if (declared > limit) {
      req.resume();
      return sendError(res, 413, too());
    }

    const entry = { id: randomUUID(), kind: known.kind, type, name: cleanName(url.searchParams.get('name')), bytes: 0, createdAt: new Date().toISOString() };
    await mkdir(dir, { recursive: true });
    const path = fileOf(entry);
    const partial = `${path}.part`;
    let bytes = 0;
    let over = false;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) {
        over = true;
        req.destroy(new Error('upload limit'));
      }
    });
    try {
      await pipeline(req, createWriteStream(partial));
    } catch {
      await rm(partial, { force: true });
      if (!res.headersSent) sendError(res, over ? 413 : 400, over ? too() : `The upload of ${entry.name} was interrupted. Try again.`);
      return;
    }
    if ((Number.isFinite(declared) && declared !== bytes) || bytes === 0) {
      await rm(partial, { force: true });
      return sendError(res, 400, `${entry.name} arrived incomplete (${bytes} bytes). Try again.`);
    }
    await rename(partial, path);
    entry.bytes = bytes;
    await serial(async () => writeIndex([...(await list()), entry]));
    sendJson(res, 200, { upload: view(entry) });
  }

  async function getAll(req, res) {
    sendJson(res, 200, { uploads: (await list()).map(view) });
  }

  async function remove(req, res, id) {
    if (!isUploadId(id)) return sendError(res, 404, 'No upload with that id.');
    if ((await inUse()).has(id)) return sendError(res, 409, 'It still hangs in her museum. Take it off the walls and save first.');
    const result = await serial(async () => {
      const all = await list();
      const found = all.find((u) => u.id === id);
      if (!found) return false;
      await rm(fileOf(found), { force: true });
      await writeIndex(all.filter((u) => u.id !== id));
      return true;
    });
    if (!result) return sendError(res, 404, 'No upload with that id.');
    sendJson(res, 200, { ok: true });
  }

  async function file(req, res, id) {
    const found = isUploadId(id) ? (await list()).find((u) => u.id === id) : null;
    if (!found) return sendError(res, 404, 'No upload with that id.');
    const path = fileOf(found);
    let size;
    try {
      size = (await stat(path)).size;
    } catch {
      return sendError(res, 404, 'No upload with that id.');
    }
    sendFile(req, res, path, size, path);
  }

  const routes = [
    ['POST', /^\/api\/museum\/uploads$/, upload],
    ['GET', /^\/api\/museum\/uploads$/, getAll],
    ['DELETE', /^\/api\/museum\/uploads\/([^/]+)$/, remove],
    // Before the capture file routes, which would take "museum" for a capture id.
    ['GET', /^\/files\/museum\/([^/]+)$/, file],
    ['HEAD', /^\/files\/museum\/([^/]+)$/, file],
  ];
  return { routes, ids, list };
}
