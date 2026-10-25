"""
3D Gaussian splats of the static room, in the capture's world coordinates (ARKit: meters, y up),
so they line up with room.bin, the camera path and the people replay.

`train` optimises Gaussians against the capture's own video frames with gsplat (3DGS-MCMC
densification), starting from the fused room cloud. People and pets are masked out of the loss,
so they don't get baked into the room; the people replay shows them instead. Nothing is
invented: a Gaussian only survives if it helps reproduce what the camera saw.

(Depth Anything 3 can also predict Gaussians directly, `infer_gs=True`. We tried it: on our clips
it rendered held-out frames worse than the plain points, 17 dB vs 19, against 28 to 34 dB for a
trained splat, and it makes a Gaussian per pixel per view. So it isn't offered.)

Files are standard INRIA 3DGS binary PLYs (docs/capture-format.md, `room.splat`).
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

SH_C0 = 0.28209479177387814
# OpenCV camera (x right, y down, z forward) <-> capture/ARKit camera (x right, y up, looks down -z).
FLIP = torch.diag(torch.tensor([1.0, -1.0, -1.0, 1.0]))


def viewmats(c2w: torch.Tensor) -> torch.Tensor:
    """Capture camera-to-world (N, 4, 4) -> gsplat world-to-camera (OpenCV camera axes)."""
    return FLIP.to(c2w) @ torch.linalg.inv(c2w)


def _gauss_blur(x: torch.Tensor) -> torch.Tensor:
    """11-tap Gaussian (sigma 1.5) blur of (B, C, H, W), separable: two 1D passes."""
    g = torch.exp(-((torch.arange(11, device=x.device, dtype=x.dtype) - 5.0) ** 2) / (2 * 1.5**2))
    g = g / g.sum()
    c = x.shape[1]
    x = F.conv2d(x, g.view(1, 1, 11, 1).expand(c, 1, 11, 1), padding=(5, 0), groups=c)
    return F.conv2d(x, g.view(1, 1, 1, 11).expand(c, 1, 1, 11), padding=(0, 5), groups=c)


def ssim(a: torch.Tensor, b: torch.Tensor) -> torch.Tensor:
    """Mean SSIM of images (B, 3, H, W) in 0..1, 11x11 Gaussian window (same value as the usual
    2D-window SSIM; fused_ssim's CUDA kernel is used for training when it's installed)."""
    mu_a, mu_b = _gauss_blur(a), _gauss_blur(b)
    va, vb, cov = _gauss_blur(a * a) - mu_a**2, _gauss_blur(b * b) - mu_b**2, _gauss_blur(a * b) - mu_a * mu_b
    c1, c2 = 0.01**2, 0.03**2
    s = ((2 * mu_a * mu_b + c1) * (2 * cov + c2)) / ((mu_a**2 + mu_b**2 + c1) * (va + vb + c2))
    return s.mean()


def training_ssim():
    """fused_ssim (much faster, same formula) when installed, else `ssim`."""
    try:
        from fused_ssim import fused_ssim

        return lambda a, b: fused_ssim(a, b, padding="same")
    except ImportError:
        return ssim


# ---------- PLY ----------

def write_ply(path: Path, means: np.ndarray, scales_log: np.ndarray, quats_wxyz: np.ndarray,
              opacity_logit: np.ndarray, sh: np.ndarray, comment: str) -> None:
    """INRIA 3DGS layout. `sh` is (N, K, 3): K = (degree+1)^2 coefficients per colour channel,
    DC first. f_rest is channel-major (all of R's coefficients, then G's, then B's)."""
    n, k, _ = sh.shape
    rest = sh[:, 1:, :].transpose(0, 2, 1).reshape(n, -1)
    names = (["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2"] + [f"f_rest_{i}" for i in range(rest.shape[1])]
             + ["opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"])
    data = np.concatenate([means, sh[:, 0, :], rest, opacity_logit[:, None], scales_log, quats_wxyz], axis=1)
    header = ("ply\nformat binary_little_endian 1.0\n" + f"comment {comment}\n" + f"element vertex {n}\n"
              + "".join(f"property float {p}\n" for p in names) + "end_header\n")
    with open(path, "wb") as f:
        f.write(header.encode())
        f.write(np.ascontiguousarray(data, dtype="<f4").tobytes())


def read_ply(path: Path) -> dict[str, np.ndarray]:
    """The inverse of write_ply (only float properties, as written above)."""
    raw = Path(path).read_bytes()
    end = raw.index(b"end_header\n") + len(b"end_header\n")
    lines = raw[:end].decode().splitlines()
    n = next(int(l.split()[2]) for l in lines if l.startswith("element vertex"))
    names = [l.split()[2] for l in lines if l.startswith("property float")]
    data = np.frombuffer(raw, dtype="<f4", offset=end, count=n * len(names)).reshape(n, len(names))
    col = {name: i for i, name in enumerate(names)}
    rest = sorted((c for c in names if c.startswith("f_rest_")), key=lambda c: int(c.split("_")[2]))
    k = 1 + len(rest) // 3
    sh = np.zeros((n, k, 3), np.float32)
    sh[:, 0] = data[:, [col["f_dc_0"], col["f_dc_1"], col["f_dc_2"]]]
    if rest:
        sh[:, 1:] = data[:, [col[c] for c in rest]].reshape(n, 3, k - 1).transpose(0, 2, 1)
    pick = lambda *c: data[:, [col[x] for x in c]]  # noqa: E731
    return {"means": pick("x", "y", "z"), "scales": pick("scale_0", "scale_1", "scale_2"),
            "quats": pick("rot_0", "rot_1", "rot_2", "rot_3"), "opacities": data[:, col["opacity"]], "sh": sh}


# ---------- rendering (training and evaluation) ----------

def render(g: dict[str, torch.Tensor], c2w: torch.Tensor, K: torch.Tensor, width: int, height: int,
           sh_degree: int, with_depth: bool = False) -> tuple[torch.Tensor, torch.Tensor, dict]:
    """Render one view. `g` holds raw parameters: means, scales (log), quats, opacities (logit),
    sh (N, K, 3). Returns RGB (H, W, 3) in 0..1 (plus expected depth as a 4th channel with
    `with_depth`), alpha (H, W) and gsplat's info."""
    from gsplat import rasterization

    img, alpha, info = rasterization(
        g["means"], F.normalize(g["quats"], dim=-1), torch.exp(g["scales"]), torch.sigmoid(g["opacities"]),
        g["sh"], viewmats(c2w[None]), K[None], width, height, sh_degree=sh_degree, packed=False,
        rasterize_mode="antialiased", render_mode="RGB+ED" if with_depth else "RGB")
    img = img[0]
    rgb = img[..., :3].clamp(0, 1)
    return (torch.cat([rgb, img[..., 3:]], -1) if with_depth else rgb), alpha[0, ..., 0], info


def tensors(p: dict[str, np.ndarray], device: torch.device) -> dict[str, torch.Tensor]:
    return {"means": torch.as_tensor(p["means"], device=device), "scales": torch.as_tensor(p["scales"], device=device),
            "quats": torch.as_tensor(p["quats"], device=device), "opacities": torch.as_tensor(p["opacities"], device=device),
            "sh": torch.as_tensor(p["sh"], device=device)}


def points_as_gaussians(points: np.ndarray, colors: np.ndarray, size: float) -> dict[str, np.ndarray]:
    """room.bin's dots as small round, opaque Gaussians: how the point cloud looks, for comparing
    it with a splat in the same renderer."""
    n = len(points)
    return {"means": points.astype(np.float32), "scales": np.full((n, 3), math.log(size / 2), np.float32),
            "quats": np.tile(np.array([1, 0, 0, 0], np.float32), (n, 1)), "opacities": np.full(n, 4.0, np.float32),
            "sh": ((colors.astype(np.float32) / 255 - 0.5) / SH_C0)[:, None, :]}


# ---------- training ----------

def neighbour_spacing(points: np.ndarray, k: int = 3) -> np.ndarray:
    """Mean distance from each point to its k nearest neighbours."""
    from scipy.spatial import cKDTree

    d, _ = cKDTree(points).query(points, k=k + 1, workers=-1)
    return d[:, 1:].mean(1).astype(np.float32)


def schedule(n: int, batch: int, steps: int, seed: int = 0) -> torch.Tensor:
    """Frame indices (steps, batch): consecutive random passes over all n frames."""
    rng = np.random.default_rng(seed)
    order = np.concatenate([rng.permutation(n) for _ in range(-(-steps * batch // n))])
    return torch.from_numpy(order[: steps * batch].reshape(steps, batch))


def train_steps(n: int, batch: int, passes: float) -> int:
    """Optimiser steps for `passes` passes over n frames, `batch` frames per step."""
    return max(100, math.ceil(passes * n / batch))


def train(points: torch.Tensor, colors: torch.Tensor, images: torch.Tensor, masks: torch.Tensor,
          poses: torch.Tensor, Ks: torch.Tensor, depths: torch.Tensor, passes: float = 30, batch: int = 4,
          sh_degree: int = 1, cap: int = 800_000, depth_weight: float = 0.2, empty_weight: float = 0.1,
          log=print, checkpoint=lambda: None, progress=lambda fraction: None) -> dict[str, torch.Tensor]:
    """Optimise Gaussians so they reproduce the training frames, `batch` frames per step.
    points (P, 3), colors (P, 3) 0..255: the fused room cloud (initial Gaussians).
    images (N, H, W, 3) uint8, masks (N, H, W) bool (True = moving thing, ignored by the loss),
    poses (N, 4, 4) capture camera-to-world, Ks (N, 3, 3) at the images' resolution.
    depths (N, h, w): the model's depth for these frames on the depth grid, 0 where it isn't
    trusted (edges, people, sky). Matching it keeps the splat's shape sensible away from the
    recorded path: with little camera motion, colour alone lets Gaussians smear along the rays.
    Inside the masks the splat is nudged towards transparent (`empty_weight`): a wall another
    frame shows keeps its colour, but nothing is made up behind someone who never moved.
    A small per-frame colour gain/offset absorbs the camera's auto-exposure; it is not exported.
    No step reads a value back from the GPU except the progress log."""
    from gsplat import rasterization
    from gsplat.strategy import MCMCStrategy

    dev = images.device
    n, H, W, _ = images.shape
    B = min(batch, n)
    steps = train_steps(n, B, passes)
    if len(points) > cap // 2:  # start from a random half of the budget; MCMC adds the rest where needed
        pick = torch.randperm(len(points), device=points.device)[: cap // 2]
        points, colors = points[pick], colors[pick]
    centres = poses[:, :3, 3]
    scene_scale = float((centres - centres.mean(0)).norm(dim=1).max().clamp_min(0.5)) * 1.1

    # Initial size: the distance to the nearest neighbours, so the room starts closed but not blobby.
    nn = torch.as_tensor(neighbour_spacing(points.cpu().numpy()), device=dev)
    k = (sh_degree + 1) ** 2
    sh = torch.zeros((len(points), k, 3), device=dev)
    sh[:, 0] = (colors.float() / 255 - 0.5) / SH_C0
    params = torch.nn.ParameterDict({
        "means": torch.nn.Parameter(points.clone()),
        "scales": torch.nn.Parameter(torch.log(nn.clamp(1e-4, 0.05))[:, None].repeat(1, 3)),
        "quats": torch.nn.Parameter(F.normalize(torch.randn(len(points), 4, device=dev), dim=-1)),
        "opacities": torch.nn.Parameter(torch.logit(torch.full((len(points),), 0.5, device=dev))),
        "sh0": torch.nn.Parameter(sh[:, :1].contiguous()),
        "shN": torch.nn.Parameter(sh[:, 1:].contiguous()),
    })
    # Batches average B frames' gradients: scale the learning rates by sqrt(B), as gsplat does.
    lr = {"means": 1.6e-4 * scene_scale, "scales": 5e-3, "quats": 1e-3, "opacities": 5e-2, "sh0": 2.5e-3, "shN": 2.5e-3 / 20}
    optimizers = {name: torch.optim.Adam([params[name]], lr=lr[name] * math.sqrt(B), eps=1e-15 / math.sqrt(B))
                  for name in params}
    means_decay = torch.optim.lr_scheduler.ExponentialLR(optimizers["means"], gamma=0.01 ** (1.0 / steps))
    exposure = torch.nn.Parameter(torch.zeros((n, 2, 3), device=dev))  # per frame: log gain, offset
    exposure_opt = torch.optim.Adam([exposure], lr=1e-3 * math.sqrt(B))

    every = max(5, round(steps / 70))
    strategy = MCMCStrategy(cap_max=cap, refine_start_iter=every * 5, refine_stop_iter=int(steps * 0.8),
                            refine_every=every, verbose=False)
    strategy.check_sanity(params, optimizers)
    state = strategy.initialize_state()
    ssim_fn = training_ssim()

    dh, dw = depths.shape[1:]
    iv = ((torch.arange(dh, device=dev) + 0.5) * H / dh).long().clamp_max(H - 1)
    iu = ((torch.arange(dw, device=dev) + 0.5) * W / dw).long().clamp_max(W - 1)
    order = schedule(n, B, steps).to(dev)
    sh_at = steps // 7
    log_every = max(1, steps // 7)
    log(f"    {steps} steps of {B} frames ({passes:g} passes over {n})")
    for step in range(steps):
        if step % 50 == 0:
            checkpoint()
            progress(step / steps)
        idx = order[step]
        degree = min(sh_degree, step // sh_at) if sh_at else sh_degree
        colors_sh = torch.cat([params["sh0"], params["shN"]], 1)
        out, alpha, info = rasterization(
            params["means"], F.normalize(params["quats"], dim=-1), torch.exp(params["scales"]),
            torch.sigmoid(params["opacities"]), colors_sh, viewmats(poses[idx]), Ks[idx], W, H,
            sh_degree=degree, packed=False, rasterize_mode="antialiased", render_mode="RGB+ED")
        e = exposure[idx]
        img = out[..., :3].clamp(0, 1) * torch.exp(e[:, 0])[:, None, None, :] + e[:, 1][:, None, None, :]
        gt = images[idx].float() / 255
        m = masks[idx]
        pred = torch.where(m[..., None], gt, img)  # moving things: no gradient
        loss = 0.8 * (pred - gt).abs().mean() + 0.2 * (1 - ssim_fn(pred.permute(0, 3, 1, 2), gt.permute(0, 3, 1, 2)))
        mf = m.float()
        loss = loss + empty_weight * (alpha[..., 0] * mf).sum() / mf.sum().clamp_min(1)
        d_ref = depths[idx]
        sure = (d_ref > 0).float()
        ed = out[..., 3][:, iv][:, :, iu]
        loss = loss + depth_weight * ((ed - d_ref).abs() / d_ref.clamp_min(1e-3) * sure).sum() / sure.sum().clamp_min(1)
        # MCMC's regularisers (prefer few, small Gaussians), plus no needles: a Gaussian may be at
        # most 10 times longer than it is wide.
        scales = torch.exp(params["scales"])
        loss = loss + 0.01 * torch.sigmoid(params["opacities"]).mean() + 0.01 * scales.mean()
        loss = loss + 0.1 * F.relu(scales.max(1).values / scales.min(1).values.clamp_min(1e-8) - 10).mean()
        loss.backward()
        for opt in [*optimizers.values(), exposure_opt]:
            opt.step()
            opt.zero_grad(set_to_none=True)
        means_decay.step()
        strategy.step_post_backward(params, optimizers, state, step, info, lr=means_decay.get_last_lr()[0])
        if step % log_every == 0 or step == steps - 1:
            log(f"    step {step:5d}  loss {loss.item():.4f}  gaussians {len(params['means']):,}")

    g = {"means": params["means"].detach(), "scales": params["scales"].detach(),
         "quats": F.normalize(params["quats"].detach(), dim=-1), "opacities": params["opacities"].detach(),
         "sh": torch.cat([params["sh0"], params["shN"]], 1).detach()}
    return g


def contributions(g: dict[str, torch.Tensor], poses: torch.Tensor, Ks: torch.Tensor, masks: torch.Tensor,
                  batch: int = 4) -> torch.Tensor:
    """How much each Gaussian shows in the training frames: the sum, over every pixel that isn't a
    person or pet, of its blending weight there (exact: the gradient of the rendered image with
    respect to a per-Gaussian colour of 1). 0 for Gaussians no frame saw, or saw only behind people."""
    from gsplat import rasterization

    n, H, W = masks.shape
    ones = torch.ones((len(g["means"]), 3), device=masks.device, requires_grad=True)
    for s in range(0, n, batch):
        img, _, _ = rasterization(g["means"], g["quats"], torch.exp(g["scales"]), torch.sigmoid(g["opacities"]), ones,
                                  viewmats(poses[s:s + batch]), Ks[s:s + batch], W, H, sh_degree=None, packed=False,
                                  rasterize_mode="antialiased")
        (img[..., 0] * (~masks[s:s + batch]).float()).sum().backward()
    return ones.grad[:, 0].detach()


def prune(g: dict[str, torch.Tensor], contrib: torch.Tensor, keep_max: int, min_contrib: float = 0.5) -> dict[str, torch.Tensor]:
    """Drop Gaussians no frame showed (less than `min_contrib` of a pixel in total), then keep
    the `keep_max` that show the most."""
    alive = torch.nonzero(contrib >= min_contrib)[:, 0]
    if len(alive) > keep_max:
        alive = alive[torch.topk(contrib[alive], keep_max).indices]
    alive = alive.sort().values
    return {k: v[alive] for k, v in g.items()}


def train_from_package(capture: Path, masks_model, device: str, holdout_frames: list[int] | None = None,
                       passes: float = 30, batch: int = 4, width: int = 1280, cap: int = 800_000,
                       keep_max: int = 500_000, sh_degree: int = 1, log=print, checkpoint=lambda: None,
                       progress=lambda fraction: None, timings: dict | None = None,
                       max_views: int = 240) -> dict[str, np.ndarray]:
    """Train the room splat from a capture package on disk (video.mp4, frames.jsonl, depth,
    room.bin): the model frames (lines with `d`) minus `holdout_frames`. Same inputs whether it
    runs right after the conversion or as the GPU worker's separate splat job. At most
    `max_views` frames, evenly spread, so memory stays bounded for long videos."""
    import json
    import time

    import decode
    import fusion
    import package

    t0 = time.perf_counter()
    timings = timings if timings is not None else {}
    dev = torch.device(device)
    manifest = json.loads((capture / "manifest.json").read_text())
    lines = [l for l in package.read_frames(capture / "frames.jsonl") if l.get("d") is not None]
    skip = set(holdout_frames or [])
    lines = [l for l in lines if l["i"] not in skip]
    if len(lines) < 2:
        raise decode.ConvertError("Fewer than two frames with depth to train the splat on.")
    if len(lines) > max_views:  # a long video: an even selection keeps memory bounded
        lines = [lines[int(j)] for j in np.linspace(0, len(lines) - 1, max_views).round()]
    info = decode.probe(capture / manifest["video"]["file"])
    dec = decode.decode(info, [l["i"] for l in lines], width, None, checkpoint=checkpoint)
    images_cpu = torch.from_numpy(np.stack([dec.frames[l["i"]] for l in lines]))
    _, H, W, _ = images_cpu.shape
    masks = masks_model(images_cpu).to(dev)
    images = images_cpu.to(dev)
    mm = package.read_depth(capture, manifest)
    depths = torch.from_numpy(np.stack([mm[l["d"]] for l in lines]).astype(np.float32) / 1000).to(dev)
    depths = torch.where(fusion.resize_mask(masks, *depths.shape[1:]), torch.zeros_like(depths), depths)
    poses, Ks = [], []
    for l in lines:
        T, K = package.pose_of(l)
        poses.append(T)
        Ks.append(fusion.scale_K(torch.tensor(K, dtype=torch.float32), W / info.width, H / info.height))
    poses_t = torch.tensor(np.stack(poses), dtype=torch.float32, device=dev)
    Ks_t = torch.stack(Ks).to(dev)
    pts, cols = package.read_room_bin(capture / manifest["room"]["bin"])
    if device == "cuda":
        torch.cuda.synchronize()
    timings["splat prep"] = round(time.perf_counter() - t0, 2)
    t0 = time.perf_counter()
    log(f"    training on {len(lines)} frames at {W}x{H}, starting from {len(pts):,} points")
    g = train(torch.from_numpy(pts).to(dev), torch.from_numpy(cols).to(dev), images, masks, poses_t, Ks_t, depths,
              passes=passes, batch=batch, sh_degree=sh_degree, cap=cap, log=log, checkpoint=checkpoint, progress=progress)
    if device == "cuda":
        torch.cuda.synchronize()
    timings["splat train"] = round(time.perf_counter() - t0, 2)
    t0 = time.perf_counter()
    contrib = contributions(g, poses_t, Ks_t, masks)
    before = len(g["means"])
    g = prune(g, contrib, keep_max)
    log(f"    kept {len(g['means']):,} of {before:,} Gaussians (the rest no frame showed, or showed least)")
    out = {k: v.float().cpu().numpy() for k, v in g.items()}
    timings["splat prune"] = round(time.perf_counter() - t0, 2)
    return out
