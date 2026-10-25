"""
Cleaning and fusing Depth Anything 3's per-frame depth into one room point cloud.

All geometry here is in the capture convention (ARKit: meters, y up, the camera looks down -z).
Depth `d` is the distance along the camera's viewing axis, like ARKit's depth. Everything runs
on torch tensors so the same code works on CUDA, MPS or CPU.
"""

from __future__ import annotations

import math
from typing import Callable

import torch
import torch.nn.functional as F

from decode import ConvertError

# COCO labels (torchvision numbering) for things that move during a visit and must not become
# part of the static room: people and pets.
MOVING_LABELS = (1, 17, 18)  # person, cat, dog


def dilate(mask: torch.Tensor, radius: int) -> torch.Tensor:
    """Grow a boolean mask (..., H, W) by `radius` pixels (square)."""
    if radius <= 0:
        return mask
    m = mask.float().reshape(-1, 1, *mask.shape[-2:])
    m = F.max_pool2d(m, 2 * radius + 1, stride=1, padding=radius)
    return m.reshape(mask.shape) > 0


def depth_edges(depth: torch.Tensor, rel: float = 0.04, radius: int = 1) -> torch.Tensor:
    """Pixels next to a depth jump (N, H, W) -> bool. Unprojecting them makes "flying pixels":
    streaks between a person and the wall behind. A jump is a relative difference to any
    4-neighbour above `rel` (0.04 keeps surfaces seen at up to about 87 degrees)."""
    d = depth.clamp_min(1e-6)
    jump = torch.zeros_like(d, dtype=torch.bool)
    dy = (d[:, 1:, :] - d[:, :-1, :]).abs() / torch.minimum(d[:, 1:, :], d[:, :-1, :])
    dx = (d[:, :, 1:] - d[:, :, :-1]).abs() / torch.minimum(d[:, :, 1:], d[:, :, :-1])
    jump[:, 1:, :] |= dy > rel
    jump[:, :-1, :] |= dy > rel
    jump[:, :, 1:] |= dx > rel
    jump[:, :, :-1] |= dx > rel
    return dilate(jump, radius)


def pixel_grid(h: int, w: int, device: torch.device) -> tuple[torch.Tensor, torch.Tensor]:
    v, u = torch.meshgrid(torch.arange(h, device=device, dtype=torch.float32),
                          torch.arange(w, device=device, dtype=torch.float32), indexing="ij")
    return u, v


def unproject(depth: torch.Tensor, K: torch.Tensor, c2w: torch.Tensor) -> torch.Tensor:
    """One frame's depth (H, W) -> world points (H, W, 3). K is [[fx,0,cx],[0,fy,cy],[0,0,1]]
    at this depth map's resolution; c2w is the capture-convention camera-to-world (4x4)."""
    h, w = depth.shape
    u, v = pixel_grid(h, w, depth.device)
    x = (u - K[0, 2]) * depth / K[0, 0]
    y = (v - K[1, 2]) * depth / K[1, 1]
    cam = torch.stack([x, -y, -depth], dim=-1)  # ARKit camera: y up, looking down -z
    return cam @ c2w[:3, :3].T + c2w[:3, 3]


def project(points: torch.Tensor, K: torch.Tensor, c2w: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    """World points (..., 3) -> pixel u, v and depth along the viewing axis in that camera."""
    w2c = torch.linalg.inv(c2w)
    cam = points @ w2c[:3, :3].T + w2c[:3, 3]
    z = -cam[..., 2]
    zs = z.clamp_min(1e-6)
    u = K[0, 0] * cam[..., 0] / zs + K[0, 2]
    v = -K[1, 1] * cam[..., 1] / zs + K[1, 2]
    return u, v, z


def consistency(depth: torch.Tensor, valid: torch.Tensor, Ks: torch.Tensor, poses: torch.Tensor,
                usable: list[int], window: int = 4, rel: float = 0.03, min_agree: int = 2) -> torch.Tensor:
    """Multi-view check (N, H, W) -> bool: a pixel's 3D point is kept only if at least
    `min_agree` nearby frames (within `window` samples, among `usable`) see a surface at the
    same depth (within `rel`). Floaters, "double walls" from misaligned frames and things that
    moved disagree and are dropped. Frames with fewer usable neighbours need fewer agreements."""
    n, h, w = depth.shape
    keep = torch.zeros_like(valid)
    pos = {k: i for i, k in enumerate(usable)}
    for k in usable:
        i = pos[k]
        neighbours = [usable[j] for j in range(max(0, i - window), min(len(usable), i + window + 1)) if j != i]
        if not neighbours:
            keep[k] = valid[k]
            continue
        pts = unproject(depth[k], Ks[k], poses[k])
        agree = torch.zeros((h, w), dtype=torch.int32, device=depth.device)
        for j in neighbours:
            u, v, z = project(pts, Ks[j], poses[j])
            ui, vi = u.round().long(), v.round().long()
            inside = (ui >= 0) & (ui < w) & (vi >= 0) & (vi < h) & (z > 0)
            ui, vi = ui.clamp(0, w - 1), vi.clamp(0, h - 1)
            dj = depth[j][vi, ui]
            ok = inside & valid[j][vi, ui] & ((z - dj).abs() <= rel * dj)
            agree += ok.int()
        keep[k] = valid[k] & (agree >= min(min_agree, len(neighbours)))
    return keep


def voxel_keys(points: torch.Tensor, voxel: float) -> torch.Tensor:
    """One int64 per voxel (21 bits per axis, about ±15 km at 1.5 cm)."""
    q = torch.floor(points / voxel).long() + (1 << 20)
    return (q[:, 0] << 42) | (q[:, 1] << 21) | q[:, 2]


class VoxelGrid:
    """Running weighted sums of positions and colours per voxel, so a long video's frames can be
    fused a batch at a time instead of all at once. With a `limit`, the grid coarsens itself
    whenever it holds more voxels than that (sums add up exactly, so merging voxels loses nothing
    but resolution): memory stays bounded however much surface the video shows."""

    def __init__(self, voxel: float, device: torch.device, limit: int | None = None):
        self.voxel = voxel
        self.limit = limit
        self.keys = torch.zeros(0, dtype=torch.long, device=device)
        self.sums = torch.zeros((0, 7), dtype=torch.float64, device=device)  # w·xyz, w·rgb, w

    def add(self, points: torch.Tensor, colors: torch.Tensor, weights: torch.Tensor) -> None:
        """Adds observations; ones with weight <= 0 or anything non-finite carry no evidence and are
        skipped (a voxel seen only by those would otherwise come out as a black point at 0, 0, 0)."""
        ok = (weights > 0) & torch.isfinite(weights) & torch.isfinite(points).all(1) & torch.isfinite(colors).all(1)
        if not ok.all():
            points, colors, weights = points[ok], colors[ok], weights[ok]
        w = weights.double()[:, None]
        rows = torch.cat([points.double() * w, colors.double() * w, w], 1)
        self._merge(torch.cat([self.keys, voxel_keys(points, self.voxel)]), torch.cat([self.sums, rows]))
        while self.limit is not None and len(self.keys) > self.limit:
            self.coarsen(max(1.2, math.sqrt(len(self.keys) / self.limit)))

    def coarsen(self, factor: float) -> None:
        """Voxels `factor` times bigger; each old voxel goes where its centroid falls."""
        self.voxel *= factor
        centroids = self.sums[:, :3] / self.sums[:, 6:7].clamp_min(1e-12)
        self._merge(voxel_keys(centroids.float(), self.voxel), self.sums)

    def _merge(self, keys: torch.Tensor, rows: torch.Tensor) -> None:
        self.keys, inverse = torch.unique(keys, return_inverse=True)
        self.sums = torch.zeros((len(self.keys), 7), dtype=torch.float64, device=rows.device).index_add_(0, inverse, rows)

    def result(self) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        """(points float32, colours uint8, total weight) per voxel (every weight > 0)."""
        sums = self.sums[self.sums[:, 6] > 0]
        w = sums[:, 6:7]
        return ((sums[:, :3] / w).float(), (sums[:, 3:6] / w).round().clamp(0, 255).to(torch.uint8), sums[:, 6].float())


def voxel_downsample(points: torch.Tensor, colors: torch.Tensor, voxel: float,
                     weights: torch.Tensor | None = None) -> tuple[torch.Tensor, torch.Tensor]:
    """Weighted average of points and colours (float 0..255) per voxel (equal weights by default)."""
    grid = VoxelGrid(voxel, points.device)
    grid.add(points, colors, torch.ones(len(points), device=points.device) if weights is None else weights)
    p, c, _ = grid.result()
    return p, c


class MaskModel:
    """People and pets in frames, from torchvision's Mask R-CNN (COCO), loaded once. Used to keep
    moving people out of the static room and out of the splat training loss; they stay in the
    per-frame depth for the people replay."""

    def __init__(self, device: torch.device):
        from torchvision.models.detection import MaskRCNN_ResNet50_FPN_V2_Weights, maskrcnn_resnet50_fpn_v2

        self.device = device
        self.model = maskrcnn_resnet50_fpn_v2(weights=MaskRCNN_ResNet50_FPN_V2_Weights.DEFAULT).eval().to(device)
        self.labels = torch.tensor(MOVING_LABELS, device=device)

    def __call__(self, frames: torch.Tensor, score: float = 0.5, batch: int = 4) -> torch.Tensor:
        """uint8 (N, H, W, 3) on the CPU -> bool (N, H, W) on the CPU, grown a little at the edges."""
        n, h, w, _ = frames.shape
        out = torch.zeros((n, h, w), dtype=torch.bool)
        with torch.no_grad():
            for s in range(0, n, batch):
                imgs = [f.to(self.device).permute(2, 0, 1).float() / 255 for f in frames[s:s + batch]]
                for k, det in enumerate(self.model(imgs)):
                    hit = (det["scores"] >= score) & torch.isin(det["labels"], self.labels)
                    if hit.any():
                        out[s + k] = (det["masks"][hit, 0] >= 0.5).any(0).cpu()
        return dilate(out, max(3, w // 100))


def moving_masks(frames: torch.Tensor, device: torch.device, score: float = 0.5, batch: int = 4) -> torch.Tensor:
    """One-off MaskModel (loads the model each call; keep a MaskModel to reuse it)."""
    return MaskModel(device)(frames, score, batch)


def scale_K(K: torch.Tensor, sx: float, sy: float) -> torch.Tensor:
    """Intrinsics for an image resized by (sx, sy), with pixel centres at integer coordinates
    (the convention of `unproject` and of align_corners=False resampling)."""
    out = K.clone()
    out[0, 0], out[1, 1] = K[0, 0] * sx, K[1, 1] * sy
    out[0, 2] = (K[0, 2] + 0.5) * sx - 0.5
    out[1, 2] = (K[1, 2] + 0.5) * sy - 0.5
    return out


def resize_mask(mask: torch.Tensor, h: int, w: int) -> torch.Tensor:
    """Bool (N, H, W) -> (N, h, w); a pixel is set if any part of it was."""
    return F.interpolate(mask[:, None].float(), size=(h, w), mode="area")[:, 0] > 0


def resize_images(frames: torch.Tensor, h: int, w: int) -> torch.Tensor:
    """uint8 (N, H, W, 3) -> float 0..255 (N, h, w, 3), area-averaged (antialiased)."""
    x = frames.permute(0, 3, 1, 2).float()
    return F.interpolate(x, size=(h, w), mode="area").permute(0, 2, 3, 1)


def transfer_detail(coarse: torch.Tensor, coarse_ok: torch.Tensor, fine: torch.Tensor,
                    sigma_px: float = 1.0, sigma_log: float = 0.02, radius: int = 2) -> torch.Tensor:
    """Sharp, consistent depth for one frame: `fine` (H, W), a single-frame depth at a higher
    resolution with sharp edges and small objects but a shape the frames don't agree on, takes its
    large-scale shape from `coarse` (h, w), the multi-view depth, where `coarse_ok` is set.

    The per-pixel ratio coarse / fine is measured on the coarse grid and brought up to the fine
    grid with a joint bilateral upsampling guided by the fine depth (Kopf et al. 2007): each fine
    pixel averages the ratios of the coarse pixels around it (Gaussian in distance, `sigma_px`
    coarse pixels) that sit at a similar fine depth (Gaussian in log depth, `sigma_log`), so the
    correction doesn't bleed across an object's edge. Pixels with no usable ratio nearby get the
    frame's median ratio. Returns depth (H, W), 0 where `fine` has none."""
    h, w = coarse.shape
    H, W = fine.shape
    fine_ok = fine > 0
    fine_lo = F.interpolate(fine[None, None], size=(h, w), mode="area")[0, 0]
    ok_lo = coarse_ok & (coarse > 0) & (fine_lo > 0)
    ok_lo &= ~depth_edges(coarse[None])[0] & ~depth_edges(fine_lo[None])[0]
    if not ok_lo.any():
        return torch.zeros_like(fine)
    log_ratio = torch.where(ok_lo, coarse.clamp_min(1e-6).log() - fine_lo.clamp_min(1e-6).log(), 0)
    median = log_ratio[ok_lo].median()
    guide_lo = fine_lo.clamp_min(1e-6).log()

    k = 2 * radius + 1
    def neighbours(x: torch.Tensor) -> torch.Tensor:  # (h, w) -> (k*k, h, w)
        return F.unfold(x[None, None].float(), k, padding=radius)[0].reshape(k * k, h, w)
    nb_ratio, nb_guide, nb_ok = neighbours(log_ratio), neighbours(guide_lo), neighbours(ok_lo)

    # Each fine pixel's position on the coarse grid (pixel centres at integers) and nearest coarse pixel.
    fy = (torch.arange(H, device=fine.device, dtype=torch.float32) + 0.5) * h / H - 0.5
    fx = (torch.arange(W, device=fine.device, dtype=torch.float32) + 0.5) * w / W - 0.5
    cy, cx = fy.round().clamp(0, h - 1).long(), fx.round().clamp(0, w - 1).long()
    off = torch.arange(-radius, radius + 1, device=fine.device, dtype=torch.float32)
    dy = (cy.float() - fy)[None, :] + off[:, None]  # (k, H): row offset of each neighbour
    dx = (cx.float() - fx)[None, :] + off[:, None]  # (k, W)
    spatial = torch.exp(-(dy[:, None, :, None] ** 2 + dx[None, :, None, :] ** 2) / (2 * sigma_px ** 2)).reshape(k * k, H, W)
    guide_hi = fine.clamp_min(1e-6).log()
    g = nb_guide[:, cy][:, :, cx]
    weight = spatial * nb_ok[:, cy][:, :, cx] * torch.exp(-(g - guide_hi[None]) ** 2 / (2 * sigma_log ** 2))
    total = weight.sum(0)
    ratio = (weight * nb_ratio[:, cy][:, :, cx]).sum(0) / total.clamp_min(1e-12)
    # Thin things (a lamp arm) have no coarse pixel of their own: they take the correction of what
    # surrounds them, a wider average that ignores depth, and the frame's median only if nothing does.
    wide = blur_masked(log_ratio, ok_lo, sigma=6 * sigma_px)
    wide = torch.where(torch.isfinite(wide), wide, median)
    wide = F.interpolate(wide[None, None], size=(H, W), mode="bilinear", align_corners=False)[0, 0]
    ratio = torch.where(total > 1e-3, ratio, wide)
    return torch.where(fine_ok, fine * ratio.exp(), torch.zeros_like(fine))


def blur_masked(x: torch.Tensor, ok: torch.Tensor, sigma: float) -> torch.Tensor:
    """Gaussian average (h, w) of `x` over the pixels where `ok`; NaN where none is near."""
    r = max(1, int(3 * sigma))
    t = torch.arange(-r, r + 1, device=x.device, dtype=torch.float32)
    g = torch.exp(-t ** 2 / (2 * sigma ** 2))
    def sep(y: torch.Tensor) -> torch.Tensor:
        y = F.conv2d(y[None, None], g.view(1, 1, 1, -1), padding=(0, r))
        return F.conv2d(y, g.view(1, 1, -1, 1), padding=(r, 0))[0, 0]
    num, den = sep(torch.where(ok, x, 0).float()), sep(ok.float())
    return torch.where(den > 1e-3, num / den.clamp_min(1e-12), torch.full_like(num, float("nan")))


def fuse_room(depth: torch.Tensor, keep: torch.Tensor, Ks: torch.Tensor, poses: torch.Tensor,
              colors: Callable[[int], torch.Tensor], frames: list[int], voxel: float, weights: torch.Tensor | None = None,
              limit: int | None = None, batch_rows: int = 4_000_000) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, float]:
    """Fuse the kept pixels of `frames` into one coloured cloud at the depth maps' own resolution.
    Each voxel is the `weights`-weighted average (the model's confidence) of the pixels that fall in
    it. `colors(k)` is frame k's float RGB (h, w, 3), made on demand so a long video never holds
    them all. Frames are added about `batch_rows` pixels at a time; with a `limit` the voxels grow
    whenever there would be more than that (VoxelGrid). Returns points, uint8 colours, each
    voxel's total weight and the voxel size it ended at."""
    if not frames:
        raise ValueError("no frames to fuse")
    grid = VoxelGrid(voxel, depth.device, limit)
    pts: list[torch.Tensor] = []
    cols: list[torch.Tensor] = []
    ws: list[torch.Tensor] = []
    rows = 0
    for i, k in enumerate(frames):
        m = keep[k]
        pts.append(unproject(depth[k], Ks[k], poses[k])[m])
        cols.append(colors(k)[m])
        ws.append(weights[k][m] if weights is not None else torch.ones(int(m.sum()), device=depth.device))
        rows += len(pts[-1])
        if rows >= batch_rows or i == len(frames) - 1:
            grid.add(torch.cat(pts), torch.cat(cols), torch.cat(ws))
            pts, cols, ws, rows = [], [], [], 0
    points, colours, weight = grid.result()
    if len(points) == 0:
        raise ConvertError("No pixel had usable depth and confidence, so there is no room to build.")
    return points, colours, weight, grid.voxel
