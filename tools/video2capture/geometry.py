"""Pose helpers in the capture convention (ARKit: meters, y up, the camera looks down -z). numpy only."""

from __future__ import annotations

import math

import numpy as np


def rot_to_quat(r: np.ndarray) -> np.ndarray:
    w = math.sqrt(max(0.0, 1 + r[0, 0] + r[1, 1] + r[2, 2])) / 2
    x = math.copysign(math.sqrt(max(0.0, 1 + r[0, 0] - r[1, 1] - r[2, 2])) / 2, r[2, 1] - r[1, 2])
    y = math.copysign(math.sqrt(max(0.0, 1 - r[0, 0] + r[1, 1] - r[2, 2])) / 2, r[0, 2] - r[2, 0])
    z = math.copysign(math.sqrt(max(0.0, 1 - r[0, 0] - r[1, 1] + r[2, 2])) / 2, r[1, 0] - r[0, 1])
    q = np.array([w, x, y, z])
    return q / np.linalg.norm(q)


def quat_to_rot(q: np.ndarray) -> np.ndarray:
    w, x, y, z = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def slerp(a: np.ndarray, b: np.ndarray, t: float) -> np.ndarray:
    d = float(np.dot(a, b))
    if d < 0:
        b, d = -b, -d
    if d > 0.9995:
        q = a + t * (b - a)
        return q / np.linalg.norm(q)
    th = math.acos(d)
    return (math.sin((1 - t) * th) * a + math.sin(t * th) * b) / math.sin(th)


def interpolate_pose(poses: list[np.ndarray], times: list[float], t: float) -> np.ndarray:
    """Camera-to-world at time t, between the two nearest sampled poses."""
    if t <= times[0]:
        return poses[0]
    if t >= times[-1]:
        return poses[-1]
    i = int(np.searchsorted(times, t)) - 1
    u = (t - times[i]) / (times[i + 1] - times[i])
    q = slerp(rot_to_quat(poses[i][:3, :3]), rot_to_quat(poses[i + 1][:3, :3]), u)
    m = np.eye(4)
    m[:3, :3] = quat_to_rot(q)
    m[:3, 3] = (1 - u) * poses[i][:3, 3] + u * poses[i + 1][:3, 3]
    return m



# The x axes must sweep at least about ±10 degrees (variance 0.01 across the plane they span) for
# their common perpendicular to say where "up" is; below that, roll jitter decides it.
MIN_X_SPREAD = 0.01
UNLEVELED_WARNING = ("The camera barely turned, so which way is up comes from the camera itself; "
                     "if it was held tilted, the room is tilted the same way.")


def level_world(poses: list[np.ndarray]) -> np.ndarray:
    """`leveling(poses)` without the warning."""
    return leveling(poses)[0]


def leveling(poses: list[np.ndarray]) -> tuple[np.ndarray, str | None]:
    """A rotation (4x4) that makes world +y point up, and a warning when it's a guess.

    A handheld camera is rarely rolled, so its x axis stays about horizontal: when the camera
    turned enough, "up" is the direction most perpendicular to every camera's x axis (the smallest
    eigenvector of their scatter), signed to agree with the cameras' up. When it didn't (a fixed
    or barely turning camera: the x axes don't span a plane, so that eigenvector is just noise,
    often the viewing direction), up is the cameras' average up with the average roll removed:
    no tilt is invented, and the warning says the camera's own up was used."""
    xs = np.stack([T[:3, 0] for T in poses])
    ys = np.stack([T[:3, 1] for T in poses])
    vals, vecs = np.linalg.eigh(xs.T @ xs / len(xs))
    up, warning = vecs[:, 0], None
    if vals[1] < MIN_X_SPREAD or vals[0] > 0.3 * vals[1]:
        x = xs.mean(0) / np.linalg.norm(xs.mean(0))
        up = ys.mean(0) - (ys.mean(0) @ x) * x
        warning = UNLEVELED_WARNING
        if np.linalg.norm(up) < 1e-6:  # the cameras disagree about up entirely: leave the world as is
            return np.eye(4), warning
    up = up / np.linalg.norm(up)
    if up @ ys.mean(0) < 0:
        up = -up
    # Smallest rotation taking `up` to +y (Rodrigues).
    target = np.array([0.0, 1.0, 0.0])
    v, c = np.cross(up, target), float(up @ target)
    if np.linalg.norm(v) < 1e-9:
        R = np.eye(3) if c > 0 else np.diag([1.0, -1.0, -1.0])
    else:
        vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
        R = np.eye(3) + vx + vx @ vx / (1 + c)
    M = np.eye(4)
    M[:3, :3] = R
    return M, warning
