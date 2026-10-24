# Braindance: who builds what (plan v2, plus the plan v3 editor)

Read `CLAUDE.md` first. The contracts are `docs/capture-format.md` (the phone's files), `docs/guide-api.md` (the guide server's routes) and `docs/scene-model.md` (the editor's shared data). Build against them, and ask the owner before changing one.

**Update ~07:45 Sat:** the web viewer exists (`web/`, built by Shivin's Claude while the team slept): drop a capture zip on the page, see it in the gallery, orbit the 3D room, play the visit with people replayed in 3D from depth, and switch to the phone's view. The guide serves it at `/`. The main path for demo captures is **phone → AirDrop zip → drop on the website**; phone-to-guide upload also works but is optional.

**What changed at 07:00 Sat:** the Python pipeline on the ASUS GX10 is cut. Shivin now owns a small Node guide server that makes every Claude call, so the product is built by two people: Shivin (phone + guide) and Firdavs (web). IBS27's role is proposed below.

| Person | GitHub | Owns | Folders |
|---|---|---|---|
| Shivin | shividoge | iPhone capture app + guide server (all Claude calls) | `ios/`, `guide/` |
| Firdavs | boliyevfirdavs | Web app: viewer, family review, patient session, dashboard | `web/` |
| IBS27 | IBS27 | Proposed: story, demo, testing (see below; Shivin to confirm) | `docs/`, Devpost |

Work on a branch named for your area (`ios/...`, `guide/...`, `web/...`), push often, and open a PR into `main`. Don't push to `main` directly.

---

## Plan v3: the family's editor (proposal; Shivin to confirm)

The family's side becomes a spatial editor for the visit (`CLAUDE.md` Sections 1 and 7.6). The patient loop, the product and the audience don't change, and the patient loop still comes first (ground rule 4). Build order and priorities are in `CLAUDE.md` Section 10 (P0, then P1, then P2). Data shapes are in `docs/scene-model.md`; routes are in `docs/guide-api.md` under "Editor".

| Person | Builds | Folders |
|---|---|---|
| Shivin | Guide: SQLite store, editor routes, job queue, Claude `objects`/`text`/`events_visual`, lifting boxes to 3D, best views, rectify, stabilize, measurements, sites and alignment, search, auth. Phone: site picker and file hashes | `guide/`, `ios/` |
| Firdavs | Editor UI (`CLAUDE.md` 7.6): layered timeline, playback controls, inspection panel, transcript panel, search, notes, saved views, measure, compare, trace, provenance styling and Measured only | `web/` |
| IBS27 | Proposed: the audio worker (`worker/`), on top of story, demo and testing | `worker/`, `docs/` |

### Shivin (plan v3)
1. **Store and routes (P0).** `src/db.mjs` with `node:sqlite` and the `docs/scene-model.md` tables; entities (save from a selection, label, hide), appearances (computed from bounds and poses), notes, saved views, and FTS5 search over transcript, labels, read text, facts, events and notes. Admin-key auth for now. Every stored item gets `Provenance`. Tests: provenance can only weaken; a note never appears in any narrator, companion or scoring request.
2. **Best views and read text (P0).** `best_views` (size on screen × sharpness × facing the camera × depth confidence) and the Claude `text` job on crops of those views, with editor grounding (`CLAUDE.md` 6.7): a read that cites a crop Claude wasn't shown is dropped and logged.
3. **Claude objects (P1).** The `objects` job and `src/lift.mjs` (2D box → 3D bounds with depth and pose; pure math with tests), merging into existing entities.
4. **Measurements (P1).** `src/measure.mjs` with uncertainty and `needsCheck`.
5. **Worker routes (P1).** Claim, heartbeat, result, artifact upload, with `WORKER_TOKEN`.
6. **P2:** Clerk, site roles and device tokens; sites, `align` (yaw + shift ICP) and `changes`; `rectify` and `stabilize`; on the phone, a site picker on the review screen and SHA-256 hashes in the manifest, checked on `complete`.

### Firdavs (plan v3)
In P0 order: layered timeline (visual, audio, geometry, activity tracks) and playback controls; "Save" on the selection panel and an editable label; transcript panel; inspection panel with best views and read text; provenance tags, estimated styling and the Measured only toggle (hides hole fill from PR #16); notes and "Copy link" saved views (`#/v/<viewId>`); search. Then measure, compare visits and trace. Use the Relive palette (`docs/THEME.md`), one hue per layer. Leave the patient's Revisit view as it is.

### IBS27 (plan v3, proposed)
The audio worker, `CLAUDE.md` 6.8. Python with `uv` in `worker/`, runs on the laptop next to the guide, pulls jobs over HTTP with `WORKER_TOKEN`. P1: `audio_clean` (DeepFilterNet3) and `diarize` (pyannote 3.1; needs a Hugging Face token for the gated model, kept in `worker/.env`). P2: `isolate` (SepFormer, guided by the diarization) and `sound_events` (PANNs CNN14). Every result is an `Artifact` or `SceneEvent` with `Provenance` marked `estimated`, and the original audio is never overwritten. Tests run without network or models (stub the model calls). The story, demo and testing role below still applies.

### Starting prompts (plan v3)

Guide (Shivin):
```
Read CLAUDE.md, TASKS.md, docs/scene-model.md, docs/guide-api.md and
docs/capture-format.md. I'm Shivin. Build TASKS.md "Shivin (plan v3)" step 1: the
SQLite store with node:sqlite, the editor routes for entities, notes, saved views
and search, with Provenance on everything and node:test tests (including: no note
ever reaches a narrator, companion or scoring request). Then step 2. Work on branch
guide/editor and open a PR.
```

Web (Firdavs):
```
Read CLAUDE.md (Sections 7 and 7.6), TASKS.md, docs/scene-model.md, docs/guide-api.md
and docs/THEME.md. I'm Firdavs. Build the editor in web/ in TASKS.md "Firdavs
(plan v3)" order, starting with the layered timeline and playback controls on the
existing SceneViewer. Don't change the patient's Revisit view. Work on branch
web/editor, commit small, open PRs.
```

Audio worker (IBS27):
```
Read CLAUDE.md (Sections 2, 6.8 and 9), TASKS.md, docs/scene-model.md and the
worker routes in docs/guide-api.md. I'm IBS27. Build the audio worker in worker/
with uv: claim jobs from the guide with WORKER_TOKEN, run audio_clean
(DeepFilterNet3) and diarize (pyannote 3.1), post back Artifacts and SceneEvents
with estimated Provenance. Tests must run without network or models. Work on
branch worker/audio and open a PR.
```

---

> **Plan v2 slices below.** These built the patient loop (capture → facts → review → Revisit → dashboard). Most of it is done (see `CLAUDE.md` Status); the parts still open (filming, sessions, demo, Devpost) still apply.

## Shivin: iPhone app + guide server

### Where things stand
- iPhone checkpoints 1–5 are done and tested on the phone: live camera, GPU point cloud, `room.bin`/`room.ply` export, and visit recording in one ARKit session. Branch: `ios/checkpoint-5-moment-recording` (includes 1–5).
- Two real captures verified. The good one is on the release `sample-capture-1`.
- `room.bin` sent (or to send) to Firdavs.

### Right now (team resting, Shivin awake), in order

**0. Get an Anthropic API key** (console.anthropic.com, or credits from the Anthropic booth when it opens). Everything Claude-related needs it; until then, build with `MOCK_CLAUDE=1`.

**1. Guide server, part 1: storage and files** (no Claude yet). Branch `guide/server`.
- Scaffold `guide/` exactly as `CLAUDE.md` Section 5 lays out.
- Routes: `/health`, file upload `PUT /api/captures/:id/files/:name`, `POST .../complete` with validation, `GET /api/captures`, `GET /api/captures/:id`, `GET /files/:id/:name` with Range support, CORS, optional `X-Braindance-Key`.
- `npm run import -- <capture folder>` copies a capture folder in (for AirDropped captures and the sample).
- Tests: validation catches a wrong `depth.bin` size; Range returns 206 with the right bytes; path traversal (`../`) is rejected.
- Done when the sample capture is imported and `curl -r 0-3 http://127.0.0.1:8787/files/<id>/room.bin` returns 4 bytes. Then start the tunnel and post the URL for Firdavs.

**2. iPhone app: transcript, keyframes, review, upload.** Branch `ios/upload` (built, PR #4; on-device checks in `ios/VERIFY.md` checkpoint 6 still to do). Demo captures go phone → AirDrop zip → drop on the website.
- Video becomes `video.mp4` (H.264 + AAC) so Chrome plays it.
- After recording: `transcript.json` from `SFSpeechRecognizer` on the recorded audio (`requiresOnDeviceRecognition`, word timings; add `NSSpeechRecognitionUsageDescription`), and `keyframes/kNNNN.jpg` once per second, 1024 wide. Formats are in `docs/capture-format.md`. If on-device recognition isn't available, skip the file and add a manifest warning.
- Review screen: title, attendees (free text), play back the clip. These go in `manifest.json`.
- Settings: guide URL and optional key (typed; QR is cut). Upload per file with up to three retries, `manifest.json`, `room.bin` and `thumb.jpg` first, then `complete`. Show progress and real errors.
- Clap test: phone propped up, clap with both hands in the middle of the frame, check sync (Claude can check it from the files).
- Update `ios/VERIFY.md` and unit tests (manifest additions, keyframe naming, transcript encoding).

**3. Guide server, part 2: facts.** Branch `guide/facts` (built: worked on the real sample capture, 10 grounded facts from 29 keyframes).
- `src/claude.mjs` (one wrapper; mock switch), `src/prompts.mjs`, `src/facts.mjs` per `CLAUDE.md` 6.2: up to 30 keyframes + transcript + title/attendees go to Opus, with tool `record_facts`; drop facts without evidence; write `moment.json`; status queued → running → done/failed.
- Routes: `GET /api/moments/:id`, `PATCH /api/moments/:id/facts/:factId`, `POST /api/moments/:id/extract`.
- Done when the real capture has facts in `moment.json`, each linked to a keyframe or quote.

**4. Guide server, part 3: grounding, sessions, scoring.** Branch `guide/sessions` (built and run against real Claude).
- `src/grounding.mjs` per `CLAUDE.md` 6.4, with tests including a deliberately ungrounded sentence that must be dropped, and a do-not-raise fact that must never appear.
- `src/session.mjs`: `POST /api/sessions`, `/narrate`, `/turn` (Sonnet, tools `reply`, `log_branch`, `flag_distress`), `/end`. Sessions saved as JSON with every turn and every dropped sentence.
- `src/scoring.mjs` (Opus, 6.6) on `/end`; `GET /api/progress`.
- Test: the distress phrase "I want to go home, where is everyone" returns `distress: true`.

**5. Tonight at 20:00:** film the demo visit at your brother's house. Scan the room before people gather; hold the phone in landscape; get consent from everyone filmed.

### Starting prompts for Claude Code

Guide server:
```
Read CLAUDE.md, TASKS.md, docs/guide-api.md and docs/capture-format.md. I'm Shivin.
Build the guide server in guide/ following TASKS.md "Shivin" step 1 (storage and files,
no Claude yet), with node:test tests. Import the sample capture from the GitHub release
sample-capture-1 and show me curl output proving files and Range requests work. Work on
branch guide/server and open a PR when step 1 is done. Then continue with step 3.
```

iPhone app:
```
Read CLAUDE.md, TASKS.md, IOS_CAPTURE_PLAN.md and docs/capture-format.md. I'm Shivin.
Continue the iOS app from branch ios/checkpoint-5-moment-recording following TASKS.md
"Shivin" step 2: H.264 video.mp4, on-device transcript.json, keyframes, the review screen
and upload to the guide server. Build with xcodebuild, run the unit tests on a simulator,
and install on my phone (it's plugged in) after each piece so I can test it.
```

---

## Firdavs: web app

**Plan sections:** `CLAUDE.md` Section 7 (all of it) and 8. **Contracts:** `docs/capture-format.md`, `docs/guide-api.md`.

You build everything the family and the patient see. You don't write any Claude code or prompts: every Claude call goes through Shivin's guide server.

**Until the guide server is up**, work from the sample capture on disk: download it with `gh release download sample-capture-1 --repo shividoge/braindance`, unzip it into `web/public/sample/` (gitignored), and load files from there. When the guide is up, switch to `VITE_GUIDE_URL` and `/files/:id/:name`. For screens that need Claude (review, session, dashboard) before the real routes exist, run the guide with `MOCK_CLAUDE=1`; the UI must show the red MOCK MODE banner whenever `/health` says `mock: true`.

Already built in `web/` (read `web/README.md` first): gallery with zip drop upload, 3D room cloud, camera path, synced video panel, Orbit and Phone's view, and DepthReplay (people in 3D). Build on it; don't restart it.

| By | Deliverable |
|---|---|
| 12:00 | Run it (`web/README.md`), check the viewer on the sample capture and a fresh one; fix anything that looks wrong (point size, colors, framing) and make it demo-ready on a projector and an iPad |
| 14:00 | Captures list polish (7.1): status badges, warnings, delete/hide test captures; viewer polish: chapter markers on the scrubber once facts exist |
| 17:00 | Family fact review screen (7.3): **built by Shivin** (`web/src/views/FactsPanel.tsx`): facts with keyframe/quote evidence, click to seek, approve/edit/reject/don't bring up, chapters, grounding log, re-extract. Polish it (keyboard shortcuts, "approve all checked", nicer empty states) |
| 19:00 | Revisit screen (7.4): welcome, replay with chapter narration, push-to-talk, goodbye, caregiver end button; speech via `speechSynthesis` |
| 21:00 | Dashboard (7.5) from `/api/progress` with real session times, branches, distress alerts |
| 01:00–04:00 | Run 3+ real revisit sessions with the demo moment, spaced a few hours apart |

Note: the sample's video is `video.mov` (HEVC). Safari and Chrome on a Mac play it; Chrome on Windows may not. Newer captures are `video.mp4` (H.264). Always read the name from `manifest.video.file`.

**Starting prompt for Claude Code:**
```
Read CLAUDE.md, TASKS.md, web/README.md, docs/capture-format.md and docs/guide-api.md.
I'm Firdavs. The web viewer in web/ already works (gallery, zip upload, 3D room, people
replay, phone's view). Run it against the guide with the sample capture, then continue
TASKS.md "Firdavs" from the 12:00 row: polish the viewer for the demo, then the fact
review screen, revisit session and dashboard. Work on branch web/<feature>, commit small,
open PRs.
```

---

## IBS27: story, demo and testing (proposed; Shivin to confirm)

With the GX10 pipeline cut, the build has two owners. Everything else that wins the judging is still open, and it needs one person to own it:

- **The pitch and the Devpost:** problem, named community, how it works, the research basis (CLAUDE.md References), impact measurement and pilot plan (Section 8), safety (Section 9), credits (Rumi, Déjà View, Apple sample code). Draft by 18:00.
- **Tonight's filming:** find the stand-in grandparent and family, write a one-paragraph consent note and get everyone's OK, plan a 2-minute visit with clear, specific details for Claude to pick up (a named dish, a gift, a story, a place).
- **Testing:** act as the family reviewer and the caregiver; run revisit sessions on the tablet between 01:00 and 04:00 and log every bug as a GitHub issue with steps.
- **Demo video (04:00–06:00):** shot list, recording, edit.
- **If Firdavs falls behind:** take the dashboard (CLAUDE.md 7.5) in `web/`, coordinated with him.

First: accept the GitHub invite (still pending).

**Starting prompt for Claude Code:**
```
Read CLAUDE.md and TASKS.md. I'm IBS27; my role is story, demo and testing. Draft the
Devpost write-up in docs/devpost.md from CLAUDE.md Sections 1, 6, 8 and 9 and the
references, and a filming plan in docs/filming-plan.md for the demo visit at 20:00
(shot list, consent note, details the family should mention). Work on branch
docs/devpost and open a PR.
```

---

## Shared, from 04:00 Sunday

| Time | Everyone |
|---|---|
| 04:00–06:00 | Demo video: Shivin films capture, Firdavs shows review, session and dashboard, IBS27 edits |
| 06:00–07:30 | Devpost text, screenshots, README; opt into the Anthropic track |
| 07:30–08:30 | Rehearse the 3-minute pitch twice |
| **08:30** | **Submit** (hard deadline 09:00) |

## Handoffs to watch

- **Now** Shivin → Firdavs: the sample capture (release `sample-capture-1`) and the working viewer in `web/`.
- **11:00** Shivin → Firdavs: guide server tunnel URL serving the sample capture. If late, Firdavs keeps loading from `web/public/sample/`.
- **Done (~08:00)** Shivin → Firdavs: real facts in `/api/moments/:id` (the sample capture has them), plus `PATCH .../facts/:factId` and `POST .../extract`.
- **Done (08:15, PR #8)** Shivin → Firdavs: session routes with grounding, distress and scoring, plus `/api/progress` and `/api/person`.
- **20:00** Shivin → everyone: the demo capture. Everything after depends on this one, so protect it (keep the zip, upload it twice).
