"""
Which way is up, from what's in the frames. A video's orientation tag (display matrix) is usually
right, but some files have none: the Braindance phone app's video is stored the way the sensor
sees it, so a phone held upright gives sideways frames, and everything after that (the depth
model, people masks, leveling the room, keyframes) would be turned 90°.

The object detector the converter already loads (Mask R-CNN, COCO) was trained on upright photos,
so it finds more things, more confidently, when a frame is the right way up. A few frames spread
over the video are scored in all four quarter turns; a turn is applied only when it clearly beats
every other (`choose_turns`), otherwise the tag is trusted. Checked against ARKit's gravity on
phone captures and on the team clips (docs in README.md, "Upright").
"""

from __future__ import annotations

import numpy as np

import decode

SAMPLES = 12        # frames scored, spread evenly over the video
LONG_SIDE = 640     # size they're scored at
MIN_SCORE = 3.0     # summed detection confidence the winning turn needs at least
MARGIN = 1.5        # ... and how many times the runner-up's


def choose_turns(scores: list[float]) -> int:
    """Quarter turns counter-clockwise (np.rot90's k) that make the frames look upright, from the
    detector's summed confidence for each turn; 0 unless another turn clearly wins."""
    best = max(range(4), key=lambda k: scores[k])
    if best == 0:
        return 0
    runner_up = max(scores[k] for k in range(4) if k != best)
    return best if scores[best] >= MIN_SCORE and scores[best] >= MARGIN * runner_up else 0


def detect(info: decode.VideoInfo, masks_model) -> tuple[int, list[float]]:
    """(quarter turns to add to the video's own orientation, the score of each turn)."""
    n = info.frame_count
    wanted = sorted({int(round(i)) for i in np.linspace(0, n - 1, min(SAMPLES, n))})
    frames = decode.decode(info, wanted, LONG_SIDE, None).frames
    scores = [sum(masks_model.confidence(np.rot90(frames[i], k)) for i in wanted) for k in range(4)]
    return choose_turns(scores), [round(s, 2) for s in scores]
