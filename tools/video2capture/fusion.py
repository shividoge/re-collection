"""
Cleaning and fusing Depth Anything 3's per-frame depth into one room point cloud.

All geometry here is in the capture convention (ARKit: meters, y up, the camera looks down -z).
Depth `d` is the distance along the camera's viewing axis, like ARKit's depth. Everything runs
on torch tensors so the same code works on CUDA, MPS or CPU.
"""

from __future__ import annotations

from typing import Callable

import torch
import torch.nn.functional as F

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
    fused a batch at a time instead of all at once."""

    def __init__(self, voxel: float, device: torch.device):
        self.voxel = voxel
        self.keys = torch.zeros(0, dtype=torch.long, device=device)
        self.sums = torch.zeros((0, 7), dtype=torch.float64, device=device)  # w·xyz, w·rgb, w

    def add(self, points: torch.Tensor, colors: torch.Tensor, weights: torch.Tensor) -> None:
        w = weights.double()[:, None]
        rows = torch.cat([points.double() * w, colors.double() * w, w], 1)
        keys = torch.cat([self.keys, voxel_keys(points, self.voxel)])
        rows = torch.cat([self.sums, rows])
        self.keys, inverse = torch.unique(keys, return_inverse=True)
        self.sums = torch.zeros((len(self.keys), 7), dtype=torch.float64, device=rows.device).index_add_(0, inverse, rows)

    def result(self) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        """(points float32, colours uint8, total weight) per voxel."""
        w = self.sums[:, 6:7].clamp_min(1e-12)
        return ((self.sums[:, :3] / w).float(), (self.sums[:, 3:6] / w).round().clamp(0, 255).to(torch.uint8),
                self.sums[:, 6].float())


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


def fuse_room(depth: torch.Tensor, keep: torch.Tensor, Ks: torch.Tensor, poses: torch.Tensor,
              colors: Callable[[int], torch.Tensor], frames: list[int], voxel: float, weights: torch.Tensor | None = None,
              batch: int = 16) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    """Fuse the kept pixels of `frames` into one coloured cloud at the depth maps' own resolution
    (no upsampling: at 1.5 cm voxels several frames already land in every voxel). Each voxel is the
    `weights`-weighted average (the model's confidence) of the pixels that fall in it. `colors(k)` is
    frame k's float RGB (h, w, 3), made on demand so a long video never holds them all. Returns points, uint8 colours and each voxel's total weight."""
    if not frames:
        raise ValueError("no frames to fuse")
    grid = VoxelGrid(voxel, depth.device)
    for s in range(0, len(frames), batch):
        pts, cols, ws = [], [], []
        for k in frames[s:s + batch]:
            m = keep[k]
            pts.append(unproject(depth[k], Ks[k], poses[k])[m])
            cols.append(colors(k)[m])
            ws.append(weights[k][m] if weights is not None else torch.ones(int(m.sum()), device=depth.device))
        grid.add(torch.cat(pts), torch.cat(cols), torch.cat(ws))
    return grid.result()
