"""
SPZ (Niantic's compressed Gaussian splat format) writer and reader, numpy + gzip only.

We write **version 3**: the newest version in the gzip container, which Python's stdlib can produce
(v4 needs ZSTD). Spark 2.4 (rust/spark-lib/src/spz.rs) parses v1-v3 gzip and v4 NGSP; v3 gives
"smallest three" quaternions (9 bits + sign per component, much finer than v2's 8-bit xyz), and it's
what Niantic's reference wrote by default before v4. Coordinates: SPZ stores RUB, and our ARKit world
already is RUB (x right, y up, camera looks -z), so nothing is flipped. Spark applies no axis flip
when it decodes SPZ or PLY either, so the SPZ renders exactly where our PLY did.

Layout (little endian, whole stream gzipped): header `magic "NGSP" u32, version u32, numPoints u32,
shDegree u8, fractionalBits u8, flags u8 (1 = antialiased), reserved u8`, then per attribute for all
splats: positions (3 x i24 fixed point), alphas (u8 sigmoid), colors (u8, dc * 0.15 + 0.5), scales
(u8, (ln s + 10) * 16), rotations (u32 smallest three, xyzw), SH rest (u8, coefficient-major with
RGB innermost, degree 1 on 5 bits, higher on 4 bits, like the reference). Conventions in and out are
splat.read_ply's: scales natural log, quaternions w first, opacity a logit, sh (N, K, 3) DC first.
The uncompressed payload matches Niantic's reference encoder (nianticlabs/spz, version 3) byte for byte.
"""

from __future__ import annotations

import gzip
import struct
from pathlib import Path

import numpy as np

MAGIC = 0x5053474E  # "NGSP"
VERSION = 3
FLAG_ANTIALIASED = 0x1
COLOR_SCALE = 0.15
SH1_BITS, SH_REST_BITS = 5, 4
I24_MAX = (1 << 23) - 1
SQRT1_2 = 0.7071067811865476
HEADER = struct.Struct("<IIIBBBB")


def _round(x: np.ndarray) -> np.ndarray:
    """C's round(): halves away from zero (numpy's rounds them to even)."""
    return np.sign(x) * np.floor(np.abs(x) + 0.5)


def _u8(x: np.ndarray) -> np.ndarray:
    return np.clip(_round(x), 0, 255).astype(np.uint8)


def fractional_bits_for(means: np.ndarray, wanted: int = 12) -> int:
    """`wanted`, lowered until every coordinate fits a signed 24-bit integer."""
    biggest = float(np.abs(means).max()) if means.size else 0.0
    bits = wanted
    while bits >= 0 and round(biggest * (1 << bits)) > I24_MAX:
        bits -= 1
    if bits < 0:
        raise ValueError(f"SPZ: a coordinate of {biggest:g} m doesn't fit 24-bit fixed point")
    return bits


def _pack_positions(means: np.ndarray, bits: int) -> bytes:
    fixed = _round(means.astype(np.float64) * (1 << bits)).astype("<i4")
    return fixed.reshape(-1, 1).view(np.uint8)[:, :3].tobytes()


def _pack_quats(quats_wxyz: np.ndarray) -> bytes:
    """Smallest three: index of the largest |component| in the top 2 bits, then the other three
    (ascending index, first one highest) as sign bit + 9-bit magnitude, largest made positive."""
    q = quats_wxyz[:, [1, 2, 3, 0]].astype(np.float64)
    norm = np.linalg.norm(q, axis=1, keepdims=True)
    if np.any(norm == 0):
        raise ValueError("SPZ: zero-length quaternion")
    q /= norm
    largest = np.argmax(np.abs(q), axis=1)
    negate = q[np.arange(len(q)), largest] < 0
    others = np.argsort(np.arange(4)[None, :] == largest[:, None], axis=1, kind="stable")[:, :3]
    rest = np.take_along_axis(q, others, axis=1)
    mag = np.minimum(np.floor(511 * np.abs(rest) / SQRT1_2 + 0.5), 511).astype(np.uint32)
    fields = (((rest < 0) ^ negate[:, None]).astype(np.uint32) << 9) | mag  # the reference's bits, -0 included
    comp = (largest.astype(np.uint32) << 30) | (fields[:, 0] << 20) | (fields[:, 1] << 10) | fields[:, 2]
    return comp.astype("<u4").tobytes()


def _unpack_quats(comp: np.ndarray) -> np.ndarray:
    largest = (comp >> 30).astype(np.intp)
    q = np.zeros((len(comp), 4))
    others = np.argsort(np.arange(4)[None, :] == largest[:, None], axis=1, kind="stable")[:, :3]
    for slot, shift in enumerate((20, 10, 0)):
        field = (comp >> shift) & 0x3FF
        value = SQRT1_2 * (field & 0x1FF) / 511 * np.where(field & 0x200, -1.0, 1.0)
        np.put_along_axis(q, others[:, slot:slot + 1], value[:, None], axis=1)
    np.put_along_axis(q, largest[:, None], np.sqrt(np.maximum(0, 1 - (q ** 2).sum(1)))[:, None], axis=1)
    return q[:, [3, 0, 1, 2]]


def _quantize_sh(rest: np.ndarray) -> bytes:
    """rest: (N, K-1, 3). Reference rule: 8 bits, then snapped to buckets (degree 1: 5 bits)."""
    q = _round(rest.astype(np.float64) * 128) + 128
    bucket = np.full(rest.shape[1], 1 << (8 - SH_REST_BITS))
    bucket[:3] = 1 << (8 - SH1_BITS)
    bucket = bucket[None, :, None]
    q = (q + bucket // 2) // bucket * bucket
    return np.clip(q, 0, 255).astype(np.uint8).tobytes()


def _sh_degree(k: int) -> int:
    degree = round(k ** 0.5) - 1
    if (degree + 1) ** 2 != k or not 0 <= degree <= 3:
        raise ValueError(f"SPZ: sh must have 1, 4, 9 or 16 coefficients per channel, got {k}")
    return degree


def encode_spz(means: np.ndarray, scales_log: np.ndarray, quats_wxyz: np.ndarray, opacity_logit: np.ndarray,
               sh: np.ndarray, *, antialiased: bool = True, fractional_bits: int = 12) -> bytes:
    """The gzipped SPZ v3 bytes (deterministic: gzip mtime is 0)."""
    n = len(means)
    shapes = {"means": (means, (n, 3)), "scales_log": (scales_log, (n, 3)), "quats_wxyz": (quats_wxyz, (n, 4)),
              "opacity_logit": (opacity_logit, (n,))}
    for name, (a, shape) in shapes.items():
        if a.shape != shape:
            raise ValueError(f"SPZ: {name} has shape {a.shape}, expected {shape}")
    if sh.ndim != 3 or sh.shape[0] != n or sh.shape[2] != 3:
        raise ValueError(f"SPZ: sh has shape {sh.shape}, expected ({n}, K, 3)")
    for name, a in [*((k, v[0]) for k, v in shapes.items()), ("sh", sh)]:
        if not np.all(np.isfinite(a)):
            raise ValueError(f"SPZ: {name} contains NaN or infinity")
    degree = _sh_degree(sh.shape[1])
    bits = fractional_bits_for(means, fractional_bits)

    alpha = np.exp(-np.logaddexp(0.0, -opacity_logit.astype(np.float64)))  # sigmoid without overflow
    payload = b"".join([
        HEADER.pack(MAGIC, VERSION, n, degree, bits, FLAG_ANTIALIASED if antialiased else 0, 0),
        _pack_positions(means, bits),
        _u8(alpha * 255).tobytes(),
        _u8(sh[:, 0, :].astype(np.float64) * (COLOR_SCALE * 255) + 0.5 * 255).tobytes(),
        _u8((scales_log.astype(np.float64) + 10) * 16).tobytes(),
        _pack_quats(quats_wxyz),
        _quantize_sh(sh[:, 1:, :]),
    ])
    return gzip.compress(payload, compresslevel=9, mtime=0)


def write_spz(path: Path, means: np.ndarray, scales_log: np.ndarray, quats_wxyz: np.ndarray,
              opacity_logit: np.ndarray, sh: np.ndarray, *, antialiased: bool = True,
              fractional_bits: int = 12) -> int:
    """Write an SPZ v3 file; returns the number of bytes written."""
    data = encode_spz(means, scales_log, quats_wxyz, opacity_logit, sh,
                      antialiased=antialiased, fractional_bits=fractional_bits)
    Path(path).write_bytes(data)
    return len(data)


def read_header(raw: bytes) -> dict[str, int]:
    """Header fields of decompressed SPZ bytes."""
    magic, version, n, degree, bits, flags, _ = HEADER.unpack_from(raw)
    if magic != MAGIC:
        raise ValueError(f"SPZ: bad magic 0x{magic:08x}")
    if not 1 <= version <= 3 or degree > 3:
        raise ValueError(f"SPZ: unsupported version {version} or SH degree {degree}")
    return {"version": version, "numPoints": n, "shDegree": degree, "fractionalBits": bits, "flags": flags}


def read_spz(path: Path) -> dict:
    """The inverse of write_spz (gzip SPZ v1-v3), in splat.read_ply's shapes and conventions, plus
    the header fields under "header". Opacity bytes 0 and 255 come back as finite logits that
    re-encode to the same byte."""
    raw = gzip.decompress(Path(path).read_bytes())
    h = read_header(raw)
    n, k, v = h["numPoints"], (h["shDegree"] + 1) ** 2, h["version"]
    sizes = [n * (6 if v == 1 else 9), n, 3 * n, 3 * n, n * (4 if v >= 3 else 3), n * (k - 1) * 3]
    if len(raw) != HEADER.size + sum(sizes):
        raise ValueError(f"SPZ: payload is {len(raw) - HEADER.size} bytes, expected {sum(sizes)}")
    parts, at = [], HEADER.size
    for size in sizes:
        parts.append(np.frombuffer(raw, np.uint8, size, at))
        at += size
    pos, alpha, color, scale, rot, sh_rest = parts

    if v == 1:
        means = pos.view("<f2").reshape(n, 3).astype(np.float32)
    else:
        b = pos.reshape(n, 3, 3).astype(np.int32)
        fixed = b[..., 0] | (b[..., 1] << 8) | (b[..., 2] << 16)
        means = (np.where(fixed & 0x800000, fixed - (1 << 24), fixed) / (1 << h["fractionalBits"])).astype(np.float32)
    if v >= 3:
        quats = _unpack_quats(rot.view("<u4").astype(np.uint32))
    else:
        xyz = rot.reshape(n, 3) / 127.5 - 1
        quats = np.concatenate([np.sqrt(np.maximum(0, 1 - (xyz ** 2).sum(1)))[:, None], xyz], axis=1)
    p = np.clip(alpha / 255.0, 0.25 / 255, 254.75 / 255)
    sh = np.zeros((n, k, 3), np.float32)
    sh[:, 0] = (color.reshape(n, 3) / 255.0 - 0.5) / COLOR_SCALE
    sh[:, 1:] = (sh_rest.reshape(n, k - 1, 3).astype(np.float32) - 128) / 128
    return {"means": means, "scales": (scale.reshape(n, 3) / 16.0 - 10).astype(np.float32),
            "quats": quats.astype(np.float32), "opacities": np.log(p / (1 - p)).astype(np.float32),
            "sh": sh, "header": h}
