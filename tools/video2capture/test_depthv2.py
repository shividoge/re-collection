"""Depth v2 encoder tests (numpy only):  python -m unittest test_depthv2
The cross-check with shared/depth.ts runs when `bun` is on PATH."""

import json
import shutil
import subprocess
import tempfile
import unittest
import zlib
from pathlib import Path

import numpy as np

import depthv2

CHECK = Path(__file__).resolve().parents[2] / "workers" / "gpu" / "tests" / "depth_v2_check.ts"


def frames(count: int = 23, h: int = 192, w: int = 256) -> np.ndarray:
    rng = np.random.default_rng(1)
    mm = rng.integers(0, 16384, size=(count, h, w))
    mm[:, :10] = 0
    return depthv2.pack(mm, np.where(mm > 0, rng.integers(0, 3, size=mm.shape), 0))


class DepthV2(unittest.TestCase):
    def test_pixel_layout(self):
        p = depthv2.pack(np.array([1234, 0, 16383, 16384, 70000]), np.array([2, 2, 1, 2, 1]))
        self.assertEqual(p.tolist(), [1234 | 2 << 14, 0, 16383 | 1 << 14, 0, 0])  # too far = no data, not clamped
        mm, conf = depthv2.unpack(p)
        self.assertEqual(mm.tolist(), [1234, 0, 16383, 0, 0])
        self.assertEqual(conf.tolist(), [2, 0, 1, 0, 0])
        self.assertEqual(p.dtype.str, "<u2")

    def test_round_trip_and_index(self):
        f = frames()
        bin_, index = depthv2.encode(f, frames_per_chunk=10)
        self.assertEqual(len(index["chunks"]), 3)
        self.assertEqual(index["chunks"][1][0], index["chunks"][0][1])
        self.assertEqual(sum(c[1] for c in index["chunks"]), len(bin_))
        np.testing.assert_array_equal(depthv2.decode_all(bin_, index), f)
        np.testing.assert_array_equal(depthv2.decode_chunk(bin_, index, 2), f[20:])

    def test_row_delta_round_trip(self):
        f = frames()
        bin_, index = depthv2.encode(f, filter="row-delta")
        self.assertEqual(index["filter"], "row-delta")
        np.testing.assert_array_equal(depthv2.decode_all(bin_, index), f)
        np.testing.assert_array_equal(depthv2.decode_chunk(bin_, index, 1), f[10:20])
        # Each row is filtered on its own: a row's first pixel is stored as is.
        raw = np.frombuffer(zlib.decompress(bin_[:index["chunks"][0][1]], -15), "<u2").reshape(10, 192, 256)
        np.testing.assert_array_equal(raw[:, :, 0], f[:10, :, 0])
        self.assertEqual(int(raw[0, 50, 1]), (int(f[0, 50, 1]) - int(f[0, 50, 0])) & 0xFFFF)

    def test_unknown_filter_is_rejected(self):
        bin_, index = depthv2.encode(frames(3))
        with self.assertRaisesRegex(ValueError, "unknown filter"):
            depthv2.decode_all(bin_, {**index, "filter": "zigzag"})
        with self.assertRaisesRegex(ValueError, "unknown filter"):
            depthv2.decode_chunk(bin_, {**index, "filter": "zigzag"}, 0)

    @unittest.skipUnless(shutil.which("bun"), "bun not installed")
    def test_matches_shared_depth_ts(self):
        for filter in (None, "row-delta"):
            with self.subTest(filter=filter):
                self.check_with_ts(filter)

    def check_with_ts(self, filter):
        f = frames()
        bin_, index = depthv2.encode(f, filter=filter)
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            (d / "depth.bin").write_bytes(bin_)
            (d / "depth.index.json").write_text(json.dumps(index))
            (d / "expected.raw").write_bytes(f.tobytes())
            out = subprocess.run(["bun", str(CHECK), str(d)], capture_output=True, text=True)
            self.assertEqual(out.returncode, 0, out.stderr + out.stdout)
            ts_index = json.loads((d / "ts.index.json").read_text())
            self.assertEqual(ts_index.get("filter"), filter)
            np.testing.assert_array_equal(depthv2.decode_all((d / "ts.bin").read_bytes(), ts_index), f)


if __name__ == "__main__":
    unittest.main()
