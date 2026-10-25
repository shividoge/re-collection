"""The GPU work behind the worker loop: tools/video2capture's stages with the models kept loaded.

`GpuPipeline` loads Depth Anything 3 and Mask R-CNN once. `max_frames` (what the worker
advertises on `worker.claim`) is measured right after loading: the free GPU memory (unified memory
on the GX10) divided by what one model frame costs at the peak (`estimate.frames_that_fit`).
A convert job runs DA3 in one pass when its frames fit, else in overlapping windows; if free
memory has shrunk since startup (a shared GPU), the windows shrink with it.

A splat job trains from the raw capture files. On a small card, DA3's weights move to the CPU
while the splat trains and come back afterwards.
"""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Callable, Mapping
from pathlib import Path

from .errors import Cancelled, PermanentError


def estimate_patches(width: int, height: int) -> int:
    from estimate import patches

    return patches(width, height)

TOOLS = Path(__file__).resolve().parents[2] / "tools" / "video2capture"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

DEFAULT_MODEL = os.environ.get("BRAINDANCE_DA3_MODEL", str(TOOLS / "models" / "DA3NESTED-GIANT-LARGE-1.1"))
SPLAT_FREE_GIB = 6.0  # train with DA3 resident only if this much stays free; else offload it

ProgressFn = Callable[[str, float | None, str], None]


def _checkpoint(should_stop: Callable[[], bool]) -> Callable[[], None]:
    def check() -> None:
        if should_stop():
            raise Cancelled()
    return check


class GpuPipeline:
    splat_inputs = ("manifest.json", "frames.jsonl", "video.mp4", "room.bin", "depth.bin", "depth.index.json")

    def __init__(self, model: str = DEFAULT_MODEL, device: str | None = None, max_frames: int | None = None,
                 log: Callable[[str], None] = print) -> None:
        import torch

        import decode
        from convert import Converter

        for codec in ("h264", "hevc"):  # this machine's ffmpeg must handle phone videos; fail now, not per job
            decode.check_ffmpeg(codec)
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        if not Path(model).exists() and "/" not in model:
            raise RuntimeError(f"No Depth Anything 3 model at {model}; set BRAINDANCE_DA3_MODEL (README).")
        self.log = log
        self.converter = Converter(model, self.device)
        self.max_frames = max_frames or self.converter.depth_model.max_frames()
        if self.max_frames < 16:
            raise RuntimeError(f"Only {self.max_frames} model frames fit in GPU memory; is something else using the GPU?")
        log(f"models loaded on {self.device}; one pass fits {self.max_frames} frames")

    def convert(self, video: Path, out: Path, *, capture_id: str, title: str, attendees: list[str],
                progress: ProgressFn, should_stop: Callable[[], bool], **options: object) -> Mapping[str, object]:
        from convert import Options
        from decode import ConvertError

        import decode

        try:
            info = decode.probe(video)
        except ConvertError as e:
            raise PermanentError(str(e)) from e
        # maxFrames is advertised for 16:9; other shapes (4:3 phone video) and less free memory
        # than at startup give smaller windows.
        fit = self.converter.depth_model.max_frames(info.width, info.height)
        scale = estimate_patches(16, 9) / estimate_patches(info.width, info.height)
        window = max(16, min(int(self.max_frames * scale), fit))
        opts = Options(**{"window": window, **options})  # type: ignore[arg-type]
        try:
            self.last = self.converter.convert(video, out, capture_id=capture_id, title=title, attendees=attendees,
                                               opts=opts, progress=progress, checkpoint=_checkpoint(should_stop),
                                               log=self.log)
        except ConvertError as e:
            raise PermanentError(str(e)) from e
        return self.last.manifest

    def splat(self, capture: Path, out: Path, *, progress: ProgressFn, should_stop: Callable[[], bool],
              holdout_frames: list[int] | None = None, timings: dict[str, float] | None = None) -> Mapping[str, object]:
        import torch

        import spz
        import splat
        from decode import ConvertError

        offloaded = False
        if self.device == "cuda" and torch.cuda.mem_get_info()[0] / 2**30 < SPLAT_FREE_GIB:
            self.converter.depth_model.offload()
            offloaded = True
        try:
            progress("splat", None, "Preparing the frames for the splat")
            g = splat.train_from_package(capture, self.converter.masks, self.device, holdout_frames=holdout_frames,
                                         log=self.log, checkpoint=_checkpoint(should_stop),
                                         progress=lambda f: progress("splat", f, "Training the room splat"),
                                         timings=timings)
        except ConvertError as e:
            raise PermanentError(str(e)) from e
        finally:
            if offloaded:
                self.converter.depth_model.reload()
        out.mkdir(parents=True, exist_ok=True)
        spz.write_spz(out / "room.spz", g["means"], g["scales"], g["quats"], g["opacities"], g["sh"])
        return {"file": "room.spz", "format": "spz", "count": int(len(g["means"])), "shDegree": 1,
                "source": "trained-from-video"}


PIPELINE_KEYS = ("BRAINDANCE_DA3_MODEL", "WORKER_MAX_FRAMES", "FFMPEG", "FFPROBE")


def make_pipeline() -> GpuPipeline:
    """The worker's pipeline. Its settings (PIPELINE_KEYS) come from the environment or, like
    the rest of the worker's settings, from ~/.config/braindance/worker.env."""
    from .config import DEFAULT_ENV_FILE, parse_env_file

    path = Path(os.environ.get("BRAINDANCE_WORKER_ENV") or DEFAULT_ENV_FILE).expanduser()
    values = parse_env_file(path.read_text(encoding="utf-8")) if path.is_file() else {}
    for key in PIPELINE_KEYS:
        if values.get(key) and not os.environ.get(key):
            os.environ[key] = values[key]
    max_frames = os.environ.get("WORKER_MAX_FRAMES")
    model = os.environ.get("BRAINDANCE_DA3_MODEL") or DEFAULT_MODEL
    return GpuPipeline(model=model, max_frames=int(max_frames) if max_frames else None)


def add_splat_to_manifest(capture: Path, info: Mapping[str, object]) -> None:
    """What the backend does when a splat job completes: list the splat in manifest.json."""
    path = capture / "manifest.json"
    manifest = json.loads(path.read_text())
    manifest["room"]["splat"] = dict(info)
    path.write_text(json.dumps(manifest, indent=2))
