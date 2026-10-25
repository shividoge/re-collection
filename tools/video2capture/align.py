"""
Pure geometry for long videos: Depth Anything 3 runs on overlapping windows of frames, each in
its own coordinates, and the windows are chained with a similarity transform (Sim(3): scale,
rotation, translation) estimated from the frames they share. Shared frames give dense, exact
correspondences: the same pixel of the same frame is the same point in the world, so each
window's depth for that pixel, unprojected with its own pose, must land on the same spot.
numpy only, so it's testable without a GPU.
"""

from __future__ import annotations

import numpy as np


def plan_windows(n: int, size: int, overlap: int) -> list[tuple[int, int]]:
    """Frames [start, end) of each window: `size` frames, consecutive windows sharing `overlap`
    frames, the last window ending at n. One window when everything fits."""
    if n <= size:
        return [(0, n)]
    if not 0 < overlap < size:
        raise ValueError("overlap must be between 0 and the window size.")
    stride = size - overlap
    count = -(-(n - overlap) // stride)  # windows needed so the last one reaches n
    starts = np.linspace(0, n - size, count).round().astype(int)  # spread evenly: every overlap >= `overlap`
    return [(int(s), int(s) + size) for s in starts]


def umeyama(src: np.ndarray, dst: np.ndarray, w: np.ndarray | None = None) -> tuple[float, np.ndarray, np.ndarray]:
    """Weighted least-squares Sim(3) with dst ≈ s·R·src + t (Umeyama 1991). src, dst (P, 3)."""
    w = np.ones(len(src)) if w is None else np.asarray(w, np.float64)
    w = w / w.sum()
    mu_s, mu_d = w @ src, w @ dst
    xs, xd = src - mu_s, dst - mu_d
    cov = (xd * w[:, None]).T @ xs
    U, D, Vt = np.linalg.svd(cov)
    S = np.eye(3)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:
        S[2, 2] = -1
    R = U @ S @ Vt
    var_s = float(w @ (xs**2).sum(1))
    s = float(np.trace(np.diag(D) @ S) / var_s)
    t = mu_d - s * R @ mu_s
    return s, R, t


def robust_sim3(src: np.ndarray, dst: np.ndarray, w: np.ndarray | None = None, iters: int = 8,
                huber: float = 1.5) -> tuple[float, np.ndarray, np.ndarray, float]:
    """Umeyama with iteratively reweighted least squares (Huber weights on residuals scaled by
    their median), so pixels the two windows disagree on (moving people, edges) don't pull the
    fit. Returns (s, R, t, median residual after the fit, in dst units)."""
    w0 = np.ones(len(src)) if w is None else np.asarray(w, np.float64)
    wk = w0.copy()
    for _ in range(iters):
        s, R, t = umeyama(src, dst, wk)
        r = np.linalg.norm(dst - (s * src @ R.T + t), axis=1)
        scale = max(np.median(r) * 1.4826, 1e-9)
        k = huber * scale
        wk = w0 * np.where(r <= k, 1.0, k / np.maximum(r, 1e-12))
    return s, R, t, float(np.median(r))


def sim3_matrix(s: float, R: np.ndarray, t: np.ndarray) -> np.ndarray:
    M = np.eye(4)
    M[:3, :3] = s * R
    M[:3, 3] = t
    return M


def apply_sim3_to_pose(s: float, R: np.ndarray, t: np.ndarray, c2w: np.ndarray) -> np.ndarray:
    """Camera-to-world after moving the world by x -> s·R·x + t. The camera's depth scales by s."""
    out = np.eye(4)
    out[:3, :3] = R @ c2w[:3, :3]
    out[:3, 3] = s * R @ c2w[:3, 3] + t
    return out


def unproject_np(depth: np.ndarray, K: np.ndarray, c2w: np.ndarray, us: np.ndarray, vs: np.ndarray) -> np.ndarray:
    """Pixels (us, vs) of a depth map -> world points, capture convention (camera looks down -z)."""
    d = depth[vs, us]
    x = (us - K[0, 2]) * d / K[0, 0]
    y = (vs - K[1, 2]) * d / K[1, 1]
    cam = np.stack([x, -y, -d], -1)
    return cam @ c2w[:3, :3].T + c2w[:3, 3]


def correspondences(depth_a: np.ndarray, depth_b: np.ndarray, conf_a: np.ndarray, conf_b: np.ndarray,
                    K_a: np.ndarray, K_b: np.ndarray, pose_a: np.ndarray, pose_b: np.ndarray,
                    valid: np.ndarray, step: int = 4) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """One shared frame seen by windows A and B: points in B's world, the same pixels in A's world,
    and a weight (the lower of the two confidences). Every `step`-th pixel where both are valid."""
    h, w = depth_a.shape
    vv, uu = np.mgrid[0:h:step, 0:w:step]
    ok = valid[vv, uu] & (depth_a[vv, uu] > 0) & (depth_b[vv, uu] > 0)
    us, vs = uu[ok], vv[ok]
    pa = unproject_np(depth_a, K_a, pose_a, us, vs)
    pb = unproject_np(depth_b, K_b, pose_b, us, vs)
    return pb, pa, np.minimum(conf_a[vs, us], conf_b[vs, us])
