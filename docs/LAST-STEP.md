# The last step: old videos → 3D → the iPad and the Memory Museum

This is the feature that closes the demo. Firdavs and IBS27 own it while Shivin is away. Read this first, then your list in `TASKS.md` ("Right now").

## What we're building (in one paragraph)

A family has an old video (a birthday ten years ago, a kitchen, a visit). Braindance turns it into a 3D moment. The person with dementia can experience it in two places:

1. **On the iPad (the Memory Window, `#/window/<id>`):** the moment fills the screen and they swipe (or tilt the iPad, or just move their head) to look around inside it, like looking through a window. No headset.
2. **In the Memory Museum (`#/museum`):** a calm hall with one picture frame per moment, oldest first. They tap a frame to walk to it, tap again to step into it, and it opens as the Memory Window. **A family member can join from their own phone or laptop** and walk the hall with them: when the helper picks a frame, the patient's iPad goes there too; when the helper says "let's step in", the iPad opens that moment.

Everything here must be real (CLAUDE.md §0): a moment rebuilt from a video says "Estimated from a video, not measured".

## What already exists

| Piece | Where | State |
|---|---|---|
| Video → capture converter | `tools/video2capture/` (branch `tools/video-to-3d`) | **Works.** Converted three of Shivin's clips on his Mac (Depth Anything 3, about a minute each on Apple MPS); they render in the viewer and the Memory Window |
| Converted clips + Shivin's four phone scans | GitHub release **`team-data-1`** (private repo) | Ready to download, see "Get the data" |
| Memory Window (iPad: swipe, tilt, head tracking) | `web/src/window/` (in PR #25, drag-to-look on `web/museum`) | Built; needs testing on the real iPad over HTTPS |
| "Estimated from a video" badge | branch `web/video-estimated` | Built, needs a PR |
| Memory Museum | `web/src/museum/` on branch `web/museum` | UI works; **3D hall draws nothing** (Firdavs fixes) |
| Joining the museum together | nothing yet | **To build** (IBS27), spec below |

Branch order: `web/orange` (#25) ← `web/video-estimated` ← `web/museum`. Each contains the one before it. Work on top of `web/museum` for anything museum-related.

## Get the data (everyone, 5 minutes)

The scans are not in git. Download Shivin's whole guide data folder (four phone scans with their approved facts) and the three converted videos:

```bash
gh release download team-data-1 --repo shividoge/braindance --dir ~/braindance-team
cd ~/braindance-team
cat braindance-data.zip.part-* > braindance-data.zip   # split in 60 MB parts for slow Wi-Fi
cat original-clips.zip.part-* > original-clips.zip     # only needed to re-run the converter
unzip -q braindance-data.zip && unzip -q video-captures.zip
# run the guide on that data (from your clone, on the web/museum branch):
cd ~/path/to/braindance && npm --prefix web ci && npm --prefix web run build
DATA_DIR=$HOME/braindance-team/data npm --prefix guide start
# add the converted videos (absolute paths):
for c in ~/braindance-team/video-captures/capture-*; do npm --prefix guide run import -- "$c"; done
```

Open http://127.0.0.1:8787/#/museum. You should see seven frames: four phone scans and three old clips. Only want one thing quickly? `gh release download team-data-1 -p video-captures.zip` is 28 MB.

A Claude key in `guide/.env` is only needed for fact extraction and Revisit narration, not for the museum, the viewer or the Memory Window. Without one, imported clips show "facts failed: no key", which is fine for this work.

## On the real iPad (Shivin left it with the team)

The iPad only gives a web page the camera (head tracking) and the motion sensor (tilt) over **HTTPS**. On the laptop running the guide:

```bash
brew install cloudflared   # once
cloudflared tunnel --url http://127.0.0.1:8787
```

Open the printed `https://….trycloudflare.com/#/museum` in Safari on the iPad, in landscape. Allow the camera and motion prompts. The URL changes each time the tunnel restarts.

## Spec: joining the museum together (IBS27)

**The experience.** On the patient's iPad, the museum shows a small "Visit together" button. It shows a short code (4 consonants, e.g. `KTRB`) and a QR code of the join link. The helper opens `…/#/museum?join=KTRB` on their phone. From then on:

- Both screens show the same frame. Either person can tap a frame or Next/Previous; the other screen follows (the walk animation plays on both).
- "Step into this moment" on either screen opens the Memory Window on **the patient's iPad**. The helper's screen shows the same moment, with a "Back to the museum" button that brings both back.
- The iPad shows "Priya is with you" (the helper types their name once when joining; stored in `localStorage`).
- If the helper leaves, nothing breaks; the iPad just keeps working alone.
- Keep it gentle: no "connection lost" alarms on the patient's screen. Problems show on the helper's screen only.

**Guide routes** (plain `node:http`, no new dependencies, add to `docs/guide-api.md` first):

| Route | Does |
|---|---|
| `POST /api/museum/rooms` | Creates a room, returns `{ code }` (4 letters, no vowels, so no real words; skip codes in use) |
| `GET /api/museum/rooms/:code/events` | Server-sent events (`text/event-stream`). Sends the current state on connect, then every change. Sends a comment line every 15 s so the tunnel keeps it open |
| `POST /api/museum/rooms/:code/state` | Body `{ at: number, window: string \| null, by: "patient" \| "helper", name?: string }`. Validates, stores, broadcasts. `window` is a capture id or null |

State lives in memory (a `Map`). Rooms expire 3 hours after the last change. Validate the code format and that `window` is a known capture id. No auth beyond the code for the hackathon; say so in the Devpost.

**Web:** a hook `web/src/museum/useMuseumRoom.ts` (`EventSource` + `fetch`) that gives `{ code, state, peers, setAt, enter, leave }`. `Museum.tsx` takes `at` from the room when joined; `MemoryWindow.tsx` listens on the same room so "Back to the museum" from the helper brings the iPad back.

**Tests:** `guide/test/museum.test.mjs` with node:test: create a room, connect two SSE clients, post a state, both receive it; a bad code returns 404; a bad body returns 400; an expired room is gone.

**Done when:** the iPad (through the tunnel) and a phone join the same room; picking a frame on the phone moves the iPad; "Step into this moment" on the phone opens it on the iPad; back works from either side. Record a 20-second screen capture of both for the demo video.

## Done for the whole feature

- [ ] Three old clips show as frames in the museum with the "Estimated from a video" badge.
- [ ] Tapping a frame on the iPad walks to it; tapping again opens the Memory Window; swipe, tilt and head tracking all work on the real iPad over HTTPS; Back returns to the same frame.
- [ ] A helper on a phone joins with the code and leads the walk.
- [ ] Footage of all three for the demo video (IBS27's `docs/demo-video.md`).
- [ ] PRs open for `web/video-estimated`, `web/museum`, `tools/video-to-3d` and the join feature; Shivin merges.
