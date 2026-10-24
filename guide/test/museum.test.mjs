import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { after, before, describe, test } from 'node:test';

import { CODE_LETTERS, isExpired, makeCode, normalizeCode, parseStateBody, ROOM_TTL_MS } from '../src/museum.mjs';
import { createApp } from '../src/server.mjs';
import { CAPTURE_ID, tempDataDir, tinyCapture, writeCapture } from './helpers.mjs';

/** A guide with one capture on disk and a clock the test moves by hand. */
async function startGuide() {
  const dataDir = await tempDataDir();
  await writeCapture(dataDir, tinyCapture().files);
  const clock = { t: Date.parse('2026-10-24T20:00:00Z') };
  const config = {
    port: 0,
    dataDir,
    webDir: `${dataDir}/no-web-build`,
    key: '',
    mockClaude: false,
    anthropicKey: '',
    models: { offline: 'o', live: 'l' },
  };
  const app = createApp(config, { log: { log() {}, error() {} }, museum: { now: () => clock.t } });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = () => {
    app.close();
    server.closeAllConnections();
    server.close();
  };
  return { base, clock, close };
}

const postJson = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** Opens an event stream and parses it; `next(name)` resolves with the next event of that name. */
function listen(base, path) {
  return new Promise((resolve, reject) => {
    const { hostname, port } = new URL(base);
    const queued = [];
    const waiting = [];
    let buffer = '';
    const req = request({ hostname, port, path, method: 'GET', headers: { Accept: 'text/event-stream' } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (!event || data === undefined) continue;
          const item = { event, data: JSON.parse(data) };
          const i = waiting.findIndex((w) => w.event === event);
          if (i >= 0) waiting.splice(i, 1)[0].resolve(item.data);
          else queued.push(item);
        }
      });
      resolve({
        status: res.statusCode,
        headers: res.headers,
        next(event) {
          const i = queued.findIndex((q) => q.event === event);
          if (i >= 0) return Promise.resolve(queued.splice(i, 1)[0].data);
          return new Promise((done) => waiting.push({ event, resolve: done }));
        },
        close: () => req.destroy(),
      });
    });
    req.on('error', (error) => (error.code === 'ECONNRESET' ? undefined : reject(error)));
    req.end();
  });
}

describe('museum rooms: pure parts', () => {
  test('codes are 4 consonants and skip codes in use', () => {
    assert.match(CODE_LETTERS, /^[^AEIOUY]+$/);
    const picks = [0, 0, 0, 0, 0, 0, 0, 1];
    const code = makeCode(new Set(['BBBB']), () => picks.shift());
    assert.equal(code, 'BBBC');
    assert.equal(makeCode(new Set(['BBBB']), () => 0), null);
    for (let i = 0; i < 200; i += 1) assert.match(makeCode(new Set()), /^[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
  });

  test('normalizeCode accepts lower case and rejects anything else', () => {
    assert.equal(normalizeCode(' ktrb '), 'KTRB');
    assert.equal(normalizeCode('KATB'), null);
    assert.equal(normalizeCode('KTR'), null);
    assert.equal(normalizeCode('KTRBX'), null);
    assert.equal(normalizeCode(undefined), null);
  });

  test('parseStateBody checks every field', () => {
    assert.deepEqual(parseStateBody({ at: 2, window: null, by: 'helper', name: '  Priya ' }), {
      ok: true,
      value: { at: 2, window: null, by: 'helper', name: 'Priya' },
    });
    assert.equal(parseStateBody({ at: -1, window: CAPTURE_ID.toUpperCase(), by: 'patient' }).value.window, CAPTURE_ID);
    for (const bad of [
      null,
      [],
      { window: null, by: 'patient' },
      { at: 1.5, window: null, by: 'patient' },
      { at: -2, window: null, by: 'patient' },
      { at: '1', window: null, by: 'patient' },
      { at: 0, by: 'patient' },
      { at: 0, window: '../x', by: 'patient' },
      { at: 0, window: null, by: 'nurse' },
      { at: 0, window: null, by: 'helper', name: 7 },
      { at: 0, window: null, by: 'helper', name: 'x'.repeat(41) },
    ]) {
      assert.equal(parseStateBody(bad).ok, false, JSON.stringify(bad));
    }
  });

  test('a room expires 3 hours after its last change, only once no one listens', () => {
    const room = { changedAt: 0, clients: new Set() };
    assert.equal(isExpired(room, ROOM_TTL_MS - 1), false);
    assert.equal(isExpired(room, ROOM_TTL_MS), true);
    room.clients.add({});
    assert.equal(isExpired(room, ROOM_TTL_MS * 2), false);
  });
});

describe('museum rooms: routes', () => {
  let guide;
  before(async () => {
    guide = await startGuide();
  });
  after(() => guide.close());

  test('create a room; two listeners both receive a posted state', async () => {
    const created = await postJson(`${guide.base}/api/museum/rooms`, { at: 1 });
    assert.equal(created.status, 200);
    const { code, state } = await created.json();
    assert.match(code, /^[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    assert.deepEqual({ at: state.at, window: state.window, rev: state.rev }, { at: 1, window: null, rev: 0 });

    const ipad = await listen(guide.base, `/api/museum/rooms/${code}/events?as=patient`);
    assert.equal(ipad.status, 200);
    assert.match(ipad.headers['content-type'], /^text\/event-stream/);
    assert.match(ipad.headers['cache-control'], /no-cache/);
    assert.equal(ipad.headers['x-accel-buffering'], 'no');
    assert.equal((await ipad.next('state')).at, 1, 'the current state arrives on connect');
    assert.deepEqual(await ipad.next('peers'), { patient: 1, helpers: [] });

    const phone = await listen(guide.base, `/api/museum/rooms/${code.toLowerCase()}/events?as=helper&name=Priya`);
    assert.equal((await phone.next('state')).at, 1);
    assert.deepEqual(await ipad.next('peers'), { patient: 1, helpers: ['Priya'] }, 'the iPad sees who joined');

    const posted = await postJson(`${guide.base}/api/museum/rooms/${code}/state`, { at: 0, window: CAPTURE_ID, by: 'helper', name: 'Priya' });
    assert.equal(posted.status, 200, await posted.clone().text());
    const [onIpad, onPhone] = await Promise.all([ipad.next('state'), phone.next('state')]);
    for (const s of [onIpad, onPhone]) {
      assert.deepEqual({ at: s.at, window: s.window, by: s.by, name: s.name, rev: s.rev }, { at: 0, window: CAPTURE_ID, by: 'helper', name: 'Priya', rev: 1 });
    }

    phone.close();
    assert.deepEqual(await ipad.next('peers'), { patient: 1, helpers: [] }, 'the helper leaving is noticed');
    const room = await (await fetch(`${guide.base}/api/museum/rooms/${code}`)).json();
    assert.equal(room.state.window, CAPTURE_ID);
    ipad.close();
  });

  test('a bad or unknown code answers 404', async () => {
    for (const code of ['KATB', 'AB', 'ZZZZZ']) {
      assert.equal((await fetch(`${guide.base}/api/museum/rooms/${code}`)).status, 404, code);
      assert.equal((await fetch(`${guide.base}/api/museum/rooms/${code}/events`)).status, 404, code);
    }
    const res = await postJson(`${guide.base}/api/museum/rooms/ZZZZ/state`, { at: 0, window: null, by: 'patient' });
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /code/);
  });

  test('a bad body answers 400, and so does an unknown capture id', async () => {
    const { code } = await (await postJson(`${guide.base}/api/museum/rooms`, {})).json();
    const url = `${guide.base}/api/museum/rooms/${code}/state`;
    assert.equal((await postJson(url, { at: 'two', window: null, by: 'patient' })).status, 400);
    assert.equal((await postJson(url, { at: 0, window: null, by: 'someone' })).status, 400);
    assert.equal((await fetch(url, { method: 'POST', body: '{not json' })).status, 400);
    const unknown = await postJson(url, { at: 0, window: '99999999-2222-4333-8444-555555555555', by: 'patient' });
    assert.equal(unknown.status, 400);
    assert.match((await unknown.json()).error, /No capture/);
    assert.equal((await postJson(`${guide.base}/api/museum/rooms`, { at: -5 })).status, 400);
  });

  test('an expired room is gone', async () => {
    const { code } = await (await postJson(`${guide.base}/api/museum/rooms`, {})).json();
    guide.clock.t += ROOM_TTL_MS - 1000;
    const kept = await postJson(`${guide.base}/api/museum/rooms/${code}/state`, { at: 2, window: null, by: 'patient' });
    assert.equal(kept.status, 200, 'a change resets the 3 hours');
    guide.clock.t += ROOM_TTL_MS - 1000;
    assert.equal((await fetch(`${guide.base}/api/museum/rooms/${code}`)).status, 200);
    guide.clock.t += 1000;
    assert.equal((await fetch(`${guide.base}/api/museum/rooms/${code}`)).status, 404);
    assert.equal((await fetch(`${guide.base}/api/museum/rooms/${code}/events`)).status, 404);
  });
});
