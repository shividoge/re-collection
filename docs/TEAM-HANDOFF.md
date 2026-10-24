# Braindance: team handoff (Sat Oct 24, afternoon)

**One line:** a family films a visit with a LiDAR iPhone; Braindance turns it into a moment their loved one with Alzheimer's can step back into, narrated by Claude using only what the family approved, and shows the family what stuck.

**See it now (no login):** https://shividoge.github.io/braindance-site/ (a free static copy on GitHub Pages: four real scans, a guided walkthrough, the 3D viewer). Open it on a laptop in Chrome or Safari.

Read `CLAUDE.md` for the full plan and `docs/guide-api.md` / `docs/capture-format.md` for the two contracts. This page is the "where are we" summary.

## What is done

| Piece | State | Where |
|---|---|---|
| iPhone capture app | Works on a real phone: live room scan, visit recording (video, sound, depth, camera pose), on-device transcript, keyframes, review screen, upload, AirDrop zip. | `ios/` (on `main`) |
| Guide server (Node) | Uploads, validation, file serving with Range, Claude fact extraction, family review routes, revisit sessions, grounding check, distress handling, recall scoring, progress. 66 tests. | `guide/` (on `main`, plus open PRs below) |
| Website | Gallery and 3D viewer with people replayed from depth, family fact review, patient Revisit screen, family dashboard, and the **public front page** with the walkthrough. | `web/` (see the PR tangle below) |
| Public site | Live on GitHub Pages, built from the captures marked public. | repo `shividoge/braindance-site` |
| Real data | Four captures with facts: the Anthropic booth, the Cal Hacks sign, the Hardware Lab table, the Cal Hacks bear. | on Shivin's Mac (`guide/data`, not in git) |

Everything on the public site is real. The four sessions on it are Claude narrating alone: **nobody has talked back yet**, so the recall chart is an honest empty state. A real family session fills it in.

## The open PRs (read this before merging anything)

Merged to `main`: #1 to #8. Open:

- **#10** iOS: optional medium-confidence depth in the room scan. Independent. Not tested on a device yet (see `ios/VERIFY.md`).
- **#9, #11, #12, #14** are a stack on `main`: Revisit screen and dashboard (#9), public front page and walk-in viewer (#11), static export for GitHub Pages (#12), the new walkthrough site (#14). Each is based on the one before, so merge in that order and retarget each to `main` as the one before it merges.
- **#13** (Firdavs) **replaces the whole `web/` folder** with his viewer (orbit and fly navigation, object selection, revisit and talking inside it). It overlaps #9, #11, #12 and #14 in `web/src/api.ts`, `main.tsx`, `Viewer.tsx`, `FactsPanel.tsx`, `Dashboard.tsx`, `Gallery.tsx` and more.

**Decision needed, today, from Shivin and Firdavs:** which `web/` is the one we keep.
- If #13 wins: the public site is already deployed and does not depend on what is on `main`, so nothing breaks. Port the showcase onto it: `web/src/views/Showcase.tsx`, `web/src/showcase/*`, the public-mode and static-mode URL mapping in `web/src/api.ts`, and the `/public` routes in `guide/` (already guide-side, so unaffected).
- If the current tree wins: merge #9, #11, #12, #14, then bring Firdavs's navigation and selection into it.
Firdavs offered to help port; take him up on it.

## How to run it yourself

1. Clone: `gh repo clone shividoge/braindance` (the repo is private; Shivin invited `boliyevfirdavs`, and `IBS27`'s invite was pending).
2. **Ask Shivin privately** for `guide/.env` (the Anthropic key and the team password). **Never commit it or paste it in chat or an issue.** Without it the guide runs only with `MOCK_CLAUDE=1`, which labels everything `[mock]`.
3. Captures are not in git (they are big). Get a capture folder or zip from Shivin and import it: `npm --prefix guide run import -- <folder>`. Or drop the zip on the website.
4. Start it: `npm --prefix guide start`, then open http://127.0.0.1:8787. After editing `web/`, run `npm --prefix web run build` (or `npm --prefix web run dev` for hot reload on :5173).
5. Tests: `npm --prefix guide test` (66 tests, no network, no key needed).

## Where to work

- **Contracts first.** If you change a route or a file format, change `docs/guide-api.md` or `docs/capture-format.md` first, and tell the owner.
- Guide (all Claude calls and the grounding check): `guide/src/` (`facts.mjs`, `session.mjs`, `grounding.mjs`, `public-views.mjs`, `server.mjs`).
- Website: `web/src/views/` and `web/src/scene/` (3D), `web/src/showcase/` (the public front page).
- Phone: `ios/` (Swift, no third-party packages; XcodeGen from `ios/project.yml`).
- Branches: `ios/...`, `guide/...`, `web/...`, `docs/...`. Open a PR; never push to `main`. Commits are credited to the person who made them, with no AI attribution lines.

## Updating the public site

```bash
npm --prefix guide run publish -- <capture id>      # mark a capture public (needs everyone filmed to agree)
./deploy/static/build.sh                             # builds .static-site/ locally, uploads nothing
node deploy/static/serve.mjs .static-site            # look at it on http://127.0.0.1:8790
./deploy/static/publish.sh shividoge/braindance-site --publish
```
Only captures marked public are exported, and only approved facts. Details in `deploy/static/README.md`.

## What is left, in order of importance

1. **The demo capture, tonight 20:00.** Scan the room before people arrive, then 1 to 2 minutes of the family talking about specific things (a named dish, a gift, a story, a place) so Claude gets quotes and the replay shows people. Consent from everyone filmed. Keep the zip; import it twice.
2. **Real revisit sessions.** Run 3 or more on the demo capture, spaced a few hours apart, using the Revisit screen with a person playing the loved one. This fills the dashboard and the site's recall chart with real data.
3. **Clap test** (audio and video sync) with hands in frame.
4. **Demo video** (04:00 to 06:00), **Devpost write-up and screenshots**, and a rehearsed 3-minute pitch. Submission deadline is Sunday 9:00 AM PT (aim for 8:30).
5. Polish and stretch: keyboard shortcuts and "approve all" on the review screen, chapter markers on the scrubber, Cartesia voice instead of the browser voice (also a prize track), and a "far mode" for LiDAR if we scan big halls again.

## Rules we must not break

- **Nothing fake.** No mock or sample data shown as if it were a real capture or session. If a step fails, the UI shows the failure.
- **Grounded or nothing.** Claude only says what the family approved; code enforces it (`grounding.mjs`).
- **Privacy.** A capture is private until the family marks it public. Never publish a capture with an identifiable stranger in it. No API keys or passwords in git, chats, or screenshots.

## Gotchas

- The team password (`BRAINDANCE_KEY`) protects the guide's private API. The public site needs no password and cannot call Claude.
- A scan in a big, bright hall with a glossy floor loses most of its depth (the sign scan kept 42% high-confidence depth, 9% while filming; the booth kept about 70%). Scan indoors, away from windows, slowly.
- iPhone installs from the free Apple developer team expire after 7 days.
