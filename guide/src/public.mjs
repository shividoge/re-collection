import { publicArrangement } from './arrangement.mjs';
import { createPublicViews } from './public-views.mjs';
import { sendError, sendFile, sendJson } from './http.mjs';

/**
 * The read-only surface for visitors (no key). Only captures the family marked
 * public are visible; everything else answers 404, so a visitor can't tell a
 * private capture from one that doesn't exist. Nothing here writes or calls
 * Claude. What each route returns comes from public-views.mjs.
 */
export function createPublic({ store, sessions, arrangement = null }) {
  const views = createPublicViews({ store, sessions });
  const notFound = (res, what = 'capture') => sendError(res, 404, `No public ${what} with that id.`);
  const FILES = '/public/files';

  /** Wraps a view: JSON when it has something to show, 404 otherwise. */
  const json = (view, what) => async (req, res, ...params) => {
    const body = await view(...params);
    if (body === null) return notFound(res, what);
    sendJson(res, 200, body);
  };

  async function file(req, res, id, name) {
    const served = await views.servedFiles(id);
    const decoded = decodeURIComponent(name);
    if (!served || !served.includes(decoded)) return notFound(res, 'file');
    const path = store.filePath(id, decoded);
    const size = await store.size(path);
    if (size === null) return notFound(res, 'file');
    sendFile(req, res, path, size, decoded);
  }

  return [
    ['GET', /^\/public\/captures$/, json(() => views.list(FILES))],
    ['GET', /^\/public\/captures\/([^/]+)$/, json((id) => views.capture(id, FILES))],
    ['GET', /^\/public\/moments\/([^/]+)$/, json(views.moment, 'moment')],
    ['GET', /^\/public\/progress\/([^/]+)$/, json(views.progress)],
    ['GET', /^\/public\/sessions\/([^/]+)$/, json(views.session, 'session')],
    // The caretaker's museum, with only the pictures from public captures.
    [
      'GET',
      /^\/public\/museum\/arrangement$/,
      async (req, res) => sendJson(res, 200, { arrangement: publicArrangement(await arrangement?.read(), await views.publicIds()) }),
    ],
    ['GET', /^\/public\/files\/([^/]+)\/(.+)$/, file],
    ['HEAD', /^\/public\/files\/([^/]+)\/(.+)$/, file],
  ];
}
