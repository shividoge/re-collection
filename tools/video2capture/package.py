"""
Writing and reading the capture package files (docs/capture-format.md; depth v2 from
docs/architecture-v3.md §3). numpy only.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

import depthv2
from geometry import interpolate_pose

DEPTH_W, DEPTH_H = 256, 192  # the phone's LiDAR grid; the web scales K per axis, so any aspect works


def write_room_bin(path: Path, points: np.ndarray, colors: np.ndarray) -> None:
    with open(path, "wb") as f:
        f.write(np.uint32(len(points)).tobytes())
        f.write(np.ascontiguousarray(points, dtype="<f4").tobytes())
        f.write(np.ascontiguousarray(colors, dtype=np.uint8).tobytes())


def read_room_bin(path: Path) -> tuple[np.ndarray, np.ndarray]:
    raw = Path(path).read_bytes()
    n = int(np.frombuffer(raw[:4], "<u4")[0])
    pts = np.frombuffer(raw, "<f4", count=n * 3, offset=4).reshape(n, 3)
    cols = np.frombuffer(raw, np.uint8, count=n * 3, offset=4 + n * 12).reshape(n, 3)
    return pts.copy(), cols.copy()


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


def confidence_levels(conf: np.ndarray, usable: np.ndarray, has_conf: bool) -> np.ndarray:
    """Model confidence -> 0 (no data) / 1 (medium) / 2 (high) for one frame. The least confident
    fifth counts as no data; a model without confidence never gets 'high'."""
    if not has_conf:
        return np.where(usable, 1, 0).astype(np.uint8)
    vals = conf[usable]
    if vals.size == 0:
        return np.zeros(conf.shape, np.uint8)
    lo, hi = np.percentile(vals, 20), np.percentile(vals, 55)
    return np.where(usable, np.where(conf >= hi, 2, np.where(conf >= lo, 1, 0)), 0).astype(np.uint8)


def grid_indices(h: int, w: int) -> tuple[np.ndarray, np.ndarray]:
    """Rows and columns of an h x w map nearest to the centres of the 256x192 depth grid."""
    iv = np.minimum((np.arange(DEPTH_H) + 0.5) * h / DEPTH_H, h - 1).astype(int)
    iu = np.minimum((np.arange(DEPTH_W) + 0.5) * w / DEPTH_W, w - 1).astype(int)
    return iv, iu


def depth_grid(depth: np.ndarray, conf: np.ndarray, usable: np.ndarray, has_conf: bool) -> tuple[np.ndarray, np.ndarray]:
    """One model depth map -> (mm UInt16, confidence UInt8) on the 256x192 grid. Nearest
    sampling only: no value is invented between pixels. No data where the pixel isn't usable,
    is low confidence, or is out of range."""
    iv, iu = grid_indices(*depth.shape)
    d = depth[np.ix_(iv, iu)]
    c = confidence_levels(conf, usable, has_conf)[np.ix_(iv, iu)]
    mm = np.round(d * 1000)
    c[(mm <= 0) | (mm > depthv2.MAX_MM)] = 0
    return np.where(c > 0, mm, 0).astype("<u2"), c


def write_depth(out: Path, mm: np.ndarray, conf: np.ndarray, encoding: str) -> dict:
    """(N, 192, 256) frames -> depth files; returns the manifest's file fields."""
    if encoding == "v2":
        bin_, index = depthv2.encode(depthv2.pack(mm, conf))
        (out / "depth.bin").write_bytes(bin_)
        (out / "depth.index.json").write_text(json.dumps(index, separators=(",", ":")))
        return {"file": "depth.bin", "index": "depth.index.json", "encoding": "v2"}
    (out / "depth.bin").write_bytes(np.ascontiguousarray(mm, "<u2").tobytes())
    (out / "confidence.bin").write_bytes(np.ascontiguousarray(conf, np.uint8).tobytes())
    return {"file": "depth.bin", "confidenceFile": "confidence.bin"}


def read_depth(capture: Path, manifest: dict) -> np.ndarray:
    """Depth in millimeters (N, h, w) UInt16 from a v1 or v2 package (0 = no data)."""
    d = manifest["depth"]
    raw = (capture / d["file"]).read_bytes()
    if d.get("encoding") == "v2":
        mm, _ = depthv2.unpack(depthv2.decode_all(raw, json.loads((capture / d["index"]).read_text())))
        return mm
    return np.frombuffer(raw, "<u2").reshape(d["count"], d["height"], d["width"])


def frame_lines(frame_times: np.ndarray, sample_frames: list[int], poses: list[np.ndarray],
                Ks_video: list[np.ndarray]) -> list[str]:
    """frames.jsonl: one line per video frame. Model frames get their own pose and `d`; poses
    between them are interpolated (slerp + lerp), intrinsics are the nearest model frame's."""
    sample_times = [float(frame_times[i]) for i in sample_frames]
    d_of = {i: k for k, i in enumerate(sample_frames)}
    st = np.array(sample_times)
    lines = []
    for i, t in enumerate(map(float, frame_times)):
        k = d_of.get(i)
        T = poses[k] if k is not None else interpolate_pose(poses, sample_times, t)
        j = k if k is not None else int(np.abs(st - t).argmin())
        K = Ks_video[j]
        line = {"i": i, "t": round(t, 6), "T": [float(v) for v in T.T.ravel()],  # column-major
                "K": [float(K[0, 0]), float(K[1, 1]), float(K[0, 2]), float(K[1, 2])],
                "track": "normal", "d": k, "phase": "moment"}
        lines.append(json.dumps(line, separators=(",", ":"), allow_nan=False))
    return lines


def read_frames(path: Path) -> list[dict]:
    return [json.loads(l) for l in Path(path).read_text().splitlines() if l.strip()]


def pose_of(line: dict) -> tuple[np.ndarray, np.ndarray]:
    """A frames.jsonl line -> (camera-to-world 4x4, K 3x3 at video resolution)."""
    T = np.array(line["T"], np.float64).reshape(4, 4).T
    fx, fy, cx, cy = line["K"]
    return T, np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1]], np.float64)
