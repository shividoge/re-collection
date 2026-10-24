import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, normalize, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

import { guideRoot, loadConfig } from './config.mjs';
import { CORS_HEADERS, readJsonBody, sendError, sendFile, sendJson } from './http.mjs';
import { ClaudeError, createClaude } from './claude.mjs';
import { extractFacts } from './facts.mjs';
import { createSessions, SessionError } from './session.mjs';
import { Store, StoreError } from './store.mjs';
import { validateCapture } from './validate.mjs';
import { createFactsWorker } from './worker.mjs';

/** Largest single upload accepted. A 3-minute video is about 200 MB. */
const MAX_UPLOAD_BYTES = 2 * 1024 ** 3;

/**
 * Builds the request handler. Routes and JSON shapes are the contract in
 * docs/guide-api.md; change that doc first if a route changes.
 */
export function createApp(config, { claude = createClaude(config), log = console } = {}) {
  const store = new Store(config.dataDir);
  const started = Date.now();
  const worker = createFactsWorker({
    store,
    log,
    extract: (id) => extractFacts({ store, claude, model: config.models.offline }, id),
  });
  const sessions = createSessions({ store, claude, models: config.models, dataDir: config.dataDir });

  /** Wraps a session call: JSON body in, JSON out. */
  const json = (fn) => async (req, res, ...params) => {
    const body = req.method === 'GET' ? Object.fromEntries(new URL(req.url, 'http://guide.local').searchParams) : await readJsonBody(req);
    sendJson(res, 200, await fn(...params, body));
  };
  /** The built web app (web/dist), served at / so judges need one URL. */
  const webDir = config.webDir ?? join(guideRoot, '..', 'web', 'dist');

  const routes = [
    ['GET', /^\/health$/, health],
    ['GET', /^\/api\/captures$/, listCaptures],
    ['GET', /^\/api\/captures\/([^/]+)$/, getCapture],
    ['PUT', /^\/api\/captures\/([^/]+)\/files\/(.+)$/, putFile],
    ['POST', /^\/api\/captures\/([^/]+)\/complete$/, complete],
    ['GET', /^\/api\/moments\/([^/]+)$/, getMoment],
    ['PATCH', /^\/api\/moments\/([^/]+)\/facts\/([^/]+)$/, patchFact],
    ['POST', /^\/api\/moments\/([^/]+)\/extract$/, reextract],
    ['POST', /^\/api\/sessions$/, json((body) => sessions.start(body))],
    ['GET', /^\/api\/sessions\/([^/]+)$/, json((id) => sessions.get(id))],
    ['POST', /^\/api\/sessions\/([^/]+)\/narrate$/, json((id, body) => sessions.narrate(id, body))],
    ['POST', /^\/api\/sessions\/([^/]+)\/turn$/, json((id, body) => sessions.turn(id, body))],
    ['POST', /^\/api\/sessions\/([^/]+)\/end$/, json((id, body) => sessions.end(id, body))],
    ['GET', /^\/api\/progress$/, json((query) => sessions.progress(query))],
    ['GET', /^\/api\/person$/, json(() => sessions.person())],
    ['PUT', /^\/api\/person$/, json((body) => sessions.setPerson(body))],
    ['GET', /^\/files\/([^/]+)\/(.+)$/, getFile],
    ['HEAD', /^\/files\/([^/]+)\/(.+)$/, getFile],
  ];

  async function health(req, res) {
    sendJson(res, 200, {
      ok: true,
      mock: config.mockClaude,
      keyRequired: Boolean(config.key),
      claudeConfigured: Boolean(config.anthropicKey) || config.mockClaude,
      models: config.models,
      uptimeS: Math.floor((Date.now() - started) / 1000),
    });
  }

  async function summary(id) {
    const manifest = await store.readJson(id, 'manifest.json');
    if (!manifest) return null;
    const files = await store.listFiles(id);
    return {
      id,
      title: manifest.title ?? '',
      createdAt: manifest.createdAt ?? null,
      durationSec: manifest.video?.durationSec ?? null,
      thumb: files.includes('thumb.jpg') ? `/files/${id}/thumb.jpg` : null,
      status: await store.status(id),
    };
  }

  async function listCaptures(req, res) {
    const items = (await Promise.all((await store.listIds()).map(summary))).filter(Boolean);
    items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    sendJson(res, 200, items);
  }

  async function getCapture(req, res, id) {
    if (!(await store.exists(id))) return sendError(res, 404, `No capture with id ${id}.`);
    const manifest = await store.readJson(id, 'manifest.json');
    const files = {};
    for (const name of await store.listFiles(id)) files[name] = `/files/${id}/${name}`;
    sendJson(res, 200, { id, manifest, status: await store.status(id), files });
  }

  /** Streams the body to <name>.part, then renames, so a dropped upload never leaves a short file. */
  async function putFile(req, res, id, name) {
    const path = store.filePath(id, decodeURIComponent(name), { forWrite: true });
    const declared = Number(req.headers['content-length'] ?? NaN);
    if (declared > MAX_UPLOAD_BYTES) return sendError(res, 413, `${name} is larger than the 2 GB upload limit.`);

    await mkdir(dirname(path), { recursive: true });
    if ((await store.status(id)).upload !== 'receiving') {
      await store.setStatus(id, { upload: 'receiving', uploadErrors: [] });
    }

    const partial = `${path}.part`;
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_UPLOAD_BYTES) req.destroy(new Error('upload limit'));
    });
    try {
      await pipeline(req, createWriteStream(partial));
    } catch (error) {
      await rm(partial, { force: true });
      if (!res.headersSent) sendError(res, 400, `The upload of ${name} was interrupted. Retry it.`);
      return;
    }
    if (Number.isFinite(declared) && declared !== bytes) {
      await rm(partial, { force: true });
      return sendError(res, 400, `${name}: received ${bytes} bytes but Content-Length said ${declared}. Retry it.`);
    }
    await rename(partial, path);
    sendJson(res, 200, { ok: true, bytes });
  }

  async function complete(req, res, id) {
    if (!(await store.exists(id))) return sendError(res, 404, `No capture with id ${id}. Upload its files first.`);
    const result = await validateCapture(store, id);
    if (!result.ok) {
      await store.setStatus(id, { upload: 'invalid', uploadErrors: result.errors, warnings: result.warnings });
      return sendJson(res, 422, { error: `The capture isn't complete: ${result.errors.join(' ')}`, errors: result.errors });
    }
    // Fact extraction (TASKS.md step 3) picks up captures whose facts are "queued".
    const status = await store.setStatus(id, {
      upload: 'done',
      uploadErrors: [],
      warnings: result.warnings,
      facts: 'queued',
      factsError: null,
    });
    worker.kick();
    sendJson(res, 200, { ok: true, status });
  }

  async function getMoment(req, res, id) {
    if (!(await store.exists(id))) return sendError(res, 404, `No capture with id ${id}.`);
    const moment = await store.readJson(id, 'moment.json');
    if (!moment) {
      const status = await store.status(id);
      const why = status.facts === 'failed' ? `Fact extraction failed: ${status.factsError}` : `Facts aren't ready yet (${status.facts}).`;
      return sendJson(res, 404, { error: why, status });
    }
    sendJson(res, 200, moment);
  }

  /** The family's review: approve, reject, reword, or mark "don't bring this up". */
  async function patchFact(req, res, id, factId) {
    const body = await readJsonBody(req);
    const moment = await store.readJson(id, 'moment.json');
    const fact = moment?.facts.find((f) => f.id === factId);
    if (!fact) return sendError(res, 404, `No fact ${factId} in capture ${id}.`);

    if ('status' in body) {
      if (!['pending', 'approved', 'rejected'].includes(body.status)) {
        return sendError(res, 400, 'status must be pending, approved or rejected.');
      }
      fact.status = body.status;
    }
    if ('editedText' in body) {
      const edited = body.editedText === null ? null : String(body.editedText).trim();
      fact.editedText = edited || null;
    }
    if ('doNotRaise' in body) fact.doNotRaise = Boolean(body.doNotRaise);
    fact.reviewedAt = new Date().toISOString();
    await store.writeJson(id, 'moment.json', moment);
    sendJson(res, 200, fact);
  }

  async function reextract(req, res, id) {
    const status = await store.status(id);
    if (status.upload !== 'done') return sendError(res, 409, 'The capture isn\'t completely uploaded yet.');
    if (status.facts === 'running') return sendError(res, 409, 'Facts are already being extracted.');
    await store.setStatus(id, { facts: 'queued', factsError: null });
    worker.kick();
    sendJson(res, 200, { ok: true });
  }

  async function getFile(req, res, id, name) {
    const path = store.filePath(id, decodeURIComponent(name));
    const size = await store.size(path);
    if (size === null) return sendError(res, 404, `${name} isn't in capture ${id}.`);
    sendFile(req, res, path, size, name);
  }

  /** Static web app files. Unknown paths get index.html; the app routes with #hashes. */
  async function getWebFile(req, res, url) {
    const relative = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '') || 'index.html';
    let path = join(webDir, relative);
    if (!path.startsWith(webDir + sep)) return sendError(res, 400, 'Bad path.');
    let size = await store.size(path);
    if (size === null) {
      path = join(webDir, 'index.html');
      size = await store.size(path);
    }
    if (size === null) {
      return sendError(res, 404, 'The web app isn\'t built yet. Run: npm --prefix web install && npm --prefix web run build');
    }
    sendFile(req, res, path, size, path);
  }

  function isApiPath(pathname) {
    return pathname === '/health' || pathname.startsWith('/api/') || pathname.startsWith('/files/');
  }

  function authorized(req, url) {
    if (!config.key) return true;
    if (req.headers['x-braindance-key'] === config.key) return true;
    // <video> and <img> can't send headers, so /files also accepts ?key=.
    return url.pathname.startsWith('/files/') && url.searchParams.get('key') === config.key;
  }

  // Pick up anything queued before a restart.
  worker.kick();

  async function handle(req, res) {
    const url = new URL(req.url, 'http://guide.local');
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        return res.end();
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && !isApiPath(url.pathname)) {
        return await getWebFile(req, res, url);
      }
      if (url.pathname !== '/health' && !authorized(req, url)) {
        return sendError(res, 401, 'Missing or wrong X-Braindance-Key.');
      }
      for (const [method, pattern, handler] of routes) {
        if (req.method !== method) continue;
        const match = pattern.exec(url.pathname);
        if (match) return await handler(req, res, ...match.slice(1));
      }
      sendError(res, 404, `No route for ${req.method} ${url.pathname}.`);
    } catch (error) {
      if (res.headersSent) return res.destroy();
      if (error instanceof URIError) return sendError(res, 400, `Bad characters in ${url.pathname}.`);
      if (error instanceof StoreError || error instanceof SessionError || error.status) return sendError(res, error.status, error.message);
      if (error instanceof ClaudeError) return sendError(res, 502, error.message);
      console.error(error);
      sendError(res, 500, `The guide hit an error: ${error.message}`);
    }
  }

  /** Captures imported with `npm run import` while the guide runs are found by this. */
  handle.kickFacts = () => worker.kick();
  return handle;
}

export function startServer(config = loadConfig()) {
  const app = createApp(config);
  const server = createServer(app);
  setInterval(app.kickFacts, 15_000).unref();
  server.requestTimeout = 0;   // large uploads over a slow tunnel
  server.listen(config.port, () => {
    const claude = config.mockClaude ? 'MOCK MODE' : config.anthropicKey ? 'key set' : 'no key yet';
    console.log(`Braindance guide on http://127.0.0.1:${config.port} (data: ${config.dataDir}, Claude: ${claude})`);
  });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) startServer();
