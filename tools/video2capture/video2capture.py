"""
Turn an ordinary video (no LiDAR) into a Braindance capture package, so an old family video can
be revisited in 3D like a phone scan: room cloud (and optionally a Gaussian splat of the room),
camera path, per-frame depth for the people replay, keyframes and the original sound.

Depth Anything 3 (default DA3NESTED-GIANT-LARGE-1.1: multi-view depth and poses plus a metric
depth model for real-world scale) estimates each sampled frame's camera pose, intrinsics and
depth. Everything it produces is an ESTIMATE, not a measurement: scale is approximate, and
anything the camera never saw stays empty. The manifest says so (`"source": "video"`,
`"depth": {"estimated": true, ...}`) and the web app labels these scenes.

The room is built only from what several frames agree on: pixels at depth jumps, pixels
neighbouring frames contradict, low-confidence pixels, sky, and people and pets (Mask R-CNN) are
left out. People stay in the per-frame depth, so the people replay still shows them. The splat
(`--splat train`, the default) is optimised against the video's own frames with gsplat.

The stages live in convert.py and splat.py; the GPU worker (workers/gpu) runs the same code.

    .venv/bin/python video2capture.py ~/Movies/birthday-2015.mov --title "Mom's 70th birthday"
    node ../../guide/scripts/import.mjs out/capture-<id>   # or add --import above

`--format v1` (default) writes what the guide imports (depth.bin + confidence.bin, room.ply,
room.splat.ply); `--format v3` writes the architecture-v3 raw package (depth v2, room.spz).
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

# PyTorch and pycolmap (imported by DA3) each bring an OpenMP runtime on macOS; without this the
# process aborts at import. Both only use it for CPU threading here.
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
# Fewer out-of-memory failures from fragmentation when the big model runs near the GPU's limit.
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

from decode import ConvertError  # noqa: E402
from estimate import to_capture_pose  # noqa: E402,F401  (kept importable from here)
from geometry import interpolate_pose, level_world  # noqa: E402,F401

# A local copy (models/<name>: config.json + model.safetensors from the Hugging Face repo) is used
# when present; Hugging Face's own downloader can stall on large files.
MODEL_NAME = "DA3NESTED-GIANT-LARGE-1.1"
_LOCAL = Path(__file__).resolve().parent / "models" / MODEL_NAME
MODEL = str(_LOCAL) if (_LOCAL / "model.safetensors").exists() else f"depth-anything/{MODEL_NAME}"


def write_splat(out: Path, g: dict, fmt: str, sh_degree: int) -> dict:
    """room.splat.ply (3dgs-ply) or room.spz; returns the manifest's room.splat entry."""
    import splat

    if fmt == "spz":
        import spz

        spz.write_spz(out / "room.spz", g["means"], g["scales"], g["quats"], g["opacities"], g["sh"])
        name, format_ = "room.spz", "spz"
    else:
        splat.write_ply(out / "room.splat.ply", g["means"], g["scales"], g["quats"], g["opacities"], g["sh"],
                        "Room estimated from a video (trained-from-video); people masked out")
        name, format_ = "room.splat.ply", "3dgs-ply"
    return {"file": name, "format": format_, "count": int(len(g["means"])), "shDegree": sh_degree, "source": "trained-from-video"}


def main() -> int | None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video", type=Path)
    ap.add_argument("--title", default="")
    ap.add_argument("--attendees", default="", help="comma-separated names the family gives")
    ap.add_argument("--out", type=Path, default=Path("out"))
    ap.add_argument("--format", choices=["v1", "v3"], default="v1",
                    help="v1: what the guide imports; v3: depth v2 + room.spz (docs/architecture-v3.md)")
    ap.add_argument("--sample-fps", type=float, default=10.0, help="frames per second given to the model")
    ap.add_argument("--max-frames", type=int, default=None,
                    help="frames per model pass (default: what fits in GPU memory); longer videos run in overlapping windows")
    ap.add_argument("--overlap", type=int, default=None, help="frames consecutive windows share (default: a quarter)")
    ap.add_argument("--median-depth", type=float, default=2.0,
                    help="only for models without metric depth: scale so the typical depth is this many meters")
    ap.add_argument("--model", default=MODEL)
    ap.add_argument("--device", default=None, help="mps, cuda or cpu (default: best available)")
    ap.add_argument("--voxel", type=float, default=0.005, help="room.bin point spacing in meters")
    ap.add_argument("--max-points", type=int, default=6_000_000, help="most room.bin points (bigger scenes get coarser voxels)")
    ap.add_argument("--no-upright", action="store_true",
                    help="trust the video's orientation tag; don't turn frames upright from what's in them")
    ap.add_argument("--detail-res", type=int, default=1008,
                    help="long side of the single-frame depth pass that adds fine detail (0 = multi-view depth only)")
    ap.add_argument("--splat", choices=["train", "none"], default="train", help="train a Gaussian splat of the room, or none")
    ap.add_argument("--splat-passes", type=float, default=30, help="training passes over the frames")
    ap.add_argument("--splat-batch", type=int, default=4, help="frames per training step")
    ap.add_argument("--splat-max", type=int, default=800_000, help="most Gaussians while training")
    ap.add_argument("--splat-keep", type=int, default=500_000, help="most Gaussians kept in the file")
    ap.add_argument("--splat-width", type=int, default=1280, help="training image size (long side)")
    ap.add_argument("--holdout", type=int, default=0,
                    help="for evaluation: leave every Nth model frame out of the room and the splat, and list them "
                         "in <out>/capture-<id>.holdout.json")
    ap.add_argument("--holdout-frames", type=Path, default=None,
                    help="for evaluation: a holdout.json from another run; leave exactly those video frames out")
    ap.add_argument("--import", dest="import_to_guide", action="store_true",
                    help="then import the capture into the guide (node guide/scripts/import.mjs; honors DATA_DIR)")
    args = ap.parse_args()

    import torch

    from convert import Converter, Options

    src = args.video.expanduser().resolve()
    if not src.exists():
        raise SystemExit(f"No such video: {src}")
    if args.splat == "train":
        try:
            import gsplat  # noqa: F401
        except ImportError:
            raise SystemExit("--splat train needs gsplat (README: 'gsplat'), or pass --splat none.")
    device = args.device or ("cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu")
    v3 = args.format == "v3"
    cid = str(uuid.uuid4())
    out = (args.out / f"capture-{cid}").resolve()
    holdout_frames = json.loads(args.holdout_frames.read_text())["frames"] if args.holdout_frames else None
    opts = Options(sample_fps=args.sample_fps, voxel=args.voxel, max_points=args.max_points, detail_res=args.detail_res, detect_upright=not args.no_upright,
                   depth_encoding="v2" if v3 else "v1", write_ply=not v3, window=args.max_frames, overlap=args.overlap,
                   median_depth=args.median_depth, holdout=args.holdout, holdout_frames=holdout_frames)

    t0 = time.perf_counter()
    print(f"Loading Depth Anything 3 ({Path(args.model).name}) and Mask R-CNN on {device}…")
    converter = Converter(args.model, device)
    load_s = time.perf_counter() - t0
    print(f"Converting {src.name}…")
    try:
        result = converter.convert(src, out, capture_id=cid, title=args.title,
                                   attendees=[a.strip() for a in args.attendees.split(",") if a.strip()], opts=opts,
                                   progress=lambda s, f, m: print(f"[{s}] {m}" + (f" ({f:.0%})" if f is not None else "")))
    except ConvertError as e:
        raise SystemExit(str(e))
    timings = {"load models": round(load_s, 2), **result.timings}
    manifest = result.manifest
    if args.splat == "train":
        import splat

        print("[splat] Training the room splat…")
        g = splat.train_from_package(out, converter.masks, device, holdout_frames=result.holdout_frames,
                                     passes=args.splat_passes, batch=args.splat_batch, width=args.splat_width,
                                     cap=args.splat_max, keep_max=args.splat_keep, timings=timings)
        t1 = time.perf_counter()
        manifest["room"]["splat"] = write_splat(out, g, "spz" if v3 else "ply", 1)
        timings["splat write"] = round(time.perf_counter() - t1, 2)
        (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    timings["total"] = round(time.perf_counter() - t0, 2)
    if result.holdout_frames:
        (args.out / f"capture-{cid}.holdout.json").write_text(json.dumps({"frames": result.holdout_frames}))
    (args.out / f"capture-{cid}.timings.json").write_text(json.dumps(timings, indent=2))
    splat_entry = manifest["room"].get("splat")
    print(f"Done: {out}\n  {manifest['room']['points']:,} room points, {manifest['depth']['count']} depth frames, "
          f"{manifest['video']['frameCount']} video frames" + (f", {splat_entry['count']:,} Gaussians" if splat_entry else "") + "."
          + "\n  " + ", ".join(f"{k} {v:.1f} s" for k, v in timings.items()))
    if args.import_to_guide:
        if v3:
            raise SystemExit("--import needs --format v1 (the guide reads depth v1).")
        importer = Path(__file__).resolve().parents[2] / "guide" / "scripts" / "import.mjs"
        sys.stdout.flush()
        return subprocess.run(["node", str(importer), str(out)]).returncode
    return None


if __name__ == "__main__":
    sys.exit(main())
