"""
Reading the source video once (PyAV), and the H.264 copy for the web (one ffmpeg process).

`probe` reads the frame timestamps from the container without decoding (packets the container's
edit list discards are skipped, exactly as the decoder skips them). `decode` then decodes the
video once and hands back only what's needed: the model's frames (resized, upright) and the
keyframes. `Transcode` writes video.mp4 in the background meanwhile, at the same upright size and
with the same frames, which `Transcode.wait` checks.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np

# Fedora's stock ffmpeg-free has no libx264 and no HEVC decoder; point these at a full build.
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
FFPROBE = os.environ.get("FFPROBE", "ffprobe")
MAX_VIDEO_WIDTH = 1920


class ConvertError(Exception):
    """The input can't become a capture (no video stream, undecodable, broken timestamps, model
    output not finite). Retrying won't help; the message is shown to the family."""


@dataclass
class VideoInfo:
    path: Path
    times: np.ndarray        # every frame's presentation time (s), first frame at 0
    width: int               # upright size of video.mp4 (even, at most MAX_VIDEO_WIDTH wide)
    height: int
    rotation: int            # display rotation in degrees (multiple of 90)
    has_audio: bool
    created: str | None      # when it was recorded, ISO 8601, if the file says
    codec: str
    audio_rate: int | None = None

    @property
    def frame_count(self) -> int:
        return len(self.times)

    @property
    def fps(self) -> float:
        return (len(self.times) - 1) / self.times[-1] if len(self.times) > 1 and self.times[-1] > 0 else 30.0

    @property
    def duration(self) -> float:
        return float(self.times[-1]) + 1.0 / self.fps


def output_size(width: int, height: int, rotation: int) -> tuple[int, int]:
    """Upright size of video.mp4: at most 1920 wide, both sides even, aspect kept."""
    if rotation % 180:
        width, height = height, width
    w = min(MAX_VIDEO_WIDTH, width) // 2 * 2
    h = max(2, int(round(height * w / width / 2)) * 2)
    return w, h


def fit_long_side(width: int, height: int, long_side: int) -> tuple[int, int]:
    s = min(1.0, long_side / max(width, height))
    return max(2, int(round(width * s / 2)) * 2), max(2, int(round(height * s / 2)) * 2)


def created_at(tags: dict[str, str]) -> str | None:
    """The recording date: Apple's own tag first (creation_time is often when the file was copied)."""
    for key in ("com.apple.quicktime.creationdate", "creation_time"):
        v = tags.get(key)
        if v:
            return re.sub(r"([+-]\d\d)(\d\d)$", r"\1:\2", v.replace(".000000Z", "Z"))
    return None


def probe(path: Path) -> VideoInfo:
    import av

    try:
        container = av.open(str(path))
    except av.error.FFmpegError as e:
        raise ConvertError(f"Couldn't open the video: {e}") from e
    with container:
        if not container.streams.video:
            raise ConvertError("The file has no video in it.")
        s = container.streams.video[0]
        pts = sorted(p.pts for p in container.demux(s) if p.pts is not None and not p.is_discard)
        if len(pts) < 2 or len(set(pts)) != len(pts):
            raise ConvertError("The video's frame timestamps are missing or repeated; can't line the camera path up with playback.")
        rotation = 0
        container.seek(0)
        for frame in container.decode(s):
            rotation = int(round((frame.rotation or 0) / 90)) * 90
            break
        times = (np.array(pts, np.float64) - pts[0]) * float(s.time_base)
        w, h = output_size(s.codec_context.width, s.codec_context.height, rotation)
        tags = {**container.metadata, **s.metadata}
        return VideoInfo(path=path, times=times, width=w, height=h, rotation=rotation,
                         has_audio=bool(container.streams.audio), created=created_at(tags), codec=s.codec_context.name,
                         audio_rate=container.streams.audio[0].sample_rate if container.streams.audio else None)


@dataclass
class Decoded:
    frames: dict[int, np.ndarray]   # video frame index -> RGB uint8 (h, w, 3) at the work size
    keyframes: list[tuple[int, int]]  # (second, video frame index) for every keyframe written


def keyframe_indices(times: np.ndarray, duration: float) -> list[tuple[int, int]]:
    """One keyframe per whole second of the video: the first frame at or after that second."""
    out = []
    for s in range(int(np.floor(duration - 1e-3)) + 1):
        i = int(np.searchsorted(times, s - 1e-6))
        out.append((s, min(i, len(times) - 1)))
    return out


def decode(info: VideoInfo, wanted: list[int], work_long_side: int, keyframe_dir: Path | None,
           keyframe_long_side: int = 1024, checkpoint: Callable[[], None] = lambda: None) -> Decoded:
    """One decoding pass: the `wanted` frames as RGB at `work_long_side`, and (if `keyframe_dir`)
    keyframes/kNNNN.jpg at `keyframe_long_side`. Frames are counted in presentation order, the
    same numbering frames.jsonl and video.mp4 use."""
    import av
    from PIL import Image

    wanted_set = set(wanted)
    keys = keyframe_indices(info.times, info.duration) if keyframe_dir else []
    key_at: dict[int, list[int]] = {}
    for s, i in keys:
        key_at.setdefault(i, []).append(s)
    k = info.rotation // 90 % 4
    work = fit_long_side(info.width, info.height, work_long_side)
    key_size = fit_long_side(info.width, info.height, keyframe_long_side)
    frames: dict[int, np.ndarray] = {}
    if keyframe_dir:
        keyframe_dir.mkdir(parents=True, exist_ok=True)
    last = max([*wanted_set, *key_at, 0])

    def rgb(frame, size: tuple[int, int]) -> np.ndarray:
        w, h = size if k % 2 == 0 else size[::-1]  # scale before turning upright
        a = frame.to_ndarray(width=w, height=h, format="rgb24", interpolation="AREA")
        return np.ascontiguousarray(np.rot90(a, k)) if k else a

    with av.open(str(info.path)) as container:
        s = container.streams.video[0]
        s.thread_type = "AUTO"
        i = -1
        expected = info.times / float(s.time_base)
        for frame in container.decode(s):
            i += 1
            if i >= len(expected) or frame.pts is None:
                raise ConvertError("The video decoded to more frames than its container lists.")
            if i % 100 == 0:
                checkpoint()
            if i in wanted_set:
                frames[i] = rgb(frame, work)
            for sec in key_at.get(i, []):
                Image.fromarray(rgb(frame, key_size)).save(keyframe_dir / f"k{sec:04d}.jpg", quality=90)
            if i >= last:
                break
    if len(frames) != len(wanted_set):
        raise ConvertError(f"Read {len(frames)} of the {len(wanted_set)} frames the model needs.")
    return Decoded(frames=frames, keyframes=keys)


# ---------- video.mp4 (ffmpeg) ----------

def check_ffmpeg(codec: str) -> None:
    """Fail early if this ffmpeg can't decode the input or encode H.264 with libx264."""
    def out(*args: str) -> str:
        return subprocess.run([FFMPEG, "-hide_banner", *args], capture_output=True, text=True).stdout

    missing = [] if " libx264 " in out("-encoders") else ["the libx264 encoder"]
    if codec and not re.search(rf"^ \S+ {re.escape(codec)}\b", out("-decoders"), re.M):
        missing.append(f"a {codec} decoder")
    if missing:
        raise RuntimeError(f"{FFMPEG} lacks {' and '.join(missing)}. Install a full ffmpeg, or set FFMPEG and "
                           "FFPROBE to one (tools/video2capture/README.md, 'ffmpeg on Linux').")


class Transcode:
    """video.mp4 (H.264 + AAC, upright, `info.width` x `info.height`, every source frame with its
    own timestamp) written by one ffmpeg process running in the background."""

    def __init__(self, info: VideoInfo, dst: Path):
        check_ffmpeg(info.codec)
        self.info, self.dst = info, dst
        cmd = [FFMPEG, "-v", "error", "-y", "-i", str(info.path), "-map", "0:v:0", "-map", "0:a:0?",
               "-vf", f"scale={info.width}:{info.height}", "-fps_mode", "passthrough",
               "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
        cmd += ["-c:a", "aac", "-b:a", "128k", "-ac", "1"] if info.has_audio else ["-an"]
        self.proc = subprocess.Popen(cmd + [str(dst)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    def cancel(self) -> None:
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()

    def wait(self) -> None:
        _, err = self.proc.communicate()
        if self.proc.returncode != 0:
            raise RuntimeError(f"ffmpeg couldn't write video.mp4:\n{err.decode(errors='replace')[-2000:]}")
        got = packet_times(self.dst)
        if len(got) != self.info.frame_count or np.abs(got - self.info.times).max() > 1e-3:
            raise RuntimeError(f"video.mp4 has {len(got)} frames, the source {self.info.frame_count}, or their times "
                               "differ; frames.jsonl wouldn't line up with playback.")


def packet_times(path: Path) -> np.ndarray:
    """Presentation times (s, first at 0) of a video's frames, read from packets (no decoding)."""
    out = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time",
                          "-of", "json", str(path)], capture_output=True, text=True, check=True).stdout
    ts = np.sort(np.array([float(p["pts_time"]) for p in json.loads(out).get("packets", []) if p.get("pts_time") not in (None, "N/A")]))
    return ts - ts[0] if len(ts) else ts
