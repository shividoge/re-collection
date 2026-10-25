"""
Video -> capture package, as stages the CLI (video2capture.py) and the GPU worker
(workers/gpu) share. `Converter` loads Depth Anything 3 and Mask R-CNN once and converts any
number of videos with them.

Stages: read (one decode pass; video.mp4 is transcoded in the background meanwhile) -> depth
(DA3, one pass or overlapping windows) -> people (Mask R-CNN) -> clean (depth edges, multi-view
check) -> fuse (room.bin) -> write (depth, frames.jsonl, manifest). The splat is separate
(splat.train_from_package), so the points capture is ready first.
"""

from __future__ import annotations

import json
import shutil
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import numpy as np

import align
import decode
import estimate
import package
from decode import ConvertError
from geometry import leveling

Progress = Callable[[str, float | None, str], None]


@dataclass
class Options:
    sample_fps: float = 10.0       # model frames per second of video
    voxel: float = 0.005           # room.bin spacing (m)
    max_points: int = 6_000_000    # bigger scenes get coarser voxels
    detail_res: int = 1008         # single-frame depth at this long side for fine detail (0 = multi-view depth only)
    depth_encoding: str = "v2"     # "v2" (architecture v3) or "v1" (depth.bin + confidence.bin, for the guide)
    write_ply: bool = False        # room.ply as well (v1 packages)
    window: int | None = None      # frames per model pass (default: what fits in memory now)
    overlap: int | None = None     # frames shared by consecutive windows (default: a quarter, at least 8)
    work_long_side: int = 1008     # size the model frames are decoded at (DA3 works at 504)
    median_depth: float = 2.0      # only for models without metric depth
    holdout: int = 0               # evaluation: leave every Nth model frame out of the room
    holdout_frames: list[int] | None = None  # evaluation: leave exactly these video frames out


@dataclass
class Result:
    manifest: dict
    sample_frames: list[int]
    holdout_frames: list[int]
    timings: dict[str, float] = field(default_factory=dict)


def sample_count(frame_count: int, duration: float, sample_fps: float = 10.0) -> int:
    """Model frames for a video: `sample_fps` per second, at least 16, at most one per frame.
    This is also the job's frame need for routing (capped at estimate.MAX_PASS_FRAMES)."""
    return max(2, min(frame_count, max(16, int(duration * sample_fps) + 1)))


def frames_needed(duration_sec: float, fps: float = 30.0) -> int:
    """`needs.frames` for a convert job from the video's length (docs/architecture-v3.md §7):
    model frames in one pass, so a worker that fits that many runs it without windows."""
    return min(estimate.MAX_PASS_FRAMES, sample_count(max(2, int(duration_sec * fps)), duration_sec))


def choose_samples(times: np.ndarray, n: int) -> list[int]:
    """n frames evenly spaced in time, each the nearest real frame."""
    return sorted({int(np.abs(times - t).argmin()) for t in np.linspace(0, times[-1], n)})


class Converter:
    def __init__(self, model: str, device: str):
        import torch

        import fusion

        self.device = device
        self.dev = torch.device(device)
        self.depth_model = estimate.DepthModel(model, device)
        self.masks = fusion.MaskModel(self.dev)

    def convert(self, src: Path, out: Path, *, capture_id: str | None = None, title: str = "",
                attendees: list[str] | None = None, opts: Options | None = None,
                progress: Progress = lambda s, f, m: None, checkpoint: Callable[[], None] = lambda: None,
                log: Callable[[str], None] = print) -> Result:
        import torch

        import fusion

        opts = opts or Options()
        cid = capture_id or str(uuid.uuid4())
        uuid.UUID(cid)
        out.mkdir(parents=True, exist_ok=True)
        timings: dict[str, float] = {}
        clock = time.perf_counter()

        def lap(name: str) -> None:
            nonlocal clock
            if self.device == "cuda":
                torch.cuda.synchronize()
            now = time.perf_counter()
            timings[name] = round(timings.get(name, 0) + now - clock, 2)
            clock = now

        # ---- read: one decode pass; video.mp4 in the background ----
        progress("read", None, "Reading the video")
        info = decode.probe(src)
        transcode = decode.Transcode(info, out / "video.mp4")
        try:
            n = sample_count(info.frame_count, info.duration, opts.sample_fps)
            sample_frames = choose_samples(info.times, n)
            if opts.holdout_frames:
                sample_frames = sorted(set(sample_frames) | set(opts.holdout_frames))
            n = len(sample_frames)
            if opts.holdout_frames:
                holdout = [k for k, i in enumerate(sample_frames) if i in set(opts.holdout_frames)]
            else:
                holdout = [k for k in range(n) if opts.holdout and k % opts.holdout == opts.holdout // 2]
            usable = [k for k in range(n) if k not in set(holdout)]
            log(f"  {info.duration:.1f} s, {info.frame_count} frames; {n} model frames ({n / info.duration:.1f} per second)")
            dec = decode.decode(info, sample_frames, max(opts.work_long_side, opts.detail_res), out / "keyframes",
                                checkpoint=checkpoint)
            images = [dec.frames[i] for i in sample_frames]
            lap("read")

            # ---- depth ----
            window = opts.window or self.depth_model.max_frames(info.width, info.height)
            if window < 16:
                raise RuntimeError(f"Only {window} frames fit in GPU memory right now; is something else using the GPU?")
            est = self.run_depth(images, window, opts, progress, checkpoint, log)
            lap("depth")
            poses_np = est.poses
            level, level_warning = leveling(poses_np)  # turn the world so gravity points down -y, like ARKit
            if level_warning:
                log(f"  {level_warning}")
            poses_np = [level @ T for T in poses_np]
            if opts.detail_res:
                est = self.add_detail(est, images, opts.detail_res, progress, checkpoint)
                lap("detail")
            _, h, w = est.depth.shape

            # ---- people and pets ----
            checkpoint()
            progress("people", None, "Finding people and pets")
            full = torch.from_numpy(np.stack(images))
            moving = fusion.resize_mask(self.masks(full).to(self.dev), h, w)
            lap("people")

            # ---- clean: what may become part of the static room ----
            checkpoint()
            progress("clean", None, "Checking which pixels the frames agree on")
            dev = self.dev
            depth = torch.from_numpy(est.depth).to(dev)
            conf = torch.from_numpy(est.conf).to(dev)
            poses = torch.from_numpy(np.stack(poses_np)).float().to(dev)
            Ks = torch.from_numpy(np.stack(est.Ks)).float().to(dev)
            valid = depth > 0
            edges = fusion.depth_edges(depth)
            sky = torch.from_numpy(est.sky).to(dev) if est.sky is not None else torch.zeros_like(valid)
            surface = valid & ~edges & ~sky
            # Only the least confident 5% per frame: textureless near surfaces (a white bedsheet) get
            # low confidence yet sound depth. The edge and multi-view checks do the real cleaning.
            floor = torch.stack([torch.quantile(conf[k][surface[k]].float(), 0.05) if surface[k].any() else conf.new_tensor(0)
                                 for k in range(n)])
            static = surface & ~moving & (conf >= floor[:, None, None])
            keep = fusion.consistency(depth, static, Ks, poses, usable)
            log(f"  kept {keep[usable].float().mean().item():.0%} of pixels for the room (people/pets "
                f"{moving[usable].float().mean().item():.0%}, edges {edges[usable].float().mean().item():.0%})")
            lap("clean")

            # ---- fuse: room.bin ----
            checkpoint()
            progress("fuse", None, "Building the room")
            colors = lambda k: fusion.resize_images(full[k:k + 1], h, w)[0].to(dev)  # noqa: E731
            # Bigger scenes end at coarser voxels: the grid grows them whenever it passes max_points.
            points, cols, _, voxel = fusion.fuse_room(depth, keep, Ks, poses, colors, usable, opts.voxel, weights=conf,
                                                      limit=opts.max_points)
            if len(points) == 0 or not torch.isfinite(points).all():
                raise ConvertError("The room came out empty or with non-finite points.")
            points_np, cols_np = points.cpu().numpy(), cols.cpu().numpy()
            package.write_room_bin(out / "room.bin", points_np, cols_np)
            if opts.write_ply:
                package.write_room_ply(out / "room.ply", points_np, cols_np)
            lap("fuse")

            # ---- write: depth for the people replay, frames.jsonl, thumb, manifest ----
            checkpoint()
            progress("write", None, "Writing the capture")
            usable_px = (valid & ~edges & ~sky).cpu().numpy()
            has_conf = bool((est.conf > 0).any())
            grids = [package.depth_grid(est.depth[k], est.conf[k], usable_px[k], has_conf) for k in range(n)]
            depth_files = package.write_depth(out, np.stack([g[0] for g in grids]), np.stack([g[1] for g in grids]),
                                              opts.depth_encoding)
            Ks_video = [fusion.scale_K(Ks[k], info.width / w, info.height / h).cpu().numpy() for k in range(n)]
            (out / "frames.jsonl").write_text("\n".join(package.frame_lines(info.times, sample_frames, poses_np, Ks_video)) + "\n")
            keyframe_count = len(dec.keyframes)
            shutil.copy(out / f"keyframes/k{min(2, keyframe_count - 1):04d}.jpg", out / "thumb.jpg")
            lap("write")
            progress("write", None, "Finishing video.mp4")
            transcode.wait()
            lap("transcode wait")
        except BaseException:
            transcode.cancel()
            raise

        model_name = self.depth_model.name
        warnings = [f"Reconstructed from an ordinary video by Depth Anything 3 ({model_name}). "
                    "The room, depth, scale and camera path are estimated, not measured."]
        if level_warning:
            warnings.append(level_warning)
        if len(est.windows) > 1:
            warnings.append(f"A long video: estimated in {len(est.windows)} overlapping stretches lined up with each other.")
        room = {"bin": "room.bin", "points": int(len(points_np)), "voxelMeters": round(voxel, 4), "source": "estimated-from-video"}
        if opts.write_ply:
            room = {"ply": "room.ply", **room}
        manifest = {
            "format": "braindance.capture",
            "version": 1,
            "id": cid,
            "createdAt": info.created or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "device": f"video ({model_name})",
            "source": "video",
            "title": title,
            "attendees": attendees or [],
            "coordinates": "arkit-world-meters-y-up",
            "imageOrientation": "upright",
            "video": {"file": "video.mp4", "width": info.width, "height": info.height, "fps": round(info.fps),
                      "durationSec": round(info.duration, 3), "frameCount": info.frame_count},
            "audio": {"inVideo": info.has_audio, "sampleRate": info.audio_rate or 48000, "channels": 1},
            "depth": {**depth_files, "width": package.DEPTH_W, "height": package.DEPTH_H, "unit": "mm",
                      "rateHz": round(n / info.duration, 3), "count": n, "estimated": True,
                      "model": f"Depth Anything 3 ({model_name})", "scale": "metric" if est.metric else "approximate"},
            "mesh": {"present": False},
            "room": room,
            "keyframes": {"dir": "keyframes", "everySec": 1, "count": keyframe_count},
            "phases": {"moment": {"tStart": 0, "tEnd": round(info.duration, 3)}},
            "warnings": warnings,
        }
        (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
        log(f"  {len(points_np):,} room points, {n} depth frames, {info.frame_count} video frames; " +
            ", ".join(f"{k} {v:.1f} s" for k, v in timings.items()))
        return Result(manifest, sample_frames, [sample_frames[k] for k in holdout], timings)

    def add_detail(self, est: estimate.Estimate, images: list[np.ndarray], res: int, progress: Progress,
                   checkpoint: Callable[[], None]) -> estimate.Estimate:
        """The multi-view estimate at the single-frame pass's resolution: each frame's sharp
        single-frame depth, shaped like the multi-view depth (fusion.transfer_detail). Confidence
        and sky are carried over (nearest), intrinsics rescaled."""
        import torch
        import torch.nn.functional as F

        import fusion

        n, h, w = est.depth.shape
        depth, H, W = [], 0, 0
        for k in range(n):
            checkpoint()
            if k % 10 == 0:
                progress("detail", k / n, f"Sharpening depth, frame {k + 1} of {n}")
            fine = torch.from_numpy(self.depth_model.infer_fine(images[k], res)).to(self.dev)
            H, W = fine.shape
            coarse = torch.from_numpy(est.depth[k]).to(self.dev)
            depth.append(fusion.transfer_detail(coarse, coarse > 0, fine).cpu().numpy())
        if self.device == "cuda":
            torch.cuda.empty_cache()
        def up(x: np.ndarray) -> np.ndarray:
            return F.interpolate(torch.from_numpy(x.astype(np.float32))[:, None], size=(H, W), mode="nearest")[:, 0].numpy()
        Ks = [fusion.scale_K(torch.from_numpy(K).float(), W / w, H / h).double().numpy() for K in est.Ks]
        return estimate.Estimate(depth=np.stack(depth), conf=up(est.conf), poses=est.poses, Ks=Ks,
                                 sky=None if est.sky is None else up(est.sky) > 0.5, metric=est.metric,
                                 windows=est.windows, align_residuals=est.align_residuals)

    def run_depth(self, images: list[np.ndarray], window: int, opts: Options, progress: Progress,
                  checkpoint: Callable[[], None], log: Callable[[str], None]) -> estimate.Estimate:
        """DA3 on every frame; on CUDA out-of-memory (something else took GPU memory), once more
        with windows a third smaller."""
        import torch

        def run(win: int) -> estimate.Estimate:
            spans = len(align.plan_windows(len(images), win, opts.overlap or max(8, win // 4)))
            log(f"  Depth Anything 3: {len(images)} frames" + (f" in {spans} windows of {win}" if spans > 1 else " in one pass"))
            return estimate.estimate(self.depth_model, images, win, opts.overlap,
                                     progress=lambda f, m: progress("depth", f, m), checkpoint=checkpoint,
                                     median_depth=opts.median_depth)

        try:
            return_value: estimate.Estimate | None = run(window)
        except torch.OutOfMemoryError:
            return_value = None  # retry outside this block: the exception's traceback pins the failed pass's tensors
        if return_value is None:
            torch.cuda.empty_cache()
            smaller = max(16, window * 2 // 3)
            log(f"  out of GPU memory with {window} frames per pass; retrying with {smaller}")
            return_value = run(smaller)
        est = return_value
        if len(est.windows) > 1:
            log("  window joins: median misfit " + ", ".join(f"{r * 100:.1f} cm" for r in est.align_residuals))
        return est
