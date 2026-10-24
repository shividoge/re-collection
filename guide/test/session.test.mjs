import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, test } from 'node:test';

import { allowedFacts, freeSentenceProblem, groundReply, namesToGuard, soundsDistressed } from '../src/grounding.mjs';
import { createApp } from '../src/server.mjs';
import { CAPTURE_ID, tempDataDir, tinyCapture, writeCapture } from './helpers.mjs';

const moment = {
  captureId: CAPTURE_ID,
  moment: { title: 'Cake visit', place: '', occasion: '', summary: '' },
  facts: [
    { id: 'f1', text: 'Priya brought a mango cake.', kind: 'object', salience: 3, cue: 'Something sweet', status: 'approved', editedText: null, doNotRaise: false, evidence: [{ type: 'frame', t: 1, keyframe: 'keyframes/k0001.jpg' }] },
    { id: 'f2', text: 'Uncle Raj told a story about the war.', kind: 'speech', salience: 2, cue: '', status: 'approved', editedText: null, doNotRaise: true, evidence: [{ type: 'frame', t: 0, keyframe: 'keyframes/k0000.jpg' }] },
    { id: 'f3', text: 'There were yellow flowers on the table.', kind: 'object', salience: 1, cue: '', status: 'pending', editedText: null, doNotRaise: false, evidence: [{ type: 'frame', t: 0, keyframe: 'keyframes/k0000.jpg' }] },
    { id: 'f4', text: 'Dev wore a red sweater.', kind: 'person', salience: 2, cue: '', status: 'approved', editedText: 'Dev wore his red sweater.', doNotRaise: false, evidence: [{ type: 'frame', t: 1, keyframe: 'keyframes/k0001.jpg' }] },
  ],
  chapters: [{ tStart: 0, tEnd: 2, label: 'Arriving' }],
  dropped: [],
};
const manifest = { attendees: ['Priya Shah', 'Dev'] };

describe('grounding check', () => {
  const allowed = allowedFacts(moment);
  const names = namesToGuard(moment, manifest, 'Mom');
  const allow = new Set(['mom']);   // how she likes to be addressed
  const ground = (sentences, extended = false) => groundReply(sentences, { allowed, moment, names, extended, allow });

  test('only approved facts the family allows are usable, in the family\'s wording', () => {
    assert.deepEqual([...allowed.keys()], ['f1', 'f4']);
    assert.equal(allowed.get('f4').text, 'Dev wore his red sweater.');
  });

  test('a sentence citing an approved fact is kept', () => {
    const { sentences, dropped } = ground([{ sentence: 'Priya brought the mango cake you love.', factIds: ['f1'], free: false }]);
    assert.equal(sentences.length, 1);
    assert.deepEqual(dropped, []);
  });

  test('an invented sentence with no fact behind it is dropped and logged', () => {
    const { sentences, dropped } = ground([
      { sentence: 'Your grandson played the piano for you.', factIds: [], free: false },
      { sentence: 'Everyone sang happy birthday.', factIds: ['f99'], free: false },
    ]);
    assert.equal(sentences.length, 0);
    assert.deepEqual(dropped.map((d) => d.reason), ['free sentence mentions a person ("grandson")', 'cites unknown fact f99']);
  });

  test('a "don\'t bring this up" fact never gets through, even when cited', () => {
    const { sentences, dropped } = ground([{ sentence: 'Raj told you about the war.', factIds: ['f2'], free: false }]);
    assert.equal(sentences.length, 0);
    assert.match(dropped[0].reason, /don't bring this up/);
  });

  test('unapproved facts are dropped', () => {
    const { dropped } = ground([{ sentence: 'There were yellow flowers.', factIds: ['f3'], free: false }]);
    assert.match(dropped[0].reason, /hasn't approved/);
  });

  test('one free sentence per reply, and never with a name, number, date or place', () => {
    const { sentences, dropped } = ground([
      { sentence: "It's lovely to see you, Mom.", factIds: [], free: true },
      { sentence: 'Take your time.', factIds: [], free: true },
    ]);
    assert.deepEqual(sentences.map((s) => s.sentence), ["It's lovely to see you, Mom."]);
    assert.match(dropped[0].reason, /more than 1 free sentence/);

    assert.match(freeSentenceProblem('Your grandson played the piano.', names), /person \("grandson"\)/);
    assert.match(freeSentenceProblem('Priya says hello.', names), /name "priya"/);
    assert.match(freeSentenceProblem('Dev is here.', names), /name "dev"/);
    assert.match(freeSentenceProblem('That was 3 weeks ago.', names), /number/);
    assert.match(freeSentenceProblem('It was a lovely Sunday.', names), /date/);
    assert.match(freeSentenceProblem('Your kitchen is so bright.', names), /place/);
    // Following their lead: words they just said may be echoed back.
    const echo = new Set(['my', 'father', 'had', 'a', 'workshop']);
    assert.equal(freeSentenceProblem("What was your father's workshop like?", names, echo), null);
    assert.match(freeSentenceProblem("What was your father's workshop like?", names), /person|place/);
    assert.equal(freeSentenceProblem("It's nice to see you, Mom.", names, allow), null);
  });

  test('a reassurance Claude forgot to mark free is still allowed', () => {
    const { sentences } = ground([{ sentence: "You're safe, Mom, and I'm right here with you.", factIds: [], free: false }], true);
    assert.equal(sentences.length, 1);
  });

  test('reassurance after distress, or a question about a shared memory, may use two free sentences', () => {
    const { sentences } = ground([
      { sentence: "You're safe.", factIds: [], free: true },
      { sentence: "I'm right here with you.", factIds: [], free: true },
    ], true);
    assert.equal(sentences.length, 2);
  });

  test('distress phrases are caught in code', () => {
    assert.equal(soundsDistressed('I want to go home, where is everyone'), true);
    assert.equal(soundsDistressed("I'm scared"), true);
    assert.equal(soundsDistressed('Oh, I love mango cake'), false);
  });
});

describe('sessions through the API', () => {
  let base;
  let server;
  const calls = [];
  let nextReply;

  before(async () => {
    const dataDir = await tempDataDir();
    const { files } = tinyCapture();
    await writeCapture(dataDir, { ...files, 'moment.json': Buffer.from(JSON.stringify(moment)) });
    const claude = {
      mock: false,
      async json(request) {
        calls.push(request);
        return { data: nextReply(request), model: request.model, usage: null };
      },
    };
    const silent = { log() {}, error() {} };
    server = createServer(createApp({ port: 0, dataDir, webDir: `${dataDir}/none`, key: '', mockClaude: false, anthropicKey: '', models: { offline: 'opus', live: 'sonnet' } }, { claude, log: silent }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    await fetch(`${base}/api/person`, { method: 'PUT', body: JSON.stringify({ displayName: 'Grandma', preferredAddress: 'Mom' }) });
  });
  after(() => server.close());

  const post = async (path, body) => {
    const res = await fetch(base + path, { method: 'POST', body: JSON.stringify(body ?? {}) });
    return { status: res.status, body: await res.json() };
  };

  test('a full session: welcome, narration, a recalled detail, a branch, scoring', async () => {
    const started = await post('/api/sessions', { momentId: CAPTURE_ID });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.welcome.sentences[0].sentence, "Hello, Mom. Let's look back at a visit together.");
    const sid = started.body.sessionId;

    // Narration: Claude tries to sneak in the do-not-raise fact; only the grounded line survives.
    nextReply = () => ({
      sentences: [
        { sentence: 'Dev wore his red sweater.', factIds: ['f4'], free: false },
        { sentence: 'Raj told a story.', factIds: ['f2'], free: false },
      ],
    });
    const narration = await post(`/api/sessions/${sid}/narrate`, { chapterIndex: 0 });
    assert.equal(narration.status, 200);
    assert.deepEqual(narration.body.reply.sentences.map((s) => s.sentence), ['Dev wore his red sweater.']);
    assert.equal(narration.body.reply.dropped.length, 1);
    assert.equal(calls.at(-1).model, 'sonnet');
    assert.match(calls.at(-1).content[0].text, /f1: Priya brought a mango cake\./);
    assert.doesNotMatch(calls.at(-1).content[0].text, /war|yellow flowers/, 'unapproved and do-not-raise facts never reach Claude');

    // The person brings up the cake on their own, and an older memory.
    nextReply = () => ({
      sentences: [
        { sentence: 'Yes, Priya brought the mango cake.', factIds: ['f1'], free: false },
        { sentence: 'That sounds wonderful.', factIds: [], free: true },
        { sentence: "What was your mother's cake like?", factIds: [], free: true },
      ],
      branch: 'My mother made mango cake every summer',
      distress: false,
    });
    const turn = await post(`/api/sessions/${sid}/turn`, { text: 'Was there mango cake? My mother made mango cake every summer.' });
    assert.equal(turn.body.distress, false);
    assert.equal(turn.body.reply.sentences.length, 3, 'a shared memory allows a warm reply plus one question');
    assert.equal(turn.body.branch, 'My mother made mango cake every summer');

    // Then mentions the sweater after Claude had said it.
    nextReply = () => ({ sentences: [{ sentence: "It's lovely to talk with you.", factIds: [], free: true }], branch: null, distress: false });
    await post(`/api/sessions/${sid}/turn`, { text: 'Dev and that red sweater of his.' });

    // Scoring: Claude says both were recalled unprompted; code corrects the sweater to after_cue.
    nextReply = (request) => {
      assert.equal(request.model, 'opus');
      return {
        scores: [
          { factId: 'f1', result: 'unprompted', line: 3 },
          { factId: 'f4', result: 'unprompted', line: 5 },
        ],
        branches: [{ quote: 'My mother made mango cake every summer', note: 'Her mother baked.' }],
        note: 'She talked about the cake and her mother.',
      };
    };
    const ended = await post(`/api/sessions/${sid}/end`, { reason: 'complete' });
    assert.equal(ended.status, 200, JSON.stringify(ended.body));
    assert.deepEqual(ended.body.scores.map((s) => [s.factId, s.result]), [['f1', 'unprompted'], ['f4', 'after_cue']]);
    assert.equal(ended.body.branches.length, 1, 'the live branch and the scored one are the same quote');

    const progress = await (await fetch(`${base}/api/progress?momentId=${CAPTURE_ID}`)).json();
    assert.equal(progress.sessions.length, 1);
    assert.equal(progress.sessions[0].unprompted, 1);
    assert.equal(progress.sessions[0].afterCue, 1);
    assert.equal(progress.nextRevisit.length, 4);
    assert.deepEqual(progress.facts.map((f) => f.id), ['f1', 'f4']);

    const again = await post(`/api/sessions/${sid}/turn`, { text: 'hello?' });
    assert.equal(again.status, 409, 'an ended session takes no more turns');
  });

  test('the distress phrase is caught even if Claude misses it, and logged as an alert', async () => {
    const { body } = await post('/api/sessions', { momentId: CAPTURE_ID });
    nextReply = () => ({ sentences: [{ sentence: 'Priya brought cake.', factIds: ['f1'], free: false }], branch: null, distress: false });
    const turn = await post(`/api/sessions/${body.sessionId}/turn`, { text: 'I want to go home, where is everyone' });
    assert.equal(turn.body.distress, true);

    const ended = await post(`/api/sessions/${body.sessionId}/end`, { reason: 'distress' });
    assert.equal(ended.body.alerts.length, 1);
    assert.match(ended.body.alerts[0].note, /want to go home/);
  });

  test('if every sentence is dropped, the person still hears something safe', async () => {
    const { body } = await post('/api/sessions', { momentId: CAPTURE_ID });
    nextReply = () => ({ sentences: [{ sentence: 'Your brother flew in on Tuesday.', factIds: [], free: false }], branch: null, distress: false });
    const turn = await post(`/api/sessions/${body.sessionId}/turn`, { text: 'Who came?' });
    assert.deepEqual(turn.body.reply.sentences.map((s) => s.sentence), ["I'm right here with you."]);
    assert.equal(turn.body.reply.dropped.length, 1);
  });

  test('a session needs approved facts, and bad requests say why', async () => {
    assert.equal((await post('/api/sessions', {})).status, 400);
    assert.equal((await post('/api/sessions/not-an-id/turn', { text: 'hi' })).status, 400);
    const { body } = await post('/api/sessions', { momentId: CAPTURE_ID });
    assert.equal((await post(`/api/sessions/${body.sessionId}/turn`, { text: '  ' })).status, 400);
    assert.equal((await post(`/api/sessions/${body.sessionId}/end`, { reason: 'bored' })).status, 400);
  });
});
