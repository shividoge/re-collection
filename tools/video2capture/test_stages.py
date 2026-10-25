"""Pure-logic tests for the conversion stages (no model, no GPU, no network):
    .venv/bin/python -m unittest -v test_stages
align/decode/estimate/package tests need numpy only; the fusion and splat ones need torch."""

import json
import math
import tempfile
import unittest
from pathlib import Path

import numpy as np

import align
import convert
import decode
import estimate
import package


def rot(axis: str, a: float) -> np.ndarray:
    c, s = math.cos(a), math.sin(a)
    return {"x": np.array([[1, 0, 0], [0, c, -s], [0, s, c]]), "y": np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]]),
            "z": np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])}[axis]


def pose(eye, yaw=0.0) -> np.ndarray:
    T = np.eye(4)
    T[:3, :3] = rot("y", yaw)
    T[:3, 3] = eye
    return T


K = np.array([[100.0, 0, 31.5], [0, 100.0, 23.5], [0, 0, 1]])


def room_depth(T: np.ndarray, h: int = 48, w: int = 64) -> np.ndarray:
    """Depth of a camera looking at the wall z = -3 (camera at z, looking down -z, yaw small)."""
    vv, uu = np.mgrid[0:h, 0:w]
    dirs = np.stack([(uu - K[0, 2]) / K[0, 0], -(vv - K[1, 2]) / K[1, 1], -np.ones_like(uu, float)], -1)
    world_dirs = dirs @ T[:3, :3].T
    s = (-3 - T[2, 3]) / world_dirs[..., 2]  # ray parameter to the plane
    return (s * 1.0).astype(np.float32)  # camera-space z of dirs is -1, so depth = s


class Windows(unittest.TestCase):
    def test_one_window_when_it_fits(self):
        self.assertEqual(align.plan_windows(50, 67, 16), [(0, 50)])

    def test_windows_cover_everything_with_enough_overlap(self):
        for n, size, ov in [(99, 32, 8), (2400, 240, 60), (68, 67, 16), (500, 67, 16)]:
            spans = align.plan_windows(n, size, ov)
            self.assertEqual(spans[0][0], 0)
            self.assertEqual(spans[-1][1], n)
            for (s0, e0), (s1, e1) in zip(spans, spans[1:]):
                self.assertEqual(e0 - s0, size)
                self.assertGreaterEqual(e0 - s1, ov)
                self.assertLess(s0, s1)


class Sim3(unittest.TestCase):
    def setUp(self):
        rng = np.random.default_rng(0)
        self.src = rng.normal(size=(500, 3))
        self.R = rot("y", 0.7) @ rot("x", -0.3)
        self.s, self.t = 1.3, np.array([0.5, -2.0, 1.0])
        self.dst = self.s * self.src @ self.R.T + self.t

    def test_umeyama_recovers_a_similarity(self):
        s, R, t = align.umeyama(self.src, self.dst)
        self.assertAlmostEqual(s, self.s, places=6)
        np.testing.assert_allclose(R, self.R, atol=1e-6)
        np.testing.assert_allclose(t, self.t, atol=1e-6)

    def test_robust_fit_ignores_outliers(self):
        dst = self.dst.copy()
        dst[:100] += np.random.default_rng(1).normal(scale=2.0, size=(100, 3))  # a fifth disagree wildly
        s, R, t, resid = align.robust_sim3(self.src, dst)
        self.assertAlmostEqual(s, self.s, places=2)
        np.testing.assert_allclose(R, self.R, atol=1e-2)
        self.assertLess(resid, 0.05)

    def test_pose_moves_with_the_world(self):
        T = pose([0.2, 1.0, 0.5], yaw=0.3)
        p_cam = np.array([0.1, -0.2, -2.0])
        p_world = T[:3, :3] @ p_cam + T[:3, 3]
        T2 = align.apply_sim3_to_pose(self.s, self.R, self.t, T)
        # The same pixel at depth scaled by s lands on the moved world point.
        np.testing.assert_allclose(T2[:3, :3] @ (self.s * p_cam) + T2[:3, 3], self.s * self.R @ p_world + self.t, atol=1e-9)


class Merge(unittest.TestCase):
    def test_windows_in_different_coordinates_are_chained(self):
        """Window b sees the same wall in a world moved by a known Sim(3); merge undoes it."""
        poses = [pose([0.1 * i, 0, 0], yaw=0.02 * i) for i in range(12)]
        depth = np.stack([room_depth(T) for T in poses])
        conf = np.ones_like(depth)
        s, R, t = 0.8, rot("y", 0.4), np.array([1.0, 0.2, -0.5])
        inv = (1 / s, R.T, -R.T @ t / s)  # b's world = the inverse move of a's
        a = estimate.Estimate(depth[:8], conf[:8], poses[:8], [K] * 8, None, True, [(0, 8)], [])
        b_poses = [align.apply_sim3_to_pose(*inv, T) for T in poses[4:]]
        b = estimate.Estimate(depth[4:] / s, conf[4:], b_poses, [K] * 8, None, True, [(4, 12)], [])
        m = estimate.merge(a, b, 4, 8)
        self.assertEqual(len(m.depth), 12)
        self.assertLess(m.align_residuals[0], 1e-6)
        for T, T_true in zip(m.poses, poses):
            np.testing.assert_allclose(T, T_true, atol=1e-6)
        np.testing.assert_allclose(m.depth, depth, rtol=1e-5)


class Budget(unittest.TestCase):
    def test_frames_that_fit(self):
        self.assertEqual(estimate.frames_that_fit(1.0), 0)
        self.assertEqual(estimate.frames_that_fit(1.85 + 0.5 + 0.074 * 67 + 0.01), 67)
        self.assertEqual(estimate.frames_that_fit(100), estimate.MAX_PASS_FRAMES)

    def test_patches_follow_da3_resize(self):
        self.assertEqual(estimate.patches(1920, 1080), 36 * 20)   # 504x280
        self.assertEqual(estimate.patches(1920, 1440), 36 * 27)   # 504x378: 4:3 costs 35% more per frame
        self.assertEqual(estimate.patches(1080, 1920), 20 * 36)
        self.assertLess(estimate.frames_that_fit(8.4, frame_patches=972), estimate.frames_that_fit(8.4))

    def test_frames_needed_for_routing(self):
        self.assertEqual(convert.frames_needed(3.1), 32)
        self.assertEqual(convert.frames_needed(1.0), 16)       # short clips still get 16 views
        self.assertEqual(convert.frames_needed(240.0), 240)    # long videos ask for the most one pass takes

    def test_choose_samples_snaps_to_real_frames(self):
        times = np.arange(0, 3.0, 1 / 30)
        idx = convert.choose_samples(times, 31)
        self.assertEqual(idx[0], 0)
        self.assertEqual(idx[-1], len(times) - 1)
        self.assertEqual(len(idx), 31)


class Decode(unittest.TestCase):
    def test_output_size(self):
        self.assertEqual(decode.output_size(3840, 2160, 0), (1920, 1080))
        self.assertEqual(decode.output_size(1920, 1080, -90), (1080, 1920))
        self.assertEqual(decode.output_size(1281, 721, 0), (1280, 720))

    def test_keyframes_one_per_second(self):
        times = np.arange(0, 3.1, 1 / 30)
        ks = decode.keyframe_indices(times, 3.1 + 1 / 30)
        self.assertEqual([s for s, _ in ks], [0, 1, 2, 3])
        self.assertEqual([i for _, i in ks], [0, 30, 60, 90])

    def test_recording_date_prefers_apple_tag(self):
        tags = {"creation_time": "2026-10-24T22:32:29.000000Z", "com.apple.quicktime.creationdate": "2022-03-05T15:03:45-0500"}
        self.assertEqual(decode.created_at(tags), "2022-03-05T15:03:45-05:00")
        self.assertEqual(decode.created_at({"creation_time": "2026-10-24T22:32:29.000000Z"}), "2026-10-24T22:32:29Z")


class Package(unittest.TestCase):
    def test_depth_grid_never_invents_values(self):
        d = np.full((378, 504), 2.0, np.float32)
        d[:, :252] = 20.0  # beyond what 14 bits of mm hold: no data, not clamped
        usable = np.ones_like(d, bool)
        usable[:10] = False
        mm, c = package.depth_grid(d, np.ones_like(d), usable, has_conf=False)
        self.assertEqual(mm.shape, (192, 256))
        self.assertTrue((mm[:, :128] == 0).all() and (c[:, :128] == 0).all())
        self.assertTrue((mm[10:, 130:] == 2000).all())
        self.assertTrue((mm[:5] == 0).all())
        self.assertEqual(set(np.unique(mm)), {0, 2000})

    def test_frame_lines_exact_poses_at_model_frames(self):
        times = np.arange(10) / 30
        poses = [pose([0, 0, 0]), pose([1, 0, 0], yaw=0.5)]
        lines = [json.loads(l) for l in package.frame_lines(times, [0, 9], poses, [K, K])]
        self.assertEqual([l["d"] for l in lines], [0] + [None] * 8 + [1])
        np.testing.assert_allclose(package.pose_of(lines[9])[0], poses[1])
        np.testing.assert_allclose(package.pose_of(lines[4])[0][:3, 3], [4 / 9, 0, 0], atol=1e-9)

    def test_room_bin_and_depth_round_trip(self):
        rng = np.random.default_rng(0)
        pts, cols = rng.normal(size=(10, 3)).astype(np.float32), rng.integers(0, 255, (10, 3)).astype(np.uint8)
        mm = rng.integers(0, 9000, (3, 192, 256)).astype(np.uint16)
        conf = np.where(mm > 0, 2, 0).astype(np.uint8)
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            package.write_room_bin(out / "room.bin", pts, cols)
            p2, c2 = package.read_room_bin(out / "room.bin")
            np.testing.assert_array_equal(p2, pts)
            np.testing.assert_array_equal(c2, cols)
            for enc in ("v1", "v2"):
                fields = package.write_depth(out, mm, conf, enc)
                manifest = {"depth": {**fields, "count": 3, "width": 256, "height": 192}}
                np.testing.assert_array_equal(package.read_depth(out, manifest), mm)


try:
    import torch
except ImportError:  # numpy-only environment
    torch = None


@unittest.skipIf(torch is None, "needs torch")
class TorchParts(unittest.TestCase):
    def test_voxel_grid_weighted_average_in_batches(self):
        import fusion

        p = torch.tensor([[0.001, 0.001, 0.001], [0.003, 0.003, 0.003], [0.5, 0.5, 0.5]])
        c = torch.tensor([[0.0, 0, 0], [100, 100, 100], [255, 255, 255]])
        g = fusion.VoxelGrid(0.01, p.device)
        g.add(p[:1], c[:1], torch.tensor([1.0]))
        g.add(p[1:], c[1:], torch.tensor([3.0, 1.0]))  # the second point is 3x as confident
        pts, cols, w = g.result()
        self.assertEqual(len(pts), 2)
        self.assertIn(75, cols[:, 0].tolist())
        self.assertAlmostEqual(float(pts[0, 0]), 0.0025, places=6)
        self.assertEqual(sorted(w.tolist()), [1.0, 4.0])

    def test_voxel_keys_handle_negative_coordinates(self):
        import fusion

        p = torch.tensor([[-0.004, 0.0, 0.0], [0.004, 0.0, 0.0], [-0.006, 0.0, 0.0]])
        k = fusion.voxel_keys(p, 0.01)
        self.assertEqual(int(k[0]), int(k[2]))
        self.assertNotEqual(int(k[0]), int(k[1]))

    def test_fuse_room_uses_depth_resolution(self):
        import fusion

        depth = torch.full((2, 48, 64), 2.0)
        keep = torch.ones_like(depth, dtype=torch.bool)
        Ks = torch.tensor(K, dtype=torch.float32).expand(2, 3, 3)
        poses = torch.tensor(np.stack([pose([0, 0, 0]), pose([0, 0, 0])]), dtype=torch.float32)
        pts, cols, w = fusion.fuse_room(depth, keep, Ks, poses, lambda k: torch.full((48, 64, 3), 128.0), [0, 1], 0.0001)
        self.assertEqual(len(pts), 48 * 64)  # one point per pixel, no upsampling
        self.assertTrue(torch.all(w == 2))

    def test_schedule_visits_every_frame_each_pass(self):
        import splat

        order = splat.schedule(10, 4, splat.train_steps(10, 4, 30))
        self.assertEqual(order.shape[1], 4)
        flat = order.reshape(-1)[:100]
        for p in range(10):
            self.assertEqual(sorted(flat[p * 10:(p + 1) * 10].tolist()), list(range(10)))

    def test_prune_keeps_the_most_visible(self):
        import splat

        g = {"means": torch.arange(6.0)[:, None].repeat(1, 3), "opacities": torch.zeros(6)}
        out = splat.prune(g, torch.tensor([0.0, 5.0, 0.2, 9.0, 1.0, 3.0]), keep_max=3)
        self.assertEqual(out["means"][:, 0].tolist(), [1.0, 3.0, 5.0])

    def test_separable_ssim_matches_2d_window(self):
        import torch.nn.functional as F

        import splat

        a, b = torch.rand(2, 3, 40, 50), torch.rand(2, 3, 40, 50)
        g = torch.exp(-((torch.arange(11) - 5.0) ** 2) / (2 * 1.5**2))
        g = g / g.sum()
        win = (g[:, None] * g[None, :]).expand(3, 1, 11, 11)
        blur = lambda x: F.conv2d(x, win, padding=5, groups=3)  # noqa: E731
        mu_a, mu_b = blur(a), blur(b)
        va, vb, cov = blur(a * a) - mu_a**2, blur(b * b) - mu_b**2, blur(a * b) - mu_a * mu_b
        ref = (((2 * mu_a * mu_b + 1e-4) * (2 * cov + 9e-4)) / ((mu_a**2 + mu_b**2 + 1e-4) * (va + vb + 9e-4))).mean()
        self.assertAlmostEqual(float(splat.ssim(a, b)), float(ref), places=5)


if __name__ == "__main__":
    unittest.main()
