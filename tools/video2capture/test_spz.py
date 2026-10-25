"""SPZ writer/reader tests (numpy only, no GPU):  uv run --with numpy python -m unittest -v test_spz

`python test_spz.py --fixture DIR` instead writes Spark-check fixtures (workers/gpu/tests/spark_spz_check.mjs):
for each SH degree d, `d{d}.spz`, `d{d}.ply` (the same Gaussians as an INRIA PLY, the layout of
splat.write_ply, so Spark's PLY path is the reference) and `d{d}.json` (the original values)."""

import gzip
import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

import spz

SH_C0 = 0.28209479177387814


def gaussians(n: int, degree: int, seed: int = 0) -> dict[str, np.ndarray]:
    """Random Gaussians in the format's representable ranges, plus a few awkward quaternions."""
    rng = np.random.default_rng(seed)
    quats = rng.normal(size=(n, 4))
    special = np.array([[1, 0, 0, 0], [-1, 0, 0, 0], [0, 0, 0, 1], [0.5, 0.5, 0.5, 0.5], [0.5, -0.5, 0.5, -0.5],
                        [0.7071, 0.7071, 0, 0], [0, -0.7071, 0, 0.7071], [0.2, -0.9, 0.3, 0.1]])
    quats[:min(n, len(special))] = special[:n]
    return {"means": rng.uniform(-6, 6, (n, 3)).astype(np.float32),
            "scales_log": rng.uniform(-9, 1, (n, 3)).astype(np.float32),
            "quats_wxyz": quats.astype(np.float32),
            "opacity_logit": rng.uniform(-8, 8, n).astype(np.float32),
            "sh": np.concatenate([rng.uniform(-3, 3, (n, 1, 3)), rng.uniform(-0.9, 0.9, (n, (degree + 1) ** 2 - 1, 3))],
                                 axis=1).astype(np.float32)}


def sigmoid(x):
    return 1 / (1 + np.exp(-np.asarray(x, np.float64)))


def unit(q):
    return q / np.linalg.norm(q, axis=1, keepdims=True)


class RoundTrip(unittest.TestCase):
    def roundtrip(self, g, **kw):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "room.spz"
            size = spz.write_spz(path, **g, **kw)
            self.assertEqual(size, path.stat().st_size)
            return spz.read_spz(path)

    def test_every_attribute_within_quantization(self):
        for degree in range(4):
            with self.subTest(degree=degree):
                g = gaussians(500, degree, seed=degree)
                r = self.roundtrip(g)
                self.assertEqual(r["sh"].shape, g["sh"].shape)
                self.assertLessEqual(np.abs(r["means"] - g["means"]).max(), 0.5 / 4096 + 1e-6)
                self.assertLessEqual(np.abs(r["scales"] - g["scales_log"]).max(), 1 / 32 + 1e-6)
                self.assertLessEqual(np.abs(sigmoid(r["opacities"]) - sigmoid(g["opacity_logit"])).max(), 0.5 / 255 + 1e-6)
                self.assertLessEqual(np.abs(r["sh"][:, 0] - g["sh"][:, 0]).max(), 0.5 / (255 * 0.15) + 1e-6)
                # Rotations up to sign: 9 bits over [0, 1/sqrt2] per component.
                a, b = unit(g["quats_wxyz"].astype(np.float64)), r["quats"].astype(np.float64)
                err = np.minimum(np.abs(a - b).max(1), np.abs(a + b).max(1))
                self.assertLessEqual(err.max(), 2e-3)
                if degree:
                    rest_err = np.abs(r["sh"][:, 1:] - g["sh"][:, 1:])
                    self.assertLessEqual(rest_err[:, :3].max(), 4.5 / 128 + 1e-6)   # degree 1: buckets of 8
                    self.assertLessEqual(rest_err.max(), 8.5 / 128 + 1e-6)          # higher: buckets of 16

    def test_header_fields(self):
        g = gaussians(7, 2)
        r = self.roundtrip(g, antialiased=False, fractional_bits=10)
        self.assertEqual(r["header"], {"version": 3, "numPoints": 7, "shDegree": 2, "fractionalBits": 10, "flags": 0})
        raw = spz.encode_spz(**g)
        self.assertEqual(raw[:4], b"\x1f\x8b\x08\x00")  # plain gzip, which Spark sniffs for
        self.assertEqual(gzip.decompress(raw)[:16], b"NGSP" + bytes([3, 0, 0, 0, 7, 0, 0, 0, 2, 12, 1, 0]))

    def test_known_bytes(self):
        g = {"means": np.array([[1.0, -1.0, 0.5]]), "scales_log": np.array([[-10.0, 0.0, 5.9375]]),
             "quats_wxyz": np.array([[1.0, 0, 0, 0]]), "opacity_logit": np.array([0.0]),
             "sh": np.zeros((1, 1, 3))}
        body = gzip.decompress(spz.encode_spz(**g))[16:]
        self.assertEqual(body[:9], bytes([0x00, 0x10, 0x00, 0x00, 0xF0, 0xFF, 0x00, 0x08, 0x00]))  # 4096, -4096, 2048
        self.assertEqual(body[9], 128)                       # sigmoid(0) * 255 = 127.5, rounded away from zero
        self.assertEqual(body[10:13], bytes([128] * 3))      # dc 0 -> 127.5 -> 128
        self.assertEqual(body[13:16], bytes([0, 160, 255]))  # (ln s + 10) * 16
        self.assertEqual(body[16:20], bytes([0, 0, 0, 0xC0]))  # largest = w (index 3), others 0

    def test_deterministic(self):
        g = gaussians(200, 3)
        self.assertEqual(spz.encode_spz(**g), spz.encode_spz(**g))

    def test_empty(self):
        r = self.roundtrip(gaussians(0, 1))
        self.assertEqual(r["means"].shape, (0, 3))
        self.assertEqual(r["sh"].shape, (0, 4, 3))
        self.assertEqual(r["header"]["numPoints"], 0)

    def test_large_coordinates_lower_fractional_bits(self):
        g = gaussians(5, 0)
        g["means"][0, 1] = 3000.0  # beyond 2048 m, the 12-bit range
        r = self.roundtrip(g)
        self.assertEqual(r["header"]["fractionalBits"], 11)
        self.assertLessEqual(np.abs(r["means"] - g["means"]).max(), 0.5 / 2048 + 1e-4)
        g["means"][0, 1] = 1e7
        with self.assertRaises(ValueError):
            spz.encode_spz(**g)

    def test_rejects_bad_input(self):
        for name in ["means", "scales_log", "quats_wxyz", "opacity_logit", "sh"]:
            g = gaussians(4, 1)
            g[name].flat[0] = np.nan
            with self.subTest(name=name), self.assertRaises(ValueError):
                spz.encode_spz(**g)
        g = gaussians(4, 1)
        g["sh"] = g["sh"][:, :3]
        with self.assertRaises(ValueError):
            spz.encode_spz(**g)
        g = gaussians(4, 1)
        g["quats_wxyz"][2] = 0
        with self.assertRaises(ValueError):
            spz.encode_spz(**g)


def ply_bytes(d: dict) -> bytes:
    """INRIA 3DGS PLY, the same layout as splat.write_ply (which needs torch to import)."""
    sh = d["sh"]
    n, k, _ = sh.shape
    rest = sh[:, 1:, :].transpose(0, 2, 1).reshape(n, -1)
    names = (["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2"] + [f"f_rest_{i}" for i in range(rest.shape[1])]
             + ["opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"])
    data = np.concatenate([d["means"], sh[:, 0], rest, d["opacity_logit"][:, None], d["scales_log"], d["quats_wxyz"]],
                          axis=1)
    header = (f"ply\nformat binary_little_endian 1.0\nelement vertex {n}\n"
              + "".join(f"property float {p}\n" for p in names) + "end_header\n")
    return header.encode() + np.ascontiguousarray(data, "<f4").tobytes()


def write_fixtures(out: Path, n: int = 300) -> None:
    out.mkdir(parents=True, exist_ok=True)
    for degree in range(4):
        g = gaussians(n, degree, seed=10 + degree)
        spz.write_spz(out / f"d{degree}.spz", **g)
        (out / f"d{degree}.ply").write_bytes(ply_bytes(g))
        (out / f"d{degree}.json").write_text(json.dumps(
            {"degree": degree, "means": g["means"].tolist(), "scales_log": g["scales_log"].tolist(),
             "quats_xyzw": unit(g["quats_wxyz"].astype(np.float64))[:, [1, 2, 3, 0]].tolist(),
             "opacity": sigmoid(g["opacity_logit"]).tolist(), "rgb": (0.5 + SH_C0 * g["sh"][:, 0]).tolist(),
             "sh_rest": g["sh"][:, 1:].tolist()}))
    print(f"wrote fixtures for SH degrees 0-3 ({n} splats each) to {out}")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--fixture":
        write_fixtures(Path(sys.argv[2]))
    else:
        unittest.main()
