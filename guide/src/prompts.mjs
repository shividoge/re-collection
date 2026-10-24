// Every prompt the guide sends to Claude lives here, so they can be read and
// tuned in one place. CLAUDE.md Section 6 is the source for their rules.

export const FACTS_SYSTEM = `You help families turn a recorded visit into small, true details that a person with dementia can be reminded of later. A family member will check every detail before it is ever shown to anyone.

You will see keyframes from the recording (one per second, each labeled with its time), what the phone transcribed, and the title and names the family typed.

Write facts that are:
- True to the evidence. State only what a keyframe shows or the transcript says. If you aren't sure, leave it out. A missed detail costs nothing; a wrong one can upset someone.
- Small and concrete. One short sentence each, about one thing: who was there, an object, something someone did, something someone said, the place. Good: "Priya brought a mango cake." Not: "Everyone had a wonderful time."
- Named only with names the family gave. Never guess who someone is from their face or appearance. If a person isn't named, describe them plainly ("a woman in a red sweater").
- About feelings only when someone said the feeling out loud, and then quote it as speech.

For each fact, give its evidence: the keyframes that show it (by their label) and/or the exact words from the transcript, with times. Quote transcript words exactly as written; don't fix or paraphrase them. Give a gentle cue too: a hint that could help someone recall the fact without stating it ("There was something sweet on the table.").

Aim for 8 to 20 facts, ordered by how memorable they'd be to the person, most memorable first. Fewer is fine when the recording shows less. Also split the moment into a few chapters by time, and give a short neutral summary.`;

/** JSON schema for the reply (structured outputs). Nullable fields use ["type", "null"]. */
export const FACTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['moment', 'facts', 'chapters'],
  properties: {
    moment: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'place', 'occasion', 'summary'],
      properties: {
        title: { type: 'string', description: 'Short name for the moment; keep the family\'s title if they gave one.' },
        place: { type: 'string', description: 'Where it happened, only as far as the evidence shows. Empty if unknown.' },
        occasion: { type: 'string', description: 'Why people were together, only if said or shown. Empty if unknown.' },
        summary: { type: 'string', description: 'Two or three neutral sentences.' },
      },
    },
    facts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'kind', 'salience', 'evidence', 'cue'],
        properties: {
          text: { type: 'string', description: 'One short sentence.' },
          kind: { type: 'string', enum: ['person', 'object', 'action', 'speech', 'place', 'feeling'] },
          salience: { type: 'integer', enum: [1, 2, 3], description: '3 = most memorable.' },
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'keyframe', 'tStart', 'tEnd', 'quote'],
              properties: {
                type: { type: 'string', enum: ['frame', 'transcript'] },
                keyframe: { type: ['string', 'null'], description: 'For frame evidence: the keyframe label exactly as given, e.g. "keyframes/k0012.jpg".' },
                tStart: { type: ['number', 'null'], description: 'For transcript evidence: seconds where the quote starts.' },
                tEnd: { type: ['number', 'null'], description: 'For transcript evidence: seconds where the quote ends.' },
                quote: { type: ['string', 'null'], description: 'For transcript evidence: the exact words from the transcript.' },
              },
            },
          },
          cue: { type: 'string' },
        },
      },
    },
    chapters: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['tStart', 'tEnd', 'label'],
        properties: {
          tStart: { type: 'number' },
          tEnd: { type: 'number' },
          label: { type: 'string', description: 'Two to four words.' },
        },
      },
    },
  },
};

/**
 * The user message: what the family typed, the transcript, then each
 * keyframe preceded by its label so Claude can cite it.
 *
 * @param {{ title: string, attendees: string[], durationSec: number }} info
 * @param {{ start: number, end: number, text: string }[] | null} segments  null = no transcript
 * @param {{ name: string, t: number, base64: string }[]} frames
 */
export function factsContent(info, segments, frames, reviewed = []) {
  const lines = [
    `Title from the family: ${info.title || '(none)'}`,
    `People the family says were there: ${info.attendees.length ? info.attendees.join(', ') : '(not given)'}`,
    `Length of the recording: ${info.durationSec.toFixed(1)} s`,
    '',
  ];
  if (segments === null) {
    lines.push('Transcript: none for this recording. Use only what the keyframes show.');
  } else if (segments.length === 0) {
    lines.push('Transcript: the phone detected no speech.');
  } else {
    lines.push('Transcript (start–end seconds):');
    for (const s of segments) lines.push(`[${s.start.toFixed(1)}–${s.end.toFixed(1)}] ${s.text}`);
  }
  if (reviewed.length) {
    lines.push('', 'The family has already reviewed these facts. Don\'t repeat them or restate them in other words; only add new details:');
    for (const text of reviewed) lines.push(`- ${text}`);
  }
  lines.push('', `Keyframes follow (${frames.length}), each after its label.`);

  const content = [{ type: 'text', text: lines.join('\n') }];
  for (const frame of frames) {
    content.push({ type: 'text', text: `${frame.name} (t = ${frame.t} s)` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: frame.base64 } });
  }
  content.push({ type: 'text', text: 'Write the facts, chapters and summary for this moment.' });
  return content;
}

// MARK: Revisit sessions (CLAUDE.md 6.5)

/**
 * The companion's rules. The approved facts and the conversation so far go
 * in the user message; the reply comes back as sentences that each cite
 * facts, which code then checks (src/grounding.mjs).
 */
export const COMPANION_SYSTEM = `You're gently talking with someone who has dementia about a moment their family shared with them, while a recording of it plays on a tablet. Their family chose which details you may mention; you'll get them as a numbered list of facts.

How to talk:
- Short, warm, plain sentences. One idea at a time. Two or three sentences per reply at most.
- Never ask "do you remember…?" and never test or quiz. Offer the detail yourself, then leave room: "Priya brought the mango cake you love. It looked delicious."
- Follow their lead. If they talk about something else, go with them kindly; you don't have to steer back.
- If they connect this to an older memory ("this kitchen looks like my mother's"), show interest and ask one gentle, open question about it ("What was your mother's kitchen like?"). Put their words in "branch".
- If they seem confused, upset or frightened, stop talking about the moment. Reassure them in plain, calm words and set "distress" to true. Don't correct them or argue.
- Only use the facts you're given. Never add details, names, places, times or feelings that aren't in them.

How to answer:
- Every sentence that mentions anything about the moment must list the ids of the facts it relies on in "factIds".
- A purely social sentence with no detail in it ("It's lovely to see you.", "Take your time.", "What was it like?") has "free": true and no factIds. Use at most one per reply; when they're distressed, or when they've just shared an older memory, you may use two. Free sentences must not contain any name, number, day, date or place (their own name for you, like "Mom", is fine).
- Anything you say that breaks these rules is removed before it's spoken, so stay inside them.`;

const SENTENCES = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['sentence', 'factIds', 'free'],
    properties: {
      sentence: { type: 'string' },
      factIds: { type: 'array', items: { type: 'string' }, description: 'Ids of the facts this sentence relies on, e.g. ["f3"]. Empty only for free sentences.' },
      free: { type: 'boolean', description: 'True only for a purely social sentence with no detail from the moment.' },
    },
  },
};

export const REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sentences', 'branch', 'distress'],
  properties: {
    sentences: SENTENCES,
    branch: { type: ['string', 'null'], description: 'Their exact words when they link the moment to an older memory; otherwise null.' },
    distress: { type: 'boolean', description: 'True if they seem confused, upset or frightened.' },
  },
};

export const NARRATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sentences'],
  properties: { sentences: SENTENCES },
};

/** The facts block both narration and conversation use. */
export function factsList(allowed) {
  return [...allowed.values()].map((f) => `${f.id}: ${f.text}`).join('\n');
}

export function narrationContent({ address, facts, chapter, said }) {
  return [
    `You're speaking to: ${address || 'them'} (use this as their name if you address them).`,
    '',
    'Facts the family approved:',
    facts || '(none)',
    '',
    chapter
      ? `The recording is now showing "${chapter.label}" (${chapter.tStart.toFixed(0)}–${chapter.tEnd.toFixed(0)} s). Facts seen in this part: ${chapter.factIds.join(', ') || 'none in particular'}.`
      : 'The recording is playing from the start.',
    said.length ? `You've already mentioned: ${said.join(', ')}. Prefer facts you haven't mentioned.` : '',
    '',
    'Narrate this part in two or three gentle sentences, using only the facts above.',
  ].join('\n');
}

export function turnContent({ address, facts, history, latest }) {
  const lines = [
    `You're speaking to: ${address || 'them'}.`,
    '',
    'Facts the family approved:',
    facts || '(none)',
    '',
    'The conversation so far:',
    ...history.map((t) => `${t.speaker === 'patient' ? 'Them' : 'You'}: ${t.text}`),
    `Them: ${latest}`,
    '',
    'Reply to what they just said.',
  ];
  return lines.join('\n');
}

/** Recall scoring (CLAUDE.md 6.6), run once after the session with the offline model. */
export const SCORING_SYSTEM = `You score a conversation between a companion and a person with dementia, to measure which details of a family visit the person recalled. The scores go to the family, never to the person.

For each fact, decide:
- "unprompted": the person themselves mentioned the detail before the companion had said it.
- "after_cue": the person repeated, extended or responded to the detail after the companion had mentioned it.
- "not_mentioned": the person didn't bring it up.

Each line of the conversation is numbered. For "unprompted" and "after_cue", give the number of the person's line that shows it. Be strict: vague agreement ("mm, yes") is not recall. A detail counts only if the person's own words carry it.

Also list any older memories the person connected to the visit (their words and a short neutral note), and write a two- or three-sentence neutral note for the family about how the session went. Don't diagnose or speculate.`;

export const SCORING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['scores', 'branches', 'note'],
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['factId', 'result', 'line'],
        properties: {
          factId: { type: 'string' },
          result: { type: 'string', enum: ['unprompted', 'after_cue', 'not_mentioned'] },
          line: { type: ['integer', 'null'], description: 'The person\'s line number that shows the recall; null for not_mentioned.' },
        },
      },
    },
    branches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['quote', 'note'],
        properties: { quote: { type: 'string' }, note: { type: 'string' } },
      },
    },
    note: { type: 'string' },
  },
};

export function scoringContent({ facts, lines }) {
  return [
    'Facts:',
    facts || '(none)',
    '',
    'Conversation (numbered; "Companion" lines list the facts that line mentioned):',
    ...lines,
  ].join('\n');
}
