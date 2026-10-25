import unittest

import numpy as np

from completion import constrain, transform_gaussians


def gaussians(points):
    n = len(points)
    return {'means': np.array(points, np.float32), 'scales': np.zeros((n, 3), np.float32),
            'quats': np.tile([1, 0, 0, 0], (n, 1)).astype(np.float32),
            'opacities': np.ones(n, np.float32), 'sh': np.zeros((n, 1, 3), np.float32)}


class CompletionTests(unittest.TestCase):
    def test_rejects_free_space_but_keeps_hidden_surfaces_and_fills_observed_holes(self):
        g = gaussians([[0, 0, -1], [0, 0, -2], [0, 0, -3]])
        depths = np.full((1, 4, 4), 2.0)
        K = np.array([[[2, 0, 2], [0, 2, 2], [0, 0, 1]]])
        colors = np.tile([255, 0, 0], (1, 4, 4, 1))
        out, report = constrain(g, np.empty((0, 3)), depths, np.eye(4)[None], K, colors, np.zeros_like(depths, bool))
        self.assertEqual(report['freeSpaceConflicts'], 1)
        np.testing.assert_allclose(out['means'][:, 2], [-2, -3])
        self.assertEqual(report['coloredFromVideo'], 1)
        self.assertGreater(out['sh'][0, 0, 0], out['sh'][0, 0, 1])

    def test_moving_subject_is_not_static_free_space_evidence(self):
        depths = np.full((1, 4, 4), 2.0)
        K = np.array([[[2, 0, 2], [0, 2, 2], [0, 0, 1]]])
        out, _ = constrain(gaussians([[0, 0, -1]]), np.empty((0, 3)), depths, np.eye(4)[None], K,
                           np.zeros((1, 4, 4, 3)), np.ones_like(depths, bool))
        self.assertEqual(len(out['means']), 1)

    def test_transform_rotates_covariance_and_rejects_reflections(self):
        g = gaussians([[1, 0, 0]])
        T = np.eye(4)
        T[:3, :3] = [[0, -1, 0], [1, 0, 0], [0, 0, 1]]
        out = transform_gaussians(g, T)
        np.testing.assert_allclose(out['means'], [[0, 1, 0]], atol=1e-6)
        np.testing.assert_allclose(np.abs(out['quats']), [[2**-0.5, 0, 0, 2**-0.5]], atol=1e-6)
        T[2, 2] = -1
        with self.assertRaises(ValueError):
            transform_gaussians(g, T)


if __name__ == '__main__':
    unittest.main()
