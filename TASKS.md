# Braindance: who builds what

## 🎯 Everything left until submission (read this first)

**Deadline: Sunday 9:00 AM PT, submit by 8:30.** This list is the single source of truth for what's left in the whole project. Every Claude session should read `CLAUDE.md`, this section, and `docs/LAST-STEP.md`, then take the next open item for its person. Tick items off here (in a PR) as they land.

**What the finished demo shows:** a phone scan of a real family visit → Claude's grounded facts, approved by the family → a Revisit session on the iPad → the recall dashboard; and an **old video turned into 3D**, explored on the **iPad** (swipe, tilt, head tracking) and in the **Memory Museum**, where a family member **joins from their phone** and walks the patient to a picture frame and into the moment.

### Must do (the demo depends on these)

| # | What | Who | Where / how | Done when |
|---|---|---|---|---|
| M1 | Memory Museum draws its 3D hall; tap frame → walk → step into Memory Window → back | Firdavs | `web/museum`, details below (Firdavs 2) | Works in Safari on the real iPad; PR open |
| M2 | Memory Window on the real iPad: swipe, tilt, head tracking over HTTPS | Firdavs | `docs/LAST-STEP.md` → "On the real iPad" | Results written in the PR |
| M3 | "Visit together": helper joins the museum from a phone and leads | IBS27 | `docs/LAST-STEP.md` → spec; branch `web/museum-together` | iPad + phone in one room through the tunnel; PR open |
| M4 | Old videos as 3D moments | done (Shivin's Claude) | `tools/video-to-3d`; three clips on release `team-data-1` | ✅ render in viewer and Memory Window |
| M5 | A **real old family video** (with consent) converted and in the museum | IBS27 (convert), Shivin (find the video) | `tools/video2capture/README.md` | It's a frame in the museum |
| M6 | Merge the web stack, in this order: #25 → Firdavs's #16 on top → `web/video-estimated` → `web/museum` → `web/museum-together` → `tools/video-to-3d` | Shivin (merges), each author opens the PR | GitHub | `main` has all of it; the guide serves it |
| M7 | Demo visit filmed with the phone (scan + visit, real people talking, consent) | Shivin films; IBS27 preps the people and details | 20:00 tonight | Imported, facts extracted |
| M8 | Facts reviewed and approved for the demo visit; one "don't bring up" | Shivin (family reviewer) | website → Facts | Approved |
| M9 | 3+ real Revisit sessions on the iPad, a few hours apart | whoever is awake, 01:00–04:00 | website → Begin the visit | Dashboard chart has real points |
| M10 | Demo video (3:00), song cue per `docs/THEME.md` §7 | IBS27 edits; everyone films their part | shot list in `docs/demo-video.md` | Uploaded (unlisted) |
| M11 | Devpost write-up + sponsor opt-ins (Anthropic, Cal Hacks tracks, Meta, Microsoft, MLH + its supplemental form) | IBS27 drafts, Shivin submits | `docs/devpost.md`, `docs/SPONSOR-PLAN.md` | Submitted by 08:30 |
| M12 | Rehearse the 3-minute pitch twice | everyone | 07:30–08:30 | Done |

### Should do (if the Must list is on track)

| # | What | Who |
|---|---|---|
| S1 | "Relive With A Smile" rename, user-facing strings only (`docs/THEME.md` §5), after #25 merges | Firdavs (web), Shivin (iPhone app name) |
| S2 | Republish the public site from `main` after M6 (`docs/TEAM-HANDOFF.md` → "Updating the public site"); only with Shivin's OK | Shivin |
| S3 | Close the old stacked PRs #9, #11, #12, #14, #17, #23 once #25 is merged | Shivin |
| S4 | Acceptance checklist, `CLAUDE.md` §12 (clap test, grounding test, distress phrase, tablet layout) | IBS27 runs it, Shivin does the clap test |
| S5 | Decide on PR #24 (plan v3) | Shivin with IBS27 |

### Nice to have (only with spare time)

"Hide from her" web side (`web/hide-triggers`), Cartesia voice, Vultr hosting, testing PR #10 (iOS medium confidence) on the phone.

### Timeline

| When | Firdavs | IBS27 | Shivin |
|---|---|---|---|
| now–18:00 | M1, M2 (lists below) | M3, then video-to-3D setup (M5) | away |
| 18:00–20:00 | finish M1/M2, PRs; S1 | finish M3; demo-video plan; filming prep | M6 merges, S3, find an old family video |
| 20:00–22:00 | support filming | run M7 with Shivin | M7, then M8 |
| 22:00–01:00 | polish what the shots need | M5, Devpost draft | S2, S4 clap test |
| 01:00–04:00 | M9 sessions (in shifts) | M9 sessions | M9 sessions |
| 04:00–07:30 | M10 screen recordings | M10 edit, M11 | M11 submit-ready |
| 07:30–08:30 | M12 | M12 | M12, **submit** |

---


## ⏱ Right now: Sat 16:00–18:00, detailed lists for Firdavs and IBS27

Shivin is away for about two hours (back ~18:00). Everything that's left is split evenly between **Firdavs** and **IBS27** so you can work in parallel. Don't wait for Shivin: pick up your list below, top to bottom. Older sections further down are history; this section wins where they disagree.

**The goal for these two hours: [`docs/LAST-STEP.md`](docs/LAST-STEP.md).** Old video → 3D → experienced two ways: swiping around it on the iPad (Memory Window), and walking a Memory Museum of picture frames that a family member can **join from their phone** to guide the patient. Read it first.

**Get the data first** (both of you): the GitHub release `team-data-1` has Shivin's four phone scans and three old clips already converted to 3D. Steps in `docs/LAST-STEP.md` → "Get the data". After import the museum should show seven frames.

**Shivin's iPad stays with the team** for testing the museum and the Memory Window (Firdavs, task 2).

**Rules for these two hours**
- Branch per task (`web/...`, `tools/...`, `docs/...`), push often, open a PR. Don't push to `main`, and don't merge; Shivin merges when he's back.
- The website doesn't need to take uploads from the public. It only has to show the scenes **we** give it (phone scans and converted videos). Don't spend time on upload UX.
- Nothing fake (CLAUDE.md §0): a scene rebuilt from a video is labelled "Estimated from a video, not measured".
- Leave a one-line note in the Work log at the bottom of `CLAUDE.md` when you finish a task, and say in the PR what you checked and on which device.
- Stuck for more than 20 minutes? Write it in the team chat and move to your next task.

**What the open branches are** (all pushed):

| Branch / PR | What it is | State |
|---|---|---|
| `web/orange` → PR #25 | The website in one orange look, no password anywhere; includes #17 (public site) and #23 (Memory Window) | Ready for review |
| `web/app` → PR #16 (Firdavs) | Render quality: room as one surface, selection tint, sharp replay | Needs merging with #25 |
| `web/video-estimated` (no PR yet) | "Estimated from a video" badge on cards, viewer, public view and Memory Window; guide summary includes `source` | Built on `web/orange`, open a PR |
| `web/museum` (no PR yet) | **Memory Museum** `#/museum`: a hall of picture frames, one per moment; tap to walk to it, tap again to step into its Memory Window (`#/window/<id>?from=museum`) and back. Also drag-to-look in the Memory Window | UI overlay works; **the 3D hall renders blank** (see Firdavs 2) |
| `tools/video-to-3d` (no PR yet) | `tools/video2capture/`: any old video → a capture package with Depth Anything 3 (README inside) | **Works**: three real clips converted (on the `team-data-1` release); render in the viewer and the Memory Window, drag-to-look checked |
| `web/hide-triggers` | "Hide from her": family picks parts of a scene to hide from the patient. Guide side + tests done, web side not started | Paused, last priority |
| `docs/spatial-editor` → PR #24 (IBS27) | Plan v3 proposal | Waiting for Shivin; don't build on it in these two hours |

### Firdavs: the website (`web/`)

1. **Review PR #25 and merge your #16 onto it.** Check out `web/orange`, run it (`npm --prefix guide start`, then http://127.0.0.1:8787), look at the front page, gallery, viewer, `#/p/<id>` and `#/window/<id>`. Then make a branch `web/app-on-orange` that merges `web/app` into `web/orange`, fix the conflicts, and open a PR. Keep one orange look (no blue) and no password prompt.
2. **Fix the Memory Museum** (`web/museum`, `web/src/museum/Museum.tsx`). The UI overlay renders ("Your memories", Previous/Next) but the R3F canvas shows only the background colour. Already ruled out: the bundle is fresh, the canvas has a WebGL context and a size, and the capture viewer draws fine in the same browser, so the problem is in the museum code. Suspects, in order: the drei `<Html transform>` plaques, the `Walker` camera quaternion (the helper is a `PerspectiveCamera` so `lookAt` faces −z), the fog range, or a component throwing inside the Canvas. Remove pieces until the hall draws. Then check: tap a frame → walk to it; tap again or "Step into this moment" → Memory Window → "← Back to the museum" returns to the same frame; Next/Previous; works on an iPad (Safari, or Xcode's iPad simulator; touch drag, big buttons). Open a PR from `web/museum`.
   - **Test it on Shivin's real iPad** (he left it with the team). The iPad only allows the front camera and the tilt sensor over **HTTPS**, so a `http://192.168…` link or the simulator won't show head tracking. On your laptop: run the guide, then `cloudflared tunnel --url http://127.0.0.1:8787` (`brew install cloudflared` if needed), and open the printed `https://….trycloudflare.com/#/museum` in Safari on the iPad. Check, in landscape:
     - museum: walking to frames, tapping, Previous/Next, text size and button size;
     - Memory Window: **head tracking** (allow the camera; moving your head should shift the view like looking through a window), **tilt** (allow motion when asked; tilting the iPad looks around), and **drag to look** when both are off; "← Back to the museum".
   - Write what works and what feels off in the PR. Fix what you can; these become the demo shots (IBS27's `docs/demo-video.md`), so tell IBS27 when it's ready to film.
3. **Open a PR for `web/video-estimated`** after checking the badge on a capture whose manifest has `"source": "video"` (the three converted clips on the `team-data-1` release are video-sourced).
4. **"Relive With A Smile" rename** in the website, user-facing strings only, per `docs/THEME.md` §5. Do it on top of `web/orange` (branch `web/relive-rename`).
5. Only if all of that is done: the "Hide from her" web side (`web/hide-triggers`; routes in its guide changes) plus a short scroll section on the front page explaining it.

### IBS27: museum together, video-to-3D, Devpost

1. **Build "Visit together"**: a family member joins the patient's museum from their phone and leads the walk. Full spec (guide routes with server-sent events, the `useMuseumRoom` hook, tests, done-when) in `docs/LAST-STEP.md` → "Spec: joining the museum together". Branch `web/museum-together` off `web/museum`; write the guide routes and tests first (they don't depend on Firdavs's canvas fix), then wire `Museum.tsx` once his fix is pushed. Test with the real iPad plus your phone through the tunnel.
2. **Video-to-3D on your machine** (`tools/video-to-3d`, `tools/video2capture/README.md`). It already works on Shivin's Mac; set it up on yours (`--device cuda` if you have a GPU) so we can convert any new old video tonight. Re-run one of the source clips from `original-clips.zip` on the release and compare. Open a PR from `tools/video-to-3d` saying what you checked. If someone has a better old video (a real family moment, with consent), convert it: that's the strongest demo.
3. **Devpost draft** in `docs/devpost.md` (branch `docs/devpost`): name and story from `docs/THEME.md`, how it works (CLAUDE.md §1, §6), impact and pilot plan (§8), safety (§9), the research references, credits (Rumi, Déjà View, Apple sample code, Depth Anything 3). Add the new pieces: Memory Window (head-tracked 3D on any screen, no headset), Memory Museum, and old videos turned into 3D.
4. **Demo video plan** in `docs/demo-video.md`: the 3:00 shot list from `docs/THEME.md` §7, plus shots of the museum, the Memory Window on an iPad, a helper joining from a phone, and a "this was an old video" moment. Note which shots need tonight's 20:00 capture.
5. **Sponsors** (`docs/SPONSOR-PLAN.md`): answer the "Check these before spending any time" list (Devpost opt-ins, MLH supplemental form, Microsoft requirements, Cartesia/Vultr criteria) and write the answers into that file.
6. **Tonight's filming prep:** consent note, who plays the grandparent, and 4–5 specific details the family should mention (a named dish, a gift, a place, a story).

### Shivin, when he's back (~18:00)

- M6: merge the web stack in order (#25 → #16 on top → `web/video-estimated` → `web/museum` → `web/museum-together` → `tools/video-to-3d`); S3: close the old stacked PRs.
- Find an old family video (with consent) for M5 and give it to IBS27.
- M7/M8: film the demo capture at 20:00, import, review facts. Then M9 sessions.
- S2: republish the public site from `main` once the stack is merged.
- ~~Revoke the leaked Anthropic key~~ done 16:00; a new key is in `guide/.env`.

### Starting prompts for Claude Code

Shivin (when back):
```
Read CLAUDE.md, TASKS.md ("Everything left until submission") and docs/LAST-STEP.md.
I'm Shivin. Check which PRs Firdavs and IBS27 opened, review each against its "Done
when", and tell me which are ready to merge in the M6 order. Then help with M7.
```

Firdavs:
```
Read CLAUDE.md, TASKS.md ("Everything left until submission" and "Right now") and
docs/LAST-STEP.md. I'm Firdavs.
Get the data from the team-data-1 release (docs/LAST-STEP.md). Work through
"Firdavs: the website" in order, starting with task 1 (merge web/app onto web/orange). One branch and one PR per task; don't merge to main. Run the guide and check
each change in the browser before opening the PR. When your list is done, take the
next open item for Firdavs in "Everything left until submission".
```

IBS27:
```
Read CLAUDE.md, TASKS.md ("Everything left until submission" and "Right now") and
docs/LAST-STEP.md. I'm IBS27. Work through "IBS27: museum together, video-to-3D, Devpost" in
order, starting with task 1: the guide routes and tests for joining the museum together,
then the web hook, on branch web/museum-together. One branch and one PR per task;
don't merge to main. When your list is done, take the next open item for IBS27 in
"Everything left until submission".
```

---


## History: plan v2 (Sat 07:00)

Read `CLAUDE.md` first. The contracts are `docs/capture-format.md` (the phone's files) and `docs/guide-api.md` (the guide server's routes). Build against them, and ask the owner before changing one.

**Update ~07:45 Sat:** the web viewer exists (`web/`, built by Shivin's Claude while the team slept): drop a capture zip on the page, see it in the gallery, orbit the 3D room, play the visit with people replayed in 3D from depth, and switch to the phone's view. The guide serves it at `/`. The main path for demo captures is **phone → AirDrop zip → drop on the website**; phone-to-guide upload also works but is optional.

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
