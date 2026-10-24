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
export function factsContent(info, segments, frames) {
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
  lines.push('', `Keyframes follow (${frames.length}), each after its label.`);

  const content = [{ type: 'text', text: lines.join('\n') }];
  for (const frame of frames) {
    content.push({ type: 'text', text: `${frame.name} (t = ${frame.t} s)` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: frame.base64 } });
  }
  content.push({ type: 'text', text: 'Write the facts, chapters and summary for this moment.' });
  return content;
}
