import unittest

import numpy as np
import torch

from quality import image_detail_weights, spatial_selection


class DetailTests(unittest.TestCase):
    def test_small_isolated_object_survives_dominant_wall(self):
        wall = np.random.default_rng(0).uniform(0, 0.01, (100, 3))
        points = np.concatenate([wall, [[1, 0, 0], [1.001, 0, 0]]])
        scores = np.concatenate([np.arange(100, 200), [1, 2]])
        kept = spatial_selection(points, scores, 10)
        self.assertIn(101, kept)
        self.assertIn(99, kept)
        self.assertEqual(len(kept), 10)
        np.testing.assert_array_equal(kept, spatial_selection(points, scores, 10))

    def test_invalid_and_empty_inputs(self):
        self.assertEqual(len(spatial_selection(np.empty((0, 3)), np.empty(0), 10)), 0)
        with self.assertRaises(ValueError):
            spatial_selection(np.array([[np.nan, 0, 0]]), np.ones(1), 2)

    def test_motion_boundaries_are_not_promoted_as_detail(self):
        images = torch.zeros((1, 8, 8, 3), dtype=torch.uint8)
        images[:, :, 4:] = 255
        mask = torch.zeros((1, 8, 8), dtype=torch.bool)
        weights = image_detail_weights(images, mask)
        self.assertGreater(weights[0, 3, 3].item(), 1)
        mask[:, :, 4:] = True
        weights = image_detail_weights(images, mask)
        self.assertEqual(weights[0, 3, 3].item(), 1)


if __name__ == '__main__':
    unittest.main()
