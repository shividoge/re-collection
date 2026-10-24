import { randomInt } from 'node:crypto';

import { CORS_HEADERS, readJsonBody, sendError, sendJson } from './http.mjs';
import { isCaptureId } from './store.mjs';

/**
 * "Visit together": a helper on a phone joins the patient's Memory Museum and
 * leads the walk. A room is a short code plus one shared state, kept in memory
 * and pushed to every screen with server-sent events. Contract:
 * docs/guide-api.md "Visit together (museum rooms)".
 */

/** Consonants only (no vowels, no Y), so a code never spells a word. */
export const CODE_LETTERS = 'BCDFGHJKLMNPQRSTVWXZ';
const CODE_PATTERN = new RegExp(`^[${CODE_LETTERS}]{4}$`);
export const ROOM_TTL_MS = 3 * 60 * 60 * 1000;
export const KEEPALIVE_MS = 15_000;
const MAX_AT = 9999;
const MAX_NAME = 40;

/** Upper-cases a typed code; returns null if it can't be a room code. */
export function normalizeCode(code) {
  const upper = String(code ?? '').trim().toUpperCase();
  return CODE_PATTERN.test(upper) ? upper : null;
}

/** A fresh code not in `taken`, or null if none was found (practically never: 160,000 codes). */
export function makeCode(taken, random = randomInt) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    let code = '';
    for (let i = 0; i < 4; i += 1) code += CODE_LETTERS[random(CODE_LETTERS.length)];
    if (!taken.has(code)) return code;
  }
  return null;
}

function cleanName(name) {
  if (name === undefined || name === null) return { ok: true, value: null };
  if (typeof name !== 'string') return { ok: false, error: 'name must be a string.' };
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (trimmed.length > MAX_NAME) return { ok: false, error: `name must be at most ${MAX_NAME} characters.` };
  return { ok: true, value: trimmed || null };
}

export function isFrameIndex(at) {
  return Number.isInteger(at) && at >= -1 && at <= MAX_AT;
}

/**
 * Checks the shape of a state change. Whether `window` names a capture that
 * exists is checked by the caller, since that needs the store.
 */
export function parseStateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Send a JSON object.' };
  if (!isFrameIndex(body.at)) return { ok: false, error: `at must be a whole number from -1 to ${MAX_AT}.` };
  if (body.window !== null && !(typeof body.window === 'string' && isCaptureId(body.window))) {
    return { ok: false, error: 'window must be null or a capture id.' };
  }
  if (body.by !== 'patient' && body.by !== 'helper') return { ok: false, error: 'by must be "patient" or "helper".' };
  const name = cleanName(body.name);
  if (!name.ok) return name;
  return { ok: true, value: { at: body.at, window: body.window?.toLowerCase() ?? null, by: body.by, name: name.value } };
}

/** A room with no listeners and no change for 3 hours is gone. */
export function isExpired(room, now) {
  return room.clients.size === 0 && now - room.changedAt >= ROOM_TTL_MS;
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * The rooms and their routes. `now` and `random` are injectable for tests.
 * Returns { routes, sweep, close, rooms }.
 */
export function createMuseumRooms({ store, now = Date.now, random = randomInt, keepaliveMs = KEEPALIVE_MS }) {
  /** code → { code, state, changedAt, clients: Set<{ res, as, name }> } */
  const rooms = new Map();

  const peersOf = (room) => {
    const peers = { patient: 0, helpers: [] };
    for (const client of room.clients) {
      if (client.as === 'helper') peers.helpers.push(client.name ?? 'Someone');
      else peers.patient += 1;
    }
    return peers;
  };
  const view = (room) => ({ code: room.code, state: room.state, peers: peersOf(room) });
  const broadcast = (room, event, data) => {
    for (const client of room.clients) sse(client.res, event, data);
  };

  function sweep() {
    const t = now();
    for (const [code, room] of rooms) if (isExpired(room, t)) rooms.delete(code);
  }

  /** The room for a code in the URL, or null (bad format, unknown or expired). */
  function find(rawCode) {
    const code = normalizeCode(decodeURIComponent(rawCode));
    if (!code) return null;
    const room = rooms.get(code);
    if (!room) return null;
    if (isExpired(room, now())) {
      rooms.delete(code);
      return null;
    }
    return room;
  }
  const notFound = (res) => sendError(res, 404, 'No visit with that code. Check the code on the iPad.');

  async function create(req, res) {
    sweep();
    const body = await readJsonBody(req);
    const at = body.at ?? -1;
    if (!isFrameIndex(at)) return sendError(res, 400, `at must be a whole number from -1 to ${MAX_AT}.`);
    const code = makeCode(new Set(rooms.keys()), random);
    if (!code) return sendError(res, 503, 'Couldn\'t find a free code. Try again.');
    const t = now();
    const room = {
      code,
      state: { at, window: null, by: 'patient', name: null, rev: 0, updatedAt: new Date(t).toISOString() },
      changedAt: t,
      clients: new Set(),
    };
    rooms.set(code, room);
    sendJson(res, 200, view(room));
  }

  async function get(req, res, rawCode) {
    const room = find(rawCode);
    if (!room) return notFound(res);
    sendJson(res, 200, view(room));
  }

  async function events(req, res, rawCode) {
    const room = find(rawCode);
    if (!room) return notFound(res);
    const query = new URL(req.url, 'http://guide.local').searchParams;
    const name = cleanName(query.get('name') ?? undefined);
    const client = { res, as: query.get('as') === 'helper' ? 'helper' : 'patient', name: name.ok ? name.value : null };

    // Headers that keep proxies (cloudflared, nginx) from buffering or closing the stream.
    res.writeHead(200, {
      ...CORS_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    req.socket.setNoDelay(true);
    req.socket.setTimeout(0);
    res.write('retry: 3000\n\n');

    room.clients.add(client);
    sse(res, 'state', room.state);
    broadcast(room, 'peers', peersOf(room));

    const leave = () => {
      if (!room.clients.delete(client)) return;
      broadcast(room, 'peers', peersOf(room));
    };
    req.on('close', leave);
    res.on('close', leave);
    res.on('error', leave);
  }

  async function setState(req, res, rawCode) {
    const room = find(rawCode);
    if (!room) return notFound(res);
    const parsed = parseStateBody(await readJsonBody(req));
    if (!parsed.ok) return sendError(res, 400, parsed.error);
    const { window } = parsed.value;
    if (window !== null && !(await store.exists(window))) return sendError(res, 400, `No capture with id ${window}.`);

    const t = now();
    room.state = { ...parsed.value, rev: room.state.rev + 1, updatedAt: new Date(t).toISOString() };
    room.changedAt = t;
    broadcast(room, 'state', room.state);
    sendJson(res, 200, { ok: true, state: room.state });
  }

  const timer = setInterval(() => {
    for (const room of rooms.values()) for (const client of room.clients) client.res.write(': keepalive\n\n');
    sweep();
  }, keepaliveMs);
  timer.unref();

  function close() {
    clearInterval(timer);
    for (const room of rooms.values()) for (const client of room.clients) client.res.end();
    rooms.clear();
  }

  const routes = [
    ['POST', /^\/api\/museum\/rooms$/, create],
    ['GET', /^\/api\/museum\/rooms\/([^/]+)$/, get],
    ['GET', /^\/api\/museum\/rooms\/([^/]+)\/events$/, events],
    ['POST', /^\/api\/museum\/rooms\/([^/]+)\/state$/, setState],
  ];
  return { routes, sweep, close, rooms };
}
