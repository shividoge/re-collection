# Braindance: team handoff (Sat Oct 24, evening)

> **Superseded for "what's left":** the current list, owners and timeline are at the top of `TASKS.md` ("Everything left until submission"), and the final feature is in `docs/LAST-STEP.md`. The how-to sections below (running it, updating the public site, gotchas) still apply.

**One line:** a family films a visit with a LiDAR iPhone; Braindance turns it into a moment their loved one with Alzheimer's can step back into, narrated by Claude using only what the family approved, and shows the family what stuck.

**See it now (no login):** https://shividoge.github.io/braindance-site/ (a free static copy on GitHub Pages: four real scans, a guided walkthrough, the 3D viewer). Open it on a laptop in Chrome or Safari.

Read `CLAUDE.md` for the full plan and `docs/guide-api.md` / `docs/capture-format.md` for the two contracts. This page is the "where are we" summary.

## What is done

| Piece | State | Where |
|---|---|---|
| iPhone capture app | Works on a real phone, with a new guided UI: a step bar, live coaching, one big button per screen (PR #21, merged). Live room scan, visit recording, on-device transcript, keyframes, review, upload, AirDrop zip. | `ios/` (on `main`) |
| Guide server (Node) | Uploads, validation, file serving with Range, Claude fact extraction, family review routes, revisit sessions, grounding check, distress handling, recall scoring, progress. 66 tests. | `guide/` (on `main`, plus open PRs below) |
| Website | Firdavs's viewer (orbit, fly, select, visit dock, dashboard) is on `main` (PR #13). The public front page and read-only viewer are in PR #17. | `web/` |
| Public site | Live on GitHub Pages, built from the captures marked public. | repo `shividoge/braindance-site` |
| Real data | Four captures with facts: the Anthropic booth, the Cal Hacks sign, the Hardware Lab table, the Cal Hacks bear. | on Shivin's Mac (`guide/data`, not in git) |

Everything on the public site is real. The four sessions on it are Claude narrating alone: **nobody has talked back yet**, so the recall chart is an honest empty state. A real family session fills it in.

## Pull requests: where things stand

**Merged to `main`:** #1 to #8 (phone app, guide, first viewer), **#13** (Firdavs's new `web/`: orbit, fly, select, visit dock, dashboard), **#18** (render-quality brief), **#20** (photo-to-3D brief), **#21** (guided phone UI).

**Open, in the order to look at them:**

- **#17** Public site ported onto Firdavs's `web/`: the guide's `/public` routes, the static export for GitHub Pages, the front page walkthrough, `#/p/<id>` read-only viewer, the family "Public" switch. Mergeable. **This replaces #9, #11, #12 and #14.**
- **#16** (Firdavs) Room as one connected surface, selection tint, sharper replay. This looks like his answer to issue #19 (render quality). Mergeable and in different files from #17, so the two should merge in either order.
- **#10** iPhone: optional medium-confidence depth. Not yet tested on a device (`ios/VERIFY.md`).
- **#15** This handoff.
- **#9, #11, #12, #14** are the old stacked web PRs. Leave them open until #17 is merged, then close each with "Replaced by #17".

**Open task briefs (in the repo):** `docs/RENDER-QUALITY.md` (issue #19, Firdavs), `docs/PHOTO-TO-3D.md` (estimated 3D from photos, nobody has started), and `docs/SPONSOR-PLAN.md` (which prizes to aim at, and the work each one needs).

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

1. **The demo capture, tonight 20:00.** Scan the room before people arrive, then 1 to 2 minutes of the family talking about specific things (a named dish, a gift, a story, a place). Consent from everyone filmed. Keep the zip; import it twice. The phone app now has the guided UI.
2. **Real revisit sessions.** Three or more on the demo capture, a few hours apart, with a person playing the loved one. This fills the dashboard and the site's recall chart with real data.
3. **Review and merge #17 and #16**, then close #9, #11, #12 and #14. Rebuild and republish the public site (ask Shivin first).
4. **Sponsor work** from `docs/SPONSOR-PLAN.md`: the opt-ins first (free), then the cheap real integrations (Vultr hosting, Cartesia voice).
5. **Clap test** (audio and video sync), **demo video**, **Devpost**, rehearse the three minutes twice. Submission is Sunday 9:00 AM PT; aim for 8:30.
6. Stretch: photo-to-3D (`docs/PHOTO-TO-3D.md`), re-scan the sign after #10 is tested, "approve all" and keyboard shortcuts on the review screen.

## Rules we must not break

- **Nothing fake.** No mock or sample data shown as if it were a real capture or session. If a step fails, the UI shows the failure.
- **Grounded or nothing.** Claude only says what the family approved; code enforces it (`grounding.mjs`).
- **Privacy.** A capture is private until the family marks it public. Never publish a capture with an identifiable stranger in it. No API keys or passwords in git, chats, or screenshots.

## Gotchas

- The team password (`BRAINDANCE_KEY`) protects the guide's private API. The public site needs no password and cannot call Claude.
- A scan in a big, bright hall with a glossy floor loses most of its depth (the sign scan kept 42% high-confidence depth, 9% while filming; the booth kept about 70%). Scan indoors, away from windows, slowly.
- iPhone installs from the free Apple developer team expire after 7 days.
