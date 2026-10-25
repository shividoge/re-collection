"""Run the GPU worker's pipeline on a local video, no Convex or storage involved:

    python -m workers.gpu.run --local clip.mov --out /tmp/bd-gpu-out/clip

writes exactly the package a convert job uploads (depth v2, keyframes, video.mp4, ...) into
--out, then (unless --no-splat) runs the splat job's code on that package and adds room.spz,
listing it in manifest.json the way the backend does when the splat job completes. Stage
timings go to <out>.timings.json. For evaluation, --holdout-frames takes another run's
holdout.json and leaves exactly those video frames out of the room and the splat
(tools/video2capture/evaluate.py then scores both runs on them).
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import uuid
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m workers.gpu.run", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--local", type=Path, required=True, metavar="VIDEO")
    ap.add_argument("--out", type=Path, required=True, help="package folder (created; must be empty)")
    ap.add_argument("--title", default="")
    ap.add_argument("--attendees", default="")
    ap.add_argument("--no-splat", action="store_true")
    ap.add_argument("--max-frames", type=int, default=None, help="frames per model pass (default: measured)")
    ap.add_argument("--window", type=int, default=None, help="force windows of this many frames (testing)")
    ap.add_argument("--sample-fps", type=float, default=None, help="model frames per second (default 10)")
    ap.add_argument("--voxel", type=float, default=None, help="room.bin spacing in meters (default 0.015)")
    ap.add_argument("--holdout", type=int, default=0, help="leave every Nth model frame out (evaluation)")
    ap.add_argument("--holdout-frames", type=Path, default=None, help="holdout.json of another run (evaluation)")
    args = ap.parse_args(argv)

    from .pipeline import GpuPipeline, add_splat_to_manifest

    out = args.out.resolve()
    if out.exists() and any(out.iterdir()):
        raise SystemExit(f"{out} isn't empty.")
    timings: dict[str, float] = {}
    t0 = time.perf_counter()
    pipeline = GpuPipeline(max_frames=args.max_frames)
    timings["load models"] = round(time.perf_counter() - t0, 2)

    def progress(stage: str, fraction: float | None, message: str) -> None:
        print(f"[{stage}] {message}" + (f" {fraction:.0%}" if fraction is not None else ""), flush=True)

    options: dict[str, object] = {"holdout": args.holdout}
    if args.window:
        options["window"] = args.window
    if args.voxel:
        options["voxel"] = args.voxel
    if args.sample_fps:
        options["sample_fps"] = args.sample_fps
    if args.holdout_frames:
        options["holdout_frames"] = json.loads(args.holdout_frames.read_text())["frames"]
    if args.window:
        pipeline.max_frames = args.window
    t1 = time.perf_counter()
    pipeline.convert(args.local.expanduser().resolve(), out, capture_id=str(uuid.uuid4()), title=args.title,
                     attendees=[a.strip() for a in args.attendees.split(",") if a.strip()],
                     progress=progress, should_stop=lambda: False, **options)
    result = pipeline.last
    timings.update(result.timings)
    timings["convert total"] = round(time.perf_counter() - t1, 2)
    if result.holdout_frames:
        out.with_name(out.name + ".holdout.json").write_text(json.dumps({"frames": result.holdout_frames}))
    if not args.no_splat:
        t2 = time.perf_counter()
        info = pipeline.splat(out, out, progress=progress, should_stop=lambda: False,
                              holdout_frames=result.holdout_frames, timings=timings)
        timings["splat total"] = round(time.perf_counter() - t2, 2)
        add_splat_to_manifest(out, info)
    timings["total"] = round(time.perf_counter() - t0, 2)
    out.with_name(out.name + ".timings.json").write_text(json.dumps(timings, indent=2))
    print("timings: " + ", ".join(f"{k} {v:.1f} s" for k, v in timings.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
