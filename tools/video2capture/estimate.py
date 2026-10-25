"""
Depth Anything 3 on a video's frames: depth, confidence, camera poses and intrinsics.

`DepthModel` loads the model once and keeps it (the worker reuses it for every job). `estimate`
runs it in one pass when the frames fit in memory, or in overlapping windows chained with a
Sim(3) fit on the frames they share (align.py) when they don't, so a long video keeps the full
10 frames per second instead of being sampled sparsely.

Coordinates: DA3 returns OpenCV-style world-to-camera poses (x right, y down, z forward) in its
own world frame. We convert to the capture convention (ARKit: x right, y up, camera looks down
-z, world y up) by flipping y and z in both the camera and the world frames.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable

import numpy as np

import align
from decode import ConvertError

FLIP = np.diag([1.0, -1.0, -1.0, 1.0])  # OpenCV <-> ARKit axes, for camera and world frames
# Measured with workers/gpu/calibrate.py on 16:9 video (DA3 works at 504x280 = 720 patches): above the resident
# weights a pass peaks at 1.85 GiB + 0.070 GiB per frame on the RTX 5060 Ti (16-80 frames) and
# 1.65 GiB + 0.074 GiB per frame on the GX10 (16-240 frames). The larger of each is used.
GIB_PER_FRAME = 0.074
PASS_CONSTANT_GIB = 1.85
MAX_PASS_FRAMES = 240


def to_capture_pose(w2c: np.ndarray) -> np.ndarray:
    """OpenCV world-to-camera (3x4 or 4x4) -> capture camera-to-world (4x4), y up, looks down -z."""
    m = np.eye(4)
    m[: w2c.shape[0], :4] = w2c[:, :4] if w2c.shape[0] == 3 else w2c
    return FLIP @ np.linalg.inv(m) @ FLIP


CALIBRATION_PATCHES = 720


def patches(width: int, height: int, res: int = 504) -> int:
    """14x14 patches DA3 makes of one frame: long side scaled to `res`, each side rounded to a
    multiple of 14 (its upper_bound_resize)."""
    s = res / max(width, height)
    return max(1, round(width * s / 14)) * max(1, round(height * s / 14))


def frames_that_fit(free_gib: float, margin_gib: float = 0.5, frame_patches: int = CALIBRATION_PATCHES) -> int:
    """Model frames one pass can take with `free_gib` free after the models are loaded. A frame's
    cost grows with its patches: a 4:3 video (504x378) costs 35% more per frame than 16:9."""
    per_frame = GIB_PER_FRAME * frame_patches / CALIBRATION_PATCHES
    return int(max(0, min(MAX_PASS_FRAMES, (free_gib - PASS_CONSTANT_GIB - margin_gib) / per_frame)))


@dataclass
class Estimate:
    depth: np.ndarray      # (N, h, w) float32 meters, 0 = none
    conf: np.ndarray       # (N, h, w) float32, the model's confidence (0 where no depth)
    poses: list[np.ndarray]  # N capture camera-to-world 4x4
    Ks: list[np.ndarray]   # N 3x3 at the depth maps' resolution
    sky: np.ndarray | None  # (N, h, w) bool
    metric: bool
    windows: list[tuple[int, int]]
    align_residuals: list[float]  # median point misfit (m) of each window join


class DepthModel:
    def __init__(self, model: str, device: str):
        import torch
        from depth_anything_3.api import DepthAnything3

        self.name = model.rstrip("/").split("/")[-1]
        self.device = device
        self.torch = torch
        self.model = DepthAnything3.from_pretrained(model).to(device=torch.device(device)).eval()

    def max_frames(self, width: int = 16, height: int = 9) -> int:
        """Frames of this aspect one pass fits in right now, from the free GPU (or unified) memory."""
        if self.device != "cuda":
            return 40
        free, _ = self.torch.cuda.mem_get_info()
        return frames_that_fit(free / 2**30, frame_patches=patches(width, height))

    def offload(self) -> None:
        """Move the weights to the CPU to free GPU memory (for splat training on a small card)."""
        self.model.to("cpu")
        if self.device == "cuda":
            self.torch.cuda.empty_cache()

    def reload(self) -> None:
        self.model.to(self.device)

    def infer(self, images: list[np.ndarray], median_depth: float = 2.0) -> Estimate:
        """One pass. Depth from a model without metric scale is scaled so its typical confident
        depth is `median_depth` meters."""
        torch = self.torch
        with torch.no_grad():
            pred = self.model.inference(images)
        if self.device == "cuda":
            torch.cuda.empty_cache()
        depth = np.asarray(pred.depth, dtype=np.float32)
        conf = np.asarray(pred.conf, dtype=np.float32) if pred.conf is not None else np.ones_like(depth)
        valid = np.isfinite(depth) & (depth > 0)
        if not valid.any():
            raise ConvertError("Depth Anything 3 found no usable depth in this video.")
        conf = np.where(valid & np.isfinite(conf), conf, 0).astype(np.float32)
        if pred.is_metric:
            scale = 1.0
        else:
            good = valid & (conf > np.median(conf[valid]))
            scale = median_depth / float(np.median(depth[good if good.any() else valid]))
        if not math.isfinite(scale) or scale <= 0:
            raise ConvertError(f"Couldn't scale the depth (scale {scale}).")
        depth = np.where(valid, depth * scale, 0).astype(np.float32)
        poses, Ks = [], []
        for k in range(len(depth)):
            w2c = np.asarray(pred.extrinsics[k], dtype=np.float64).copy()
            w2c[:3, 3] *= scale
            poses.append(to_capture_pose(w2c))
            Ks.append(np.asarray(pred.intrinsics[k], dtype=np.float64))
        if not all(np.isfinite(T).all() for T in poses) or not all(np.isfinite(K).all() and K[0, 0] > 0 and K[1, 1] > 0 for K in Ks):
            raise ConvertError("Depth Anything 3 returned a camera pose or intrinsics that aren't finite.")
        sky = (np.asarray(pred.sky) > 0.5) if pred.sky is not None else None
        return Estimate(depth, conf, poses, Ks, sky, bool(pred.is_metric), [(0, len(depth))], [])

    def infer_fine(self, image: np.ndarray, res: int) -> np.ndarray:
        """One frame on its own at `res` (long side): sharper edges and small objects than the
        multi-view pass, but its scale and shape aren't tied to the other frames, so it is only
        used through fusion.transfer_detail. Returns depth (h, w) float32, 0 = none."""
        with self.torch.no_grad():
            pred = self.model.inference([image], process_res=res)
        d = np.asarray(pred.depth[0], dtype=np.float32)
        return np.where(np.isfinite(d) & (d > 0), d, 0).astype(np.float32)


def merge(a: Estimate, b: Estimate, b_start: int, a_end: int, max_residual: float | None = None) -> Estimate:
    """Append window b (covering frames from `b_start`) to the chain a (frames up to `a_end`),
    moving b into a's world with a Sim(3) fit on the shared frames [b_start, a_end). Each shared
    frame keeps the estimate from the window where it sits further from the edge."""
    shared = range(b_start, a_end)
    src, dst, w = [], [], []
    for f in shared:
        ka, kb = f, f - b_start
        valid = (a.conf[ka] > 0) & (b.conf[kb] > 0)
        if a.sky is not None:
            valid &= ~a.sky[ka]
        pb, pa, ww = align.correspondences(a.depth[ka], b.depth[kb], a.conf[ka], b.conf[kb], a.Ks[ka], b.Ks[kb],
                                           a.poses[ka], b.poses[kb], valid)
        src.append(pb), dst.append(pa), w.append(ww)
    src_, dst_, w_ = np.concatenate(src), np.concatenate(dst), np.concatenate(w)
    if len(src_) < 100:
        raise ConvertError("Two stretches of the video share too little depth to line them up.")
    # Metric windows keep their own scale: fitting it at every join lets small errors compound
    # (6 windows drifted 10% in scale against LiDAR); rotation and translation still chain.
    s, R, t, resid = align.robust_sim3(src_, dst_, w_, with_scale=not (a.metric and b.metric))
    if not (math.isfinite(s) and s > 0) or (max_residual is not None and resid > max_residual):
        raise ConvertError(f"Couldn't line up two stretches of the video (misfit {resid:.3f} m).")
    poses_b = [align.apply_sim3_to_pose(s, R, t, T) for T in b.poses]
    depth_b = b.depth * np.float32(s)
    cut = (b_start + a_end) // 2  # shared frames before the middle of the overlap keep a's estimate
    nb = cut - b_start
    keep_a = slice(0, cut)
    sky = None if a.sky is None or b.sky is None else np.concatenate([a.sky[keep_a], b.sky[nb:]])
    return Estimate(
        depth=np.concatenate([a.depth[keep_a], depth_b[nb:]]),
        conf=np.concatenate([a.conf[keep_a], b.conf[nb:]]),
        poses=a.poses[:cut] + poses_b[nb:],
        Ks=a.Ks[:cut] + b.Ks[nb:],
        sky=sky, metric=a.metric and b.metric,
        windows=a.windows + b.windows,
        align_residuals=a.align_residuals + [resid],
    )


def estimate(model: DepthModel, images: list[np.ndarray], window: int, overlap: int | None = None,
             progress: Callable[[float, str], None] = lambda f, m: None,
             checkpoint: Callable[[], None] = lambda: None, median_depth: float = 2.0) -> Estimate:
    """All frames, in one pass if they fit in `window`, else in overlapping windows."""
    n = len(images)
    overlap = overlap if overlap is not None else max(8, window // 4)
    spans = align.plan_windows(n, window, overlap)
    out: Estimate | None = None
    for j, (s, e) in enumerate(spans):
        checkpoint()
        progress(j / len(spans), f"Depth Anything 3 on frames {s + 1}–{e} of {n}" if len(spans) > 1 else f"Depth Anything 3 on {n} frames")
        est = model.infer(images[s:e], median_depth)
        est.windows = [(s, e)]
        if out is None:
            out = est
        else:
            out = merge(out, est, s, spans[j - 1][1])
    assert out is not None and len(out.depth) == n
    return out
