import { allowedFacts } from './grounding.mjs';
import { isCaptureId } from './store.mjs';

/** Files that never leave the guide, even for a public capture. */
export const PRIVATE_FILES = new Set(['status.json', 'moment.json', 'room.ply']);

/**
 * What a visitor may see, as plain data. The live /public routes and the
 * static export both build their output here, so the privacy rules (public
 * only, approved facts only, finished sessions only, no internal files) live
 * in one place. Each view returns null when there's nothing visible.
 */
export function createPublicViews({ store, sessions }) {
  async function visible(id) {
    return isCaptureId(id) && (await store.exists(id)) && (await store.isPublic(id));
  }

  async function publicIds() {
    const ids = [];
    for (const id of await store.listIds()) if (await store.isPublic(id)) ids.push(id);
    return ids;
  }

  /** Files of a public capture that may be served. */
  async function servedFiles(id) {
    if (!(await visible(id))) return null;
    return (await store.listFiles(id)).filter((name) => !PRIVATE_FILES.has(name));
  }

  async function list(filesBase) {
    const items = [];
    for (const id of await publicIds()) {
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
        thumb: files.includes('thumb.jpg') ? `${filesBase}/${id}/thumb.jpg` : null,
        facts: moment ? allowedFacts(moment).size : 0,
      });
    }
    items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return items;
  }

  async function capture(id, filesBase) {
    const names = await servedFiles(id);
    if (!names) return null;
    const files = {};
    for (const name of names) files[name] = `${filesBase}/${id}/${name}`;
    const status = await store.status(id);
    const manifest = await store.readJson(id, 'manifest.json');
    // Nobody typed a title on the phone? Use the one Claude gave the moment.
    const moment = await store.readJson(id, 'moment.json');
    return {
      id,
      manifest: manifest && { ...manifest, title: manifest.title || moment?.moment?.title || '' },
      status: { upload: status.upload, facts: status.facts, factsError: null },
      files,
    };
  }

  /** Only approved facts that aren't "don't bring this up", in the family's wording; the extraction log is left out. */
  async function moment(id) {
    if (!(await visible(id))) return null;
    const full = await store.readJson(id, 'moment.json');
    if (!full) return null;
    const allowed = allowedFacts(full);
    const facts = full.facts
      .filter((f) => allowed.has(f.id))
      .map((f) => ({ ...f, text: allowed.get(f.id).text, status: 'approved', editedText: null, doNotRaise: false }));
    return { ...full, facts, dropped: [] };
  }

  async function progress(id) {
    if (!(await visible(id))) return null;
    return sessions.progress({ momentId: id });
  }

  /** A finished session of a public capture: turns, held-back sentences, branches, scores, note (no person details). */
  async function session(sid) {
    const found = await sessions.get(sid).catch(() => null);
    if (!found || !found.endedAt || !(await visible(found.momentId))) return null;
    return {
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
    };
  }

  /** Ids of the finished sessions that belong to public captures. */
  async function sessionIds() {
    const ids = [];
    for (const id of await publicIds()) {
      const p = await progress(id).catch(() => null);
      for (const s of p?.sessions ?? []) ids.push(s.sessionId);
    }
    return ids;
  }

  return { visible, publicIds, servedFiles, list, capture, moment, progress, session, sessionIds };
}
