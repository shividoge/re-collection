"""
Cleaning and fusing Depth Anything 3's per-frame depth into one room point cloud.

All geometry here is in the capture convention (ARKit: meters, y up, the camera looks down -z).
Depth `d` is the distance along the camera's viewing axis, like ARKit's depth. Everything runs
on torch tensors so the same code works on CUDA, MPS or CPU.
"""

from __future__ import annotations

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


def voxel_downsample(points: torch.Tensor, colors: torch.Tensor, voxel: float) -> tuple[torch.Tensor, torch.Tensor]:
    """Average points and colours (float 0..255) per voxel."""
    keys = torch.floor(points / voxel).long()
    _, inverse, counts = torch.unique(keys, dim=0, return_inverse=True, return_counts=True)
    m = counts.numel()
    psum = torch.zeros((m, 3), device=points.device, dtype=torch.float64).index_add_(0, inverse, points.double())
    csum = torch.zeros((m, 3), device=points.device, dtype=torch.float64).index_add_(0, inverse, colors.double())
    c = counts[:, None].double()
    return (psum / c).float(), (csum / c).round().clamp(0, 255).to(torch.uint8)


def moving_masks(frames: torch.Tensor, device: torch.device, score: float = 0.5, batch: int = 4) -> torch.Tensor:
    """People and pets in each frame (N, H, W, 3 uint8 on CPU) -> bool (N, H, W), from
    torchvision's Mask R-CNN (COCO). Used to keep moving people out of the static room and out
    of the splat training loss; they stay in the per-frame depth for the people replay."""
    from torchvision.models.detection import MaskRCNN_ResNet50_FPN_V2_Weights, maskrcnn_resnet50_fpn_v2

    model = maskrcnn_resnet50_fpn_v2(weights=MaskRCNN_ResNet50_FPN_V2_Weights.DEFAULT).eval().to(device)
    n, h, w, _ = frames.shape
    out = torch.zeros((n, h, w), dtype=torch.bool)
    with torch.no_grad():
        for s in range(0, n, batch):
            imgs = [f.to(device).permute(2, 0, 1).float() / 255 for f in frames[s:s + batch]]
            for k, det in enumerate(model(imgs)):
                hit = (det["scores"] >= score) & torch.isin(det["labels"], torch.tensor(MOVING_LABELS, device=device))
                if hit.any():
                    out[s + k] = (det["masks"][hit, 0] >= 0.5).any(0).cpu()
    del model
    if device.type == "cuda":
        torch.cuda.empty_cache()
    return dilate(out, max(3, w // 100))


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
              colors: torch.Tensor, frames: list[int], upsample: int, voxel: float) -> tuple[torch.Tensor, torch.Tensor]:
    """Fuse the kept pixels of `frames` into one coloured cloud, at `upsample` times the depth
    resolution. Depth is bilinear-upsampled only inside surfaces: `keep` already excludes
    edges, so no pixel blends across a depth jump. `colors` are float RGB frames (N, H*up, W*up, 3)
    resampled from the full-resolution video."""
    n, h, w = depth.shape
    H, W = h * upsample, w * upsample
    pts, cols = [], []
    for k in frames:
        d = F.interpolate(depth[k][None, None], size=(H, W), mode="bilinear", align_corners=False)[0, 0]
        m = F.interpolate(keep[k][None, None].float(), size=(H, W), mode="nearest")[0, 0] > 0
        K = scale_K(Ks[k], W / w, H / h)
        world = unproject(d, K, poses[k])
        pts.append(world[m])
        cols.append(colors[k][m])
    if not pts:
        raise ValueError("no frames to fuse")
    return voxel_downsample(torch.cat(pts), torch.cat(cols), voxel)
