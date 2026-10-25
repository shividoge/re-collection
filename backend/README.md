# Braindance backend (Convex)

The v3 backend: every function in `docs/architecture-v3.md` §5–§7. It holds all app data, the job queue, every Claude call, and presigned R2 URLs. The guide server's logic is ported into `convex/lib/` and keeps its behavior.

```
convex/
  captures.ts uploads.ts videos.ts   capture lifecycle, presigned uploads (single PUT ≤ 8 MiB, else 16 MiB multipart parts)
  moments.ts factsJob.ts             family review; fact extraction, run as a job by Convex itself
  sessions.ts people.ts progress.ts  revisit sessions (each reply is grounded again inside the mutation that saves it), dashboard
  museum.ts public.ts system.ts      Visit together rooms + arrangement, the read-only front page, health
  worker.ts jobsCron.ts crons.ts     job protocol for bake/GPU workers; cron re-queues expired leases every 30 s
  admin.ts                           token-protected writes for the import script
  lib/                               pure logic: grounding, prompts, claude, facts, session, museum, validate, jobs, stages, r2 (SigV4)
scripts/                             import-guide-data, export-static, smoke-claude (bun, ConvexHttpClient)
```

## Run

```bash
bun install
bun run typecheck          # convex/ and scripts/
bun run test               # vitest + convex-test; stub Claude and a fake R2, so no network and no keys
bunx convex dev --once     # deploy to the dev deployment (.env.local: CONVEX_DEPLOYMENT=dev:adamant-schnauzer-171)
```

Deployment environment (`bunx convex env set NAME value`):
- `ANTHROPIC_API_KEY`, plus optionally `MODEL_OFFLINE` (default `claude-opus-5-5`), `MODEL_LIVE` (default `claude-sonnet-5-5`) and `MOCK_CLAUDE=1` (canned `[mock]` output).
- `WORKER_TOKEN`, shared with the workers.
- `R2_ACCOUNT_ID` (or `R2_ENDPOINT`), `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, and optionally `R2_REGION` (default `auto`). Until these are set, every function that returns or needs a URL throws `R2 isn't configured: …`. It never returns fake URLs.

## End-to-end storage tests

`convex/lib/r2.test.ts` and `convex/r2flow.test.ts` also run against a real S3-compatible server that checks signatures, but only when `R2_TEST_*` is set. Without it they are skipped. For example, with [versitygw](https://github.com/versity/versitygw):

```bash
ROOT_ACCESS_KEY_ID=testkey ROOT_SECRET_ACCESS_KEY=testsecret123 versitygw --port 127.0.0.1:5191 posix /tmp/s3data &
R2_TEST_ENDPOINT=http://127.0.0.1:5191 R2_TEST_ACCESS_KEY_ID=testkey R2_TEST_SECRET_ACCESS_KEY=testsecret123 bun run test
```

To run them against the real dev bucket instead, point `R2_TEST_*` at it with `R2_TEST_REGION=auto`.

## Scripts

These read `CONVEX_URL` and `WORKER_TOKEN` from the environment or from `~/.config/braindance/worker.env`.

```bash
bun scripts/import-guide-data.ts <guide data dir> --dry-run   # check every package locally; touches nothing
bun scripts/import-guide-data.ts <guide data dir>             # captures + review + sessions + person + museum + public flags (needs R2)
bun scripts/export-static.ts [outDir]                         # public data → <outDir>/data for GitHub Pages (default ../.static-site)
bun scripts/smoke-claude.ts                                   # one real narrate/turn/end on a throwaway moment, then deletes it
```

You can rerun the import safely: files already stored with the same size are skipped, and the review state is restored before any file is registered, so imported captures never re-extract facts.

## Dense scene for an existing memory

`bun scripts/import-reconstruction.ts <original capture ID> <completed capture folder>` uploads
an alternate package without creating another memory or replacing the original's facts, sessions
or files. Once baked, the package with the most room points is selected by the family and public
viewers, the palace and the Memory Window. An unfinished package leaves the original scene active.
Use a new capture ID for changed packages. Deleting the memory also deletes its alternate packages.

A cleaned scene may contain fewer points. After reviewing its direct capture URL, select it with
`bun scripts/prefer-reconstruction.ts <original ID> <scene ID>`. This token-protected mutation
only accepts a completed, non-empty scene linked to that memory. Pass `auto` instead of the scene ID to
restore automatic density selection. An unavailable preferred package falls back to density selection;
other memories retain their existing defaults. Importing a smaller scene does not select it automatically.

For a reconstruction of a phone video whose world is tilted, first run
`tools/video2capture/align_capture.py <converted folder> --reference <phone folder> --out <new folder>`
in the converter environment. This applies one rigid transform to the room, camera poses and
splat, preserves every point and writes a new package. Both inputs must use the same video orientation.
