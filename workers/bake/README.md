# Bake worker

Bakes each capture once so the browser never rebuilds the room (docs/architecture-v3.md §4, §7).
A Bun + TypeScript process that pulls `bake` jobs from Convex, downloads the raw files from R2,
writes the derived files and uploads them back. Outbound connections only.

| Output (`captures/<id>/derived/`) | What | Stored as |
|---|---|---|
| `points.pack` | room.bin reordered for level of detail (every prefix an even sample), unorm16 positions, splat sizes from `gaps.ts`, levels 65 536 / 262 144 / all with a measured `sizeScale` | gzip |
| `surface.pack` | the fused room surface, **indexed** (vertices split only at keyframe seams); `meta.keyframes` = the keyframe layers in the browser's order (≤ 32) | gzip |
| `timeline.pack` | what the visit adds over time, plus the replay `skip` mask | gzip |
| `depth.bin`, `depth.index.json` | depth v2 with the `row-delta` filter (v1 input), or the phone's v2 files copied as is | depth.bin as is, index gzip |
| `derived.json` | the derived manifest, plus `timings` (ms per stage) | gzip |

`surface` and `timeline` are left out when the capture has no scan depth (converted videos), as in the browser.

The geometry is **the web's own code** (`web/src/scene/surface.ts`, `timeline.ts`, `align.ts`,
`gaps.ts`, `formats.ts`), imported unchanged, so the bake and the old browser path can't drift apart.
Those files import `three` (marching-cubes tables); `src/webModules.ts` (preloaded by `bunfig.toml`)
resolves it from this package. `scripts/equivalence.ts` runs the browser's
`web/src/scene/surfaceWorker.ts` itself (from git commit a46255c, since v3 deletes it from the web) next to the bake and compares the results.

## Run it

```bash
cd workers/bake
bun install

# One capture folder on disk → derived files (as is + .gz). No network.
bun run bake --local <captureDir> --out <outDir>

# The worker. Reads CONVEX_URL and WORKER_TOKEN from the environment or ~/.config/braindance/worker.env.
bun run start                    # one job at a time
bun src/worker.ts --concurrency 2
bun src/worker.ts --check        # only asks system.health whether the backend is up
```

`~/.config/braindance/worker.env`:
```
CONVEX_URL=https://<deployment>.convex.cloud
WORKER_TOKEN=<the WORKER_TOKEN set in Convex>
```

Behavior:
- Polls `worker.claim({ kinds: ['bake'], gpu: false })`, backing off 2 s → 15 s while idle (and while the backend errors).
- Heartbeats every 30 s with `{ stage, fraction, message }`; `cancelled: true` stops the job without reporting (it was re-queued or deleted).
- Downloads only what the bake reads (not the video), 4 files at a time, each retried 4 times and size-checked. Temp files are deleted after every job.
- Uploads each derived file with the target `worker.outputUrls` returns (single PUT with its headers, or parts in parallel, ETags back to `worker.finishOutput`), then `worker.complete({ result: { kind: 'bake', derived } })`. Files that are stored gzipped are declared with `contentEncoding: 'gzip'`; for multipart uploads the backend must set `Content-Encoding` when it creates the upload.
- Failures: an invalid capture → `worker.fail` with `retryable: false` and the reasons in plain words; anything else (network, R2, a crash) → `retryable: true`.
- SIGINT/SIGTERM: stop claiming, let the running job finish for up to 90 s, then fail it as retryable. A second signal ends it now.
- `workerId` = hostname-pid.

## Fedora

Bun 1.4+ (`curl -fsSL https://bun.sh/install | bash`), then `bun install` in `workers/bake`.
`sharp` (keyframe decoding) ships prebuilt libvips for linux-x64 and linux-arm64 (glibc); nothing else is native.

## GX10 (aarch64 Linux)

Same steps: Bun has aarch64 Linux builds, and `sharp` installs its linux-arm64 binary. The bake is
CPU only (single-threaded per job), so `--concurrency` up to the number of fast cores is fine;
a job peaks at about 1 GB of memory for a 30 s, 1 M-point capture (9 s of baking on the Fedora desktop).

## As a service

`braindance-bake.service` is a `systemd --user` unit (instructions at its top). Logs: `journalctl --user -u braindance-bake -f`.

## Checks

```bash
bun test                 # no network: validation, LOD, quantization, indexing, depth v2, the job loop against a fake backend
bun run typecheck        # also type-checks the web modules and the generated Convex api it imports
bun run lint
bun scripts/equivalence.ts <captureDir>...   # bake vs the browser's surface worker on real captures
```
