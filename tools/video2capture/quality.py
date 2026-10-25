"""Coverage-preserving selection for detail reconstruction. No model or renderer dependencies."""

from __future__ import annotations

import numpy as np


def spatial_selection(points: np.ndarray, scores: np.ndarray, budget: int, voxel: float = 0.04) -> np.ndarray:
    """Reserve half the budget for the best point in each occupied cell, then rank globally.

    Unlike global top-k, a small object seen briefly can retain samples even when a wall
    receives most of the image contributions. Only call this on already-supported points.
    Deterministic ties make comparisons reproducible. Coarsen until cell representatives fit.
    """
    if budget < 1 or voxel <= 0 or not np.isfinite(voxel):
        raise ValueError("Selection needs a positive budget and voxel size.")
    if points.shape != (len(scores), 3) or not np.isfinite(points).all() or not np.isfinite(scores).all():
        raise ValueError("Selection needs finite XYZ points and one finite score per point.")
    n = len(points)
    if n <= budget:
        return np.arange(n)
    ranked = np.argsort(-scores, kind="stable")
    # Subtracting a common origin avoids integer overflow for translated scenes.
    origin = points.min(0)
    reserved = max(1, budget // 2)
    for _ in range(64):
        cells = np.floor((points[ranked] - origin) / voxel).astype(np.int64)
        _, first = np.unique(cells, axis=0, return_index=True)
        representatives = ranked[first]
        if len(representatives) <= reserved:
            break
        voxel *= 1.5
    chosen = np.zeros(n, dtype=bool)
    chosen[representatives] = True
    rest = ranked[~chosen[ranked]][:budget - len(representatives)]
    chosen[rest] = True
    return np.flatnonzero(chosen)


def image_detail_weights(images, masks):
    """Give visible RGB edges extra weight without amplifying moving-mask boundaries."""
    import torch
    import torch.nn.functional as F

    rgb = images.float() / 255
    gray = rgb.mean(-1)
    dx = F.pad((gray[:, :, 1:] - gray[:, :, :-1]).abs(), (0, 1))
    dy = F.pad((gray[:, 1:] - gray[:, :-1]).abs(), (0, 0, 0, 1))
    edges = (dx + dy).clamp(0, 0.25) * 4
    near_mask = F.max_pool2d(masks.float()[:, None], 5, stride=1, padding=2)[:, 0] > 0
    return torch.where(near_mask, torch.ones_like(edges), 1 + 2 * edges)
