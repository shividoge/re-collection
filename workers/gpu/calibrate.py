"""Measure what one Depth Anything 3 frame costs in GPU memory on this machine:

    python -m workers.gpu.calibrate clip.mov [--frames 16,32,48,64]

Loads the model, runs one pass per frame count on real frames of the clip, and prints the peak
memory above the loaded model for each, the fitted cost per frame and the constant, and how many
frames `estimate.frames_that_fit` would allow with the memory free now. Use it to check
GIB_PER_FRAME in tools/video2capture/estimate.py on a new machine.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import pipeline  # noqa: F401  (puts tools/video2capture on sys.path)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m workers.gpu.calibrate")
    ap.add_argument("video", type=Path)
    ap.add_argument("--frames", default="16,32,48,64")
    ap.add_argument("--model", default=pipeline.DEFAULT_MODEL)
    args = ap.parse_args(argv)

    import numpy as np
    import torch

    import convert
    import decode
    import estimate

    counts = [int(x) for x in args.frames.split(",")]
    info = decode.probe(args.video)
    wanted = convert.choose_samples(info.times, max(counts))
    frames = decode.decode(info, wanted, 1008, None).frames
    images = [frames[i] for i in wanted]
    model = estimate.DepthModel(args.model, "cuda")
    torch.cuda.synchronize()
    base = torch.cuda.memory_allocated()
    free0 = torch.cuda.mem_get_info()[0] / 2**30
    rows = []
    for n in counts:
        torch.cuda.reset_peak_memory_stats()
        model.infer(images[:n])
        peak = (torch.cuda.max_memory_allocated() - base) / 2**30
        rows.append((n, peak))
        print(f"{n:4d} frames: peak {peak:.2f} GiB above the loaded model")
    slope, const = np.polyfit([r[0] for r in rows], [r[1] for r in rows], 1)
    print(f"per frame {slope:.4f} GiB, constant {const:.2f} GiB; free after loading {free0:.2f} GiB; "
          f"frames_that_fit now: {estimate.frames_that_fit(torch.cuda.mem_get_info()[0] / 2**30)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
