# Braindance guide server

Stores captures from the phone, serves their files to the web app, and (from step 3 on) makes every Claude call. The API is the contract in `../docs/guide-api.md`.

Node 21.7 or later, no dependencies yet.

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
src/server.mjs     routes, CORS, auth
src/http.mjs       JSON helpers, Range parsing, file streaming
src/store.mjs      capture folders on disk, safe file paths, status.json
src/validate.mjs   package checks against the manifest
scripts/import.mjs copy a capture folder in and validate it
test/              node:test
```
