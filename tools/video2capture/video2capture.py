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

Output follows docs/capture-format.md (same files a phone capture has), so the guide's import,
fact extraction, review, revisit sessions, the viewer and the Memory Window all work unchanged:

    .venv/bin/python video2capture.py ~/Movies/birthday-2015.mov --title "Mom's 70th birthday"
    node ../../guide/scripts/import.mjs out/capture-<id>   # or add --import above

Coordinates: DA3 returns OpenCV-style world-to-camera poses (x right, y down, z forward) in the
first camera's frame. We convert to the capture convention (ARKit: x right, y up, camera looks
down -z, world y up) by flipping y and z in both the camera and the world frames.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

# PyTorch and pycolmap (imported by DA3) each bring an OpenMP runtime on macOS; without this the
# process aborts at import. Both only use it for CPU threading here.
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
# Fewer out-of-memory failures from fragmentation when the big model runs near the GPU's limit.
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

# A local copy (models/<name>: config.json + model.safetensors from the Hugging Face repo) is used
# when present; Hugging Face's own downloader can stall on large files.
MODEL_NAME = "DA3NESTED-GIANT-LARGE-1.1"
_LOCAL = Path(__file__).resolve().parent / "models" / MODEL_NAME
MODEL = str(_LOCAL) if (_LOCAL / "model.safetensors").exists() else f"depth-anything/{MODEL_NAME}"
FLIP = np.diag([1.0, -1.0, -1.0, 1.0])  # OpenCV <-> ARKit axes, for camera and world frames
# Fedora's stock ffmpeg-free has no libx264 and no HEVC decoder (iPhone videos); point these at a full build.
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
FFPROBE = os.environ.get("FFPROBE", "ffprobe")


# ---------- video in/out (ffmpeg) ----------

def run(cmd: list[str]) -> str:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit(f"{cmd[0]} failed:\n{result.stderr[-2000:]}")
    return result.stdout


def probe(path: Path) -> dict:
    """Duration, fps, frame size (after rotation), creation time, and whether there's audio."""
    info = json.loads(run([FFPROBE, "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path)]))
    video = next((s for s in info["streams"] if s["codec_type"] == "video"), None)
    if video is None:
        raise SystemExit(f"{path} has no video stream.")
    num, den = (int(x) for x in video.get("avg_frame_rate", "30/1").split("/"))
    fps = num / den if den else 30.0
    tags = info.get("format", {}).get("tags", {})
    check_ffmpeg(video.get("codec_name", ""))
    return {
        "duration": float(info["format"]["duration"]),
        "fps": fps,
        "has_audio": any(s["codec_type"] == "audio" for s in info["streams"]),
        "created": tags.get("creation_time"),
    }


def check_ffmpeg(codec: str) -> None:
    """Fail before writing anything if this ffmpeg can't decode the input or encode H.264 with libx264."""
    encoders = run([FFMPEG, "-hide_banner", "-encoders"])
    decoders = run([FFMPEG, "-hide_banner", "-decoders"])
    missing = [] if " libx264 " in encoders else ["the libx264 encoder"]
    if codec and not re.search(rf"^ \S+ {re.escape(codec)}\b", decoders, re.M):
        missing.append(f"a {codec} decoder")
    if missing:
        raise SystemExit(f"{FFMPEG} lacks {' and '.join(missing)}. Install a full ffmpeg, or set FFMPEG and FFPROBE "
                         "to one (README: 'ffmpeg on Linux').")


def transcode(src: Path, dst: Path, has_audio: bool) -> None:
    """H.264 + AAC mp4, upright (ffmpeg applies rotation metadata), at most 1920 wide, even sizes.
    Frame timing is kept as is (variable frame rate stays variable); frames.jsonl uses the real timestamps."""
    cmd = [FFMPEG, "-v", "error", "-y", "-i", str(src),
           "-vf", "scale='trunc(min(1920,iw)/2)*2':-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
           "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
    cmd += ["-c:a", "aac", "-b:a", "128k", "-ac", "1"] if has_audio else ["-an"]
    run(cmd + [str(dst)])


def frame_times_and_size(path: Path) -> tuple[np.ndarray, int, int, float]:
    """Every frame's presentation time (s, first frame at 0), width, height and average fps.
    Real timestamps, not i/fps: phone videos are often variable frame rate."""
    out = run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries",
               "stream=width,height,avg_frame_rate:frame=best_effort_timestamp_time", "-of", "json", str(path)])
    info = json.loads(out)
    s = info["streams"][0]
    num, den = (int(x) for x in s["avg_frame_rate"].split("/"))
    ts = np.array([float(f["best_effort_timestamp_time"]) for f in info.get("frames", [])
                   if f.get("best_effort_timestamp_time") not in (None, "N/A")])
    if len(ts) == 0 or len(ts) != len(info.get("frames", [])) or np.any(np.diff(ts) <= 0):
        raise SystemExit(f"{path}: frame timestamps are missing or out of order; can't line poses up with playback.")
    return ts - ts[0], int(s["width"]), int(s["height"]), num / den if den else len(ts) / max(ts[-1] - ts[0], 1e-6)


def extract_frames(video: Path, indices: list[int], folder: Path) -> list[Path]:
    """The video frames at these indices (presentation order), exactly, in one decode pass."""
    expr = "+".join(f"eq(n,{i})" for i in indices)
    run([FFMPEG, "-v", "error", "-y", "-i", str(video), "-vf", f"select='{expr}'", "-fps_mode", "passthrough",
         "-pix_fmt", "yuvj420p", "-q:v", "2", "-start_number", "0", str(folder / "f%04d.jpg")])
    paths = sorted(folder.glob("f*.jpg"))
    if len(paths) != len(indices):
        raise SystemExit(f"Read {len(paths)} of the {len(indices)} frames the model needs from {video}.")
    return paths


# ---------- geometry ----------

def to_capture_pose(w2c: np.ndarray) -> np.ndarray:
    """OpenCV world-to-camera (3x4 or 4x4) -> capture camera-to-world (4x4), y up, looks down -z."""
    m = np.eye(4)
    m[: w2c.shape[0], :4] = w2c[:, :4] if w2c.shape[0] == 3 else w2c
    c2w = np.linalg.inv(m)
    return FLIP @ c2w @ FLIP


def rot_to_quat(r: np.ndarray) -> np.ndarray:
    w = math.sqrt(max(0.0, 1 + r[0, 0] + r[1, 1] + r[2, 2])) / 2
    x = math.copysign(math.sqrt(max(0.0, 1 + r[0, 0] - r[1, 1] - r[2, 2])) / 2, r[2, 1] - r[1, 2])
    y = math.copysign(math.sqrt(max(0.0, 1 - r[0, 0] + r[1, 1] - r[2, 2])) / 2, r[0, 2] - r[2, 0])
    z = math.copysign(math.sqrt(max(0.0, 1 - r[0, 0] - r[1, 1] + r[2, 2])) / 2, r[1, 0] - r[0, 1])
    q = np.array([w, x, y, z])
    return q / np.linalg.norm(q)


def quat_to_rot(q: np.ndarray) -> np.ndarray:
    w, x, y, z = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def slerp(a: np.ndarray, b: np.ndarray, t: float) -> np.ndarray:
    d = float(np.dot(a, b))
    if d < 0:
        b, d = -b, -d
    if d > 0.9995:
        q = a + t * (b - a)
        return q / np.linalg.norm(q)
    th = math.acos(d)
    return (math.sin((1 - t) * th) * a + math.sin(t * th) * b) / math.sin(th)


def interpolate_pose(poses: list[np.ndarray], times: list[float], t: float) -> np.ndarray:
    """Camera-to-world at time t, between the two nearest sampled poses."""
    if t <= times[0]:
        return poses[0]
    if t >= times[-1]:
        return poses[-1]
    i = int(np.searchsorted(times, t)) - 1
    u = (t - times[i]) / (times[i + 1] - times[i])
    q = slerp(rot_to_quat(poses[i][:3, :3]), rot_to_quat(poses[i + 1][:3, :3]), u)
    m = np.eye(4)
    m[:3, :3] = quat_to_rot(q)
    m[:3, 3] = (1 - u) * poses[i][:3, 3] + u * poses[i + 1][:3, 3]
    return m



def level_world(poses: list[np.ndarray]) -> np.ndarray:
    """A rotation (4x4) that makes world +y point up. A handheld camera is rarely rolled, so its
    x axis stays about horizontal: "up" is the direction most perpendicular to every camera's x
    axis (the smallest eigenvector of their scatter), signed to agree with the cameras' up. When
    the camera never turned enough to pin that down, fall back to the cameras' average up with
    the roll removed."""
    xs = np.stack([T[:3, 0] for T in poses])
    ys = np.stack([T[:3, 1] for T in poses])
    vals, vecs = np.linalg.eigh(xs.T @ xs / len(xs))
    up = vecs[:, 0]
    if vals[0] > 0.3 * vals[1]:  # ambiguous: the x axes span less than a plane
        x = xs.mean(0) / np.linalg.norm(xs.mean(0))
        up = ys.mean(0) - (ys.mean(0) @ x) * x
    up = up / np.linalg.norm(up)
    if up @ ys.mean(0) < 0:
        up = -up
    # Smallest rotation taking `up` to +y (Rodrigues).
    target = np.array([0.0, 1.0, 0.0])
    v, c = np.cross(up, target), float(up @ target)
    if np.linalg.norm(v) < 1e-9:
        R = np.eye(3) if c > 0 else np.diag([1.0, -1.0, -1.0])
    else:
        vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
        R = np.eye(3) + vx + vx @ vx / (1 + c)
    M = np.eye(4)
    M[:3, :3] = R
    return M


def write_room_bin(path: Path, points: np.ndarray, colors: np.ndarray) -> None:
    n = len(points)
    with open(path, "wb") as f:
        f.write(np.uint32(n).tobytes())
        f.write(points.astype("<f4").tobytes())
        f.write(colors.astype(np.uint8).tobytes())


def write_room_ply(path: Path, points: np.ndarray, colors: np.ndarray) -> None:
    header = ("ply\nformat binary_little_endian 1.0\ncomment Estimated from a video by Depth Anything 3\n"
              f"element vertex {len(points)}\nproperty float x\nproperty float y\nproperty float z\n"
              "property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n")
    rec = np.zeros(len(points), dtype=[("x", "<f4"), ("y", "<f4"), ("z", "<f4"), ("r", "u1"), ("g", "u1"), ("b", "u1")])
    rec["x"], rec["y"], rec["z"] = points[:, 0], points[:, 1], points[:, 2]
    rec["r"], rec["g"], rec["b"] = colors[:, 0], colors[:, 1], colors[:, 2]
    with open(path, "wb") as f:
        f.write(header.encode())
        f.write(rec.tobytes())


def default_max_frames(device: str) -> int:
    """How many frames the model can take at once. The 1.4B-parameter model needs about 8.6 GiB
    plus 0.065 GiB per frame (measured on CUDA at 504 px: 72 frames fit in 16 GB, 84 don't)."""
    import torch

    if device != "cuda":
        return 40
    total = torch.cuda.get_device_properties(0).total_memory / 2**30
    return int(max(16, min(240, (total - 2.5 - 8.6) / 0.065)))


def confidence_levels(conf: np.ndarray, usable: np.ndarray, has_conf: bool) -> np.ndarray:
    """Model confidence -> the capture's 0 (no data) / 1 (medium) / 2 (high), per frame."""
    if not has_conf:
        return np.where(usable, 1, 0).astype(np.uint8)  # no confidence from the model: medium, never high
    vals = conf[usable]
    if vals.size == 0:
        return np.zeros(conf.shape, np.uint8)
    lo, hi = np.percentile(vals, 20), np.percentile(vals, 55)
    return np.where(usable, np.where(conf >= hi, 2, np.where(conf >= lo, 1, 0)), 0).astype(np.uint8)


# ---------- main ----------

def main() -> int | None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video", type=Path)
    ap.add_argument("--title", default="")
    ap.add_argument("--attendees", default="", help="comma-separated names the family gives")
    ap.add_argument("--out", type=Path, default=Path("out"))
    ap.add_argument("--sample-fps", type=float, default=10.0, help="frames per second given to the model")
    ap.add_argument("--max-frames", type=int, default=None,
                    help="cap on model frames (default: what fits in GPU memory; longer videos are sampled more sparsely)")
    ap.add_argument("--median-depth", type=float, default=2.0,
                    help="only for models without metric depth: scale so the typical depth is this many meters")
    ap.add_argument("--model", default=MODEL)
    ap.add_argument("--device", default=None, help="mps, cuda or cpu (default: best available)")
    ap.add_argument("--voxel", type=float, default=0.01, help="room.bin point spacing in meters")
    ap.add_argument("--max-points", type=int, default=2_000_000, help="most room.bin points (bigger scenes get coarser voxels)")
    ap.add_argument("--splat", choices=["train", "none"], default="train",
                    help="room.splat.ply: train a Gaussian splat with gsplat, or none")
    ap.add_argument("--splat-steps", type=int, default=7000)
    ap.add_argument("--splat-max", type=int, default=1_000_000, help="most Gaussians in the splat")
    ap.add_argument("--splat-width", type=int, default=1280, help="training image width")
    ap.add_argument("--holdout", type=int, default=0,
                    help="for evaluation: leave every Nth model frame out of the room and the splat, and list them "
                         "in <out>/capture-<id>.holdout.json")
    ap.add_argument("--import", dest="import_to_guide", action="store_true",
                    help="then import the capture into the guide (node guide/scripts/import.mjs; honors DATA_DIR)")
    args = ap.parse_args()

    import torch
    from depth_anything_3.api import DepthAnything3
    from PIL import Image

    import fusion
    import splat

    src = args.video.expanduser().resolve()
    if not src.exists():
        raise SystemExit(f"No such video: {src}")
    if args.splat == "train":
        try:
            import gsplat  # noqa: F401
        except ImportError:
            raise SystemExit("--splat train needs gsplat (README: 'gsplat'), or pass --splat none.")
    info = probe(src)
    device = args.device or ("cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu")
    dev = torch.device(device)
    cid = str(uuid.uuid4())
    out = (args.out / f"capture-{cid}").resolve()
    out.mkdir(parents=True)
    print(f"[1/8] Transcoding {src.name} ({info['duration']:.1f} s) to H.264…")
    video = out / "video.mp4"
    transcode(src, video, info["has_audio"])
    frame_times, W, H, fps = frame_times_and_size(video)
    frame_count = len(frame_times)
    duration = float(frame_times[-1]) + 1.0 / fps

    # Frames for the model, evenly spaced in time, each snapped to the nearest real frame
    # (frames.jsonl gives those frames `d`). Short clips still get at least 16 views.
    cap = args.max_frames or default_max_frames(device)
    n = max(2, min(cap, frame_count, max(16, int(duration * args.sample_fps) + 1)))
    sample_frames = sorted({int(np.abs(frame_times - t).argmin()) for t in np.linspace(0, frame_times[-1], n)})
    n = len(sample_frames)
    sample_times = [float(frame_times[i]) for i in sample_frames]
    holdout = [k for k in range(n) if args.holdout and k % args.holdout == args.holdout // 2]
    usable = [k for k in range(n) if k not in holdout]
    with tempfile.TemporaryDirectory() as tmp:
        print(f"[2/8] Extracting {n} frames ({n / duration:.1f} per second)…")
        paths = extract_frames(video, sample_frames, Path(tmp))
        full = torch.from_numpy(np.stack([np.asarray(Image.open(p).convert("RGB")) for p in paths]))  # N, H, W, 3

        print(f"[3/8] Depth Anything 3 ({Path(args.model).name}) on {device}…")
        model = DepthAnything3.from_pretrained(args.model).to(device=dev)
        with torch.no_grad():
            pred = model.inference([str(p) for p in paths])
        del model
        if device == "cuda":
            torch.cuda.empty_cache()

    depth_np = np.asarray(pred.depth, dtype=np.float32)            # N, h, w
    has_conf = pred.conf is not None
    conf_np = np.asarray(pred.conf, dtype=np.float32) if has_conf else np.ones_like(depth_np)
    _, h, w = depth_np.shape
    valid_np = np.isfinite(depth_np) & (depth_np > 0)
    conf_np = np.where(valid_np & np.isfinite(conf_np), conf_np, 0).astype(np.float32)
    if not valid_np.any():
        raise SystemExit("Depth Anything 3 returned no usable depth for this video.")
    if pred.is_metric:
        scale = 1.0
    else:  # arbitrary units: scale the typical depth of the more confident pixels to --median-depth
        good = valid_np & (conf_np > np.median(conf_np[valid_np]))
        scale = args.median_depth / float(np.median(depth_np[good if good.any() else valid_np]))
    if not math.isfinite(scale) or scale <= 0:
        raise SystemExit(f"Couldn't scale the depth (scale {scale}); not writing a capture from it.")
    depth_np = np.where(valid_np, depth_np * scale, 0).astype(np.float32)
    poses_np = []
    for k in range(n):
        w2c = np.asarray(pred.extrinsics[k], dtype=np.float64).copy()
        w2c[:3, 3] *= scale
        poses_np.append(to_capture_pose(w2c))
    level = level_world(poses_np)  # turn the world so gravity points down -y, like ARKit
    poses_np = [level @ T for T in poses_np]
    Ks_np = [np.asarray(pred.intrinsics[k], dtype=np.float64) for k in range(n)]
    if not all(np.isfinite(T).all() for T in poses_np) or not all(np.isfinite(K).all() and K[0, 0] > 0 and K[1, 1] > 0 for K in Ks_np):
        raise SystemExit("Depth Anything 3 returned a camera pose or intrinsics that aren't finite; not writing a capture from it.")

    # ---- what may become part of the static room ----
    print("[4/8] Finding people, depth edges and pixels the frames disagree on…")
    depth = torch.from_numpy(depth_np).to(dev)
    conf = torch.from_numpy(conf_np).to(dev)
    poses = torch.from_numpy(np.stack(poses_np)).float().to(dev)
    Ks = torch.from_numpy(np.stack(Ks_np)).float().to(dev)
    valid = torch.from_numpy(valid_np).to(dev)
    moving_full = fusion.moving_masks(full, dev)                     # N, H, W (video resolution)
    moving = fusion.resize_mask(moving_full.to(dev), h, w)
    edges = fusion.depth_edges(depth)
    sky = torch.from_numpy(np.asarray(pred.sky) > 0.5).to(dev) if pred.sky is not None else torch.zeros_like(valid)
    surface = valid & ~edges & ~sky
    # Only the least confident 5% per frame: textureless near surfaces (a white bedsheet) get low
    # confidence yet sound depth. The edge and multi-view checks do the real cleaning.
    floor = torch.stack([torch.quantile(conf[k][surface[k]], 0.05) if surface[k].any() else conf.new_tensor(0) for k in range(n)])
    static = surface & ~moving & (conf >= floor[:, None, None])
    keep = fusion.consistency(depth, static, Ks, poses, usable)
    print(f"      kept {keep[usable].float().mean().item():.0%} of pixels for the room "
          f"(people/pets {moving[usable].float().mean().item():.0%}, edges {edges[usable].float().mean().item():.0%})")

    # ---- room.bin: fuse what the frames agree on, coloured from the full-resolution video ----
    print("[5/8] Fusing the room…")
    up = 2
    colors = fusion.resize_images(full, h * up, w * up).to(dev)
    voxel = args.voxel
    points, cols = fusion.fuse_room(depth, keep, Ks, poses, colors, usable, upsample=up, voxel=voxel)
    while len(points) > args.max_points:  # big scenes: coarser voxels (surface points scale with 1/voxel^2)
        voxel *= max(1.2, math.sqrt(len(points) / args.max_points))
        points, cols = fusion.voxel_downsample(points, cols.float(), voxel)
    if voxel != args.voxel:
        print(f"      a big scene: {voxel * 100:.1f} cm voxels to stay under {args.max_points:,} points")
    del colors
    if len(points) == 0 or not torch.isfinite(points).all():
        raise SystemExit("The fused room has no points or non-finite points; not writing a capture from it.")
    points_np, cols_np = points.cpu().numpy(), cols.cpu().numpy()
    write_room_bin(out / "room.bin", points_np, cols_np)
    write_room_ply(out / "room.ply", points_np, cols_np)

    # ---- room.splat.ply ----
    splat_entry = None
    if args.splat == "train":
        sw = min(args.splat_width, W)
        sh_ = int(round(H * sw / W / 2)) * 2
        print(f"[6/8] Training the splat on {len(usable)} frames at {sw}x{sh_} ({args.splat_steps} steps)…")
        images = fusion.resize_images(full[usable], sh_, sw).round().clamp(0, 255).to(torch.uint8).to(dev)
        masks = fusion.resize_mask(moving_full[usable].to(dev), sh_, sw)
        Ks_train = torch.stack([fusion.scale_K(Ks[k], sw / w, sh_ / h) for k in usable])
        trusted = torch.where(surface & ~moving, depth, torch.zeros_like(depth))[usable]
        g = splat.train(points, cols, images, masks, poses[usable], Ks_train, trusted,
                        steps=args.splat_steps, cap=args.splat_max)
        del images, masks
        source, sh_degree = "trained-from-video", 1
    else:
        print("[6/8] No splat (--splat none).")
    if args.splat != "none":
        splat.write_ply(out / "room.splat.ply", g["means"], g["scales"], g["quats"], g["opacities"], g["sh"],
                        f"Room estimated from a video ({source}); people masked out")
        splat_entry = {"file": "room.splat.ply", "format": "3dgs-ply", "count": int(len(g["means"])),
                       "shDegree": sh_degree, "source": source}

    # ---- depth.bin / confidence.bin on the phone's 256x192 grid (people included, edges removed) ----
    # The web viewer assumes LiDAR's 256x192 for every capture and scales K per axis
    # (fx by 256/videoW, fy by 192/videoH), so any video aspect works on this grid.
    dw, dh = 256, 192
    usable_px = (valid & ~edges & ~sky).cpu().numpy()
    with open(out / "depth.bin", "wb") as fd, open(out / "confidence.bin", "wb") as fc:
        for k in range(n):
            idx_v = np.minimum((np.arange(dh) + 0.5) * h / dh, h - 1).astype(int)
            idx_u = np.minimum((np.arange(dw) + 0.5) * w / dw, w - 1).astype(int)
            d = depth_np[k][np.ix_(idx_v, idx_u)]
            c8 = confidence_levels(conf_np[k], usable_px[k], has_conf)[np.ix_(idx_v, idx_u)]
            mm_f = np.round(d * 1000)
            c8[(mm_f <= 0) | (mm_f > 65535)] = 0  # no depth, or beyond what UInt16 mm can hold
            mm = np.where(c8 > 0, mm_f, 0).astype("<u2")  # low confidence counts as no data
            fd.write(mm.tobytes())
            fc.write(c8.tobytes())

    # ---- frames.jsonl: one line per video frame; poses between samples are interpolated ----
    print("[7/8] Writing the camera path…")
    has_depth = {i: k for k, i in enumerate(sample_frames)}
    Ks_video = [fusion.scale_K(Ks[k], W / w, H / h).cpu().numpy() for k in range(n)]
    with open(out / "frames.jsonl", "w") as f:
        for i in range(frame_count):
            t = float(frame_times[i])
            T = interpolate_pose(poses_np, sample_times, t)
            K = Ks_video[int(np.argmin([abs(t - s) for s in sample_times]))]
            line = {
                "i": i, "t": round(t, 6),
                "T": [float(v) for v in T.T.ravel()],  # column-major
                "K": [float(K[0, 0]), float(K[1, 1]), float(K[0, 2]), float(K[1, 2])],
                "track": "normal", "d": has_depth.get(i), "phase": "moment",
            }
            f.write(json.dumps(line, separators=(",", ":"), allow_nan=False) + "\n")

    # ---- keyframes, thumbnail ----
    print("[8/8] Keyframes and manifest…")
    (out / "keyframes").mkdir()
    for s in range(int(math.floor(duration - 1e-3)) + 1):
        # Seek a little before the end for the last second: a seek past the final frame writes nothing.
        run([FFMPEG, "-v", "error", "-y", "-ss", f"{min(s, max(0.0, duration - 0.3)):.3f}", "-i", str(video), "-frames:v", "1",
             "-vf", "scale='if(gt(iw,ih),1024,-2)':'if(gt(iw,ih),-2,1024)'", "-pix_fmt", "yuvj420p", "-q:v", "3", str(out / f"keyframes/k{s:04d}.jpg")])
    shutil.copy(out / f"keyframes/k{min(2, int(duration - 1e-3)):04d}.jpg", out / "thumb.jpg")

    created = info["created"] or datetime.now(timezone.utc).isoformat()
    keyframe_count = len(list((out / "keyframes").glob("k*.jpg")))
    model_name = Path(args.model).name
    room = {"ply": "room.ply", "bin": "room.bin", "points": int(len(points_np)), "voxelMeters": round(voxel, 4),
            "source": "estimated-from-video"}
    if splat_entry:
        room["splat"] = splat_entry
    manifest = {
        "format": "braindance.capture",
        "version": 1,
        "id": cid,
        "createdAt": created.replace("+00:00", "Z") if created.endswith("+00:00") else created,
        "device": f"video ({model_name})",
        "source": "video",
        "title": args.title,
        "attendees": [a.strip() for a in args.attendees.split(",") if a.strip()],
        "coordinates": "arkit-world-meters-y-up",
        "imageOrientation": "upright",
        "video": {"file": "video.mp4", "width": W, "height": H, "fps": round(fps), "durationSec": round(duration, 3), "frameCount": frame_count},
        "audio": {"inVideo": info["has_audio"], "sampleRate": 48000, "channels": 1},
        "depth": {"file": "depth.bin", "confidenceFile": "confidence.bin", "width": dw, "height": dh, "unit": "mm",
                  "rateHz": round(n / duration, 3), "count": n, "estimated": True, "model": f"Depth Anything 3 ({model_name})",
                  "scale": "metric" if pred.is_metric else "approximate"},
        "mesh": {"present": False},
        "room": room,
        "keyframes": {"dir": "keyframes", "everySec": 1, "count": keyframe_count},
        "phases": {"moment": {"tStart": 0, "tEnd": round(duration, 3)}},
        "warnings": [
            f"Reconstructed from an ordinary video by Depth Anything 3 ({model_name}). "
            "The room, depth, scale and camera path are estimated, not measured."
        ],
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    if holdout:
        (args.out / f"capture-{cid}.holdout.json").write_text(json.dumps({"frames": [sample_frames[k] for k in holdout]}))
    print(f"Done: {out}\n  {len(points_np):,} room points, {n} depth frames, {frame_count} video frames"
          + (f", {splat_entry['count']:,} Gaussians" if splat_entry else "") + "."
          f"\n  Import it (from the repo root): node guide/scripts/import.mjs {out}")
    if args.import_to_guide:
        importer = Path(__file__).resolve().parents[2] / "guide" / "scripts" / "import.mjs"
        sys.stdout.flush()
        return subprocess.run(["node", str(importer), str(out)]).returncode
    return None


if __name__ == "__main__":
    sys.exit(main())
