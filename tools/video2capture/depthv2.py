"""
Depth v2 (docs/architecture-v3.md §3), the Python twin of shared/depth.ts.

A pixel is a little-endian UInt16: `(mm & 0x3FFF) | (confidence << 14)`; mm 0 means no data,
confidence 0 low, 1 medium, 2 high. Frames are grouped `frames_per_chunk` at a time, each group's
pixels back to back and compressed with raw DEFLATE; depth.bin is the chunks concatenated and
depth.index.json lists each chunk's [byteOffset, byteLength].
"""

from __future__ import annotations

import zlib

import numpy as np

MAX_MM = 0x3FFF


def pack(mm: np.ndarray, confidence: np.ndarray) -> np.ndarray:
    """Millimeters (any integer or float array, already rounded) and confidence 0..2 -> packed UInt16.
    Depths beyond 16 383 mm can't be stored and become "no data" (never clamped to a fake wall)."""
    mm = np.asarray(mm)
    if mm.shape != np.shape(confidence):
        raise ValueError("depth and confidence must have the same shape.")
    conf = np.asarray(confidence).astype(np.uint16)
    if conf.max(initial=0) > 2:
        raise ValueError("confidence must be 0, 1 or 2.")
    ok = (mm > 0) & (mm <= MAX_MM)
    return np.where(ok, mm.astype(np.int64) | (conf.astype(np.int64) << 14), 0).astype("<u2")


def unpack(packed: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Packed UInt16 -> (mm UInt16, confidence UInt8)."""
    packed = np.asarray(packed, dtype=np.uint16)
    return (packed & MAX_MM).astype(np.uint16), (packed >> 14).astype(np.uint8)


def encode(packed: np.ndarray, frames_per_chunk: int = 10, level: int = 6) -> tuple[bytes, dict]:
    """Packed frames (count, height, width) -> (depth.bin bytes, depth.index.json dict)."""
    if packed.ndim != 3 or packed.dtype.kind != "u" or packed.dtype.itemsize != 2:
        raise ValueError("expected packed UInt16 frames of shape (count, height, width).")
    count, height, width = packed.shape
    data = np.ascontiguousarray(packed, dtype="<u2")
    parts, chunks, offset = [], [], 0
    for first in range(0, count, frames_per_chunk):
        z = zlib.compressobj(level, zlib.DEFLATED, -15)  # negative window bits: raw DEFLATE, no header
        c = z.compress(data[first:first + frames_per_chunk].tobytes()) + z.flush()
        parts.append(c)
        chunks.append([offset, len(c)])
        offset += len(c)
    index = {"format": "braindance.depth", "version": 2, "width": int(width), "height": int(height),
             "count": int(count), "framesPerChunk": int(frames_per_chunk), "chunks": chunks}
    return b"".join(parts), index


def decode_chunk(bin_: bytes, index: dict, c: int) -> np.ndarray:
    """Chunk c -> its packed frames (n, height, width)."""
    off, length = index["chunks"][c]
    first = c * index["framesPerChunk"]
    n = min(index["framesPerChunk"], index["count"] - first)
    raw = zlib.decompress(bin_[off:off + length], -15)
    expected = n * index["width"] * index["height"] * 2
    if len(raw) != expected:
        raise ValueError(f"Depth chunk {c} decompressed to {len(raw)} bytes, expected {expected}.")
    return np.frombuffer(raw, "<u2").reshape(n, index["height"], index["width"])


def decode_all(bin_: bytes, index: dict) -> np.ndarray:
    """Every packed frame (count, height, width)."""
    if index.get("format") != "braindance.depth" or index.get("version") != 2:
        raise ValueError("not a braindance depth v2 index.")
    if len(index["chunks"]) != -(-index["count"] // index["framesPerChunk"]):
        raise ValueError("depth.index.json has the wrong number of chunks.")
    frames = [decode_chunk(bin_, index, c) for c in range(len(index["chunks"]))]
    return np.concatenate(frames) if frames else np.zeros((0, index["height"], index["width"]), "<u2")
