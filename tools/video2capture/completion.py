"""World-space completion geometry and evidence checks, independent of a generation model.

All candidate geometry stays explicitly generated. Real RGB may constrain its visible color;
passing a depth check never turns a generated surface into a measured one.
"""

from __future__ import annotations

import numpy as np
from scipy.spatial import cKDTree
from scipy.spatial.transform import Rotation


def transform_gaussians(g: dict[str, np.ndarray], transform: np.ndarray) -> dict[str, np.ndarray]:
    """Rigidly transform a degree-0 splat, including its anisotropic covariance."""
    r, t = transform[:3, :3], transform[:3, 3]
    if not np.allclose(r.T @ r, np.eye(3), atol=1e-4) or not np.isclose(np.linalg.det(r), 1, atol=1e-4):
        raise ValueError('Completion transform must be a proper rigid transform.')
    if g['sh'].shape[1] != 1:
        raise ValueError('Rotate completion in degree-0 color space; directional SH would also need rotation.')
    result = {k: v.copy() for k, v in g.items()}
    result['means'] = (g['means'] @ r.T + t).astype(np.float32)
    q = Rotation.from_quat(g['quats'][:, [1, 2, 3, 0]])
    result['quats'] = (Rotation.from_matrix(r) * q).as_quat()[:, [3, 0, 1, 2]].astype(np.float32)
    return result


def camera_projection(points: np.ndarray, pose: np.ndarray, K: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    cam = (points - pose[:3, 3]) @ pose[:3, :3]
    z = -cam[:, 2]
    u = K[0, 0] * cam[:, 0] / np.maximum(z, 1e-8) + K[0, 2]
    v = -K[1, 1] * cam[:, 1] / np.maximum(z, 1e-8) + K[1, 2]
    return u, v, z


def constrain(g: dict[str, np.ndarray], evidence_points: np.ndarray,
              depths: np.ndarray, poses: np.ndarray, intrinsics: np.ndarray,
              colors: np.ndarray, moving: np.ndarray, checkpoint=lambda: None) -> tuple[dict[str, np.ndarray], dict]:
    """Remove duplicates and candidates in observed free space; preserve source RGB at surfaces.

    Inputs share the depth-grid image size. Moving/unknown pixels constrain nothing. A point
    behind an observed surface is unobserved, not a contradiction. Limit Gaussian support to
    3 cm to avoid a correct center concealing an enormous foreground blob.
    """
    if len(depths) != len(poses) or depths.shape != moving.shape or colors.shape != (*depths.shape, 3):
        raise ValueError('Completion constraints must use matching image/depth/mask grids.')
    p = g['means']
    if not all(np.isfinite(v).all() for v in g.values()):
        raise ValueError('Generated geometry contains non-finite values.')
    n, h, w = depths.shape
    # Avoid overlaying new texture on successfully reconstructed surfaces.
    duplicate = cKDTree(evidence_points).query(p, workers=-1)[0] < 0.02 if len(evidence_points) else np.zeros(len(p), bool)
    contradiction = np.zeros(len(p), dtype=bool)
    rgb_sum = np.zeros((len(p), 3), np.float64)
    weight_sum = np.zeros(len(p), np.float64)
    for k in range(n):
        checkpoint()
        u, v, z = camera_projection(p, poses[k], intrinsics[k])
        ui, vi = np.rint(u).astype(np.int64), np.rint(v).astype(np.int64)
        inside = (z > 0) & (ui >= 0) & (vi >= 0) & (ui < w) & (vi < h)
        ui, vi = ui.clip(0, w - 1), vi.clip(0, h - 1)
        d = depths[k, vi, ui]
        known = inside & (d > 0) & ~moving[k, vi, ui]
        tolerance = np.maximum(0.04, d * 0.025)
        contradiction |= known & (z < d - tolerance)
        surface = known & (np.abs(z - d) < tolerance)
        weight = surface / np.maximum(z * z, 0.01)
        rgb_sum += colors[k, vi, ui] * weight[:, None]
        weight_sum += weight
    keep = ~duplicate & ~contradiction
    out = {k: v[keep].copy() for k, v in g.items()}
    out['scales'] = np.minimum(out['scales'], np.log(0.01))
    recolor = weight_sum[keep] > 0
    observed_rgb = rgb_sum[keep][recolor] / weight_sum[keep][recolor, None] / 255
    out['sh'][recolor, 0] = (observed_rgb - 0.5) / 0.28209479177387814
    return out, {'candidates': len(p), 'kept': int(keep.sum()), 'duplicates': int(duplicate.sum()),
                 'freeSpaceConflicts': int(contradiction.sum()), 'coloredFromVideo': int(recolor.sum())}


def planar_candidates(points: np.ndarray, colors: np.ndarray, *, seed: int = 0) -> dict[str, np.ndarray]:
    """Complete bounded patches of observed planes, never an arbitrary enclosing box.

    RANSAC requires substantial support, then fills the rectangle inside the central 96% of
    the inliers. This is a geometric estimate, separately labelled from learned object shapes.
    Subsequent free-space checks remove patches crossing doors or visible gaps.
    """
    rng = np.random.default_rng(seed)
    choice = rng.choice(len(points), min(50_000, len(points)), replace=False)
    remaining, rgb = points[choice], colors[choice]
    patches, patch_colors, rotations = [], [], []
    for _ in range(8):
        if len(remaining) < 600:
            break
        best = np.zeros(len(remaining), bool)
        normal = None
        for _ in range(100):
            a, b, c = remaining[rng.choice(len(remaining), 3, replace=False)]
            n = np.cross(b - a, c - a)
            length = np.linalg.norm(n)
            if length < 1e-6:
                continue
            n /= length
            hit = np.abs((remaining - a) @ n) < 0.025
            if hit.sum() > best.sum():
                best, normal = hit, n
        if best.sum() < max(600, len(remaining) * 0.06) or normal is None:
            break
        support = remaining[best]
        center = np.median(support, axis=0)
        _, _, vh = np.linalg.svd(support - center, full_matrices=False)
        x, y = vh[:2]
        z = np.cross(x, y)
        uv = (support - center) @ np.stack([x, y], 1)
        low, high = np.quantile(uv, [0.02, 0.98], axis=0)
        extent = high - low
        if extent.min() > 0.35 and np.prod(extent) > 0.5:
            spacing = max(0.025, np.sqrt(np.prod(extent) / 100_000))
            u, v = np.meshgrid(np.arange(low[0], high[0], spacing), np.arange(low[1], high[1], spacing))
            world = center + u.reshape(-1, 1) * x + v.reshape(-1, 1) * y
            patches.append(world)
            patch_colors.append(np.tile(np.median(rgb[best], axis=0), (len(world), 1)))
            q = Rotation.from_matrix(np.stack([x, y, z], 1)).as_quat()[[3, 0, 1, 2]]
            rotations.append(np.tile(q, (len(world), 1)))
        remaining, rgb = remaining[~best], rgb[~best]
    means = np.concatenate(patches).astype(np.float32) if patches else np.empty((0, 3), np.float32)
    c = np.concatenate(patch_colors).astype(np.float32) if patches else np.empty((0, 3), np.float32)
    quats = np.concatenate(rotations).astype(np.float32) if patches else np.empty((0, 4), np.float32)
    return {'means': means, 'scales': np.tile(np.log([0.01, 0.01, 0.002]), (len(means), 1)).astype(np.float32),
            'quats': quats, 'opacities': np.full(len(means), 3.0, np.float32),
            'sh': ((c / 255 - 0.5) / 0.28209479177387814)[:, None, :]}
