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
/** A screen that polls instead of listening counts as present this long after its last poll. */
export const POLL_TTL_MS = 10_000;
const CLIENT_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
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
  const atId = body.atId ?? null;
  if (atId !== null && !(typeof atId === 'string' && isCaptureId(atId))) return { ok: false, error: 'atId must be null or a capture id.' };
  const name = cleanName(body.name);
  if (!name.ok) return name;
  return {
    ok: true,
    value: { at: body.at, atId: atId?.toLowerCase() ?? null, window: body.window?.toLowerCase() ?? null, by: body.by, name: name.value },
  };
}

/** True while a polling screen's last poll is under 10 s old. */
export function isPollerLive(poller, now) {
  return now - poller.seenAt < POLL_TTL_MS;
}

/** A room with no listeners, no live pollers and no change for 3 hours is gone. */
export function isExpired(room, now) {
  if (room.clients.size > 0) return false;
  for (const poller of room.pollers.values()) if (isPollerLive(poller, now)) return false;
  return now - room.changedAt >= ROOM_TTL_MS;
}

/**
 * Who is here: one entry per screen. A screen that sends a client id is counted once, even if it
 * both listens and polls (it falls back from one to the other).
 */
export function countPeers(clients, pollers) {
  const screens = new Map();
  for (const client of clients) screens.set(client.id ?? client, client);
  for (const [id, poller] of pollers) if (!screens.has(id)) screens.set(id, poller);
  const peers = { patient: 0, helpers: [] };
  for (const screen of screens.values()) {
    if (screen.as === 'helper') peers.helpers.push(screen.name ?? 'Someone');
    else peers.patient += 1;
  }
  return peers;
}

/**
 * Reads ?as=, ?name= and ?client= (who a listener or poller is) and ?since= (polls only).
 * A name that is too long is dropped, like on the event stream; a malformed client id or since is an error.
 */
export function parseWho(query) {
  const name = cleanName(query.get('name') ?? undefined);
  const client = query.get('client');
  if (client !== null && !CLIENT_PATTERN.test(client)) return { ok: false, error: 'client must be 8 to 64 letters, digits, - or _.' };
  const sinceRaw = query.get('since');
  const since = sinceRaw === null ? null : Number(sinceRaw);
  if (since !== null && !(sinceRaw.trim() !== '' && Number.isInteger(since) && since >= 0)) return { ok: false, error: 'since must be a whole number.' };
  return { ok: true, value: { as: query.get('as') === 'helper' ? 'helper' : 'patient', name: name.ok ? name.value : null, id: client, since } };
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * The rooms and their routes. `now` and `random` are injectable for tests.
 * Returns { routes, sweep, close, rooms }.
 */
export function createMuseumRooms({ store, now = Date.now, random = randomInt, keepaliveMs = KEEPALIVE_MS }) {
  /**
   * code → { code, state, changedAt, version, clients: Set<{ res, as, name, id }>,
   * pollers: Map<id, { as, name, seenAt }> }. `version` goes up on any change to state or peers.
   */
  const rooms = new Map();

  const peersOf = (room) => countPeers(room.clients, room.pollers);
  const view = (room) => ({ code: room.code, state: room.state, peers: peersOf(room), version: room.version });
  const broadcast = (room, event, data) => {
    for (const client of room.clients) sse(client.res, event, data);
  };
  /** Call after anything that may change who is here. Returns true if it did (and told the listeners). */
  const peersChanged = (room, before) => {
    const after = peersOf(room);
    if (JSON.stringify(after) === JSON.stringify(before)) return false;
    room.version += 1;
    broadcast(room, 'peers', after);
    return true;
  };

  /** Drops pollers that stopped polling (a closed phone), and tells the listeners. */
  function prune(room, t) {
    const before = peersOf(room);
    let dropped = false;
    for (const [id, poller] of room.pollers) {
      if (isPollerLive(poller, t)) continue;
      room.pollers.delete(id);
      dropped = true;
    }
    if (dropped) peersChanged(room, before);
  }

  function sweep() {
    const t = now();
    for (const [code, room] of rooms) {
      prune(room, t);
      if (isExpired(room, t)) rooms.delete(code);
    }
  }

  /** The room for a code in the URL, or null (bad format, unknown or expired). */
  function find(rawCode) {
    let code;
    try {
      code = normalizeCode(decodeURIComponent(rawCode));
    } catch {
      return null;   // a broken %-escape is just a wrong code
    }
    if (!code) return null;
    const room = rooms.get(code);
    if (!room) return null;
    prune(room, now());
    if (isExpired(room, now())) {
      rooms.delete(code);
      return null;
    }
    return room;
  }
  const notFound = (res) => sendError(res, 404, 'No visit with that code. Check the code on the iPad.');

  async function create(req, res) {
    sweep();
    const body = (await readJsonBody(req)) ?? {};
    const at = typeof body === 'object' ? (body.at ?? -1) : null;
    if (!isFrameIndex(at)) return sendError(res, 400, `at must be a whole number from -1 to ${MAX_AT}.`);
    const code = makeCode(new Set(rooms.keys()), random);
    if (!code) return sendError(res, 503, 'Couldn\'t find a free code. Try again.');
    const t = now();
    const room = {
      code,
      state: { at, atId: null, window: null, by: 'patient', name: null, rev: 0, updatedAt: new Date(t).toISOString() },
      changedAt: t,
      version: 0,
      clients: new Set(),
      pollers: new Map(),
    };
    rooms.set(code, room);
    sendJson(res, 200, view(room));
  }

  /**
   * The room as JSON. With ?client= this is also a poll: the screen counts as present for 10 s.
   * With ?since=<version> it answers 204 when nothing changed since then.
   */
  async function get(req, res, rawCode) {
    const room = find(rawCode);
    if (!room) return notFound(res);
    const who = parseWho(new URL(req.url, 'http://guide.local').searchParams);
    if (!who.ok) return sendError(res, 400, who.error);
    const { as, name, id, since } = who.value;
    if (id !== null) {
      const before = peersOf(room);
      room.pollers.set(id, { as, name, seenAt: now() });
      // A screen that polls has given up on its stream, but a tunnel can hold the stream open
      // here for half a minute after the browser closed it. End it, so only the poll's 10 s count.
      for (const client of room.clients) {
        if (client.id !== id) continue;
        room.clients.delete(client);
        client.res.end();
      }
      peersChanged(room, before);
    }
    if (since !== null && since === room.version) {
      res.writeHead(204, { ...CORS_HEADERS, 'Cache-Control': 'no-store' });
      return res.end();
    }
    sendJson(res, 200, view(room));
  }

  async function events(req, res, rawCode) {
    const room = find(rawCode);
    if (!room) return notFound(res);
    const who = parseWho(new URL(req.url, 'http://guide.local').searchParams);
    if (!who.ok) return sendError(res, 400, who.error);
    const { as, name, id } = who.value;
    const client = { res, as, name, id };

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

    const before = peersOf(room);
    room.clients.add(client);
    sse(res, 'state', room.state);
    // Everyone hears about a new face; a screen already counted (it polled first) just gets the list.
    if (!peersChanged(room, before)) sse(res, 'peers', before);

    const leave = () => {
      const was = peersOf(room);
      if (!room.clients.delete(client)) return;
      peersChanged(room, was);
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
    room.version += 1;
    broadcast(room, 'state', room.state);
    sendJson(res, 200, { ok: true, state: room.state });
  }

  const timer = setInterval(() => {
    for (const room of rooms.values()) for (const client of room.clients) client.res.write(': keepalive\n\n');
  }, keepaliveMs);
  timer.unref();
  // Often enough that a helper who stops polling leaves the iPad's list within a few seconds.
  const sweeper = setInterval(sweep, POLL_TTL_MS / 4);
  sweeper.unref();

  function close() {
    clearInterval(timer);
    clearInterval(sweeper);
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
