# Braindance: who builds what

Three owners. Each person owns their slice end to end and commits to their own folder or branch. Read `CLAUDE.md` Section 0 before starting.

The split runs along the product instead of server vs web, so each teammate can demo their half alone:

- **Shivin:** the capture app (iPhone → package on the server)
- **Teammate B:** the moment pipeline (package → approved, grounded facts)
- **Teammate C:** the revisit loop (approved facts → patient session → recall dashboard)

---

## Contracts everyone depends on (first 45 minutes)

Teammate B writes these first and pushes them by **06:30**. Shivin and C read them before writing any code that touches files or APIs.

- `docs/capture-format.md`: package format (`CLAUDE.md` Section 5 + `IOS_CAPTURE_PLAN.md` Section 7)
- `server/app/models.py` + `web/src/types.ts`: the same shapes in Pydantic and TypeScript
- `server/app/db.py`: the tables in `CLAUDE.md` Section 9
- the REST routes in `CLAUDE.md` Section 6.6, stubbed so they return real errors until implemented
- `server/tests/make_fixture.py`: a tiny synthetic package, used only in tests and local dev

If anyone needs a contract change, say it in the team chat and B makes it, so all three stay in sync.

---

## Shivin: iOS capture app (Mac + iPhone 16 Pro Max)

**Plan:** `IOS_CAPTURE_PLAN.md`, all of it.

| By | Deliverable |
|---|---|
| 07:00 | App runs on the phone; upright camera feed at 60 fps |
| 08:30 | Live colored points accumulate and stay locked to real objects |
| 09:30 | `room.ply` opens on a laptop with correct colors and scale |
| 10:00 | **Send a real `room.bin` to C** |
| 12:00 | Moment recording (video + audio + poses + depth); clap test passes |
| 13:30 | Review screen, manifest, per-file upload to B's server |
| 15:00 | Edge cases: backgrounding, interruptions, thermal, low storage |
| 20:00 | **Film the demo visit** at your brother's house with everyone's consent |

Also yours: the capture part of the demo video, and the pitch section about how the scan works.

**Starting prompt for Claude Code:**
```
Read IOS_CAPTURE_PLAN.md and CLAUDE.md Section 0. Build the iOS app in ios/ following
IOS_CAPTURE_PLAN.md. Start with Section 10's first two checkpoints: an app that runs on
my iPhone 16 Pro Max showing the camera feed in an MTKView, then live point accumulation.
Give me the exact Xcode steps to create and sign the project. You can't run it, so stop
after each checkpoint and tell me what to check on the phone.
```

---

## Teammate B: moment pipeline (server + family review)

**Plan sections:** `CLAUDE.md` 6.1–6.6, 7.1–7.4, 8.1, 8.3, 9, 11.

Owns the FastAPI server scaffold and database. Runs it on the GX10 (or a laptop) and exposes it through `cloudflared` or Tailscale so the phone and tablet can reach it.

| By | Deliverable |
|---|---|
| 06:30 | Contracts above pushed |
| 07:15 | All dependencies installed and verified on the GX10 (ARM Linux); report any that fail |
| 10:00 | Upload routes + ingest validation work with the fixture; public HTTPS URL shared with Shivin |
| 13:00 | Transcode, keyframes and transcription work on Shivin's first real capture |
| 16:00 | Claude fact extraction (7.2) with evidence; results stored as `pending_review` |
| 18:00 | Grounding enforcement (7.4) with tests, including a deliberately ungrounded sentence getting dropped |
| 20:00 | Family upload/status page (8.1) and fact review page (8.3): approve, edit, reject, "don't bring up" |
| 22:00 | Run the real demo capture through the pipeline; tune the extraction prompt |

Also yours: the Devpost "How we built it" section and the README's setup and capture-format docs.

**Starting prompt for Claude Code:**
```
Read CLAUDE.md and TASKS.md. I'm Teammate B. First write the contracts listed in TASKS.md
and commit them. Then install every server dependency and confirm each works on this
machine (ARM Linux) before writing pipeline code; report anything that fails. Then build
Sections 6.1–6.6 against the fixture, then fact extraction (7.2) and grounding (7.4) with
tests, then the family upload and fact review pages (8.1, 8.3) in web/.
```

---

## Teammate C: revisit loop (3D viewer + patient session + dashboard)

**Plan sections:** `CLAUDE.md` 7.5–7.6, 8.2, 8.4, 8.5, 10.

Owns the shared 3D viewer component (B's review page imports it), the session routes on B's server (`/api/sessions/*`), and everything the patient and family see after facts get approved.

| By | Deliverable |
|---|---|
| 08:00 | Web scaffold; StaticCloud renders the fixture cloud with soft round points |
| 10:30 | Renders Shivin's real `room.bin` |
| 12:00 | Synced video fallback panel + camera path playback (8.2 fallback first) |
| 15:00 | Session routes on the server: start, turn, end; companion prompt (7.5) using B's grounding check |
| 18:00 | Revisit screen (8.4): welcome, replay with narration, push-to-talk conversation, goodbye; TTS via Cartesia or browser speech |
| 20:00 | Scoring (7.6) after each session + dashboard (8.5) with real session timestamps and branches |
| 22:00 | DepthReplay shader (people in 3D) if everything above works |
| 01:00–04:00 | Run 3+ real revisit sessions with the demo moment, spaced a few hours apart |

Also yours: the pitch section on impact measurement and the dashboard part of the demo video.

**Starting prompt for Claude Code:**
```
Read CLAUDE.md and TASKS.md. I'm Teammate C. Build web/ following Section 8.2 first:
the StaticCloud viewer loading room.bin (format in docs/capture-format.md) with the synced
video fallback, as a reusable component. Use the fixture until a real capture arrives.
Then add the session routes to the server (Sections 7.5–7.6, using the grounding check in
server/app/claude/grounding.py), then the Revisit screen (8.4), then scoring and the
dashboard (8.5).
```

---

## Shared, from 04:00 Sunday

| Time | Everyone |
|---|---|
| 04:00–06:00 | Demo video: Shivin films capture, B shows facts + review, C shows the session + dashboard |
| 06:00–07:30 | Devpost text, screenshots, README, research references; opt into the Anthropic track |
| 07:30–08:30 | Rehearse the 3-minute pitch twice |
| **08:30** | **Submit** (hard deadline 09:00) |

## Handoffs to watch

- **10:00** Shivin → C: first real `room.bin`. If late, C keeps going on the fixture.
- **10:00** B → Shivin: public server URL. If late, Shivin AirDrops the package to B.
- **15:00** B → C: grounding module ready to import. If late, C stubs it with a clear TODO and no fake output.
- **20:00** Shivin → B: the demo capture. Everything after depends on this one, so protect it.
