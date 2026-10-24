import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Store } from '../src/store.mjs';
import { validateCapture } from '../src/validate.mjs';
import { CAPTURE_ID, tempDataDir, tinyCapture, writeCapture } from './helpers.mjs';

async function check(mutate) {
  const dataDir = await tempDataDir();
  const { files, manifest } = tinyCapture();
  mutate?.(files, manifest);
  files['manifest.json'] = Buffer.from(JSON.stringify(manifest));
  await writeCapture(dataDir, files);
  return validateCapture(new Store(dataDir), CAPTURE_ID);
}

test('a complete capture passes', async () => {
  const result = await check();
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test('depth.bin with the wrong size is caught with the expected size', async () => {
  const result = await check((files) => {
    files['depth.bin'] = files['depth.bin'].subarray(0, 10);
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /depth\.bin is 10 bytes, but the manifest implies 48/);
});

test('a missing video is named', async () => {
  const result = await check((files) => {
    delete files['video.mov'];
  });
  assert.match(result.errors.join(' '), /video\.mov is missing/);
});

test('room.bin whose header disagrees with the manifest is caught', async () => {
  const result = await check((files) => {
    files['room.bin'].writeUInt32LE(7, 0);
  });
  assert.match(result.errors.join(' '), /room\.bin says 7 points/);
});

test('frame count must match the moment lines in frames.jsonl', async () => {
  const result = await check((files, manifest) => {
    manifest.video.frameCount = 5;
  });
  assert.match(result.errors.join(' '), /3 moment lines, but manifest\.video\.frameCount is 5/);
});

test('a depth index past the end of depth.bin is caught', async () => {
  const result = await check((files, manifest) => {
    manifest.depth.count = 1;
    files['depth.bin'] = Buffer.alloc(1 * 4 * 3 * 2);
    files['confidence.bin'] = Buffer.alloc(1 * 4 * 3);
  });
  assert.match(result.errors.join(' '), /points at depth frame 1, but manifest\.depth\.count is 1/);
});

test('declared keyframes must all be there', async () => {
  const result = await check((files, manifest) => {
    manifest.keyframes = { dir: 'keyframes', everySec: 1, count: 2 };
  });
  assert.match(result.errors.join(' '), /keyframes\/ has 0 images, but manifest\.keyframes\.count is 2/);
});

test('a manifest for another capture is rejected', async () => {
  const result = await check((files, manifest) => {
    manifest.id = 'aaaaaaaa-2222-4333-8444-555555555555';
  });
  assert.match(result.errors.join(' '), /doesn't match the upload id/);
});
