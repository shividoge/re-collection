# Braindance: who builds what (plan v2)

Read `CLAUDE.md` first. The contracts are `docs/capture-format.md` (the phone's files) and `docs/guide-api.md` (the guide server's routes). Build against them, and ask the owner before changing one.

**What changed at 07:00 Sat:** the Python pipeline on the ASUS GX10 is cut. Shivin now owns a small Node guide server that makes every Claude call, so the product is built by two people: Shivin (phone + guide) and Firdavs (web). IBS27's role is proposed below.

| Person | GitHub | Owns | Folders |
|---|---|---|---|
| Shivin | shividoge | iPhone capture app + guide server (all Claude calls) | `ios/`, `guide/` |
| Firdavs | boliyevfirdavs | Web app: viewer, family review, patient session, dashboard | `web/` |
| IBS27 | IBS27 | Proposed: story, demo, testing (see below; Shivin to confirm) | `docs/`, Devpost |

Work on a branch named for your area (`ios/...`, `guide/...`, `web/...`), push often, and open a PR into `main`. Don't push to `main` directly.

---

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

**2. iPhone app: transcript, keyframes, review, upload.** Branch `ios/upload`.
- Video becomes `video.mp4` (H.264 + AAC) so Chrome plays it.
- After recording: `transcript.json` from `SFSpeechRecognizer` on the recorded audio (`requiresOnDeviceRecognition`, word timings; add `NSSpeechRecognitionUsageDescription`), and `keyframes/kNNNN.jpg` once per second, 1024 wide. Formats are in `docs/capture-format.md`. If on-device recognition isn't available, skip the file and add a manifest warning.
- Review screen: title, attendees (free text), play back the clip. These go in `manifest.json`.
- Settings: guide URL and optional key (typed; QR is cut). Upload per file with up to three retries, `manifest.json`, `room.bin` and `thumb.jpg` first, then `complete`. Show progress and real errors.
- Clap test: phone propped up, clap with both hands in the middle of the frame, check sync (Claude can check it from the files).
- Update `ios/VERIFY.md` and unit tests (manifest additions, keyframe naming, transcript encoding).

**3. Guide server, part 2: facts.** Branch `guide/facts`.
- `src/claude.mjs` (one wrapper; mock switch), `src/prompts.mjs`, `src/facts.mjs` per `CLAUDE.md` 6.2: up to 30 keyframes + transcript + title/attendees go to Opus, with tool `record_facts`; drop facts without evidence; write `moment.json`; status queued → running → done/failed.
- Routes: `GET /api/moments/:id`, `PATCH /api/moments/:id/facts/:factId`, `POST /api/moments/:id/extract`.
- Done when the real capture has facts in `moment.json`, each linked to a keyframe or quote.

**4. Guide server, part 3: grounding, sessions, scoring.** Branch `guide/sessions`.
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

| By | Deliverable |
|---|---|
| 12:00 | Vite + React + TS + R3F scaffold in `web/`; StaticCloud renders the sample `room.bin` with soft round points, in the right orientation (y up, floor flat) |
| 13:30 | Camera path from `frames.jsonl` as a faint line; synced video fallback panel with a playhead on the path |
| 15:00 | Captures list (7.1) against the guide server; CameraPath playback mode |
| 17:00 | Family fact review screen (7.3): facts next to keyframes/quotes, click to seek, approve/edit/reject/don't bring up |
| 19:00 | Revisit screen (7.4): welcome, replay with chapter narration, push-to-talk, goodbye, caregiver end button; speech via `speechSynthesis` |
| 21:00 | Dashboard (7.5) from `/api/progress` with real session times, branches, distress alerts |
| 23:00 | DepthReplay shader (people in 3D) if everything above works |
| 01:00–04:00 | Run 3+ real revisit sessions with the demo moment, spaced a few hours apart |

Note: the sample's video is `video.mov` (HEVC). Safari plays it; Chrome on Windows may not. The next phone build writes `video.mp4` (H.264). Read the name from `manifest.video.file`.

**Starting prompt for Claude Code:**
```
Read CLAUDE.md, TASKS.md, docs/capture-format.md and docs/guide-api.md. I'm Firdavs.
Build web/ (Vite + React + TypeScript + React Three Fiber) following CLAUDE.md Section 7.
Start with the StaticCloud viewer loading room.bin from the sample capture (GitHub release
sample-capture-1, unzipped into web/public/sample/, gitignored), then the camera path and
the synced video fallback. Work on branch web/viewer, commit small, open a PR. Then the
captures list, fact review, revisit session and dashboard against the guide server API.
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

- **Now** Shivin → Firdavs: `room.bin` and the sample capture (release `sample-capture-1`).
- **11:00** Shivin → Firdavs: guide server tunnel URL serving the sample capture. If late, Firdavs keeps loading from `web/public/sample/`.
- **16:00** Shivin → Firdavs: real facts in `/api/moments/:id`. Until then, mock mode with the banner.
- **18:00** Shivin → Firdavs: session routes with grounding. Until then, mock mode with the banner.
- **20:00** Shivin → everyone: the demo capture. Everything after depends on this one, so protect it (keep the zip, upload it twice).
