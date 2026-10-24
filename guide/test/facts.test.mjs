import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, test } from 'node:test';

import { chooseKeyframes, extractFacts, groundFacts, mergeFacts } from '../src/facts.mjs';
import { FACTS_SCHEMA } from '../src/prompts.mjs';
import { createApp } from '../src/server.mjs';
import { Store } from '../src/store.mjs';
import { CAPTURE_ID, tempDataDir, tinyCapture, writeCapture } from './helpers.mjs';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

/** The tiny capture plus two keyframes and a transcript, as the new phone build writes. */
function captureWithEvidence() {
  const { files, manifest } = tinyCapture();
  manifest.keyframes = { dir: 'keyframes', everySec: 1, count: 2 };
  manifest.transcript = { file: 'transcript.json', locale: 'en-US', onDevice: true };
  manifest.attendees = ['Priya'];
  manifest.video.durationSec = 2;
  files['manifest.json'] = Buffer.from(JSON.stringify(manifest));
  files['keyframes/k0000.jpg'] = JPEG;
  files['keyframes/k0001.jpg'] = JPEG;
  files['transcript.json'] = Buffer.from(JSON.stringify({
    locale: 'en-US',
    segments: [{ start: 0.4, end: 1.6, text: 'Mom, I brought the mango cake!', words: [] }],
  }));
  return files;
}

/** A stand-in for Claude that records what it was sent and returns `reply`. */
function stubClaude(reply) {
  const calls = [];
  return {
    calls,
    mock: false,
    async json(request) {
      calls.push(request);
      return { data: typeof reply === 'function' ? reply(request) : reply, model: 'stub-model', usage: null };
    },
  };
}

const goodReply = {
  moment: { title: 'Cake visit', place: 'a kitchen', occasion: '', summary: 'Priya visited.' },
  facts: [
    {
      text: 'Priya brought a mango cake.',
      kind: 'object',
      salience: 3,
      cue: 'There was something sweet.',
      evidence: [
        { type: 'transcript', keyframe: null, tStart: 0.4, tEnd: 1.6, quote: 'I brought the mango cake' },
        { type: 'frame', keyframe: 'keyframes/k0001.jpg', tStart: null, tEnd: null, quote: null },
      ],
    },
    {
      // Invented: cites a frame Claude never saw and words nobody said.
      text: 'Grandpa played the piano.',
      kind: 'action',
      salience: 2,
      cue: 'Music',
      evidence: [
        { type: 'frame', keyframe: 'keyframes/k0099.jpg', tStart: null, tEnd: null, quote: null },
        { type: 'transcript', keyframe: null, tStart: 1, tEnd: 2, quote: 'play us a song' },
      ],
    },
  ],
  chapters: [{ tStart: 0, tEnd: 5, label: 'Arriving' }],
};

test('keyframes are spread evenly when there are more than 30', () => {
  const names = Array.from({ length: 90 }, (_, k) => `keyframes/k${String(k).padStart(4, '0')}.jpg`);
  const picked = chooseKeyframes([...names, 'thumb.jpg', 'room.bin']);
  assert.equal(picked.length, 30);
  assert.equal(picked[0], 'keyframes/k0000.jpg');
  assert.equal(picked.at(-1), 'keyframes/k0089.jpg');
  assert.deepEqual(chooseKeyframes(['keyframes/k0001.jpg', 'keyframes/k0000.jpg']), ['keyframes/k0000.jpg', 'keyframes/k0001.jpg']);
});

test('facts are only kept with evidence Claude was actually given', () => {
  const segments = [{ start: 0.4, end: 1.6, text: 'Mom, I brought the mango cake!' }];
  const shown = new Set(['keyframes/k0000.jpg', 'keyframes/k0001.jpg']);
  const { facts, dropped, chapters } = groundFacts(goodReply, shown, segments, 2);

  assert.equal(facts.length, 1);
  assert.equal(facts[0].text, 'Priya brought a mango cake.');
  assert.deepEqual(facts[0].evidence, [
    { type: 'transcript', tStart: 0.4, tEnd: 1.6, quote: 'I brought the mango cake' },
    { type: 'frame', t: 1, keyframe: 'keyframes/k0001.jpg' },
  ]);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].text, 'Grandpa played the piano.');
  assert.deepEqual(chapters, [{ tStart: 0, tEnd: 2, label: 'Arriving' }], 'chapters are clipped to the recording');
});

test('quotes match despite case and punctuation, but not different words', () => {
  const segments = [{ start: 0, end: 2, text: "It's so GOOD to see you, Mom." }];
  const reply = (quote) => ({
    facts: [{ text: 'x', kind: 'speech', salience: 1, cue: '', evidence: [{ type: 'transcript', tStart: 0, tEnd: 2, quote }] }],
  });
  assert.equal(groundFacts(reply("it's so good to see you mom"), new Set(), segments, 2).facts.length, 1);
  assert.equal(groundFacts(reply("it's great to see you"), new Set(), segments, 2).facts.length, 0);
});

test('re-extracting keeps what the family already reviewed', () => {
  const previous = {
    facts: [
      { id: 'f1', text: 'A', status: 'approved', editedText: null, doNotRaise: false },
      { id: 'f2', text: 'B', status: 'pending', editedText: null, doNotRaise: false },
      { id: 'f3', text: 'C', status: 'rejected', editedText: null, doNotRaise: false },
    ],
  };
  const merged = mergeFacts(previous, [{ text: 'D', kind: 'object', salience: 1, evidence: [], cue: '' }]);
  assert.deepEqual(merged.map((f) => [f.id, f.text, f.status]), [
    ['f1', 'A', 'approved'],
    ['f3', 'C', 'rejected'],
    ['f4', 'D', 'pending'],
  ]);
});

test('extraction sends the transcript, names and labeled keyframes, and writes moment.json', async () => {
  const dataDir = await tempDataDir();
  await writeCapture(dataDir, captureWithEvidence());
  const store = new Store(dataDir);
  const claude = stubClaude(goodReply);

  const moment = await extractFacts({ store, claude, model: 'claude-opus-5-5' }, CAPTURE_ID);

  const call = claude.calls[0];
  assert.equal(call.model, 'claude-opus-5-5');
  assert.equal(call.schema, FACTS_SCHEMA);
  const intro = call.content[0].text;
  assert.match(intro, /People the family says were there: Priya/);
  assert.match(intro, /\[0\.4–1\.6\] Mom, I brought the mango cake!/);
  assert.deepEqual(call.content.filter((b) => b.type === 'image').length, 2);
  assert.ok(call.content.some((b) => b.type === 'text' && b.text === 'keyframes/k0001.jpg (t = 1 s)'));

  assert.equal(moment.facts.length, 1);
  assert.equal(moment.facts[0].id, 'f1');
  assert.equal(moment.facts[0].status, 'pending');
  assert.equal(moment.dropped.length, 1);
  assert.equal(moment.model, 'stub-model');
  assert.deepEqual(await store.readJson(CAPTURE_ID, 'moment.json'), moment);
});

test('a capture from before keyframes uses its thumbnail', async () => {
  const dataDir = await tempDataDir();
  await writeCapture(dataDir, tinyCapture().files);
  const claude = stubClaude({ moment: {}, facts: [], chapters: [] });
  await extractFacts({ store: new Store(dataDir), claude, model: 'm' }, CAPTURE_ID);
  assert.match(claude.calls[0].content[0].text, /Transcript: none/);
  assert.ok(claude.calls[0].content.some((b) => b.type === 'text' && b.text === 'thumb.jpg (t = 2 s)'));
});

describe('facts through the API', () => {
  let base;
  let server;
  let claude;
  before(async () => {
    const dataDir = await tempDataDir();
    claude = stubClaude(goodReply);
    const silent = { log() {}, error() {} };
    server = createServer(createApp({ port: 0, dataDir, webDir: `${dataDir}/none`, key: '', mockClaude: false, anthropicKey: '', models: { offline: 'claude-opus-5-5', live: 'l' } }, { claude, log: silent }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    for (const [name, data] of Object.entries(captureWithEvidence())) {
      await fetch(`${base}/api/captures/${CAPTURE_ID}/files/${name}`, { method: 'PUT', body: data });
    }
  });
  after(() => server.close());

  async function waitForFacts() {
    for (let k = 0; k < 50; k++) {
      const { status } = await (await fetch(`${base}/api/captures/${CAPTURE_ID}`)).json();
      if (status.facts === 'done' || status.facts === 'failed') return status;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('facts never finished');
  }

  test('completing an upload extracts facts in the background', async () => {
    const before = await fetch(`${base}/api/moments/${CAPTURE_ID}`);
    assert.equal(before.status, 404);

    await fetch(`${base}/api/captures/${CAPTURE_ID}/complete`, { method: 'POST' });
    const status = await waitForFacts();
    assert.equal(status.facts, 'done', status.factsError);

    const moment = await (await fetch(`${base}/api/moments/${CAPTURE_ID}`)).json();
    assert.equal(moment.facts[0].text, 'Priya brought a mango cake.');
  });

  test('the family can approve, reword and mark a fact', async () => {
    const res = await fetch(`${base}/api/moments/${CAPTURE_ID}/facts/f1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved', editedText: 'Priya brought Mom a mango cake.', doNotRaise: false }),
    });
    assert.equal(res.status, 200);
    const fact = await res.json();
    assert.equal(fact.status, 'approved');
    assert.equal(fact.editedText, 'Priya brought Mom a mango cake.');

    const bad = await fetch(`${base}/api/moments/${CAPTURE_ID}/facts/f1`, { method: 'PATCH', body: JSON.stringify({ status: 'maybe' }) });
    assert.equal(bad.status, 400);
    assert.equal((await fetch(`${base}/api/moments/${CAPTURE_ID}/facts/f9`, { method: 'PATCH', body: '{}' })).status, 404);
  });

  test('re-extracting keeps the approved fact and adds fresh pending ones', async () => {
    const res = await fetch(`${base}/api/moments/${CAPTURE_ID}/extract`, { method: 'POST' });
    assert.equal(res.status, 200);
    await waitForFacts();
    const moment = await (await fetch(`${base}/api/moments/${CAPTURE_ID}`)).json();
    assert.deepEqual(moment.facts.map((f) => [f.id, f.status]), [['f1', 'approved'], ['f2', 'pending']]);
    assert.match(claude.calls.at(-1).content[0].text, /already reviewed these facts[\s\S]*- Priya brought Mom a mango cake\./, 'Claude is told what not to repeat');
    assert.equal(moment.facts[0].editedText, 'Priya brought Mom a mango cake.');
    assert.equal(claude.calls.length, 2);
  });

  test('a Claude failure shows up in the status, in words', async () => {
    claude.json = async () => {
      throw new Error('Claude is rate-limited right now. Try again in a minute.');
    };
    await fetch(`${base}/api/moments/${CAPTURE_ID}/extract`, { method: 'POST' });
    const status = await waitForFacts();
    assert.equal(status.facts, 'failed');
    assert.match(status.factsError, /rate-limited/);
  });
});
