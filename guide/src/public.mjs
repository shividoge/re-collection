import { allowedFacts } from './grounding.mjs';
import { sendError, sendFile, sendJson } from './http.mjs';
import { isCaptureId } from './store.mjs';

/** Files that never leave the guide, even for a public capture. */
const PRIVATE_FILES = new Set(['status.json', 'moment.json', 'room.ply']);

/**
 * The read-only surface for visitors (no key). Only captures the family marked
 * public are visible; everything else answers 404, so a visitor can't tell a
 * private capture from one that doesn't exist. Nothing here writes or calls
 * Claude. Facts are filtered the same way the patient view filters them:
 * approved and not "don't bring up".
 */
export function createPublic({ store, sessions }) {
  const notFound = (res, what = 'capture') => sendError(res, 404, `No public ${what} with that id.`);

  async function visible(id) {
    return isCaptureId(id) && (await store.exists(id)) && (await store.isPublic(id));
  }

  async function list(req, res) {
    const items = [];
    for (const id of await store.listIds()) {
      if (!(await store.isPublic(id))) continue;
      const manifest = await store.readJson(id, 'manifest.json');
      if (!manifest) continue;
      const files = await store.listFiles(id);
      const moment = await store.readJson(id, 'moment.json');
      items.push({
        id,
        title: moment?.moment?.title || manifest.title || '',
        summary: moment?.moment?.summary ?? '',
        createdAt: manifest.createdAt ?? null,
        durationSec: manifest.video?.durationSec ?? null,
        thumb: files.includes('thumb.jpg') ? `/public/files/${id}/thumb.jpg` : null,
        facts: moment ? allowedFacts(moment).size : 0,
      });
    }
    items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    sendJson(res, 200, items);
  }

  async function capture(req, res, id) {
    if (!(await visible(id))) return notFound(res);
    const manifest = await store.readJson(id, 'manifest.json');
    const files = {};
    for (const name of await store.listFiles(id)) {
      if (!PRIVATE_FILES.has(name)) files[name] = `/public/files/${id}/${name}`;
    }
    const status = await store.status(id);
    sendJson(res, 200, { id, manifest, status: { upload: status.upload, facts: status.facts, factsError: null }, files });
  }

  async function moment(req, res, id) {
    if (!(await visible(id))) return notFound(res);
    const full = await store.readJson(id, 'moment.json');
    if (!full) return notFound(res, 'moment');
    const allowed = allowedFacts(full);
    const facts = full.facts
      .filter((f) => allowed.has(f.id))
      .map((f) => ({ ...f, text: allowed.get(f.id).text, status: 'approved', editedText: null, doNotRaise: false }));
    sendJson(res, 200, { ...full, facts, dropped: [] });
  }

  async function progress(req, res, id) {
    if (!(await visible(id))) return notFound(res);
    sendJson(res, 200, await sessions.progress({ momentId: id }));
  }

  /** A finished session of a public capture: what was said, and what the grounding check held back. */
  async function session(req, res, sid) {
    const found = await sessions.get(sid).catch(() => null);
    if (!found || !found.endedAt || !(await visible(found.momentId))) return notFound(res, 'session');
    sendJson(res, 200, {
      id: found.id,
      momentId: found.momentId,
      startedAt: found.startedAt,
      endedAt: found.endedAt,
      endReason: found.endReason,
      turns: found.turns.map(({ t, speaker, text, kind, factIds }) => ({ t, speaker, text, kind, factIds })),
      dropped: found.dropped,
      branches: found.branches,
      scores: found.scores ?? [],
      note: found.note ?? '',
    });
  }

  async function file(req, res, id, name) {
    if (!(await visible(id))) return notFound(res, 'file');
    if (PRIVATE_FILES.has(name)) return notFound(res, 'file');
    const path = store.filePath(id, decodeURIComponent(name));
    const size = await store.size(path);
    if (size === null) return notFound(res, 'file');
    sendFile(req, res, path, size, name);
  }

  /** [method, pattern, handler] for server.mjs, mounted under /public. */
  const routes = [
    ['GET', /^\/public\/captures$/, list],
    ['GET', /^\/public\/captures\/([^/]+)$/, capture],
    ['GET', /^\/public\/moments\/([^/]+)$/, moment],
    ['GET', /^\/public\/progress\/([^/]+)$/, progress],
    ['GET', /^\/public\/sessions\/([^/]+)$/, session],
    ['GET', /^\/public\/files\/([^/]+)\/(.+)$/, file],
    ['HEAD', /^\/public\/files\/([^/]+)\/(.+)$/, file],
  ];
  return routes;
}
