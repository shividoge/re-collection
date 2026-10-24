# Guide server API

The guide server replaces the old Python pipeline on the GX10. It's a small Node service in `guide/`, owned by Shivin and modeled on the Déjà View guide server. It does four jobs:

1. **Stores captures** uploaded from the phone and serves their files, with range requests.
2. **Extracts facts** with Claude from the keyframes and transcript, each tied to evidence.
3. **Runs revisit sessions:** narration and conversation from family-approved facts only, enforced by the grounding check.
4. **Scores recall** with Claude after each session.

The web app (Firdavs) only talks to this API. The Claude API key lives only in `guide/.env` and never reaches the browser.

## Running it

```bash
cd guide
cp .env.example .env    # set ANTHROPIC_API_KEY; BRAINDANCE_KEY is optional
npm install
npm start               # http://127.0.0.1:8787
npm test                # node:test, no network or key needed
cloudflared tunnel --url http://127.0.0.1:8787   # public HTTPS URL for the phone and the tablet
```

`.env`:
```
PORT=8787
ANTHROPIC_API_KEY=
MODEL_OFFLINE=claude-opus-5-5     # fact extraction and scoring: accuracy matters
MODEL_LIVE=claude-sonnet-5-5      # narration and conversation: latency matters
BRAINDANCE_KEY=                   # if set, every route except /health needs header X-Braindance-Key
MOCK_CLAUDE=0                     # 1 = canned replies for UI work without a key (see below)
DATA_DIR=./data
```

**Mock mode:** with `MOCK_CLAUDE=1`, every Claude-backed route returns canned output whose text starts with `[mock]`, and `/health` reports `"mock": true`. The web shows a red **MOCK MODE** banner whenever `/health` says so. Mock mode is for building UI only; never use it in the demo or show its output as real (CLAUDE.md ground rule 2).

## Storage

Plain files, no database:

```
guide/data/
  captures/<captureId>/     the uploaded package, exactly as the phone wrote it
    moment.json             facts + review state (written by the guide)
    status.json             pipeline status (written by the guide)
  sessions/<sessionId>.json one revisit session: turns, dropped sentences, scores
  people.json               who the patient is, e.g. { "displayName": "Grandma", "preferredAddress": "Mom" }
```

The capture id is the manifest's `id`.

## Conventions

- JSON in and out, `Content-Type: application/json`, except file uploads and downloads.
- Errors: HTTP 4xx/5xx with `{ "error": "plain-language message" }`. The web shows the message as is.
- Times are seconds of moment time (same clock as `frames.jsonl` `t`), or ISO 8601 strings for wall-clock times.
- CORS is open (`*`), so the web dev server and the tablet can call it.

## Routes

### Health
`GET /health` → `{ ok: true, mock: boolean, models: { offline, live }, uptimeS }`

### Captures (phone → guide)

| Method | Path | Body | Returns |
|---|---|---|---|
| PUT | `/api/captures/:id/files/:name` | raw file bytes | `{ ok: true, bytes }`. `name` may include `keyframes/` |
| POST | `/api/captures/:id/complete` | – | `{ ok: true }` after validating; starts fact extraction in the background |
| GET | `/api/captures` | – | `[{ id, title, createdAt, durationSec, thumb, status }]`, newest first. `thumb` is a URL or `null` |
| GET | `/api/captures/:id` | – | `{ id, manifest, status, files: { [name]: url } }` |
| GET | `/files/:id/:name` | – | the file, with `Range` support (needed for video and depth.bin). `HEAD` works too |

URLs the guide returns (`thumb`, `files`) are paths like `/files/<id>/room.bin`, relative to the guide's base URL. If `BRAINDANCE_KEY` is set, `<video>` and `<img>` can't send the header, so add `?key=<key>` to `/files` URLs.

The phone uploads `manifest.json`, `room.bin` and `thumb.jpg` first, so the web can show the room within seconds, then everything else, then calls `complete`. Each file is retried up to three times. `complete` checks that every file the manifest names is present and the right size (for example, `depth.bin` must be exactly `count·256·192·2` bytes), and rejects with a specific message if not.

`status`:
```json
{
  "upload": "receiving | done | invalid",
  "uploadErrors": [],
  "warnings": ["No transcript: facts can only come from what the keyframes show."],
  "facts": "not_started | queued | running | done | failed",
  "factsError": null,
  "updatedAt": "2026-10-24T14:12:54Z"
}
```
`upload` is `invalid` when `complete` failed; `uploadErrors` says why. Re-uploading any file sets it back to `receiving`. `facts` stays `queued` until the extractor (TASKS.md Shivin step 3) runs. `warnings` are worth showing to the family.

### Moment and facts (family review)

`GET /api/moments/:id` → `moment.json`:

```ts
type Moment = {
  captureId: string;
  moment: { title: string; place: string; occasion: string; summary: string };
  facts: Fact[];
  chapters: { tStart: number; tEnd: number; label: string }[];
  /** Facts the grounding check threw out (evidence Claude wasn't shown, or words nobody said). */
  dropped: { text: string; reason: string }[];
  inputs: { keyframes: number; transcriptSegments: number | null };   // null = no transcript
  extractedAt: string;      // ISO time
  model: string;            // the model that actually answered (a fallback model if Opus declined)
};

type Fact = {
  id: string;               // "f1", "f2", ...
  text: string;             // one short sentence, e.g. "Priya brought a mango cake."
  kind: "person" | "object" | "action" | "speech" | "place" | "feeling";
  salience: 1 | 2 | 3;      // 3 = most memorable
  evidence: Evidence[];     // at least one item, always
  cue: string;              // a gentle hint, e.g. "There was cake on the table."
  status: "pending" | "approved" | "rejected";
  editedText: string | null;  // family's wording; use it instead of text when set
  doNotRaise: boolean;      // family said never bring this up
};

type Evidence =
  | { type: "frame"; t: number; keyframe: string }                     // keyframe = "keyframes/k0012.jpg"
  | { type: "transcript"; tStart: number; tEnd: number; quote: string };
```

| Method | Path | Body | Returns |
|---|---|---|---|
| PATCH | `/api/moments/:id/facts/:factId` | any of `{ status, editedText, doNotRaise }` | the updated `Fact` |
| POST | `/api/moments/:id/extract` | – | `{ ok: true }`, re-runs extraction (replaces pending facts, keeps reviewed ones) |

`GET /api/moments/:id` returns 404 with `{ error, status }` until facts exist; `error` says whether they're queued, running, or failed and why. Extraction starts by itself when an upload completes (or an import is picked up, within 15 s), runs one capture at a time, and costs an estimated $0.10–0.30 per capture with 30 keyframes (about 30k input tokens of images, plus thinking and output; not measured yet).

**How a fact stays grounded:** Claude must cite evidence for every fact. The guide keeps a frame citation only if it names a keyframe Claude was actually sent, and a quote only if those words appear in the transcript (ignoring case and punctuation). A fact with no surviving evidence is dropped and listed in `dropped`.

Nothing reaches the patient until a family member approves it. Only facts with `status: "approved"` and `doNotRaise: false` are ever given to Claude in a session.

### Revisit sessions (patient tablet)

`GET /api/person` / `PUT /api/person` with `{ displayName, preferredAddress }` sets who the sessions are for (e.g. `"Grandma"`, `"Mom"`). The welcome uses `preferredAddress`.

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/sessions` | `{ momentId }` | `{ sessionId, welcome: Reply }`. 409 if no facts are approved yet. The welcome is a fixed sentence, not Claude |
| POST | `/api/sessions/:sid/narrate` | `{ chapterIndex }` | `{ reply: Reply }`: 2 or 3 grounded sentences for that chapter |
| POST | `/api/sessions/:sid/turn` | `{ text }`: what the patient said (browser speech-to-text, or typed by the caregiver) | `{ reply: Reply, branch: string \| null, distress: boolean }` |
| POST | `/api/sessions/:sid/end` | `{ reason: "complete" \| "caregiver" \| "distress" \| "timeout" }` | `{ scores: Score[], branches: Branch[], note: string, alerts: Alert[] }` (runs Claude scoring; calling it again returns the same result) |
| GET | `/api/sessions/:sid` | – | the full session: turns, dropped sentences, scores |

```ts
type Sentence = { sentence: string; factIds: string[]; free?: boolean };
type Reply = { sentences: Sentence[]; dropped: { sentence: string; reason: string }[] };
type Score = { factId: string; result: "unprompted" | "after_cue" | "not_mentioned"; line?: number };
type Branch = { t: string; quote: string; note: string };   // t = ISO time
type Alert = { t: string; kind: "distress"; note: string };
```

- Narration and conversation use `MODEL_LIVE` (Sonnet 5.5) at low effort for speed; scoring uses `MODEL_OFFLINE` (Opus 5.5). Claude answers in structured JSON (`sentences`, `branch`, `distress`) rather than tool calls.
- **Scoring:** Claude says which of the person's lines carries each fact; code then decides `unprompted` vs `after_cue` from whether the companion had already said that fact before that line. Facts approved after the session started aren't scored.
- **`distress: true`** means Claude flagged confusion, fear or grief, or the person's words matched a distress phrase in code (e.g. "I want to go home", "where is everyone", "I'm scared"). The tablet stops the moment, shows the reply (which is reassurance), and ends the session with reason `distress`.
- **`branch`** is set when the patient linked the moment to an older memory ("this kitchen looks like my mother's"). The dashboard lists these.
- **`dropped`** lists sentences the grounding check removed and why. Don't show them to the patient. The caregiver debug panel and the demo can show them.
- Speak `sentences` in order with the browser's `speechSynthesis` (Cartesia is a stretch goal).

### Dashboard

`GET /api/progress?momentId=:id` →
```ts
type Progress = {
  momentId: string;
  facts: { id: string; text: string }[];        // approved facts only
  sessions: {
    sessionId: string;
    startedAt: string; endedAt: string;           // real times; never relabel a 2-hour gap as "day 3"
    endReason: string;
    unprompted: number; afterCue: number; notMentioned: number;
    scores: Score[];
    branches: Branch[];
    note: string;
  }[];
  nextRevisit: string[];                          // ISO dates: visit +1, +3, +7, +14 days
};
```

## The grounding check (code, not prompt)

`guide/src/grounding.mjs`. Every narration and conversation reply from Claude comes back as `Sentence[]` through tool use, and before anything reaches the tablet the check:

- drops any sentence whose `factIds` include a fact that is unknown, not approved, or marked `doNotRaise`;
- treats a sentence with no `factIds` as a free (social) sentence, whether or not Claude marked it so, and drops it if it contains a number, a day or date, a place, a relationship word (grandson, sister…) or a name (attendees and capitalized words in the facts). Words the person just said, and how they like to be addressed ("Mom"), are allowed, so Claude can follow their lead;
- allows **one** free sentence per reply, or **two** when they're distressed (reassurance) or just shared an older memory (a warm reply plus one question);
- if nothing survives, says a fixed safe sentence ("I'm right here with you." / "You're safe. I'm right here with you.") so the person never meets silence;
- puts every dropped sentence in `reply.dropped` with a reason and appends it to the session log.

Free sentences are checked with word lists, so they can't catch every invented detail; the prompt, the one-or-two cap and short replies are the rest of the defense.

Tests in `guide/test/grounding.test.mjs` include a deliberately ungrounded sentence that must be dropped. This check is the strongest "thoughtful use of Claude" point in the pitch.
