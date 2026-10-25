"""
Score a video-made capture against a LiDAR phone capture of the same video (the phone's
video.mov run through the converter): the phone's ARKit poses and LiDAR depth are the reference.

    .venv/bin/python compare_lidar.py --lidar <phone capture folder> --capture label=<converted folder> ...

Alignment that works even when the camera barely moves: the world rotation is the average of
the per-frame rotation differences, the scale is the median ratio of LiDAR depth to the
converted depth (1 = the metric scale was right), the translation matches the path centroids.
Then per capture: camera path error (ATE RMSE), median rotation error, the scale, and depth
error on the frames both have (median |s·d - lidar| / lidar on high-confidence LiDAR pixels).
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

import align
import package


def rotation_angle(R: np.ndarray) -> float:
    return float(np.degrees(np.arccos(np.clip((np.trace(R) - 1) / 2, -1, 1))))


def roll(k: int) -> np.ndarray:
    """4x4: k quarter turns about the camera's viewing axis."""
    c, s = [(1, 0), (0, 1), (-1, 0), (0, -1)][k % 4]
    T = np.eye(4)
    T[:2, :2] = [[c, -s], [s, c]]
    return T


def world_rotation(ours: np.ndarray, ref: np.ndarray) -> np.ndarray:
    """The rotation taking our world to the reference's (average of the per-frame differences)."""
    M = sum(b[:3, :3] @ a[:3, :3].T for a, b in zip(ours, ref))
    U, _, Vt = np.linalg.svd(M)
    return U @ np.diag([1, 1, np.sign(np.linalg.det(U @ Vt))]) @ Vt


def unturn_depth(mm: np.ndarray, turn: int, shape: tuple[int, int]) -> np.ndarray:
    """Our depth grids turned back by `turn` quarter turns and resampled (nearest) to the reference
    grid's shape: the grid is always 256x192, so a turned portrait video's grid is stretched."""
    if turn % 4 == 0:
        return mm
    turned = np.rot90(mm, -turn, axes=(1, 2))
    rows = np.minimum((np.arange(shape[0]) + 0.5) * turned.shape[1] / shape[0], turned.shape[1] - 1).astype(int)
    cols = np.minimum((np.arange(shape[1]) + 0.5) * turned.shape[2] / shape[1], turned.shape[2] - 1).astype(int)
    return turned[:, rows][:, :, cols]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lidar", type=Path, required=True)
    ap.add_argument("--capture", action="append", required=True, help="label=folder (repeatable)")
    ap.add_argument("--json", type=Path)
    args = ap.parse_args()

    ref_manifest = json.loads((args.lidar / "manifest.json").read_text())
    ref_lines = {l["i"]: l for l in package.read_frames(args.lidar / "frames.jsonl") if l.get("phase") == "moment" and l["i"] is not None}
    ref_depth, ref_conf = package.read_depth_conf(args.lidar, ref_manifest)
    results = {}
    for item in args.capture:
        label, folder = item.split("=", 1)
        folder = Path(folder)
        manifest = json.loads((folder / "manifest.json").read_text())
        lines = [l for l in package.read_frames(folder / "frames.jsonl") if l.get("d") is not None and l["i"] in ref_lines]
        ours = np.stack([package.pose_of(l)[0] for l in lines])
        ref = np.stack([package.pose_of(ref_lines[l["i"]])[0] for l in lines])
        # The converter may have turned the frames upright (upright.py): then its cameras are rolled a
        # quarter turn against the phone's, and its depth maps are turned too. Undo whichever roll fits.
        turn, R = min(((k, world_rotation(ours @ roll(k), ref)) for k in range(4)),
                      key=lambda kr: np.median([rotation_angle(kr[1] @ a[:3, :3] @ roll(kr[0])[:3, :3] @ b[:3, :3].T)
                                                for a, b in zip(ours, ref)]))
        ours = ours @ roll(turn)
        mm = unturn_depth(package.read_depth(folder, manifest), turn, ref_depth.shape[1:])
        ratios, pairs = [], []
        for l in lines:
            dref = ref_lines[l["i"]]["d"]
            if dref is None:
                continue
            r = ref_depth[dref].astype(np.float32)
            ok = (ref_conf[dref] == 2) & (r > 0) & (mm[l["d"]] > 0)
            if ok.sum() > 100:
                ratios.append(np.median(r[ok] / mm[l["d"]][ok]))
                pairs.append((mm[l["d"]][ok].astype(np.float32), r[ok]))
        s = float(np.median(ratios))
        t = ref[:, :3, 3].mean(0) - s * R @ ours[:, :3, 3].mean(0)
        moved = np.stack([align.apply_sim3_to_pose(s, R, t, T) for T in ours])
        err = np.linalg.norm(moved[:, :3, 3] - ref[:, :3, 3], axis=1)
        path_len = float(np.linalg.norm(np.diff(ref[:, :3, 3], axis=0), axis=1).sum())
        rot_err = [rotation_angle(a[:3, :3].T @ b[:3, :3]) for a, b in zip(moved, ref)]
        rel = [np.median(np.abs(d * s - r) / r) for d, r in pairs]
        results[label] = {
            "frames": len(lines), "ate_m": round(float(np.sqrt((err**2).mean())), 4),
            "ate_of_path": round(float(np.sqrt((err**2).mean())) / max(path_len, 1e-9), 4),
            "rot_deg_median": round(float(np.median(rot_err)), 2), "scale": round(s, 3),
            "depth_rel_median": round(float(np.median(rel)), 4) if rel else None,
            "windows": manifest["warnings"][1] if len(manifest["warnings"]) > 1 else "one pass",
        }
        r = results[label]
        print(f"{label:20s} ATE {r['ate_m'] * 100:6.2f} cm ({r['ate_of_path']:.1%} of a {path_len:.2f} m path)  "
              f"rotation {r['rot_deg_median']:.2f}°  scale {r['scale']:.3f}  depth error {r['depth_rel_median']}")
    if args.json:
        args.json.write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
