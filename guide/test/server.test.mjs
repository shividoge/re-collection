import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { after, before, describe, test } from 'node:test';

import { createApp } from '../src/server.mjs';
import { parseRange } from '../src/http.mjs';
import { CAPTURE_ID, startGuide, tempDataDir, tinyCapture } from './helpers.mjs';


/** fetch() normalizes "../" in URLs, so raw paths go through http.request. */
function rawGet(base, path) {
  return new Promise((resolve, reject) => {
    const { hostname, port } = new URL(base);
    const req = request({ hostname, port, path, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

async function upload(base, files, headers = {}) {
  for (const [name, data] of Object.entries(files)) {
    const res = await fetch(`${base}/api/captures/${CAPTURE_ID}/files/${name}`, { method: 'PUT', body: data, headers });
    assert.equal(res.status, 200, `${name}: ${await res.text()}`);
  }
}

describe('guide server', () => {
  let guide;
  before(async () => {
    guide = await startGuide();
  });
  after(() => guide.server.close());

  test('/health reports Claude config without a key', async () => {
    const body = await (await fetch(`${guide.base}/health`)).json();
    assert.equal(body.ok, true);
    assert.equal(body.mock, false);
    assert.equal(body.claudeConfigured, false);
  });

  test('upload, complete, list and fetch a capture', async () => {
    const { files } = tinyCapture();
    await upload(guide.base, files);

    const done = await fetch(`${guide.base}/api/captures/${CAPTURE_ID}/complete`, { method: 'POST' });
    assert.equal(done.status, 200, await done.clone().text());
    assert.equal((await done.json()).status.facts, 'queued');

    const list = await (await fetch(`${guide.base}/api/captures`)).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].title, 'Test visit');
    assert.equal(list[0].thumb, `/files/${CAPTURE_ID}/thumb.jpg`);

    const detail = await (await fetch(`${guide.base}/api/captures/${CAPTURE_ID}`)).json();
    assert.equal(detail.manifest.id, CAPTURE_ID);
    assert.equal(detail.files['room.bin'], `/files/${CAPTURE_ID}/room.bin`);
    assert.equal(detail.status.upload, 'done');
  });

  test('Range requests return 206 with exactly the requested bytes', async () => {
    const { files } = tinyCapture();
    const res = await fetch(`${guide.base}/files/${CAPTURE_ID}/room.bin`, { headers: { Range: 'bytes=0-3' } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), `bytes 0-3/${files['room.bin'].length}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(bytes.length, 4);
    assert.equal(bytes.readUInt32LE(0), 2);

    const full = await fetch(`${guide.base}/files/${CAPTURE_ID}/room.bin`);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), files['room.bin']);

    const past = await fetch(`${guide.base}/files/${CAPTURE_ID}/room.bin`, { headers: { Range: 'bytes=9999-' } });
    assert.equal(past.status, 416);
  });

  test('a capture that fails validation says why and is marked invalid', async () => {
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const { files } = tinyCapture({ id });
    files['depth.bin'] = Buffer.alloc(3);
    for (const [name, data] of Object.entries(files)) {
      await fetch(`${guide.base}/api/captures/${id}/files/${name}`, { method: 'PUT', body: data });
    }
    const res = await fetch(`${guide.base}/api/captures/${id}/complete`, { method: 'POST' });
    assert.equal(res.status, 422);
    assert.match((await res.json()).error, /depth\.bin is 3 bytes/);
    const detail = await (await fetch(`${guide.base}/api/captures/${id}`)).json();
    assert.equal(detail.status.upload, 'invalid');
  });

  test('paths that try to leave the capture folder are rejected', async () => {
    for (const path of [
      `/files/${CAPTURE_ID}/..%2F..%2Fpackage.json`,
      `/files/${CAPTURE_ID}/%2e%2e/secret`,
      `/files/not-a-uuid/room.bin`,
      `/files/${CAPTURE_ID}/../../package.json`,
    ]) {
      const status = await rawGet(guide.base, path);
      assert.ok([400, 404].includes(status), `${path} returned ${status}`);
    }
    const leaked = await (await fetch(`${guide.base}/files/${CAPTURE_ID}/..%2F..%2Fpackage.json`)).text();
    assert.doesNotMatch(leaked, /braindance-guide/);
    const res = await fetch(`${guide.base}/api/captures/${CAPTURE_ID}/files/status.json`, { method: 'PUT', body: '{}' });
    assert.equal(res.status, 400, 'the phone must not overwrite status.json');
  });

  test('keyframes/ uploads land in a subfolder', async () => {
    const res = await fetch(`${guide.base}/api/captures/${CAPTURE_ID}/files/keyframes/k0000.jpg`, {
      method: 'PUT',
      body: Buffer.from([0xff, 0xd8]),
    });
    assert.equal(res.status, 200);
    const got = await fetch(`${guide.base}/files/${CAPTURE_ID}/keyframes/k0000.jpg`);
    assert.equal(got.headers.get('content-type'), 'image/jpeg');
  });

  test('CORS preflight is answered', async () => {
    const res = await fetch(`${guide.base}/api/captures`, { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });
});

describe('guide server with a key', () => {
  let guide;
  before(async () => {
    guide = await startGuide({ key: 'secret' });
  });
  after(() => guide.server.close());

  test('API routes need X-Braindance-Key, /health does not', async () => {
    assert.equal((await fetch(`${guide.base}/health`)).status, 200);
    assert.equal((await fetch(`${guide.base}/api/captures`)).status, 401);
    assert.equal((await fetch(`${guide.base}/api/captures`, { headers: { 'X-Braindance-Key': 'secret' } })).status, 200);
  });

  test('/files accepts ?key= because <video> cannot send headers', async () => {
    const { files } = tinyCapture();
    await upload(guide.base, { 'room.bin': files['room.bin'] }, { 'X-Braindance-Key': 'secret' });
    assert.equal((await fetch(`${guide.base}/files/${CAPTURE_ID}/room.bin`)).status, 401);
    assert.equal((await fetch(`${guide.base}/files/${CAPTURE_ID}/room.bin?key=secret`)).status, 200);
  });
});

test('parseRange handles open, suffix and bad ranges', () => {
  assert.deepEqual(parseRange('bytes=0-3', 10), { start: 0, end: 3 });
  assert.deepEqual(parseRange('bytes=5-', 10), { start: 5, end: 9 });
  assert.deepEqual(parseRange('bytes=-4', 10), { start: 6, end: 9 });
  assert.deepEqual(parseRange('bytes=8-100', 10), { start: 8, end: 9 });
  assert.equal(parseRange('bytes=10-', 10), 'unsatisfiable');
  assert.equal(parseRange('bytes=0-1,4-5', 10), null);
  assert.equal(parseRange(undefined, 10), null);
});

describe('serving the web app', () => {
  let guide;
  before(async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const webDir = join(await tempDataDir(), 'dist');
    await mkdir(join(webDir, 'assets'), { recursive: true });
    await writeFile(join(webDir, 'index.html'), '<!doctype html><title>Braindance</title>');
    await writeFile(join(webDir, 'assets', 'app.js'), 'console.log(1)');
    guide = await startGuide({ key: 'secret', webDir });
  });
  after(() => guide.server.close());

  test('the app loads without the key, the API still needs it', async () => {
    const page = await fetch(`${guide.base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const script = await fetch(`${guide.base}/assets/app.js`);
    assert.match(script.headers.get('content-type'), /javascript/);
    assert.equal((await fetch(`${guide.base}/api/captures`)).status, 401);
    assert.equal((await (await fetch(`${guide.base}/health`)).json()).keyRequired, true);
  });

  test('paths outside the app folder are refused', async () => {
    // "../" collapses inside the app folder, so these get index.html, never a file from outside.
    for (const path of ['/..%2f..%2fpackage.json', '/../../package.json', '/%2e%2e/%2e%2e/src/server.mjs']) {
      const status = await rawGet(guide.base, path);
      assert.ok([200, 400, 404].includes(status), `${path} returned ${status}`);
      const body = await (await fetch(guide.base + path)).text();
      assert.doesNotMatch(body, /braindance-guide|createApp/, `${path} leaked a file`);
    }
  });
});
