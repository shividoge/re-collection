import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { iceServersFrom, parseView } from '../src/live.mjs';
import { startGuide } from './server.test.mjs';

const VIEW = { x: 0, z: -2, yaw: 0.5, pitch: -0.02, inside: null, music: true };

describe('live visit checks', () => {
  test('a view needs numbers, and a sensible memory to be inside', () => {
    assert.deepEqual(parseView(VIEW).value, VIEW);
    assert.deepEqual(parseView({ ...VIEW, inside: { index: 3, stage: 'here' } }).value.inside, { index: 3, stage: 'here' });
    assert.ok(parseView({ ...VIEW, x: 'a' }).error);
    assert.ok(parseView({ ...VIEW, yaw: Infinity }).error);
    assert.ok(parseView({ ...VIEW, inside: { index: -1, stage: 'here' } }).error);
    assert.ok(parseView({ ...VIEW, inside: { index: 1, stage: 'flying' } }).error);
  });
  test('ICE servers come from the environment, else a public STUN server', () => {
    assert.equal(iceServersFrom('').length, 1);
    assert.deepEqual(iceServersFrom('[{"urls":"turn:t.example:3478","username":"u","credential":"c"}]')[0].urls, 'turn:t.example:3478');
    assert.match(iceServersFrom('not json')[0].urls, /^stun:/);
  });
});

describe('live visit routes', () => {
  let guide;
  const post = (path, body) => fetch(`${guide.base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const poll = (id, since, audioAfter) =>
    fetch(`${guide.base}/api/palace/live?id=${id}${since !== undefined ? `&since=${since}` : ''}${audioAfter !== undefined ? `&audioAfter=${audioAfter}` : ''}`);

  before(async () => {
    guide = await startGuide();
  });
  after(() => guide.server.close());

  test('the patient leads; family see who is here and where the patient is', async () => {
    const patient = await (await post('/api/palace/live/join', { role: 'patient' })).json();
    assert.ok(patient.me.id);
    assert.ok(patient.iceServers.length > 0);
    // No name given: the person the palace is for (people.json), or "Grandma".
    assert.equal(patient.live.members[0].role, 'patient');
    assert.ok(patient.live.members[0].name);

    assert.equal((await post('/api/palace/live/join', { role: 'family' })).status, 400);
    const sam = await (await post('/api/palace/live/join', { role: 'family', name: '  Sam  ' })).json();
    assert.deepEqual(sam.live.members.map((m) => m.name).slice(-1), ['Sam']);

    assert.equal((await post('/api/palace/live/view', { id: sam.me.id, view: VIEW })).status, 403);
    const set = await (await post('/api/palace/live/view', { id: patient.me.id, view: { ...VIEW, inside: { index: 2, stage: 'diving' } } })).json();
    assert.equal(set.rev, 1);

    const seen = await (await poll(sam.me.id)).json();
    assert.equal(seen.view.inside.index, 2);
    assert.equal(seen.members.length, 2);
    // Nothing new since that version: 204, no body.
    assert.equal((await poll(sam.me.id, seen.version)).status, 204);

    // The patient leaving ends the view; Sam sees that.
    await post('/api/palace/live/leave', { id: patient.me.id });
    const after = await (await poll(sam.me.id, seen.version)).json();
    assert.equal(after.view, null);
    assert.deepEqual(after.members.map((m) => m.name), ['Sam']);
    await post('/api/palace/live/leave', { id: sam.me.id });
    assert.equal((await poll(sam.me.id)).status, 404);
  });

  test('call setup messages reach one member, once', async () => {
    const a = await (await post('/api/palace/live/join', { role: 'family', name: 'A' })).json();
    const b = await (await post('/api/palace/live/join', { role: 'family', name: 'B' })).json();
    assert.equal((await post('/api/palace/live/signal', { id: a.me.id, to: b.me.id, data: { type: 'offer', sdp: 'x' } })).status, 200);
    const first = await (await poll(b.me.id)).json();
    assert.deepEqual(first.signals, [{ from: a.me.id, data: { type: 'offer', sdp: 'x' } }]);
    const again = await (await poll(b.me.id)).json();
    assert.deepEqual(again.signals, []);
    assert.equal((await post('/api/palace/live/signal', { id: a.me.id, to: 'nobody', data: {} })).status, 404);
    await post('/api/palace/live/leave', { id: a.me.id });
    await post('/api/palace/live/leave', { id: b.me.id });
  });

  test('voice relayed through the guide goes to everyone else, in order', async () => {
    const a = await (await post('/api/palace/live/join', { role: 'patient' })).json();
    const b = await (await post('/api/palace/live/join', { role: 'family', name: 'B' })).json();
    const send = (id, bytes) => fetch(`${guide.base}/api/palace/live/audio?id=${id}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from(bytes) });
    const s1 = await (await send(a.me.id, [1, 2, 3])).json();
    await send(a.me.id, [4, 5]);
    const got = await (await poll(b.me.id, undefined, 0)).json();
    assert.deepEqual(got.audio.map((c) => [...Buffer.from(c.data, 'base64')]), [[1, 2, 3], [4, 5]]);
    assert.equal(got.audio[0].from, a.me.id);
    // Only what's newer than audioAfter, and never your own voice back.
    const later = await (await poll(b.me.id, undefined, s1.seq)).json();
    assert.equal(later.audio.length, 1);
    const own = await (await poll(a.me.id, undefined, 0)).json();
    assert.equal(own.audio.length, 0);
    // A screen that hasn't asked for voice yet (just joined) gets none of the backlog.
    assert.deepEqual((await (await poll(b.me.id)).json()).audio, []);
    assert.equal((await send(a.me.id, [])).status, 400);
  });
});
