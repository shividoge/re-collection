"""
Turn an ordinary video (no LiDAR) into a Braindance capture package, so an old family video can
be revisited in 3D like a phone scan: room cloud, camera path, per-frame depth for the people
replay, keyframes and the original sound.

Depth Anything 3 (DA3-BASE, Apache-2.0) estimates each sampled frame's camera pose, intrinsics
and depth. Everything it produces is an ESTIMATE, not a measurement: scale is approximate, and
anything the camera never saw stays empty. The manifest says so (`"source": "video"`,
`"depth": {"estimated": true, ...}`) and the web app labels these scenes.

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
from PIL import Image

# PyTorch and pycolmap (imported by DA3) each bring an OpenMP runtime on macOS; without this the
# process aborts at import. Both only use it for CPU threading here.
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

# A local copy (models/DA3-BASE: config.json + model.safetensors from the Hugging Face repo)
# is used when present; Hugging Face's own downloader can stall on large files.
_LOCAL = Path(__file__).resolve().parent / "models" / "DA3-BASE"
MODEL = str(_LOCAL) if (_LOCAL / "model.safetensors").exists() else "depth-anything/DA3-BASE"
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
    """H.264 + AAC mp4, upright (ffmpeg applies rotation metadata), at most 1920 wide, even sizes."""
    cmd = [FFMPEG, "-v", "error", "-y", "-i", str(src),
           "-vf", "scale='min(1920,iw)':-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
           "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
    cmd += ["-c:a", "aac", "-b:a", "128k", "-ac", "1"] if has_audio else ["-an"]
    run(cmd + [str(dst)])


def frame_count_and_size(path: Path) -> tuple[int, int, int, float]:
    out = run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-count_frames",
               "-show_entries", "stream=nb_read_frames,width,height,avg_frame_rate", "-of", "json", str(path)])
    s = json.loads(out)["streams"][0]
    num, den = (int(x) for x in s["avg_frame_rate"].split("/"))
    return int(s["nb_read_frames"]), int(s["width"]), int(s["height"]), num / den


def extract_frames(video: Path, times: list[float], folder: Path, width: int | None = None) -> list[Path]:
    paths = []
    for k, t in enumerate(times):
        p = folder / f"f{k:04d}.jpg"
        vf = ["-vf", f"scale={width}:-2"] if width else []
        # Some phone videos end a little before their stated duration; step back until a frame comes out.
        for back in (0.0, 0.25, 0.5, 1.0):
            run([FFMPEG, "-v", "error", "-y", "-ss", f"{max(0.0, t - back):.3f}", "-i", str(video), "-frames:v", "1",
                 *vf, "-pix_fmt", "yuvj420p", "-q:v", "2", str(p)])
            if p.exists():
                break
        else:
            raise SystemExit(f"Couldn't read a frame near {t:.2f}s from {video}")
        paths.append(p)
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


def unproject(depth: np.ndarray, K: np.ndarray, c2w: np.ndarray, stride: int) -> tuple[np.ndarray, np.ndarray]:
    """Depth pixels -> world points (capture convention). Returns (points Nx3, (v,u) indices)."""
    h, w = depth.shape
    vs, us = np.mgrid[0:h:stride, 0:w:stride]
    d = depth[vs, us]
    x = (us - K[0, 2]) * d / K[0, 0]
    y = (vs - K[1, 2]) * d / K[1, 1]
    cam = np.stack([x, -y, -d, np.ones_like(d)], axis=-1).reshape(-1, 4)  # ARKit camera space
    world = (c2w @ cam.T).T[:, :3]
    return world, np.stack([vs.ravel(), us.ravel()], axis=-1)


def voxel_downsample(points: np.ndarray, colors: np.ndarray, voxel: float) -> tuple[np.ndarray, np.ndarray]:
    keys = np.floor(points / voxel).astype(np.int64)
    _, inverse, counts = np.unique(keys, axis=0, return_inverse=True, return_counts=True)
    inverse = inverse.ravel()
    sums = np.zeros((counts.size, 3))
    np.add.at(sums, inverse, points)
    csum = np.zeros((counts.size, 3))
    np.add.at(csum, inverse, colors.astype(np.float64))
    return (sums / counts[:, None]).astype(np.float32), np.clip(np.round(csum / counts[:, None]), 0, 255).astype(np.uint8)


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


# ---------- main ----------

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video", type=Path)
    ap.add_argument("--title", default="")
    ap.add_argument("--attendees", default="", help="comma-separated names the family gives")
    ap.add_argument("--out", type=Path, default=Path("out"))
    ap.add_argument("--sample-fps", type=float, default=2.0, help="frames per second given to the model")
    ap.add_argument("--max-frames", type=int, default=40, help="cap on model frames (memory)")
    ap.add_argument("--median-depth", type=float, default=2.0,
                    help="the model's depth has no true scale; scale it so the typical depth is this many meters")
    ap.add_argument("--model", default=MODEL)
    ap.add_argument("--device", default=None, help="mps, cuda or cpu (default: best available)")
    ap.add_argument("--import", dest="import_to_guide", action="store_true",
                    help="then import the capture into the guide (node guide/scripts/import.mjs; honors DATA_DIR)")
    args = ap.parse_args()

    import torch
    from depth_anything_3.api import DepthAnything3

    src = args.video.expanduser().resolve()
    if not src.exists():
        raise SystemExit(f"No such video: {src}")
    info = probe(src)
    cid = str(uuid.uuid4())
    out = (args.out / f"capture-{cid}").resolve()
    out.mkdir(parents=True)
    print(f"[1/6] Transcoding {src.name} ({info['duration']:.1f} s) to H.264…")
    video = out / "video.mp4"
    transcode(src, video, info["has_audio"])
    frame_count, W, H, fps = frame_count_and_size(video)
    duration = frame_count / fps

    # Frames for the model, evenly spaced, at most --max-frames.
    # Short clips still get enough views to reconstruct from (at least 16, never more than exist).
    n = max(2, min(args.max_frames, frame_count, max(16, int(duration * args.sample_fps) + 1)))
    sample_times = list(np.linspace(0, max(0.0, duration - 1.0 / fps), n))
    with tempfile.TemporaryDirectory() as tmp:
        print(f"[2/6] Extracting {n} frames…")
        paths = extract_frames(video, sample_times, Path(tmp))

        device = args.device or ("cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu")
        print(f"[3/6] Depth Anything 3 ({args.model}) on {device}…")
        model = DepthAnything3.from_pretrained(args.model).to(device=torch.device(device))
        with torch.no_grad():
            pred = model.inference([str(p) for p in paths])

    depth = np.asarray(pred.depth, dtype=np.float32)            # N, h, w
    conf = np.asarray(pred.conf, dtype=np.float32) if pred.conf is not None else np.ones_like(depth)
    images = np.asarray(pred.processed_images)                   # N, h, w, 3
    _, h, w = depth.shape
    # Scale: the model's units are arbitrary unless it reports metric depth.
    good = conf > np.median(conf)
    scale = 1.0 if pred.is_metric else args.median_depth / float(np.median(depth[good]))
    depth *= scale
    poses = []
    for k in range(n):
        w2c = np.asarray(pred.extrinsics[k], dtype=np.float64).copy()
        w2c[:3, 3] *= scale
        poses.append(to_capture_pose(w2c))
    Ks = [np.asarray(pred.intrinsics[k], dtype=np.float64) for k in range(n)]

    # ---- room.bin: fuse the confident pixels of every frame ----
    print("[4/6] Fusing the room…")
    pts, cols = [], []
    for k in range(n):
        keep_mask = (conf[k] >= np.percentile(conf[k], 40)) & (depth[k] > 0)
        world, idx = unproject(depth[k], Ks[k], poses[k], stride=2)
        m = keep_mask[idx[:, 0], idx[:, 1]]
        pts.append(world[m])
        cols.append(images[k][idx[m, 0], idx[m, 1]])
    points = np.concatenate(pts)
    colors = np.concatenate(cols)
    points, colors = voxel_downsample(points, colors, voxel=0.015)
    write_room_bin(out / "room.bin", points, colors)
    write_room_ply(out / "room.ply", points, colors)

    # ---- depth.bin / confidence.bin on the phone's 256x192 grid ----
    # The web viewer assumes LiDAR's 256x192 for every capture and scales K per axis
    # (fx by 256/videoW, fy by 192/videoH), so any video aspect works on this grid.
    dw, dh = 256, 192
    with open(out / "depth.bin", "wb") as fd, open(out / "confidence.bin", "wb") as fc:
        for k in range(n):
            d = np.asarray(Image.fromarray(depth[k]).resize((dw, dh), Image.NEAREST))
            c = np.asarray(Image.fromarray(conf[k]).resize((dw, dh), Image.NEAREST))
            lo, hi = np.percentile(c, 30), np.percentile(c, 60)
            c8 = np.where(c >= hi, 2, np.where(c >= lo, 1, 0)).astype(np.uint8)
            mm = np.clip(np.round(d * 1000), 0, 65535).astype("<u2")
            mm[c8 == 0] = 0  # low confidence counts as no data
            fd.write(mm.tobytes())
            fc.write(c8.tobytes())

    # ---- frames.jsonl: one line per video frame; poses between samples are interpolated ----
    print("[5/6] Writing the camera path…")
    sx, sy = W / w, H / h
    nearest = {int(round(t * fps)): k for k, t in enumerate(sample_times)}
    with open(out / "frames.jsonl", "w") as f:
        for i in range(frame_count):
            t = i / fps
            T = interpolate_pose(poses, sample_times, t)
            k = int(np.argmin([abs(t - s) for s in sample_times]))
            K = Ks[k]
            line = {
                "i": i, "t": round(t, 6),
                "T": [float(v) for v in T.T.ravel()],  # column-major
                "K": [float(K[0, 0] * sx), float(K[1, 1] * sy), float(K[0, 2] * sx), float(K[1, 2] * sy)],
                "track": "normal", "d": nearest.get(i), "phase": "moment",
            }
            f.write(json.dumps(line, separators=(",", ":")) + "\n")

    # ---- keyframes, thumbnail ----
    print("[6/6] Keyframes and manifest…")
    (out / "keyframes").mkdir()
    for s in range(int(math.floor(duration - 1e-3)) + 1):
        # Seek a little before the end for the last second: a seek past the final frame writes nothing.
        run([FFMPEG, "-v", "error", "-y", "-ss", f"{min(s, max(0.0, duration - 0.3)):.3f}", "-i", str(video), "-frames:v", "1",
             "-vf", "scale='if(gt(iw,ih),1024,-2)':'if(gt(iw,ih),-2,1024)'", "-pix_fmt", "yuvj420p", "-q:v", "3", str(out / f"keyframes/k{s:04d}.jpg")])
    shutil.copy(out / f"keyframes/k{min(2, int(duration - 1e-3)):04d}.jpg", out / "thumb.jpg")

    created = info["created"] or datetime.now(timezone.utc).isoformat()
    keyframe_count = len(list((out / "keyframes").glob("k*.jpg")))
    manifest = {
        "format": "braindance.capture",
        "version": 1,
        "id": cid,
        "createdAt": created.replace("+00:00", "Z") if created.endswith("+00:00") else created,
        "device": f"video ({Path(args.model).name})",
        "source": "video",
        "title": args.title,
        "attendees": [a.strip() for a in args.attendees.split(",") if a.strip()],
        "coordinates": "arkit-world-meters-y-up",
        "imageOrientation": "upright",
        "video": {"file": "video.mp4", "width": W, "height": H, "fps": round(fps), "durationSec": round(duration, 3), "frameCount": frame_count},
        "audio": {"inVideo": info["has_audio"], "sampleRate": 48000, "channels": 1},
        "depth": {"file": "depth.bin", "confidenceFile": "confidence.bin", "width": dw, "height": dh, "unit": "mm",
                  "rateHz": round(n / duration, 3), "count": n, "estimated": True, "model": f"Depth Anything 3 ({Path(args.model).name})",
                  "scale": "approximate" if not pred.is_metric else "metric"},
        "mesh": {"present": False},
        "room": {"ply": "room.ply", "bin": "room.bin", "points": int(len(points)), "voxelMeters": 0.015, "source": "estimated-from-video"},
        "keyframes": {"dir": "keyframes", "everySec": 1, "count": keyframe_count},
        "phases": {"moment": {"tStart": 0, "tEnd": round(duration, 3)}},
        "warnings": [
            f"Reconstructed from an ordinary video by Depth Anything 3 ({Path(args.model).name}). "
            "The room, depth, scale and camera path are estimated, not measured."
        ],
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"Done: {out}\n  {len(points):,} room points, {n} depth frames, {frame_count} video frames.\n"
          f"  Import it (from the repo root): node guide/scripts/import.mjs {out}")
    if args.import_to_guide:
        importer = Path(__file__).resolve().parents[2] / "guide" / "scripts" / "import.mjs"
        sys.stdout.flush()
        return subprocess.run(["node", str(importer), str(out)]).returncode


if __name__ == "__main__":
    sys.exit(main())
