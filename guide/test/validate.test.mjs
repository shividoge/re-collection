import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Store } from '../src/store.mjs';
import { validateCapture } from '../src/validate.mjs';
import { addSplat, CAPTURE_ID, tempDataDir, tinyCapture, tinySplatPly, writeCapture } from './helpers.mjs';

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

test('a capture with a valid room splat passes, with or without normals and higher SH', async () => {
  for (const options of [{}, { normals: false }, { shDegree: 3, count: 5 }]) {
    const result = await check((files, manifest) => addSplat(files, manifest, options));
    assert.deepEqual(result.errors, [], JSON.stringify(options));
  }
});

test('a listed room splat must exist', async () => {
  const result = await check((files, manifest) => {
    addSplat(files, manifest);
    delete files['room.splat.ply'];
  });
  assert.match(result.errors.join(' '), /room\.splat\.ply is missing \(the room splat\)/);
});

test('a truncated room splat is caught with the size its header implies', async () => {
  const result = await check((files, manifest) => {
    addSplat(files, manifest);
    files['room.splat.ply'] = files['room.splat.ply'].subarray(0, files['room.splat.ply'].length - 4);
  });
  assert.match(result.errors.join(' '), /room\.splat\.ply is \d+ bytes, but its header implies \d+ \(2 × 68 bytes/);
});

test('room splat count, SH degree, format and file type must agree with the manifest', async () => {
  const count = await check((files, manifest) => {
    addSplat(files, manifest);
    manifest.room.splat.count = 3;
  });
  assert.match(count.errors.join(' '), /has 2 Gaussians, but manifest\.room\.splat\.count is 3/);

  const sh = await check((files, manifest) => {
    addSplat(files, manifest);
    manifest.room.splat.shDegree = 1;
  });
  assert.match(sh.errors.join(' '), /is missing properties f_rest_0, .*f_rest_8/);

  const ascii = await check((files, manifest) => addSplat(files, manifest, { format: 'ascii' }));
  assert.match(ascii.errors.join(' '), /format is ascii, expected binary_little_endian/);

  const notPly = await check((files, manifest) => {
    addSplat(files, manifest);
    files['room.splat.ply'] = Buffer.from('{"not":"a ply"}');
  });
  assert.match(notPly.errors.join(' '), /isn't a PLY file/);

  const format = await check((files, manifest) => {
    addSplat(files, manifest);
    manifest.room.splat.format = 'spz';
  });
  assert.match(format.errors.join(' '), /manifest\.room\.splat\.format is "spz"/);
});

test('tinySplatPly is the INRIA layout: 17 floats per Gaussian at SH 0 with normals', () => {
  const ply = tinySplatPly({ count: 1 });
  const end = ply.indexOf('end_header\n') + 'end_header\n'.length;
  assert.equal(ply.length - end, 17 * 4);
});
