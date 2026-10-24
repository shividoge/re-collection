# Guide server API

The guide server replaces the old Python pipeline on the GX10. It's a small Node service in `guide/`, owned by Shivin and modeled on the Déjà View guide server. It does five jobs:

1. **Stores captures** uploaded from the phone and serves their files, with range requests.
2. **Extracts facts** with Claude from the keyframes and transcript, each tied to evidence.
3. **Runs revisit sessions:** narration and conversation from family-approved facts only, enforced by the grounding check.
4. **Scores recall** with Claude after each session.
5. **Runs the editor [planned]:** objects, read text, events, enhanced audio and views, measurements, notes, search, saved views, sites and comparison, all with provenance. Data shapes are in `docs/scene-model.md`; routes are in "Editor routes" at the end of this file.

The web app (Firdavs) only talks to this API. The Claude API key lives only in `guide/.env` and never reaches the browser.

## Running it

```bash
cd guide
cp .env.example .env    # set ANTHROPIC_API_KEY; BRAINDANCE_KEY is optional
npm install             # Node 22.13+ (node:sqlite) [planned; Node 21.7+ today]
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
# [planned] editor
DB_PATH=./data/braindance.db      # SQLite (node:sqlite) for the editor's data
CLERK_SECRET_KEY=                 # verifies family members' sign-in tokens
CLERK_PUBLISHABLE_KEY=            # the web reads the same value as VITE_CLERK_PUBLISHABLE_KEY
WORKER_TOKEN=                     # the audio worker sends this as Authorization: Bearer
```

**Mock mode:** with `MOCK_CLAUDE=1`, every Claude-backed route returns canned output whose text starts with `[mock]`, and `/health` reports `"mock": true`. The web shows a red **MOCK MODE** banner whenever `/health` says so. Mock mode is for building UI only; never use it in the demo or show its output as real (CLAUDE.md ground rule 2).

## Storage

Captures, moments and sessions are plain files:

```
guide/data/
  captures/<captureId>/     the uploaded package, exactly as the phone wrote it
    moment.json             facts + review state (written by the guide)
    status.json             pipeline status (written by the guide)
  sessions/<sessionId>.json one revisit session: turns, dropped sentences, scores
  people.json               who the patient is, e.g. { "displayName": "Grandma", "preferredAddress": "Mom" }
```

The capture id is the manifest's `id`.

**[planned]** The editor adds:

```
guide/data/
  braindance.db                       SQLite (node:sqlite): sites, members, device tokens, entities, events,
                                      jobs, artifacts, measurements, notes, saved views, search index (FTS5)
  derived/<captureId>/<artifactId>/   files made from a capture (clean audio, stills, clips, rectified crops)
```

The files above stay where they are. The guide never changes a capture's files after `complete`.

## Conventions

- JSON in and out, `Content-Type: application/json`, except file uploads and downloads.
- Errors: HTTP 4xx/5xx with `{ "error": "plain-language message" }`. The web shows the message as is.
- Times are seconds of moment time (same clock as `frames.jsonl` `t`), or ISO 8601 strings for wall-clock times.
- CORS is open (`*`), so the web dev server and the tablet can call it.
- **Auth [planned]:** family members sign in with Clerk; the web sends the session token as `Authorization: Bearer <token>` and the guide verifies it with `@clerk/backend`. Each site gives a member a role: `owner` (everything, including members and deletes), `family` (review, edit, notes, sessions) or `viewer` (invited care staff: read and write notes). The phone and the patient tablet use **device tokens** an owner creates, also sent as `Authorization: Bearer`: a phone token can only upload, a tablet token can only run revisit sessions (the person with dementia never logs in). `BRAINDANCE_KEY` keeps working as an admin key (owner of everything) until Clerk is in. Public routes need nothing. 401 means not signed in; 403 means signed in without the role.

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
| POST | `/api/sessions/:sid/turn` | `{ text, focus? }`: what the patient said (browser speech-to-text, or typed by the caregiver). Optional `focus: { label, factIds }` says what they're pointing at in the 3D room: a plain size label and the approved facts that were on camera together with it | `{ reply: Reply, branch: string \| null, distress: boolean }` |
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
- **`focus`** (optional, from the web playground): the guide keeps only fact ids that are approved and allowed, tells Claude what the person is pointing at, and asks it to say it isn't sure when none of the facts fit. The turn is saved with its focus; scoring still reads only the person's words.
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

## Editor routes [planned]

Everything in this section is planned (plan v3). The types `Site`, `Alignment`, `Entity`, `Appearance`, `ReadText`, `SceneEvent`, `Artifact`, `Measurement`, `Note`, `Anchor`, `ViewState`, `Provenance`, `SourceRef` and `Source` are defined in `docs/scene-model.md`; this file only adds the API-level types. The editor's data lives in SQLite (`DB_PATH`); derived files live in `data/derived/<captureId>/<artifactId>/`.

**Roles** (see Conventions): `viewer` < `family` < `owner`. "viewer" in a table means any member of the capture's site. The admin key counts as owner everywhere. The patient tablet's device token can use none of these routes.

### Changes to existing routes

- `GET /api/captures` returns only captures in sites you're a member of, and each item gains `siteId` (or `null`). A capture with no site is visible only to the owner whose phone token uploaded it, until they add it to a site.
- `POST /api/captures/:id/complete` also checks `manifest.hashes` (`docs/capture-format.md`) when present. A mismatch makes the upload `invalid` with the file named in `uploadErrors`; `status.hashes` becomes `"verified" | "missing" | "mismatch"`.
- After `complete`, the guide queues `facts`, `objects`, `text`, `events_visual`, `appearances` and `best_views`, plus the four audio jobs (they wait for a worker).
- Facts gain `entityIds: string[]`, and `Evidence` gains the `region` and `audio` kinds of `SourceRef`. The guide keeps a region citation only if it's on a keyframe Claude was sent, and an audio citation only if it lies inside the moment's audio. Family approval and the patient-side grounding check are unchanged.
- With a tablet token, `GET /api/moments/:id` returns only facts that are approved and not "don't bring this up".
- `GET /health` adds `worker: { lastSeenAt } | null`, so the UI can say "no audio worker running" when audio jobs sit in the queue.

### Files for `<video>` and `<img>`

Media elements can't send `Authorization`. `GET /api/file-token?captureId=` (viewer) → `{ token, expiresAt }`, valid for one hour and one capture. Add `?ft=<token>` to `/files/...` and `/derived/...` URLs. `?key=` keeps working with the admin key.

### Who you are and access

| Method | Path | Role | Body | Returns |
|---|---|---|---|---|
| GET | `/api/me` | signed in | – | `{ userId, name, admin, sites: { siteId, name, role }[] }` |
| GET | `/api/sites/:siteId/members` | owner | – | `{ userId, name, email, role }[]` |
| POST | `/api/sites/:siteId/members` | owner | `{ email, role }` | the member; sends a Clerk invitation if they have no account |
| PATCH | `/api/sites/:siteId/members/:userId` | owner | `{ role }` | the member. A site always keeps at least one owner (409 otherwise) |
| DELETE | `/api/sites/:siteId/members/:userId` | owner | – | `{ ok: true }` |
| POST | `/api/devices` | owner | `{ kind: "phone" \| "tablet", name, siteId? }` | `{ deviceId, token }`. The token is shown once. A tablet token needs `siteId` |
| GET | `/api/devices` | owner | – | your devices, without tokens |
| DELETE | `/api/devices/:deviceId` | owner | – | `{ ok: true }`; the token stops working at once |

A phone token can call only the capture upload routes. A tablet token can call only the revisit session routes, `GET /api/person`, and read-only capture, moment and file routes for its site.

### Sites, alignment and changes

| Method | Path | Role | Body | Returns |
|---|---|---|---|---|
| GET | `/api/sites` | signed in | – | `Site[]` you're a member of |
| POST | `/api/sites` | signed in | `{ name }` | `Site`; you become its owner |
| GET | `/api/sites/:siteId` | viewer | – | `Site` |
| PATCH | `/api/sites/:siteId` | owner | `{ name }` | `Site` |
| PUT | `/api/sites/:siteId/captures/:captureId` | family | – | `Site`. Queues an `align` job unless it's the site's first capture |
| DELETE | `/api/sites/:siteId/captures/:captureId` | owner | – | `Site`. The capture and its data stay; only the link and its alignment go |
| PUT | `/api/sites/:siteId/captures/:captureId/alignment` | family | `{ captureToSite }` (placed by hand) or `{ confirm: true }` | `Alignment`. Hand placement is `human`; confirming keeps the computed transform and lets a rough alignment drive `changes` |
| GET | `/api/sites/:siteId/changes?from=:captureId&to=:captureId` | viewer | – | `{ events: SceneEvent[], comparedShare: number }`: `change` events between two aligned captures, and the share of the room both saw. 409 if either alignment is rough and unconfirmed, or the `changes` job hasn't run |
| GET | `/api/sites/:siteId/entity-matches` | viewer | – | `{ a: string, b: string, overlap: number }[]`: entities in different captures proposed as the same thing |
| POST | `/api/entities/:entityId/merge` | family | `{ into: entityId }` | the merged `Entity`. Merging is how a person confirms a match |

### Entities

| Method | Path | Role | Body | Returns |
|---|---|---|---|---|
| GET | `/api/captures/:id/entities` | viewer | `?kind=&hidden=1` | `Entity[]`. Hidden ones only with `hidden=1` |
| GET | `/api/sites/:siteId/entities` | viewer | – | site-level `Entity[]` |
| POST | `/api/captures/:id/entities` | family | `{ kind, label?, voxels, voxelMeters, bounds }` from the web's selection | `Entity` (`computed`); queues `appearances` and `best_views` for it |
| GET | `/api/entities/:entityId` | viewer | – | `{ entity, events: SceneEvent[], notes: Note[], facts: Fact[] }`. Viewers get approved facts only, never "don't bring this up" ones |
| PATCH | `/api/entities/:entityId` | family | any of `{ label, kind, personName, hidden }` | `Entity`. A new label makes `labelProvenance` `human`. `personName` is only ever typed by the family |
| PUT | `/api/captures/:id/speakers` | family | `{ "S1": "Priya", ... }` | `{ ok: true }`. Puts family-typed names on diarization labels. Voices are never matched to names automatically |

### Events

| Method | Path | Role | Body | Returns |
|---|---|---|---|---|
| GET | `/api/captures/:id/events` | viewer | `?kind=&tStart=&tEnd=` | `SceneEvent[]` in time order |
| PATCH | `/api/events/:eventId` | family | any of `{ label, speaker, entityIds, hidden }` | `SceneEvent`; edits make it `human` |

### Jobs

```ts
type JobKind =
  | "facts" | "objects" | "text" | "events_visual"                      // guide, Claude (MODEL_OFFLINE)
  | "appearances" | "best_views" | "rectify" | "stabilize" | "align" | "changes"   // guide, computed
  | "audio_clean" | "diarize" | "speaker_isolate" | "sound_events";    // audio worker

type Job = {
  id: string;
  kind: JobKind;
  captureId: string | null;        // null for site-level jobs (align, changes use siteId)
  siteId: string | null;
  params: Record<string, unknown>;
  status: "queued" | "running" | "done" | "failed" | "canceled";
  runner: "guide" | "worker";
  progress: number | null;         // 0..1
  error: string | null;            // plain language; the UI shows it as is
  attempts: number;
  outputs: { artifacts: string[]; entities: string[]; events: string[] };
  dropped: { text: string; reason: string }[];   // claims the grounding check threw out
  createdAt: string; startedAt: string | null; endedAt: string | null;
};
```

| Kind | Runs in | Does | Output `source` |
|---|---|---|---|
| `facts` | guide | Existing fact extraction, now with entity links and region/audio evidence | estimated |
| `objects` | guide | Claude names objects in keyframes with 2D boxes; the guide lifts each box into 3D with that frame's depth and pose and merges it into entities | estimated |
| `text` | guide | Claude reads labels, cards and captions from best-view crops into `ReadText` | estimated |
| `events_visual` | guide | Claude proposes `action` events from the keyframe sequence, transcript and sound events | estimated |
| `appearances` | guide | Projects entity bounds into every moment frame | computed |
| `best_views` | guide | Ranks frames per appearance and writes `still` artifacts | computed |
| `rectify` | guide | `params: { t, box }`. Fits a plane to the depth in the box and writes a perspective-corrected `rectified` crop | computed |
| `stabilize` | guide | `params: { tStart, tEnd }`. Removes camera shake using the recorded poses and writes a `clip` (uses `ffmpeg` on PATH) | computed |
| `align` | guide | `params: { captureId }`. ICP on room points, turn around y plus shift (4 DoF), into site space | computed |
| `changes` | guide | `params: { from, to }`. Voxel difference between two aligned captures, only where both saw the room | computed |
| `audio_clean` | worker | Noise reduction (DeepFilterNet3) into `audio_clean` | estimated |
| `diarize` | worker | Who spoke when (pyannote speaker-diarization-3.1): `speech` events with `S1`, `S2`… | estimated |
| `speaker_isolate` | worker | `params: { speaker }`. One speaker's voice (SepFormer guided by diarization) into `audio_speaker` | estimated |
| `sound_events` | worker | Sound events with AudioSet labels (PANNs CNN14): laughter, door, applause… | estimated |

| Method | Path | Role | Body | Returns |
|---|---|---|---|---|
| POST | `/api/captures/:id/jobs` | family | `{ kind, params? }` | `Job`. 409 if the same kind with the same params is already queued or running |
| POST | `/api/sites/:siteId/jobs` | family | `{ kind: "align" \| "changes", params }` | `Job` |
| GET | `/api/captures/:id/jobs` | viewer | – | `Job[]`, newest first |
| GET | `/api/jobs/:jobId` | viewer | – | `Job` |
| DELETE | `/api/jobs/:jobId` | family | – | `Job` with `status: "canceled"`. Only queued or running jobs |

Guide jobs run one at a time, like fact extraction today. Rerunning a job makes new outputs; it never overwrites anything a person edited.

### Artifacts

| Method | Path | Role | Returns |
|---|---|---|---|
| GET | `/api/captures/:id/artifacts?kind=` | viewer | `Artifact[]` |
| GET | `/api/artifacts/:artifactId` | viewer | `Artifact` |
| GET, HEAD | `/derived/:captureId/:artifactId/:file` | viewer | the file, with `Range` support (same rules as `/files`) |

The original audio and video stay at `/files/...`. The web offers "original / enhanced" and plays the original by default.

### Measurements

| Method | Path | Role | Body | Returns |
|---|---|---|---|---|
| GET | `/api/captures/:id/measurements` | viewer | – | `Measurement[]` |
| POST | `/api/captures/:id/measurements` | family | `{ kind, points }` (capture space, picked on room points) | `Measurement`. The guide works out `meters`, `uncertaintyMeters` (from how far the scan camera was from each point, and the voxel size) and `needsCheck` |
| DELETE | `/api/measurements/:measurementId` | family | – | `{ ok: true }` |

### Notes

| Method | Path | Role | Body | Returns |
|---|---|---|---|---|
| GET | `/api/captures/:id/notes` | viewer | `?entityId=&resolved=` | `Note[]` |
| POST | `/api/captures/:id/notes` | viewer | `{ kind, body, anchor }` | `Note`. 400 if the anchor has none of `entityId`, `point`, `time` |
| POST | `/api/notes/:noteId/replies` | viewer | `{ body }` | `Note` |
| PATCH | `/api/notes/:noteId` | viewer | `{ body }` (author only) or `{ resolved }` (author or family) | `Note` |
| DELETE | `/api/notes/:noteId` | author or owner | – | `{ ok: true }` |

Notes never appear in revisit sessions, public routes, or anything sent to the narrator or companion.

### Search

`GET /api/search?q=&siteId=&captureId=&kinds=` (viewer), one of `siteId` or `captureId` required, SQLite FTS5:

```ts
type SearchHit = {
  kind: "transcript" | "entity" | "text" | "fact" | "note" | "event";
  snippet: string;                 // the matching words, with the match marked by « »
  anchor: Anchor;                  // what the web opens when the hit is clicked
  source: Source;                  // so estimated hits show as estimated
  id: string | null;               // the entity, fact, note or event id; null for transcript hits
};
// → { hits: SearchHit[] }, best first, at most 50
```

Facts are searched in the family's wording. Family members and owners also see pending facts; viewers see approved ones only, never "don't bring this up" ones.

### Saved views (share links)

| Method | Path | Role | Body | Returns |
|---|---|---|---|---|
| POST | `/api/views` | viewer | `{ view: ViewState, title? }` | `{ id, url: "#/v/<id>" }` |
| GET | `/api/views/:viewId` | viewer of that capture | – | `{ id, title, view: ViewState, author, createdAt }`. 404 for anyone without access, the same as a view that doesn't exist |

### Trace to source

`GET /api/trace` (viewer) with one of:
- `?ref=<URL-encoded JSON SourceRef>`
- `?fact=<momentId>/<factId>`
- `?sentence=<sessionId>/<turnIndex>/<sentenceIndex>`: a line the narrator or companion said, through its facts to their evidence

```ts
type TraceNode = {
  ref: SourceRef | { type: "fact"; momentId: string; factId: string } | { type: "sentence"; sessionId: string; turn: number; index: number };
  label: string;                   // "Read text: 'Happy 80th'", "Keyframe at 0:12", "Original audio 0:12–0:15"
  provenance: Provenance | null;   // null for original material
  url: string | null;              // a /files or /derived URL for frames, stills and audio
  missing: boolean;                // the input no longer exists; shown, never hidden
  children: TraceNode[];
};
// → TraceNode
```

The tree always ends at original material: frames, audio, transcript and room points.

### Audio worker protocol

The worker (`worker/`, Python with uv) is optional and runs next to the guide. It sends `Authorization: Bearer <WORKER_TOKEN>`, may call only these routes, and never sets provenance itself: the guide writes `Provenance` (`estimated`, inputs pointing at the original audio) from what it reports.

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/worker/claim` | `{ workerId, kinds: JobKind[] }` | 204 when nothing is queued, or `{ job: Job, inputs: { audio: url, transcript: url \| null, diarization: url \| null } }`. The claim is a 10-minute lease |
| POST | `/api/worker/jobs/:jobId/heartbeat` | `{ progress }` | `{ ok: true, canceled: boolean }`. Each heartbeat renews the lease; stop work when `canceled` |
| PUT | `/api/worker/jobs/:jobId/files/:name` | raw bytes | `{ ok: true, bytes }` |
| POST | `/api/worker/jobs/:jobId/complete` | `{ method, model, artifacts: { file, kind, mime, tStart?, tEnd? }[], events: { kind, label, tStart, tEnd, speaker?, confidence }[] }` | `{ ok: true }` |
| POST | `/api/worker/jobs/:jobId/fail` | `{ error }` | `{ ok: true }` |

A lease that runs out puts the job back in the queue; after three attempts it fails with the last error.

### Grounding in the editor

The grounding idea from revisit sessions covers every Claude claim the editor shows. Labels, read text, event labels and facts all come back from Claude with `SourceRef`s, and code checks each one before saving it:
- frame and region refs must name a keyframe or crop Claude was actually sent;
- transcript quotes must match the transcript (ignoring case and punctuation);
- audio refs must lie inside the capture's audio;
- entity refs must exist.

A claim with no surviving refs is dropped and logged in its job's `dropped`. Whatever survives is saved as `estimated` and shown that way. The family's approval is still the only route from the editor to the person with dementia.
