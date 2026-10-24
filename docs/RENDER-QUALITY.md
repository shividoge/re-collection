# Task: make the renders much better (a new processing step)

**For:** Firdavs (web). **From:** Shivin. **Why now:** the public site is the first thing judges and families see, and it is built almost entirely out of these renders. The clean scans look good; the hard ones look rough. We want one more processing step that makes every render clearly better, without ever showing something the sensor didn't measure.

## The ask

Add a processing step to the web viewer's rendering so the scans look noticeably better, then use it on the public site. You own the choice of technique; this page lists what we think is worth trying, in the order we'd try it. Pick, measure, and tell us what you chose and why.

The site this feeds: the front page walkthrough and the walk-in viewer at `#/p/<id>` (public site: https://shividoge.github.io/braindance-site/). The porting PR that puts it on your viewer is **#17**. Build on top of it: branch from `main` once #17 is merged, or from `web/port-showcase` until then.

## What already exists (don't redo it)

All of this is yours, in `web/src/scene/`:

- `gaps.ts` and `splatWorker.ts`: per-point splat sizes from neighbor spacing, so points overlap into surfaces. Gaps wider than `SPLAT_MAX` (3.5 cm) stay open on purpose.
- `HoleFill.tsx`: screen-space hole filling that closes pinholes inside a surface and leaves real openings alone.
- `StaticCloud.tsx`: the room as flat-coloured round points.
- `DepthReplay.tsx`: the people replay, built from `depth.bin` and `confidence.bin` with neighbouring depth pixels joined into triangles.

## What still looks bad

From looking at our four public scans (the bear, the Anthropic booth, the Hardware Lab table, the Cal Hacks sign):

- **Thin or gappy surfaces** where LiDAR was weak: glossy floors, bright light, big halls. The sign scan kept about 42% high-confidence depth while scanning and 9% while filming; the booth kept about 70%.
- **Noise:** floating specks, thick "double" walls, and ragged edges on fabric and banners.
- **Flat look:** every point is a flat colour, so a surface reads as a cloud of dots instead of a surface. There are no normals and no shading.
- **People replay edges:** stretched triangles ("flying pixels") where depth jumps between a person and the wall behind them.
- **Colour:** uneven exposure between scan passes.

## The one rule

**"Areas without data stay empty. Never fill them."** (`CLAUDE.md` section 7.2, and the "nothing fake" ground rule.)

Processing may clean, weight, smooth, light and merge what the phone *measured*. It must not invent geometry or colour the sensor never saw. Test: would a viewer come away believing the room contained something we didn't capture? If yes, don't do it.

**Plan v3 (proposed):** any pass that fills gaps or smooths across them (splat growing, screen-space hole filling, surface meshing) produces geometry with `source: "estimated"` (`docs/scene-model.md`, "The four kinds of truth"). It must look different from measured points (a softer, dashed-edge or hatched treatment from `docs/THEME.md` §3), and it disappears when the viewer's **"Measured only"** toggle is on. Measured points never change under that toggle.

## Candidates, best first

Do them in this order unless you find something better. Each is independent.

1. **Eye-dome lighting (depth shading).** A cheap post-process that darkens points next to a nearer neighbour, so edges and shapes pop. `HoleFill` already renders to an offscreen target with a depth texture, so this slots into the same pipeline. Probably the best win for the least work.
2. **Normals, oriented splats and simple lighting.** Estimate a normal per point from its K nearest neighbours (you already compute neighbours in `splatWorker.ts`), draw each splat as a disk facing that normal, and shade it (Lambert plus a little ambient). Surfaces then read as surfaces.
3. **Outlier removal.** Points with too few neighbours are noise today (they just stay small). Fade or drop them, and thin the "double wall" layers. Do it in the worker.
4. **People replay clean-up.** Reject triangles that span a large depth jump, run a small median or bilateral filter on depth, and weight by `confidence.bin`. Optionally smooth across neighbouring depth frames.
5. **Colour normalisation.** Even out exposure between scan passes, and median-filter colour among neighbours.
6. **Fuse depth from the moment into the room cloud** where the room scan has no coverage. Riskiest: people would smear into the static room, so only use static regions. Skip this unless the rest is done.

A **Raw / Enhanced** toggle is worth adding. It lets judges see exactly what the sensor measured against what our processing did, and it keeps us honest.

## Where to work

- Branch: `web/render-quality`. Open a PR; merge only when Shivin says.
- Preview with the real captures: you need them from Shivin (they aren't in git). Import with `npm --prefix guide run import -- <folder>`, then `npm --prefix guide start` and `npm --prefix web run dev` (port 5173, proxies to the guide). The four captures to test on: the **bear** (clean), the **booth**, the **table**, and the **sign** (the hard one).
- Keep heavy work in a **Web Worker**, or move it to export time (`guide/src/export-static.mjs`) if it is too slow in the browser. The public site is **static** (no server), so nothing may depend on the guide at view time.

## Done when

- Visibly better on **all four** captures. Put before and after screenshots in the PR, from the same camera position.
- **No filled gaps.** Add a vitest case in `web/tests/` (next to `gaps.test.ts`) showing a synthetic cloud with a hole wider than `SPLAT_MAX` still has the hole after processing.
- Still smooth: no noticeable drop in frame rate on a MacBook Air for the bear (about 870k points), and no more than a few seconds of extra load.
- Works in the static build: `VITE_STATIC=1 npm --prefix web run build` and the exported site (`./deploy/static/build.sh`, then `node deploy/static/serve.mjs .static-site`).
- `npm --prefix web test` and `npm --prefix web run build` pass, and the lint warning count doesn't go up.
- A short note in the PR on what you did, what you tried and dropped, and any rule you had to bend.

## Putting it on the public site

After the PR is merged, rebuild and republish. **Ask Shivin first**: publishing puts the scans on the open internet.

```bash
./deploy/static/build.sh
./deploy/static/publish.sh shividoge/braindance-site          # preview of what would go public
./deploy/static/publish.sh shividoge/braindance-site --publish
```

You have write access to `shividoge/braindance-site` (accept the invitation if you haven't). Only captures marked public are exported. More in `deploy/static/README.md`.

## Useful numbers

- `room.bin`: coloured points at 1 cm, high-confidence depth only, within 4.5 m of the phone.
- `depth.bin`: 256 by 192 UInt16 millimetres, 10 a second. `confidence.bin`: 0 low, 1 medium, 2 high.
- Formats: `docs/capture-format.md`. Routes: `docs/guide-api.md`.

## Questions to settle with Shivin

- Client or export time for the heavy steps? Our guess: a worker for 1 to 3, export time for 6.
- Do we want the Raw / Enhanced toggle on the public site, or only in the family viewer?
- If medium-confidence depth gets turned on in the phone app (PR #10), do you want to re-scan the sign first so you have better data to test on?
