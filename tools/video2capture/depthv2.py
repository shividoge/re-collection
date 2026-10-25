"""
Depth v2 (docs/architecture-v3.md §3), the Python twin of shared/depth.ts.

A pixel is a little-endian UInt16: `(mm & 0x3FFF) | (confidence << 14)`; mm 0 means no data,
confidence 0 low, 1 medium, 2 high. Frames are grouped `frames_per_chunk` at a time, each group's
pixels back to back and compressed with raw DEFLATE; depth.bin is the chunks concatenated and
depth.index.json lists each chunk's [byteOffset, byteLength]. With `"filter": "row-delta"` each
pixel after the first in a row is stored as its difference from the pixel to its left (mod 65536);
readers undo it after inflating (the bake writes it; so may the phone).
"""

from __future__ import annotations

import zlib

import numpy as np

MAX_MM = 0x3FFF
FILTERS = (None, "row-delta")


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


def row_delta(pixels: np.ndarray, undo: bool = False) -> np.ndarray:
    """The row-delta filter (or with `undo`, its reverse) over the last axis, mod 65536; a new array.
    Same as `rowDelta` in shared/depth.ts."""
    p = np.asarray(pixels, dtype="<u2")
    if undo:
        # A running sum along each row, mod 65536 (uint64 can't overflow for rows < 2^48 pixels).
        return (np.cumsum(p, axis=-1, dtype=np.uint64) & 0xFFFF).astype("<u2")
    out = p.copy()
    out[..., 1:] = p[..., 1:] - p[..., :-1]  # uint16 arithmetic wraps mod 65536
    return out


def encode(packed: np.ndarray, frames_per_chunk: int = 10, level: int = 6,
           filter: str | None = None) -> tuple[bytes, dict]:
    """Packed frames (count, height, width) -> (depth.bin bytes, depth.index.json dict)."""
    if packed.ndim != 3 or packed.dtype.kind != "u" or packed.dtype.itemsize != 2:
        raise ValueError("expected packed UInt16 frames of shape (count, height, width).")
    if filter not in FILTERS:
        raise ValueError(f"unknown depth filter {filter!r}.")
    count, height, width = packed.shape
    data = np.ascontiguousarray(packed, dtype="<u2")
    if filter == "row-delta":
        data = row_delta(data)
    parts, chunks, offset = [], [], 0
    for first in range(0, count, frames_per_chunk):
        z = zlib.compressobj(level, zlib.DEFLATED, -15)  # negative window bits: raw DEFLATE, no header
        c = z.compress(data[first:first + frames_per_chunk].tobytes()) + z.flush()
        parts.append(c)
        chunks.append([offset, len(c)])
        offset += len(c)
    index = {"format": "braindance.depth", "version": 2, "width": int(width), "height": int(height),
             "count": int(count), "framesPerChunk": int(frames_per_chunk), "chunks": chunks}
    if filter:
        index["filter"] = filter
    return b"".join(parts), index


def decode_chunk(bin_: bytes, index: dict, c: int) -> np.ndarray:
    """Chunk c -> its packed frames (n, height, width), with the index's filter undone."""
    if index.get("filter") not in FILTERS:
        raise ValueError(f"depth.index.json has an unknown filter {index.get('filter')!r}.")
    off, length = index["chunks"][c]
    first = c * index["framesPerChunk"]
    n = min(index["framesPerChunk"], index["count"] - first)
    raw = zlib.decompress(bin_[off:off + length], -15)
    expected = n * index["width"] * index["height"] * 2
    if len(raw) != expected:
        raise ValueError(f"Depth chunk {c} decompressed to {len(raw)} bytes, expected {expected}.")
    frames = np.frombuffer(raw, "<u2").reshape(n, index["height"], index["width"])
    return row_delta(frames, undo=True) if index.get("filter") == "row-delta" else frames


def decode_all(bin_: bytes, index: dict) -> np.ndarray:
    """Every packed frame (count, height, width)."""
    if index.get("format") != "braindance.depth" or index.get("version") != 2:
        raise ValueError("not a braindance depth v2 index.")
    if len(index["chunks"]) != -(-index["count"] // index["framesPerChunk"]):
        raise ValueError("depth.index.json has the wrong number of chunks.")
    frames = [decode_chunk(bin_, index, c) for c in range(len(index["chunks"]))]
    return np.concatenate(frames) if frames else np.zeros((0, index["height"], index["width"]), "<u2")
