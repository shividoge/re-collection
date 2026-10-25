import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { CAPTION_MAX, MAX_ITEMS, publicArrangement, validateArrangement } from '../src/arrangement.mjs';
import { startGuide } from './server.test.mjs';
import { CAPTURE_ID, tinyCapture, writeCapture } from './helpers.mjs';

const OTHER_ID = '99999999-2222-4333-8444-555555555555';
const ids = new Set([CAPTURE_ID, OTHER_ID]);

describe('validateArrangement', () => {
  test('keeps the order, cleans the text and fills a default title', () => {
    const { value } = validateArrangement(
      {
        items: [
          { capture: OTHER_ID, piece: 'k0012', title: '  Her 70th  ', caption: 'The whole   family came.' },
          { capture: CAPTURE_ID, piece: 'video' },
        ],
      },
      ids,
    );
    assert.equal(value.title, 'Memory Palace');
    assert.deepEqual(value.items, [
      { capture: OTHER_ID, piece: 'k0012', title: 'Her 70th', caption: 'The whole family came.' },
      { capture: CAPTURE_ID, piece: 'video', title: '', caption: '' },
    ]);
  });

  test('cuts a long caption to the limit', () => {
    const { value } = validateArrangement({ items: [{ capture: CAPTURE_ID, piece: 'thumb', caption: 'x'.repeat(500) }] }, ids);
    assert.equal(value.items[0].caption.length, CAPTION_MAX);
  });

  test('rejects unknown captures, odd pieces and too many pictures', () => {
    assert.match(validateArrangement({ items: [{ capture: '00000000-0000-4000-8000-000000000000', piece: 'video' }] }, ids).error, /doesn't exist/);
    assert.match(validateArrangement({ items: [{ capture: CAPTURE_ID, piece: '../room.bin' }] }, ids).error, /piece/);
    assert.match(validateArrangement({ items: [{ capture: CAPTURE_ID, piece: 'k12' }] }, ids).error, /piece/);
    const many = Array.from({ length: MAX_ITEMS + 1 }, () => ({ capture: CAPTURE_ID, piece: 'video' }));
    assert.match(validateArrangement({ items: many }, ids).error, /At most/);
    assert.match(validateArrangement({ items: 'nope' }, ids).error, /list/);
  });

  test('a visitor only sees pictures from public captures', () => {
    const arrangement = { title: 'T', subtitle: '', items: [{ capture: CAPTURE_ID, piece: 'video' }, { capture: OTHER_ID, piece: 'thumb' }] };
    assert.deepEqual(publicArrangement(arrangement, [OTHER_ID]).items, [{ capture: OTHER_ID, piece: 'thumb' }]);
    assert.equal(publicArrangement(null, [OTHER_ID]), null);
  });
});

describe('arrangement routes', () => {
  let guide;
  const call = (method, path, body) =>
    fetch(`${guide.base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });

  before(async () => {
    guide = await startGuide();
    for (const id of ids) {
      const { files } = tinyCapture({ id });
      await writeCapture(guide.config.dataDir, { ...files, 'status.json': JSON.stringify({ upload: 'done', facts: 'done' }) }, id);
    }
  });
  after(() => guide.server.close());

  test('none until the caretaker saves one; then it comes back as saved; reset removes it', async () => {
    assert.deepEqual(await (await call('GET', '/api/museum/arrangement')).json(), { arrangement: null });

    const saved = await call('PUT', '/api/museum/arrangement', {
      title: 'Mom’s museum',
      items: [{ capture: OTHER_ID, piece: 'thumb', caption: 'Sunday lunch' }, { capture: CAPTURE_ID, piece: 'video' }],
    });
    assert.equal(saved.status, 200);
    const { arrangement } = await (await call('GET', '/api/museum/arrangement')).json();
    assert.equal(arrangement.title, 'Mom’s museum');
    assert.deepEqual(arrangement.items.map((i) => i.capture), [OTHER_ID, CAPTURE_ID]);
    assert.equal(arrangement.items[0].caption, 'Sunday lunch');
    assert.ok(arrangement.updatedAt);

    assert.equal((await call('PUT', '/api/museum/arrangement', { items: [{ capture: CAPTURE_ID, piece: 'nope' }] })).status, 400);

    await call('DELETE', '/api/museum/arrangement');
    assert.deepEqual(await (await call('GET', '/api/museum/arrangement')).json(), { arrangement: null });
  });

  test('the public copy leaves out private captures', async () => {
    await call('PUT', '/api/museum/arrangement', { items: [{ capture: CAPTURE_ID, piece: 'video' }, { capture: OTHER_ID, piece: 'thumb' }] });
    await call('PUT', `/api/captures/${OTHER_ID}/public`, { public: true });
    const { arrangement } = await (await call('GET', '/public/museum/arrangement')).json();
    assert.deepEqual(arrangement.items.map((i) => i.capture), [OTHER_ID]);
  });
});
