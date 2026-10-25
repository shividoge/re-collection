"""Pure-logic tests (no model, no GPU, no network):  .venv/bin/python -m unittest -v test_video2capture"""

import math
import tempfile
import unittest
from pathlib import Path

import numpy as np
import torch

import fusion
import splat
from decode import ConvertError
from estimate import to_capture_pose
from geometry import level_world, leveling


def look(eye, yaw=0.0, pitch=0.0, roll=0.0) -> np.ndarray:
    """Capture-convention camera-to-world: yaw about +y, then pitch about x, then roll about z."""
    def rot(axis, a):
        c, s = math.cos(a), math.sin(a)
        return {"x": np.array([[1, 0, 0], [0, c, -s], [0, s, c]]), "y": np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]]),
                "z": np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])}[axis]
    T = np.eye(4)
    T[:3, :3] = rot("y", yaw) @ rot("x", pitch) @ rot("z", roll)
    T[:3, 3] = eye
    return T


K = torch.tensor([[100.0, 0, 31.5], [0, 100.0, 23.5], [0, 0, 1]])


class Geometry(unittest.TestCase):
    def test_level_world_removes_a_tilted_world(self):
        # A camera that pans while looking 30 degrees down, in a world tilted by 20 degrees.
        tilt = look([0, 0, 0], roll=math.radians(20))
        poses = [tilt @ look([0, 0, 0], yaw=a, pitch=math.radians(-30)) for a in np.linspace(-1, 1, 9)]
        L = level_world(poses)
        for T in poses:
            x = (L @ T)[:3, 0]
            self.assertAlmostEqual(float(x[1]), 0.0, places=6)  # every camera's x axis is level again
        self.assertGreater(float((L @ poses[4])[1, 1]), 0.5)  # and its up still points up

    def test_level_world_without_panning_only_removes_roll(self):
        poses = [look([0, 0, z], pitch=math.radians(-30), roll=math.radians(10)) for z in np.linspace(0, 1, 5)]
        x = (level_world(poses) @ poses[0])[:3, 0]
        self.assertAlmostEqual(float(x[1]), 0.0, places=6)

    def test_level_world_with_a_fixed_camera_keeps_its_up(self):
        # A camera on a stand: yaw and pitch never change, only a little roll jitter. Its x axes then
        # vary within the camera's own x-y plane, so "most perpendicular to every x" is the viewing
        # direction: leveling by it would put the room on its side.
        rng = np.random.default_rng(3)
        for yaw, pitch in ((0.0, -30.0), (40.0, 10.0), (-120.0, 0.0)):
            with self.subTest(yaw=yaw, pitch=pitch):
                poses = [look([0.01 * k, 0, 0], yaw=math.radians(yaw), pitch=math.radians(pitch),
                              roll=math.radians(rng.normal(0, 0.5))) for k in range(30)]
                L, warning = leveling(poses)
                up = (L @ poses[0])[:3, 1]
                self.assertGreater(float(up[1]), 0.999)  # the camera's own up, no invented tilt
                self.assertIsNotNone(warning)

    def test_level_world_with_a_modest_pan_is_confident(self):
        rng = np.random.default_rng(4)
        tilt = look([0, 0, 0], pitch=math.radians(15), roll=math.radians(-10))
        poses = [tilt @ look([0, 0, 0], yaw=a, pitch=math.radians(-20), roll=math.radians(rng.normal(0, 0.5)))
                 for a in np.linspace(-0.3, 0.3, 30)]  # ±17 degrees
        L, warning = leveling(poses)
        self.assertIsNone(warning)
        np.testing.assert_allclose((L @ tilt)[:3, 1], [0, 1, 0], atol=0.03)  # the world tilt is undone

    def test_capture_pose_flips_opencv_axes(self):
        T = to_capture_pose(np.eye(4))
        np.testing.assert_allclose(T, np.eye(4))
        w2c = np.eye(4)
        w2c[:3, 3] = [0, 0, 2]  # OpenCV: the world origin is 2 m in front of the camera
        T = to_capture_pose(w2c)
        np.testing.assert_allclose(T[:3, 3], [0, 0, 2])  # camera sits at z=2 looking down -z at the origin

    def test_unproject_project_round_trip(self):
        T = torch.tensor(look([0.3, 1.2, 2.0], yaw=0.4, pitch=-0.2), dtype=torch.float32)
        d = torch.full((48, 64), 2.0)
        p = fusion.unproject(d, K, T)
        u, v, z = fusion.project(p, K, T)
        uu, vv = fusion.pixel_grid(48, 64, d.device)
        torch.testing.assert_close(u, uu, atol=1e-3, rtol=0)
        torch.testing.assert_close(v, vv, atol=1e-3, rtol=0)
        torch.testing.assert_close(z, d, atol=1e-4, rtol=0)

    def test_scale_K_keeps_pixel_centres(self):
        K2 = fusion.scale_K(K, 2, 2)
        # Pixel 0's centre (0) covers [-0.5, 0.5); at 2x it's pixels 0 and 1, centre 0.5.
        self.assertAlmostEqual(float(K2[0, 2]), (31.5 + 0.5) * 2 - 0.5)
        self.assertAlmostEqual(float(K2[0, 0]), 200.0)


class Filters(unittest.TestCase):
    def test_depth_edges_mark_both_sides_of_a_jump_only(self):
        d = torch.ones(1, 10, 10)
        d[0, :, 5:] = 3.0
        e = fusion.depth_edges(d, radius=0)[0]
        self.assertTrue(e[:, 4].all() and e[:, 5].all())
        self.assertFalse(e[:, :4].any() or e[:, 6:].any())

    def test_depth_edges_keep_a_steep_but_smooth_floor(self):
        d = torch.linspace(1, 1.5, 50)[None, :, None].expand(1, 50, 20).contiguous()  # 1% per pixel
        self.assertFalse(fusion.depth_edges(d)[0].any())

    def test_consistency_drops_a_floater_and_keeps_the_wall(self):
        poses = torch.stack([torch.tensor(look([x, 0, 0]), dtype=torch.float32) for x in np.linspace(-0.2, 0.2, 5)])
        depth = torch.full((5, 48, 64), 2.0)  # a wall 2 m in front of every camera
        depth[2, 20:24, 30:34] = 1.0  # one frame sees a floater the others don't
        valid = torch.ones_like(depth, dtype=torch.bool)
        keep = fusion.consistency(depth, valid, K.expand(5, 3, 3), poses, list(range(5)))
        self.assertFalse(keep[2, 20:24, 30:34].any())
        self.assertTrue(keep[2, 5:15, 5:15].all())

    def test_voxel_downsample_averages(self):
        p = torch.tensor([[0.001, 0.001, 0.001], [0.003, 0.003, 0.003], [0.5, 0.5, 0.5]])
        c = torch.tensor([[0.0, 0, 0], [100, 100, 100], [255, 255, 255]])
        pts, cols = fusion.voxel_downsample(p, c, 0.01)
        self.assertEqual(len(pts), 2)
        self.assertIn(50, cols[:, 0].tolist())

    def test_fuse_room_ignores_zero_confidence_pixels(self):
        # A wall 2 m in front of the camera; the right half has confidence 0 (or NaN), as the
        # model gives pixels without usable depth. Those must not become black points at the origin.
        poses = torch.tensor(look([0, 0, 0]), dtype=torch.float32)[None]
        depth = torch.full((1, 48, 64), 2.0)
        conf = torch.ones(1, 48, 64)
        conf[0, :, 32:] = 0
        conf[0, :4, 32:] = float("nan")
        keep = torch.ones_like(depth, dtype=torch.bool)
        rgb = lambda k: torch.full((48, 64, 3), 200.0)  # noqa: E731
        pts, cols, w, _ = fusion.fuse_room(depth, keep, K[None], poses, rgb, [0], 0.05, weights=conf)
        self.assertGreater(len(pts), 0)
        self.assertTrue(torch.isfinite(pts).all() and (w > 0).all())
        self.assertGreater(float(pts.norm(dim=1).min()), 1.9)  # nothing at (0, 0, 0)
        self.assertTrue((cols == 200).all())
        self.assertTrue((pts[:, 0] < 0.1).all())  # only the confident (left) half
        with self.assertRaisesRegex(ConvertError, "no room"):
            fusion.fuse_room(depth, keep, K[None], poses, rgb, [0], 0.05, weights=torch.zeros_like(conf))


class Splats(unittest.TestCase):
    def test_ply_round_trip(self):
        rng = np.random.default_rng(0)
        n = 7
        g = {"means": rng.normal(size=(n, 3)), "scales": rng.normal(size=(n, 3)), "quats": rng.normal(size=(n, 4)),
             "opacities": rng.normal(size=n), "sh": rng.normal(size=(n, 4, 3))}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "s.ply"
            splat.write_ply(path, g["means"], g["scales"], g["quats"], g["opacities"], g["sh"], "test")
            header = path.read_bytes().split(b"end_header\n")[0].decode()
            self.assertIn("property float f_rest_8", header)
            self.assertNotIn("f_rest_9", header)
            back = splat.read_ply(path)
        for k in g:
            np.testing.assert_allclose(back[k], g[k].astype(np.float32), rtol=1e-6)


if __name__ == "__main__":
    unittest.main()
