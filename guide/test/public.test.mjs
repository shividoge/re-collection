import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { CAPTURE_ID, startGuide, tinyCapture, writeCapture } from './helpers.mjs';

const KEY = 'team-secret';
const OTHER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SESSION_ID = '99999999-8888-4777-8666-555555555555';
const OPEN_SESSION_ID = '99999999-8888-4777-8666-555555555556';

const fact = (id, text, extra = {}) => ({
  id, text, kind: 'object', salience: 2, cue: '', status: 'pending', editedText: null, doNotRaise: false,
  evidence: [{ type: 'frame', t: 0, keyframe: 'keyframes/k0000.jpg' }], ...extra,
});
const moment = {
  captureId: CAPTURE_ID,
  moment: { title: 'Cake visit', place: 'Kitchen', occasion: '', summary: 'A short visit.' },
  facts: [
    fact('f1', 'Priya brought a mango cake.', { status: 'approved' }),
    fact('f2', 'Dev wore a red sweater.', { status: 'approved', editedText: 'Dev wore his red sweater.' }),
    fact('f3', 'Raj told a story about the war.', { status: 'approved', doNotRaise: true }),
    fact('f4', 'There were yellow flowers.', { status: 'pending' }),
    fact('f5', 'A blue vase stood by the window.', { status: 'rejected' }),
  ],
  chapters: [{ tStart: 0, tEnd: 2, label: 'Arriving' }],
  dropped: [{ text: 'A claim with no evidence.', reason: 'no evidence' }],
};

function session(id, momentId, endedAt) {
  return {
    id, momentId, person: { displayName: 'Grandma', preferredAddress: 'Mom' },
    startedAt: '2026-10-24T20:00:00.000Z', endedAt, endReason: endedAt ? 'complete' : null,
    allowedFactIds: ['f1', 'f2'], said: ['f1'],
    turns: [{ t: '2026-10-24T20:00:01.000Z', speaker: 'claude', text: 'Hello, Mom.', kind: 'welcome', factIds: [], private: 'x' }],
    dropped: [{ t: '2026-10-24T20:00:02.000Z', sentence: 'Your grandson visited.', reason: 'mentions a person' }],
    branches: [], alerts: [], scores: [{ factId: 'f1', result: 'after_cue', line: 1 }], note: 'A calm session.',
  };
}

describe('public surface', () => {
  let guide;
  const get = (path, headers = {}) => fetch(`${guide.base}${path}`, { headers });
  const setPublic = (id, value, key = KEY) =>
    fetch(`${guide.base}/api/captures/${id}/public`, {
      method: 'PUT',
      headers: key ? { 'X-Braindance-Key': key, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public: value }),
    });

  before(async () => {
    guide = await startGuide({ key: KEY });
    const { files, manifest } = tinyCapture();
    await writeCapture(guide.config.dataDir, {
      ...files,
      'moment.json': JSON.stringify(moment),
      'status.json': JSON.stringify({ upload: 'done', facts: 'done', factsError: null }),
    });
    const other = tinyCapture({ id: OTHER_ID });
    await writeCapture(guide.config.dataDir, { ...other.files, 'status.json': JSON.stringify({ upload: 'done', facts: 'done' }) }, OTHER_ID);

    const sessions = join(guide.config.dataDir, 'sessions');
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, `${SESSION_ID}.json`), JSON.stringify(session(SESSION_ID, CAPTURE_ID, '2026-10-24T20:05:00.000Z')));
    await writeFile(join(sessions, `${OPEN_SESSION_ID}.json`), JSON.stringify(session(OPEN_SESSION_ID, CAPTURE_ID, null)));
    assert.equal(manifest.id, CAPTURE_ID);
  });
  after(() => guide.server.close());

  test('nothing is visible until the family marks a capture public', async () => {
    assert.deepEqual(await (await get('/public/captures')).json(), []);
    for (const path of [
      `/public/captures/${CAPTURE_ID}`, `/public/moments/${CAPTURE_ID}`, `/public/progress/${CAPTURE_ID}`,
      `/public/files/${CAPTURE_ID}/room.bin`, `/public/sessions/${SESSION_ID}`,
    ]) {
      assert.equal((await get(path)).status, 404, path);
    }
    // A private capture and a missing one look the same to a visitor.
    const missing = await get('/public/captures/00000000-0000-4000-8000-000000000000');
    const hidden = await get(`/public/captures/${CAPTURE_ID}`);
    assert.deepEqual(await missing.json(), await hidden.json());
  });

  test('only someone with the key can change visibility', async () => {
    assert.equal((await setPublic(CAPTURE_ID, true, '')).status, 401);
    assert.equal((await setPublic(CAPTURE_ID, true, 'wrong')).status, 401);
    assert.equal((await setPublic(CAPTURE_ID, 'yes')).status, 400);
    assert.equal((await setPublic(CAPTURE_ID, true)).status, 200);
    assert.equal((await get('/api/captures')).status, 401);   // the private API still wants the key
  });

  test('a public capture is listed and readable without a key', async () => {
    const list = await (await get('/public/captures')).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, CAPTURE_ID);
    assert.equal(list[0].title, 'Cake visit');
    assert.equal(list[0].facts, 2);
    assert.equal(list[0].thumb, `/public/files/${CAPTURE_ID}/thumb.jpg`);

    const detail = await (await get(`/public/captures/${CAPTURE_ID}`)).json();
    assert.equal(detail.manifest.id, CAPTURE_ID);
    assert.equal(detail.manifest.title, 'Test visit');
    assert.equal(detail.files['room.bin'], `/public/files/${CAPTURE_ID}/room.bin`);
    assert.equal('status.json' in detail.files, false);
    assert.equal('moment.json' in detail.files, false);
    assert.equal('room.ply' in detail.files, false);
  });

  test('visitors only see facts the family approved, never "don\'t bring up", pending or rejected', async () => {
    const shown = await (await get(`/public/moments/${CAPTURE_ID}`)).json();
    assert.deepEqual(shown.facts.map((f) => f.id), ['f1', 'f2']);
    assert.equal(shown.facts[1].text, 'Dev wore his red sweater.');
    assert.deepEqual(shown.dropped, []);
    const raw = JSON.stringify(shown);
    for (const secret of ['Raj', 'yellow flowers', 'blue vase', 'no evidence']) assert.equal(raw.includes(secret), false, secret);
  });

  test('files are served with Range, but the guide\'s own files are not', async () => {
    const part = await get(`/public/files/${CAPTURE_ID}/room.bin`, { Range: 'bytes=0-3' });
    assert.equal(part.status, 206);
    assert.equal(Buffer.from(await part.arrayBuffer()).readUInt32LE(0), 2);
    for (const name of ['status.json', 'moment.json', 'room.ply']) {
      assert.equal((await get(`/public/files/${CAPTURE_ID}/${name}`)).status, 404, name);
    }
    assert.equal((await get(`/public/files/${CAPTURE_ID}/..%2Fother`)).status === 200, false);
  });

  test('a finished session of a public capture can be read, without private fields', async () => {
    const done = await (await get(`/public/sessions/${SESSION_ID}`)).json();
    assert.equal(done.turns[0].text, 'Hello, Mom.');
    assert.equal(done.dropped[0].sentence, 'Your grandson visited.');
    assert.equal('person' in done, false);
    assert.equal('private' in done.turns[0], false);
    assert.equal((await get(`/public/sessions/${OPEN_SESSION_ID}`)).status, 404);   // still running

    const progress = await (await get(`/public/progress/${CAPTURE_ID}`)).json();
    assert.deepEqual(progress.facts.map((f) => f.id), ['f1', 'f2']);
    assert.equal(progress.sessions.length, 1);
  });

  test('other captures stay private, and nothing under /public writes', async () => {
    assert.equal((await get(`/public/captures/${OTHER_ID}`)).status, 404);
    for (const method of ['PUT', 'POST', 'PATCH', 'DELETE']) {
      const res = await fetch(`${guide.base}/public/captures`, { method });
      assert.equal(res.status, 404, method);
    }
  });

  test('marking it private again hides it at once', async () => {
    assert.equal((await setPublic(CAPTURE_ID, false)).status, 200);
    assert.deepEqual(await (await get('/public/captures')).json(), []);
    assert.equal((await get(`/public/moments/${CAPTURE_ID}`)).status, 404);
  });
});
