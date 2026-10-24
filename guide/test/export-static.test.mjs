import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { exportStatic } from '../src/export-static.mjs';
import { CAPTURE_ID, tempDataDir, tinyCapture, writeCapture } from './helpers.mjs';

const PRIVATE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const DONE = '99999999-8888-4777-8666-555555555555';
const OPEN = '99999999-8888-4777-8666-555555555556';
const OTHER = '99999999-8888-4777-8666-555555555557';

const fact = (id, text, extra = {}) => ({
  id, text, kind: 'object', salience: 2, cue: '', status: 'pending', editedText: null, doNotRaise: false,
  evidence: [{ type: 'frame', t: 0, keyframe: 'keyframes/k0000.jpg' }], ...extra,
});
const moment = {
  captureId: CAPTURE_ID,
  moment: { title: 'Cake visit', place: '', occasion: '', summary: 'A short visit.' },
  facts: [
    fact('f1', 'Priya brought a mango cake.', { status: 'approved' }),
    fact('f2', 'Raj told a story about the war.', { status: 'approved', doNotRaise: true }),
    fact('f3', 'There were yellow flowers.', { status: 'pending' }),
  ],
  chapters: [{ tStart: 0, tEnd: 2, label: 'Arriving' }],
  dropped: [{ text: 'A claim with no evidence.', reason: 'no evidence' }],
};
const session = (id, momentId, endedAt) => ({
  id, momentId, person: { displayName: 'Grandma', preferredAddress: 'Mom' },
  startedAt: '2026-10-24T20:00:00.000Z', endedAt, endReason: endedAt ? 'complete' : null,
  allowedFactIds: ['f1'], said: [], turns: [{ t: 'x', speaker: 'claude', text: 'Hello, Mom.', kind: 'welcome', factIds: [] }],
  dropped: [], branches: [], alerts: [], scores: [{ factId: 'f1', result: 'after_cue' }], note: 'Calm.',
});

async function walk(dir) {
  const names = [];
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (e.isFile()) names.push(join(e.parentPath, e.name).slice(dir.length + 1));
  }
  return names.sort();
}

async function setup({ publicCapture = true } = {}) {
  const dataDir = await tempDataDir();
  const { files } = tinyCapture();
  await writeCapture(dataDir, {
    ...files,
    'moment.json': JSON.stringify(moment),
    'status.json': JSON.stringify({ upload: 'done', facts: 'done', public: publicCapture }),
  });
  const other = tinyCapture({ id: PRIVATE_ID });
  await writeCapture(dataDir, { ...other.files, 'status.json': JSON.stringify({ upload: 'done', facts: 'done' }) }, PRIVATE_ID);
  const dir = join(dataDir, 'sessions');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${DONE}.json`), JSON.stringify(session(DONE, CAPTURE_ID, '2026-10-24T20:05:00.000Z')));
  await writeFile(join(dir, `${OPEN}.json`), JSON.stringify(session(OPEN, CAPTURE_ID, null)));
  await writeFile(join(dir, `${OTHER}.json`), JSON.stringify(session(OTHER, PRIVATE_ID, '2026-10-24T20:06:00.000Z')));
  return { dataDir, outDir: await tempDataDir() };
}

describe('static export', () => {
  test('exports only what the live public routes would show', async () => {
    const { dataDir, outDir } = await setup();
    const summary = await exportStatic({ dataDir, outDir });
    const out = join(outDir, 'data');
    const names = await walk(out);

    assert.equal(summary.captures.length, 1);
    assert.equal(summary.sessions, 1);
    assert.deepEqual(summary.warnings, []);

    const list = JSON.parse(await readFile(join(out, 'captures.json'), 'utf8'));
    assert.deepEqual(list.map((c) => c.id), [CAPTURE_ID]);
    assert.equal(list[0].facts, 1);
    assert.equal(list[0].thumb, `data/files/${CAPTURE_ID}/thumb.jpg`);

    const shown = JSON.parse(await readFile(join(out, 'moments', `${CAPTURE_ID}.json`), 'utf8'));
    assert.deepEqual(shown.facts.map((f) => f.id), ['f1']);
    assert.deepEqual(shown.dropped, []);

    // The viewer's files are there; the guide's own files and the .ply are not.
    for (const needed of ['room.bin', 'frames.jsonl', 'depth.bin', 'confidence.bin', 'manifest.json', 'thumb.jpg', 'video.mov']) {
      assert.ok(names.includes(`files/${CAPTURE_ID}/${needed}`), needed);
    }
    for (const hidden of ['status.json', 'moment.json', 'room.ply']) {
      assert.equal(names.includes(`files/${CAPTURE_ID}/${hidden}`), false, hidden);
    }

    // Only the finished session of the public capture, without person details.
    assert.deepEqual(names.filter((n) => n.startsWith('sessions/')), [`sessions/${DONE}.json`]);
    const exported = JSON.parse(await readFile(join(out, 'sessions', `${DONE}.json`), 'utf8'));
    assert.equal('person' in exported, false);

    // Nothing about the private capture or the hidden facts anywhere in the output.
    const everything = (await Promise.all(names.filter((n) => n.endsWith('.json')).map((n) => readFile(join(out, n), 'utf8')))).join('\n');
    for (const secret of [PRIVATE_ID, 'Raj', 'yellow flowers', 'no evidence', 'Grandma', OPEN, OTHER]) {
      assert.equal(everything.includes(secret), false, secret);
    }
  });

  test('with nothing public it exports an empty list and no files', async () => {
    const { dataDir, outDir } = await setup({ publicCapture: false });
    const summary = await exportStatic({ dataDir, outDir });
    assert.equal(summary.captures.length, 0);
    assert.deepEqual(JSON.parse(await readFile(join(outDir, 'data', 'captures.json'), 'utf8')), []);
    assert.deepEqual((await walk(join(outDir, 'data'))).filter((n) => n !== '.braindance-static-data'), ['captures.json']);
  });

  test('exporting again replaces the old output, and it never wipes a folder it did not make', async () => {
    const { dataDir, outDir } = await setup();
    await exportStatic({ dataDir, outDir });
    await writeFile(join(outDir, 'data', 'stale.txt'), 'old');
    await exportStatic({ dataDir, outDir });
    await assert.rejects(stat(join(outDir, 'data', 'stale.txt')));

    const strange = await tempDataDir();
    await mkdir(join(strange, 'data'));
    await writeFile(join(strange, 'data', 'mine.txt'), 'keep me');
    await assert.rejects(exportStatic({ dataDir, outDir: strange }), /wasn't made by this exporter/);
    assert.equal(await readFile(join(strange, 'data', 'mine.txt'), 'utf8'), 'keep me');
  });
});
