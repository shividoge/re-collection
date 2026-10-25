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


def ssim(a: torch.Tensor, b: torch.Tensor) -> torch.Tensor:
    """Mean SSIM of two images (B, 3, H, W) in 0..1, 11x11 Gaussian window."""
    g = torch.exp(-((torch.arange(11, device=a.device) - 5.0) ** 2) / (2 * 1.5**2))
    g = (g / g.sum()).to(a.dtype)
    win = (g[:, None] * g[None, :]).expand(3, 1, 11, 11)
    blur = lambda x: F.conv2d(x, win, padding=5, groups=3)  # noqa: E731
    mu_a, mu_b = blur(a), blur(b)
    va, vb, cov = blur(a * a) - mu_a**2, blur(b * b) - mu_b**2, blur(a * b) - mu_a * mu_b
    c1, c2 = 0.01**2, 0.03**2
    s = ((2 * mu_a * mu_b + c1) * (2 * cov + c2)) / ((mu_a**2 + mu_b**2 + c1) * (va + vb + c2))
    return s.mean()


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


def train(points: torch.Tensor, colors: torch.Tensor, images: torch.Tensor, masks: torch.Tensor,
          poses: torch.Tensor, Ks: torch.Tensor, depths: torch.Tensor, steps: int = 7000, sh_degree: int = 1,
          cap: int = 1_000_000, depth_weight: float = 0.2, empty_weight: float = 0.1, log=print) -> dict[str, np.ndarray]:
    """Optimise Gaussians so they reproduce the training frames.
    points (P, 3), colors (P, 3) 0..255: the fused room cloud (initial Gaussians).
    images (N, H, W, 3) uint8, masks (N, H, W) bool (True = moving thing, ignored by the loss),
    poses (N, 4, 4) capture camera-to-world, Ks (N, 3, 3) at the images' resolution.
    depths (N, h, w): the model's depth for these frames, 0 where it shouldn't be trusted (edges,
    people, sky); any resolution. Matching it keeps the splat's shape sensible away from the
    recorded path: with little camera motion, colour alone lets Gaussians smear along the rays.
    Inside the masks the splat is nudged towards transparent (`empty_weight`): a wall another
    frame shows keeps its colour, but nothing is made up behind someone who never moved.
    A small per-frame colour gain/offset absorbs the camera's auto-exposure; it is not exported."""
    from gsplat.strategy import MCMCStrategy

    dev = images.device
    if len(points) > cap // 2:  # start from a random half of the budget; MCMC adds the rest where needed
        pick = torch.randperm(len(points), device=points.device)[: cap // 2]
        points, colors = points[pick], colors[pick]
    n, H, W, _ = images.shape
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
    lr = {"means": 1.6e-4 * scene_scale, "scales": 5e-3, "quats": 1e-3, "opacities": 5e-2, "sh0": 2.5e-3, "shN": 2.5e-3 / 20}
    optimizers = {name: torch.optim.Adam([params[name]], lr=lr[name], eps=1e-15) for name in params}
    means_decay = torch.optim.lr_scheduler.ExponentialLR(optimizers["means"], gamma=0.01 ** (1.0 / steps))
    exposure = torch.nn.Parameter(torch.zeros((n, 2, 3), device=dev))  # per frame: log gain, offset
    exposure_opt = torch.optim.Adam([exposure], lr=1e-3)

    strategy = MCMCStrategy(cap_max=cap, refine_stop_iter=int(steps * 0.8), verbose=False)
    strategy.check_sanity(params, optimizers)
    state = strategy.initialize_state()

    target_depth = F.interpolate(depths[:, None], size=(H, W), mode="nearest")[:, 0]
    order = torch.randperm(n, device=dev)
    for step in range(steps):
        i = int(order[step % n])
        if step % n == n - 1:
            order = torch.randperm(n, device=dev)
        degree = min(sh_degree, step // 1000)
        g = {"means": params["means"], "scales": params["scales"], "quats": params["quats"],
             "opacities": params["opacities"], "sh": torch.cat([params["sh0"], params["shN"]], 1)}
        out, alpha, info = render(g, poses[i], Ks[i], W, H, degree, with_depth=True)
        img = out[..., :3] * torch.exp(exposure[i, 0]) + exposure[i, 1]
        gt = images[i].float() / 255
        keep = ~masks[i][..., None]
        pred = torch.where(keep, img, gt)  # moving things: no gradient
        l1 = (pred - gt).abs().mean()
        loss = 0.8 * l1 + 0.2 * (1 - ssim(pred.permute(2, 0, 1)[None], gt.permute(2, 0, 1)[None]))
        if masks[i].any():  # where people stood: empty unless other frames show what's there
            loss = loss + empty_weight * alpha[masks[i]].mean()
        d_ref = target_depth[i]
        sure = d_ref > 0
        if sure.any():
            loss = loss + depth_weight * ((out[..., 3][sure] - d_ref[sure]).abs() / d_ref[sure]).mean()
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
        if step % 1000 == 0 or step == steps - 1:
            log(f"    step {step:5d}  loss {loss.item():.4f}  gaussians {len(params['means']):,}")

    with torch.no_grad():
        g = {"means": params["means"], "scales": params["scales"], "quats": params["quats"],
             "opacities": params["opacities"], "sh": torch.cat([params["sh0"], params["shN"]], 1)}
        alive = (torch.sigmoid(params["opacities"]) > 0.005) & seen(g, masks, poses, Ks, sh_degree)
        log(f"    kept {int(alive.sum()):,} of {len(alive):,} Gaussians (the rest no frame saw)")
        out = {k: v[alive] for k, v in g.items()}
        out["quats"] = F.normalize(out["quats"], dim=-1)
    return {k: v.detach().float().cpu().numpy() for k, v in out.items()}


def seen(g: dict[str, torch.Tensor], masks: torch.Tensor, poses: torch.Tensor, Ks: torch.Tensor,
         sh_degree: int, slack: float = 0.05) -> torch.Tensor:
    """Which Gaussians some training frame actually saw: the centre lands inside the frame, on a
    pixel that isn't a person or pet, and isn't hidden behind the rendered surface there (within
    `slack`). The rest were never checked against the video (behind people who never moved, or
    outside every frame) and are dropped instead of shown as smears."""
    n, H, W = masks.shape
    ok = torch.zeros(len(g["means"]), dtype=torch.bool, device=masks.device)
    for i in range(n):
        out, alpha, _ = render(g, poses[i], Ks[i], W, H, sh_degree, with_depth=True)
        depth = out[..., 3]
        cam = (g["means"] - poses[i][:3, 3]) @ poses[i][:3, :3]  # world -> capture camera
        z = -cam[:, 2]
        zs = z.clamp_min(1e-6)
        u = (Ks[i][0, 0] * cam[:, 0] / zs + Ks[i][0, 2]).round().long()
        v = (-Ks[i][1, 1] * cam[:, 1] / zs + Ks[i][1, 2]).round().long()
        inside = (z > 0) & (u >= 0) & (u < W) & (v >= 0) & (v < H)
        uc, vc = u.clamp(0, W - 1), v.clamp(0, H - 1)
        in_front = (alpha[vc, uc] < 0.5) | (z <= depth[vc, uc] * (1 + slack))  # nothing solid in front of it
        ok |= inside & ~masks[i][vc, uc] & in_front
    return ok
