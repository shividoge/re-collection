import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { validateArrangement } from '../src/arrangement.mjs';
import { cleanName } from '../src/uploads.mjs';
import { startGuide } from './server.test.mjs';
import { CAPTURE_ID, tinyCapture, writeCapture } from './helpers.mjs';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

describe('upload names', () => {
  test('keep only the file name, without control characters, cut to length', () => {
    assert.equal(cleanName('C:\\Users\\me\\Priya cake.jpg'), 'Priya cake.jpg');
    assert.equal(cleanName('../../etc/passwd'), 'passwd');
    assert.equal(cleanName('a\u0000b'), 'ab');
    assert.equal(cleanName(''), 'untitled');
    assert.equal(cleanName('x'.repeat(300)).length, 120);
  });
});

describe('arrangements with uploads', () => {
  const UP = '11111111-2222-4333-8444-555555555555';
  test('an upload item keeps its words; an unknown upload is refused', () => {
    const { value } = validateArrangement({ items: [{ upload: UP, title: ' Cake ', caption: 'June' }] }, new Set(), new Set([UP]));
    assert.deepEqual(value.items, [{ upload: UP, title: 'Cake', caption: 'June' }]);
    assert.match(validateArrangement({ items: [{ upload: UP }] }, new Set(), new Set()).error, /upload that doesn't exist/);
  });
});

describe('upload routes', () => {
  let guide;
  const send = (body, type, name = 'cake.jpg') =>
    fetch(`${guide.base}/api/museum/uploads?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': type }, body });
  const call = (method, path, body) =>
    fetch(`${guide.base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });

  before(async () => {
    guide = await startGuide();
    const { files } = tinyCapture();
    await writeCapture(guide.config.dataDir, { ...files, 'status.json': JSON.stringify({ upload: 'done', facts: 'done' }) });
  });
  after(() => guide.server.close());

  test('a photo goes up, is listed, served (with ranges) and can hang in the museum', async () => {
    const res = await send(JPEG, 'image/jpeg', 'Priya’s cake.jpg');
    assert.equal(res.status, 200);
    const { upload } = await res.json();
    assert.equal(upload.kind, 'photo');
    assert.equal(upload.name, 'Priya’s cake.jpg');
    assert.equal(upload.bytes, JPEG.length);
    assert.equal(upload.url, `/files/museum/${upload.id}`);

    const { uploads } = await (await call('GET', '/api/museum/uploads')).json();
    assert.deepEqual(uploads.map((u) => u.id), [upload.id]);

    const file = await fetch(`${guide.base}${upload.url}`);
    assert.equal(file.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), JPEG);
    const part = await fetch(`${guide.base}${upload.url}`, { headers: { Range: 'bytes=0-3' } });
    assert.equal(part.status, 206);

    const saved = await call('PUT', '/api/museum/arrangement', { items: [{ upload: upload.id, title: 'The cake' }, { capture: CAPTURE_ID, piece: 'video' }] });
    assert.equal(saved.status, 200);
    // Never public: the visitors' copy leaves it out.
    const pub = await (await call('GET', '/public/museum/arrangement')).json();
    assert.ok(pub.arrangement.items.every((i) => !i.upload));
    assert.equal((await fetch(`${guide.base}/public/files/museum/${upload.id}`)).status, 404);

    // Can't be deleted while it hangs; can once it's taken down.
    assert.equal((await call('DELETE', `/api/museum/uploads/${upload.id}`)).status, 409);
    await call('PUT', '/api/museum/arrangement', { items: [{ capture: CAPTURE_ID, piece: 'video' }] });
    assert.equal((await call('DELETE', `/api/museum/uploads/${upload.id}`)).status, 200);
    assert.equal((await fetch(`${guide.base}${upload.url}`)).status, 404);
    assert.deepEqual((await (await call('GET', '/api/museum/uploads')).json()).uploads, []);
  });

  test('refuses other types and empty bodies', async () => {
    assert.equal((await send(Buffer.from('hello'), 'text/plain', 'a.txt')).status, 415);
    assert.equal((await send(Buffer.alloc(0), 'image/png', 'a.png')).status, 400);
    assert.equal((await call('DELETE', '/api/museum/uploads/not-an-id')).status, 404);
  });

  test('a video is a video', async () => {
    const { upload } = await (await send(Buffer.from('fake mp4 bytes'), 'video/mp4', 'song.mp4')).json();
    assert.equal(upload.kind, 'video');
    assert.equal((await fetch(`${guide.base}${upload.url}`)).headers.get('content-type'), 'video/mp4');
  });
});
