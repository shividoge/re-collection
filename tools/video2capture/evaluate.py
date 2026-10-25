"""
Compare reconstructions of one video on frames they never saw.

Run video2capture.py with `--holdout 8`: every 8th model frame is left out of the room and the
splat, and listed in `<out>/capture-<id>.holdout.json`. This script renders each capture's room
(the room.bin points, drawn as round dots sized to their neighbours like the web viewer, and
room.splat.ply or room.spz if present) from those frames' camera poses, and scores the renders against the
real frames: PSNR and SSIM on the pixels not covered by people or pets (they're not part of the
room), and coverage (share of those pixels the render fills at all).

    .venv/bin/python evaluate.py --holdout out/capture-<id>.holdout.json \\
        --capture before=../old/capture-<a> --capture after=out/capture-<id> --sheet compare.jpg

Captures from older runs work too (each is rendered with its own camera path); they just don't
get a fair "never seen" guarantee.
"""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path

os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

import numpy as np


def overview_pose(poses: list[np.ndarray], points: np.ndarray) -> np.ndarray:
    """A camera behind and above the recording's path, looking at the middle of the room: shows
    floaters, double walls and holes that the recording's own viewpoints hide."""
    centre = np.median(points, axis=0)
    cams = np.stack([T[:3, 3] for T in poses])
    back = np.mean([T[:3, 2] for T in poses], axis=0)  # +z points backwards out of the camera
    back = back / np.linalg.norm(back)
    dist = float(np.median(np.linalg.norm(points - cams.mean(0), axis=1)))
    eye = cams.mean(0) + back * dist * 0.8 + np.array([0, dist * 0.5, 0])
    fwd = centre - eye
    fwd /= np.linalg.norm(fwd)
    right = np.cross(fwd, [0, 1, 0])
    right /= np.linalg.norm(right)
    up = np.cross(right, fwd)
    T = np.eye(4)
    T[:3, 0], T[:3, 1], T[:3, 2], T[:3, 3] = right, up, -fwd, eye
    return T


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--holdout", type=Path, required=True)
    ap.add_argument("--capture", action="append", required=True, help="label=folder (repeatable)")
    ap.add_argument("--width", type=int, default=960)
    ap.add_argument("--sheet", type=Path, help="write a comparison image here")
    ap.add_argument("--json", type=Path, help="write the scores here")
    args = ap.parse_args()

    import torch
    from PIL import Image, ImageDraw

    import decode
    import fusion
    import package
    import splat

    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    frames = json.loads(args.holdout.read_text())["frames"]
    caps = [(c.split("=", 1)[0], Path(c.split("=", 1)[1])) for c in args.capture]

    # Ground truth: the held-out frames from the first capture's video (all captures of one
    # source video have the same frames).
    info = decode.probe(caps[0][1] / "video.mp4")
    dec = decode.decode(info, frames, max(info.width, info.height), None)
    gt_full = torch.from_numpy(np.stack([dec.frames[i] for i in frames]))
    _, H, W, _ = gt_full.shape
    w, h = args.width, int(round(H * args.width / W / 2)) * 2
    gt = fusion.resize_images(gt_full, h, w).to(dev) / 255
    people = fusion.resize_mask(fusion.moving_masks(gt_full, dev).to(dev), h, w)

    results, rows = {}, []
    for label, folder in caps:
        lines = package.read_frames(folder / "frames.jsonl")
        pts, cols = package.read_room_bin(folder / "room.bin")
        size = np.minimum(splat.neighbour_spacing(pts) * 1.2, 0.035)  # the viewer caps splats at 3.5 cm
        dots = splat.points_as_gaussians(pts, cols, 1.0)
        dots["scales"] = np.log(np.maximum(size, 1e-4) / 2)[:, None].repeat(3, 1).astype(np.float32)
        models = [("points", splat.tensors(dots, dev))]
        if (folder / "room.spz").exists():
            import spz

            models.append(("splat", splat.tensors(spz.read_spz(folder / "room.spz"), dev)))
        elif (folder / "room.splat.ply").exists():
            models.append(("splat", splat.tensors(splat.read_ply(folder / "room.splat.ply"), dev)))
        poses = [package.pose_of(lines[i]) for i in frames]
        ov = overview_pose([package.pose_of(l)[0] for l in lines], pts)
        for kind, g in models:
            degree = int(math.isqrt(g["sh"].shape[1])) - 1
            renders, psnr, ssim, cover = [], [], [], []
            with torch.no_grad():
                for j, (T, K) in enumerate(poses):
                    Ks = fusion.scale_K(torch.tensor(K, dtype=torch.float32), w / W, h / H).to(dev)
                    img, alpha, _ = splat.render(g, torch.tensor(T, dtype=torch.float32, device=dev), Ks, w, h, degree)
                    keep = ~people[j]
                    err = ((img - gt[j]) ** 2)[keep].mean()
                    psnr.append(float(-10 * torch.log10(err)))
                    a = torch.where(keep[..., None], img, gt[j]).permute(2, 0, 1)[None]
                    ssim.append(float(splat.ssim(a, gt[j].permute(2, 0, 1)[None])))
                    cover.append(float((alpha > 0.5)[keep].float().mean()))
                    renders.append(img)
                Ko = torch.tensor([[0.8 * w, 0, w / 2], [0, 0.8 * w, h / 2], [0, 0, 1]], dtype=torch.float32, device=dev)
                renders.append(splat.render(g, torch.tensor(ov, dtype=torch.float32, device=dev), Ko, w, h, degree)[0])
            name = f"{label} {kind}"
            results[name] = {"psnr": round(float(np.mean(psnr)), 2), "ssim": round(float(np.mean(ssim)), 3),
                             "coverage": round(float(np.mean(cover)), 3), "count": int(len(g["means"]))}
            print(f"{name:24s} PSNR {results[name]['psnr']:6.2f}  SSIM {results[name]['ssim']:.3f}  "
                  f"coverage {results[name]['coverage']:.0%}  ({results[name]['count']:,})")
            rows.append((name, [(r.clamp(0, 1) * 255).byte().cpu().numpy() for r in renders]))

    if args.json:
        args.json.write_text(json.dumps({"frames": frames, "results": results}, indent=2))
    if args.sheet:
        cols_n = min(4, len(frames))
        pick = list(np.linspace(0, len(frames) - 1, cols_n).round().astype(int))
        real = [(gt[j] * 255).byte().cpu().numpy() for j in pick]
        table = [("real frame (held out)", real + [np.full((h, w, 3), 24, np.uint8)])]
        table += [(name, [imgs[j] for j in pick] + [imgs[-1]]) for name, imgs in rows]
        pad = 28
        sheet = Image.new("RGB", ((cols_n + 1) * w, len(table) * (h + pad)), (16, 16, 16))
        draw = ImageDraw.Draw(sheet)
        for r, (name, imgs) in enumerate(table):
            score = results.get(name)
            text = name + (f"   PSNR {score['psnr']:.1f} dB  SSIM {score['ssim']:.2f}  coverage {score['coverage']:.0%}" if score else "")
            draw.text((8, r * (h + pad) + 7), text, fill=(235, 235, 235))
            for c, im in enumerate(imgs):
                sheet.paste(Image.fromarray(im), (c * w, r * (h + pad) + pad))
        draw.text(((cols_n) * w + 8, 7), "overview (outside the recorded path)", fill=(235, 235, 235))
        sheet.save(args.sheet, quality=90)
        print(f"Sheet: {args.sheet}")


if __name__ == "__main__":
    main()
