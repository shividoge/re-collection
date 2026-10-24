# Braindance guide server

Stores captures from the phone, serves their files to the web app, and makes every Claude call: fact extraction, revisit sessions and scoring. Plan v3 adds the editor's data and jobs (objects, read text, events, enhanced views, measurements, notes, search, sites). The API is the contract in `../docs/guide-api.md`; the editor's data shapes are in `../docs/scene-model.md`.

Node 21.7 or later today. The editor needs **Node 22.13 or later** for the built-in `node:sqlite` [planned]; `package.json` `engines` moves with it.

```bash
cd guide
cp .env.example .env          # optional for now; ANTHROPIC_API_KEY is needed from step 3
npm start                     # http://127.0.0.1:8787
npm test                      # no network, no key
```

## Getting a capture in

- **From the phone:** the app uploads each file to `PUT /api/captures/:id/files/:name`, then calls `POST /api/captures/:id/complete`, which validates the package against its manifest.
- **From a folder** (AirDrop, or the sample release):
  ```bash
  gh release download sample-capture-1 --repo shividoge/braindance --dir /tmp/sample
  unzip /tmp/sample/*.zip -d /tmp/sample
  npm run import -- /tmp/sample/capture-aa8ba104-6d9c-462f-ab5c-a172b1e0b95e
  ```

Captures live in `guide/data/captures/<id>/` (gitignored), exactly as the phone wrote them, plus `status.json` written by the guide.

## Reaching it from the phone and the tablet

Venue Wi-Fi blocks device-to-device traffic, so expose it over HTTPS:

```bash
brew install cloudflared
cloudflared tunnel --url http://127.0.0.1:8787
```

Use the printed `https://….trycloudflare.com` URL on the phone (Settings) and in the web app (`VITE_GUIDE_URL`). The URL changes every time the tunnel restarts, so post the new one in the team chat. Set `BRAINDANCE_KEY` in `.env` before sharing the URL.

## Layout

```
src/server.mjs      routes, CORS, auth
src/config.mjs      reads .env
src/http.mjs        JSON helpers, Range parsing, file streaming
src/store.mjs       capture folders on disk, safe file paths, status.json
src/validate.mjs    package checks against the manifest
src/claude.mjs      the one place that calls the Anthropic API; MOCK_CLAUDE switch
src/prompts.mjs     every prompt
src/facts.mjs       fact extraction
src/worker.mjs      runs queued fact extraction in the background
src/grounding.mjs   the grounding check
src/session.mjs     revisit sessions, distress, branches, scoring, progress
scripts/import.mjs  copy a capture folder in and validate it
test/               node:test with a stubbed Claude client
```

Planned for the editor (plan v3):

```
src/db.mjs          opens DB_PATH with node:sqlite, runs migrations
src/auth.mjs        Clerk session tokens, roles per site, device tokens, file tokens, the admin key
src/jobs.mjs        the job queue: leases, retries, one guide job at a time (replaces src/worker.mjs)
src/entities.mjs    entities, appearances, read text, events, cross-capture matches
src/extract-*.mjs   the Claude jobs: objects, text, events_visual (grounded like facts)
src/views-math.mjs  computed jobs: appearances, best_views, rectify, stabilize (ffmpeg)
src/align.mjs       4-DoF ICP between captures of a site, and change detection
src/measure.mjs     distances with uncertainty and the "check in person" flag
src/notes.mjs       notes and replies
src/search.mjs      the FTS5 index and queries
src/views.mjs       saved views (share links)
src/trace.mjs       provenance trees down to original frames and audio
src/worker-api.mjs  routes the Python audio worker (../worker/) uses
```

The audio worker is a separate, optional Python program in `../worker/`. Without it, audio jobs stay queued and the website says no worker is running.
