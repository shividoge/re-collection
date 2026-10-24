import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { validateRegions } from '../src/hidden.mjs';
import { CAPTURE_ID, startGuide, tinyCapture } from './helpers.mjs';

describe('hide from her', () => {
  let guide;
  before(async () => {
    guide = await startGuide();
    for (const [name, data] of Object.entries(tinyCapture().files)) {
      await fetch(`${guide.base}/api/captures/${CAPTURE_ID}/files/${name}`, { method: 'PUT', body: data });
    }
  });
  after(() => guide.server.close());

  const put = (regions) =>
    fetch(`${guide.base}/api/captures/${CAPTURE_ID}/hidden`, { method: 'PUT', body: JSON.stringify({ regions }) });

  test('a capture starts with nothing hidden', async () => {
    const detail = await (await fetch(`${guide.base}/api/captures/${CAPTURE_ID}`)).json();
    assert.deepEqual(detail.hidden, []);
  });

  test('the family can hide a box, and it comes back with the capture', async () => {
    const res = await put([{ label: 'Boxes', min: [0, 0, -2], max: [0.5, 0.6, -1.5] }]);
    assert.equal(res.status, 200);
    const detail = await (await fetch(`${guide.base}/api/captures/${CAPTURE_ID}`)).json();
    assert.equal(detail.hidden.length, 1);
    assert.equal(detail.hidden[0].label, 'Boxes');
    assert.deepEqual(detail.hidden[0].max, [0.5, 0.6, -1.5]);
  });

  test('bad boxes are refused with a reason, and the file can\'t be uploaded over', async () => {
    assert.equal((await put([{ min: [0, 0, 0], max: [0, 1, 1] }])).status, 400);
    assert.equal((await put('nope')).status, 400);
    const upload = await fetch(`${guide.base}/api/captures/${CAPTURE_ID}/files/hidden.json`, { method: 'PUT', body: '{}' });
    assert.equal(upload.status, 400);
  });
});

test('validateRegions caps the count and keeps ids', () => {
  assert.throws(() => validateRegions(Array.from({ length: 17 }, () => ({ min: [0, 0, 0], max: [1, 1, 1] }))), /At most 16/);
  assert.equal(validateRegions([{ id: 'x1', min: [0, 0, 0], max: [1, 1, 1] }])[0].id, 'x1');
});
