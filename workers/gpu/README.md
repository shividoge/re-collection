# GPU worker

Turns an old video into a capture package and then trains its room splat
(docs/architecture-v3.md §4.5, §5 step 4, §7). Pull-based: it only makes outbound calls to Convex
and to the presigned R2 URLs Convex hands out, so it runs anywhere with a GPU.

- `convert` job: downloads `videos/<id>/source.<ext>`, writes the raw package (manifest with
  `source: "video"`, `depth.estimated: true`, depth v2, `frames.jsonl`, `video.mp4`, `room.bin`,
  `keyframes/kNNNN.jpg` at 1 per second, `thumb.jpg`), uploads it and calls
  `worker.complete({ kind: 'convert', manifestJson })`. The backend then queues facts, bake and splat.
- `splat` job: downloads the raw files, trains the splat, uploads `room.spz` (SPZ v3, gzip) and
  calls `worker.complete({ kind: 'splat', splat: { file: 'room.spz', format: 'spz', count, shDegree: 1, source: 'trained-from-video' } })`.

The pipeline itself is `tools/video2capture` (stages in `convert.py`, `splat.py`); this folder
adds the job loop (`worker.py`), the Convex calls (`client.py`, over Convex's HTTP API: the `convex`
PyPI client holds the GIL while it waits on the network, which froze the pipeline and SIGTERM),
transfers (`transfer.py`), failure rules (`errors.py`), the pipeline adapter (`pipeline.py`), a
local mode (`run.py`) and a memory calibration (`calibrate.py`).

## Routing

- A convert job's `needs.frames` is the number of Depth Anything 3 frames it wants in one pass:
  `min(240, max(16, floor(durationSec × 10) + 1))` (`convert.frames_needed`; 10 frames per second
  of video, at least 16, at most 240). The backend sets it from `videos.create`'s `durationSec`.
- A worker advertises `maxFrames` = 16:9 frames one pass fits, measured at startup after the
  models are loaded: `(free GPU memory − 1.85 GiB − 0.5 GiB margin) / 0.074 GiB`, capped at 240
  (`estimate.frames_that_fit`; per-frame cost measured with `calibrate.py`: 0.070 GiB on the
  5060 Ti, 0.074 GiB on the GX10). Measured: **82 on the 5060 Ti, 240 on the GX10**. Override
  with `WORKER_MAX_FRAMES`. A frame's cost scales with DA3's patches, so each job's window is
  recomputed for its shape (a 4:3 phone video costs 35% more per frame: 60 frames on the 5060 Ti).
- So the 5060 Ti takes videos up to ~8 s; longer ones wait for the GX10, which runs up to 24 s
  in one pass and longer videos in overlapping windows of 240 frames, still at 10 frames per
  second (`align.py`, `estimate.merge`). Windows from the metric model are chained with a rigid
  fit on the frames they share (dense per-pixel correspondences, Huber-reweighted); scale is
  only fitted for models without metric depth.
- Why long videos go to the GX10 and not to small windows on the 5060 Ti: against the LiDAR and
  ARKit poses of a 28 s phone capture (`compare_lidar.py`), one 240-frame pass had 0.46 cm path
  error and 2.5% depth error; two 240-frame windows 0.75 cm and 2.5%; six 67-frame windows
  drifted to 2.5 cm and 5.7% scale (5.8 cm and 9.6% when the joins also fitted scale). Small
  windows are only a fallback (less free memory than at startup, or an out-of-memory retry).
- `splat` jobs need no particular memory (training uses at most 240 views) and go to whichever
  GPU worker claims first; with batched training both machines train equally fast. On a 16 GB
  card DA3's weights move to the CPU while a splat trains.

## Failures

`errors.py` has the rules. Retryable (re-queued, at most 3 attempts): network trouble, HTTP 5xx/408/429,
size mismatches, CUDA out of memory (after the pipeline retried in-process with windows a third
smaller; the worker then stops claiming for 60 s, since on a shared GPU it's usually contention).
Not retryable: bad input (no video, undecodable, model output not finite), deliberate `ConvexError`s,
code bugs. SIGTERM/SIGINT stop the job and hand it straight back (`fail(retryable: true)`); a killed
worker's job comes back when its 120 s lease expires.

## Setup

Both machines use the converter's environment (`tools/video2capture/README.md`: PyTorch for the
machine's CUDA, Depth Anything 3, gsplat), plus PyAV:

```bash
uv pip install --python <converter venv>/bin/python av
# optional, faster training: fused-ssim (same CUDA toolchain as gsplat)
git clone https://github.com/rahul-goel/fused-ssim /tmp/fused-ssim
uv pip install --python <converter venv>/bin/python --no-build-isolation --no-deps /tmp/fused-ssim
```

`~/.config/braindance/worker.env` (mode 600):

```
CONVEX_URL=https://<deployment>.convex.cloud
WORKER_TOKEN=...
BRAINDANCE_DA3_MODEL=/path/to/models/DA3NESTED-GIANT-LARGE-1.1
# Fedora only: a full ffmpeg (libx264 + HEVC decoder)
FFMPEG=/home/<you>/braindance-tools/ffmpeg/bin/ffmpeg
FFPROBE=/home/<you>/braindance-tools/ffmpeg/bin/ffprobe
# optional: WORKER_ID, WORKER_KINDS=convert,splat, WORKER_POLL_SEC=10, WORKER_MAX_FRAMES, WORKER_WORKDIR
```

- **Fedora (RTX 5060 Ti 16 GB):** venv `~/braindance-tools/video2capture/.venv` (Python 3.12,
  torch cu128, gsplat built with the redist-nvcc/GCC 14 recipe in the converter README).
- **GX10 (GB10, 128 GB unified, aarch64, CUDA 13):** venv `~/braindance/video2capture/.venv`
  (torch cu130, gsplat, fused-ssim); the system ffmpeg 6.1 is fine.

Run from the repo root:

```bash
<venv>/bin/python -m workers.gpu.worker          # loop
<venv>/bin/python -m workers.gpu.worker --once   # one job
```

### systemd --user

`~/.config/systemd/user/braindance-gpu-worker.service`:

```ini
[Unit]
Description=Braindance GPU worker
After=network-online.target

[Service]
WorkingDirectory=%h/braindance            # the repo checkout
EnvironmentFile=%h/.config/braindance/worker.env
ExecStart=%h/braindance-tools/video2capture/.venv/bin/python -m workers.gpu.worker
Restart=on-failure
RestartSec=30
KillSignal=SIGTERM
TimeoutStopSec=60

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now braindance-gpu-worker
loginctl enable-linger $USER    # keep it running when logged out
journalctl --user -u braindance-gpu-worker -f
```

## Local mode (no Convex, no storage)

```bash
<venv>/bin/python -m workers.gpu.run --local clip.mov --out /tmp/bd-gpu-out/clip
```

Writes exactly the package a convert job uploads, then runs the splat job's code on it and lists
`room.spz` in the manifest the way the backend does. Timings go to `/tmp/bd-gpu-out/clip.timings.json`.
`--holdout-frames <run>.holdout.json` leaves the same video frames out as another run, for
`tools/video2capture/evaluate.py`.

## Tests

```bash
uv run --project workers/gpu --group dev pytest workers/gpu/tests -q      # loop, transfers, config (no GPU)
cd tools/video2capture && <venv>/bin/python -m unittest test_stages test_video2capture test_depthv2 test_spz test_decode
```

`test_depthv2` decodes the Python depth v2 with `shared/depth.ts` (needs `bun`); `test_decode` needs
an ffmpeg with libx264; `workers/gpu/tests/spark_spz_check.mjs` checks SPZ files with Spark's own
decoder (instructions in its header); `test_s3_upload.py` runs against a local S3 server when
`BD_TEST_S3_ENDPOINT` is set.
