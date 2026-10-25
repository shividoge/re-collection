"""
Reading the source video once (PyAV), and the H.264 copy for the web (one ffmpeg process).

`probe` reads the frame timestamps from the container without decoding (packets the container's
edit list discards are skipped, exactly as the decoder skips them). `decode` then decodes the
video once and hands back only what's needed: the model's frames (resized, upright) and the
keyframes. `Transcode` writes video.mp4 in the background meanwhile, at the same upright size and
with the same frames, which `Transcode.wait` checks.

Upright: the video's display matrix (a quarter-turn and/or a mirror) is read once into an
`Orientation`, which both paths apply the same way: numpy here, explicit ffmpeg filters for
video.mp4 (with ffmpeg's own autorotation off, so ffmpeg versions can't disagree). Time zero: the
first video frame is t 0 in frames.jsonl and in video.mp4 (audio before it is cut).
"""

from __future__ import annotations

import json
import math
import os
import re
import struct
import subprocess
from dataclasses import dataclass, replace
from fractions import Fraction
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


@dataclass(frozen=True)
class Orientation:
    """How to turn a decoded frame upright, from the display matrix: transpose (swap x and y)
    first, then flip rows (upside down) and/or columns (mirror)."""

    transpose: bool = False
    flip_rows: bool = False
    flip_cols: bool = False

    @staticmethod
    def from_matrix(m: tuple[int, ...] | None) -> "Orientation":
        """From FFmpeg's display matrix (9 int32: a b u / c d v / x y w, a-d in 16.16). It maps a
        stored pixel (x, y) to the displayed (a·x + c·y, b·x + d·y), y down. Only quarter-turns and
        mirrors are supported; anything else (a free angle, a scale, a perspective) is refused."""
        if m is None:
            return Orientation()
        a, b, c, d = (v / 65536 for v in (m[0], m[1], m[3], m[4]))
        unit = all(abs(v - round(v)) < 1e-3 and abs(round(v)) <= 1 for v in (a, b, c, d))
        a, b, c, d = (round(v) for v in (a, b, c, d))
        if unit and m[2] == 0 and m[5] == 0 and b == c == 0 and a and d:
            return Orientation(False, d < 0, a < 0)
        if unit and m[2] == 0 and m[5] == 0 and a == d == 0 and b and c:
            return Orientation(True, b < 0, c < 0)
        raise ConvertError(f"The video's display matrix {list(m)} isn't a quarter-turn or a mirror, so it can't "
                           "be shown upright reliably.")

    def apply(self, a: np.ndarray) -> np.ndarray:
        """A decoded frame (h, w, ...) -> upright."""
        if self.transpose:
            a = a.swapaxes(0, 1)
        if self.flip_rows:
            a = a[::-1]
        if self.flip_cols:
            a = a[:, ::-1]
        return np.ascontiguousarray(a) if self != Orientation() else a

    def turned(self, quarter_turns: int) -> "Orientation":
        """This orientation followed by `quarter_turns` turns counter-clockwise (np.rot90's k)."""
        probe = np.arange(6).reshape(2, 3)
        want = np.rot90(self.apply(probe), quarter_turns % 4)
        for t in (False, True):
            for r in (False, True):
                for c in (False, True):
                    o = Orientation(t, r, c)
                    got = o.apply(probe)
                    if got.shape == want.shape and (got == want).all():
                        return o
        raise AssertionError("every quarter turn of a quarter turn or mirror is one")

    def ffmpeg_filters(self) -> list[str]:
        """The same transform as ffmpeg filters (ffmpeg's transpose=cclock_flip is a plain transpose)."""
        return ((["transpose=cclock_flip"] if self.transpose else []) + (["vflip"] if self.flip_rows else [])
                + (["hflip"] if self.flip_cols else []))


def display_matrix(frame) -> tuple[int, ...] | None:
    """The DISPLAYMATRIX side data of a decoded PyAV frame, as 9 int32, if it has one."""
    for key in frame.side_data.keys():
        if getattr(key, "name", "") == "DISPLAYMATRIX":
            raw = bytes(frame.side_data[key])
            if len(raw) != 36:
                raise ConvertError("The video's display matrix is malformed.")
            return struct.unpack("<9i", raw)
    return None


@dataclass
class VideoInfo:
    path: Path
    times: np.ndarray        # every frame's presentation time (s), first frame at 0
    width: int               # upright size of video.mp4 (even, at most MAX_VIDEO_WIDTH wide)
    height: int
    orientation: Orientation  # how decoded frames turn upright (the display matrix)
    has_audio: bool
    created: str | None      # when it was recorded, ISO 8601, if the file says
    codec: str
    audio_rate: int | None = None
    start_offset_us: int = 0  # first video frame minus the file's start (what ffmpeg must cut), µs, rounded down
    coded_size: tuple[int, int] = (0, 0)  # the stream's stored width and height, before turning upright

    def turned(self, quarter_turns: int) -> "VideoInfo":
        """The same video with its frames turned `quarter_turns` more times counter-clockwise."""
        orientation = self.orientation.turned(quarter_turns)
        w, h = output_size(*self.coded_size, orientation.transpose)
        return replace(self, orientation=orientation, width=w, height=h)

    @property
    def frame_count(self) -> int:
        return len(self.times)

    @property
    def fps(self) -> float:
        return (len(self.times) - 1) / self.times[-1] if len(self.times) > 1 and self.times[-1] > 0 else 30.0

    @property
    def duration(self) -> float:
        return float(self.times[-1]) + 1.0 / self.fps


def output_size(width: int, height: int, transpose: bool) -> tuple[int, int]:
    """Upright size of video.mp4: at most 1920 wide, both sides even, aspect kept."""
    if transpose:
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
        container.seek(0)
        orientation = Orientation()
        for frame in container.decode(s):
            orientation = Orientation.from_matrix(display_matrix(frame))
            break
        times = (np.array(pts, np.float64) - pts[0]) * float(s.time_base)
        # ffmpeg starts its output at the file's start time (the earliest stream); the first video
        # frame must be at 0, so video.mp4 cuts what comes before it (rounded down: never a frame).
        file_start = Fraction(container.start_time, 1_000_000) if container.start_time is not None else None
        first = Fraction(pts[0]) * s.time_base
        offset_us = max(0, math.floor((first - file_start) * 1_000_000)) if file_start is not None else 0
        w, h = output_size(s.codec_context.width, s.codec_context.height, orientation.transpose)
        tags = {**container.metadata, **s.metadata}
        return VideoInfo(path=path, times=times, width=w, height=h, orientation=orientation,
                         has_audio=bool(container.streams.audio), created=created_at(tags), codec=s.codec_context.name,
                         audio_rate=container.streams.audio[0].sample_rate if container.streams.audio else None,
                         start_offset_us=offset_us, coded_size=(s.codec_context.width, s.codec_context.height))


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
    turn = info.orientation
    work = fit_long_side(info.width, info.height, work_long_side)
    key_size = fit_long_side(info.width, info.height, keyframe_long_side)
    frames: dict[int, np.ndarray] = {}
    if keyframe_dir:
        keyframe_dir.mkdir(parents=True, exist_ok=True)
    last = max([*wanted_set, *key_at, 0])

    def rgb(frame, size: tuple[int, int]) -> np.ndarray:
        w, h = size[::-1] if turn.transpose else size  # scale before turning upright
        return turn.apply(frame.to_ndarray(width=w, height=h, format="rgb24", interpolation="AREA"))

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
        # Our own upright transform instead of ffmpeg's autorotation, so video.mp4 matches the frames
        # decode() reads whatever the ffmpeg version. `-display_rotation 0` replaces the source's
        # matrix with none (ffmpeg 6 would otherwise copy it into video.mp4, turning it twice).
        # -ss cuts whatever comes before the first video frame (audio), so it plays at 0.
        start = ["-ss", f"{info.start_offset_us}us"] if info.start_offset_us else []
        vf = ",".join([*info.orientation.ffmpeg_filters(), f"scale={info.width}:{info.height}"])
        cmd = [FFMPEG, "-v", "error", "-y", "-noautorotate", "-display_rotation", "0", *start, "-i", str(info.path), "-map", "0:v:0", "-map", "0:a:0?",
               "-vf", vf, "-fps_mode", "passthrough",
               # Keep every frame's own timestamp: without a fine time base ffmpeg rounds them to
               # 1/frame rate (ffmpeg 6 then drifts by 0.1% on a 29.98 fps phone video).
               "-enc_time_base:v", "1/90000", "-video_track_timescale", "90000",
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
        got = packet_times(self.dst)  # absolute: video.mp4's first frame must play at 0, like frame t 0
        if len(got) != self.info.frame_count or np.abs(got - self.info.times).max() > 1e-3:
            first = f"{got[0]:.3f} s" if len(got) else "none"
            raise RuntimeError(f"video.mp4 has {len(got)} frames (first at {first}), the source {self.info.frame_count}, "
                               "or their times differ; frames.jsonl wouldn't line up with playback.")


def packet_times(path: Path) -> np.ndarray:
    """Presentation times (s, as played: edit lists applied) of a video's frames, read from packets
    (no decoding)."""
    out = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time",
                          "-of", "json", str(path)], capture_output=True, text=True, check=True).stdout
    ts = np.sort(np.array([float(p["pts_time"]) for p in json.loads(out).get("packets", []) if p.get("pts_time") not in (None, "N/A")]))
    return ts
