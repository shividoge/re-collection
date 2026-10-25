import { randomUUID } from 'node:crypto';

import { readJsonBody, sendError, sendJson } from './http.mjs';

/**
 * The live visit: family join the Memory Palace from anywhere and follow the patient through it,
 * talking as they go. One visit per guide (one palace), kept in memory only.
 *
 * Screens poll about 5 times a second (a cloudflared quick tunnel holds back event streams), so
 * everything a screen needs arrives in its poll: who's here, where the patient is, call-setup
 * messages addressed to it, and voice relayed through the guide when a direct call can't connect.
 */
export const GONE_MS = 8_000;
export const AUDIO_KEEP_MS = 10_000;
export const AUDIO_MAX_BYTES = 64 * 1024;
export const SIGNAL_MAX_BYTES = 16 * 1024;
export const NAME_MAX = 40;
const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const cleanName = (name) => (typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : '');

/** Checks a view from the patient's screen. Returns { value } or { error }. */
export function parseView(view) {
  if (!view || typeof view !== 'object') return { error: 'Send { view: { x, z, yaw, pitch, inside, music } }.' };
  const { x, z, yaw, pitch, inside, music } = view;
  if (![x, z, yaw, pitch].every(finite)) return { error: 'x, z, yaw and pitch must be numbers.' };
  let room = null;
  if (inside !== null && inside !== undefined) {
    if (typeof inside !== 'object' || !Number.isInteger(inside.index) || inside.index < 0 || inside.index > 999) return { error: 'inside.index must be 0 to 999.' };
    if (!['diving', 'here', 'leaving'].includes(inside.stage)) return { error: 'inside.stage must be diving, here or leaving.' };
    room = { index: inside.index, stage: inside.stage };
  }
  return { value: { x, z, yaw, pitch, inside: room, music: Boolean(music) } };
}

/** `iceServers` from the environment (ICE_SERVERS, a JSON array), else a public STUN server. */
export function iceServersFrom(raw) {
  if (!raw) return DEFAULT_ICE;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_ICE;
  } catch {
    return DEFAULT_ICE;
  }
}

/** `person()` resolves to { displayName } (who the palace is for). */
export function createLive({ person = async () => ({}), iceServers = DEFAULT_ICE, now = Date.now } = {}) {
  /** id → { id, role, name, seenAt } */
  const members = new Map();
  /** id → [{ from, data }] waiting to be delivered */
  const mail = new Map();
  /** [{ seq, from, data (base64), at }] */
  let audio = [];
  let audioSeq = 0;
  let view = null;
  let version = 1;

  const bump = () => (version += 1);
  const memberList = () => [...members.values()].map(({ id, role, name }) => ({ id, role, name }));
  const live = () => ({ version, members: memberList(), view });

  /** Drops members not heard from lately, and voice older than a few seconds. */
  function prune() {
    const t = now();
    let changed = false;
    for (const [id, m] of members) {
      if (t - m.seenAt > GONE_MS) {
        members.delete(id);
        mail.delete(id);
        changed = true;
      }
    }
    if (changed && view && ![...members.values()].some((m) => m.role === 'patient')) view = null;
    if (changed) bump();
    audio = audio.filter((a) => t - a.at <= AUDIO_KEEP_MS);
  }

  function member(id) {
    prune();
    const m = typeof id === 'string' ? members.get(id) : undefined;
    if (m) m.seenAt = now();
    return m;
  }

  async function join(req, res) {
    const body = await readJsonBody(req);
    if (body.role !== 'patient' && body.role !== 'family') return sendError(res, 400, 'role must be "patient" or "family".');
    let name = cleanName(body.name);
    if (!name && body.role === 'patient') name = cleanName((await person())?.displayName) || 'Grandma';
    if (!name) return sendError(res, 400, 'Family members join with a name.');
    prune();
    const m = { id: randomUUID(), role: body.role, name, seenAt: now() };
    members.set(m.id, m);
    bump();
    sendJson(res, 200, { me: { id: m.id }, iceServers, live: live() });
  }

  async function leave(req, res) {
    const body = await readJsonBody(req);
    if (members.delete(body.id)) {
      mail.delete(body.id);
      if (view && ![...members.values()].some((m) => m.role === 'patient')) view = null;
      bump();
    }
    sendJson(res, 200, { ok: true });
  }

  async function poll(req, res) {
    const url = new URL(req.url, 'http://guide.local');
    const me = member(url.searchParams.get('id'));
    if (!me) return sendError(res, 404, 'Not in the visit (left, or the guide restarted). Join again.');
    const since = Number(url.searchParams.get('since'));
    const after = Number(url.searchParams.get('audioAfter'));
    const signals = mail.get(me.id) ?? [];
    mail.delete(me.id);
    const voice = Number.isFinite(after) ? audio.filter((a) => a.seq > after && a.from !== me.id).map(({ seq, from, data }) => ({ seq, from, data })) : [];
    if (since === version && signals.length === 0 && voice.length === 0) {
      res.writeHead(204);
      return res.end();
    }
    sendJson(res, 200, { ...live(), signals, audio: voice, audioSeq });
  }

  async function setView(req, res) {
    const body = await readJsonBody(req);
    const me = member(body.id);
    if (!me) return sendError(res, 404, 'Not in the visit. Join again.');
    if (me.role !== 'patient') return sendError(res, 403, 'Only the patient leads the visit.');
    const { value, error } = parseView(body.view);
    if (error) return sendError(res, 400, error);
    view = { ...value, rev: (view?.rev ?? 0) + 1, updatedAt: new Date(now()).toISOString() };
    bump();
    sendJson(res, 200, { ok: true, rev: view.rev });
  }

  async function signal(req, res) {
    const body = await readJsonBody(req, SIGNAL_MAX_BYTES + 1024);
    const me = member(body.id);
    if (!me) return sendError(res, 404, 'Not in the visit. Join again.');
    if (!members.has(body.to)) return sendError(res, 404, 'That member has left.');
    const box = mail.get(body.to) ?? [];
    box.push({ from: me.id, data: body.data ?? null });
    mail.set(body.to, box.slice(-200));
    sendJson(res, 200, { ok: true });
  }

  async function sendAudio(req, res) {
    const url = new URL(req.url, 'http://guide.local');
    const me = member(url.searchParams.get('id'));
    if (!me) {
      req.resume();
      return sendError(res, 404, 'Not in the visit. Join again.');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > AUDIO_MAX_BYTES) return sendError(res, 413, 'Audio chunks are at most 64 KB.');
      chunks.push(chunk);
    }
    if (size === 0) return sendError(res, 400, 'Empty audio chunk.');
    audioSeq += 1;
    audio.push({ seq: audioSeq, from: me.id, data: Buffer.concat(chunks).toString('base64'), at: now() });
    sendJson(res, 200, { ok: true, seq: audioSeq });
  }

  const routes = [
    ['POST', /^\/api\/palace\/live\/join$/, join],
    ['POST', /^\/api\/palace\/live\/leave$/, leave],
    ['GET', /^\/api\/palace\/live$/, poll],
    ['POST', /^\/api\/palace\/live\/view$/, setView],
    ['POST', /^\/api\/palace\/live\/signal$/, signal],
    ['POST', /^\/api\/palace\/live\/audio$/, sendAudio],
  ];
  return { routes };
}
