"""Shared real-frame inputs for object reconstruction and completion checks."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch

import decode
import fusion
import package


@dataclass
class SceneInputs:
    frames: list[dict]
    images: np.ndarray
    depths: np.ndarray
    colors: np.ndarray
    moving: np.ndarray
    poses: np.ndarray
    intrinsics: np.ndarray
    image_intrinsics: np.ndarray


def load(capture: Path, masks: fusion.MaskModel, holdout: list[int], max_views: int = 48) -> SceneInputs:
    manifest = json.loads((capture / 'manifest.json').read_text())
    frames = [f for f in package.read_frames(capture / 'frames.jsonl') if f.get('d') is not None and f['i'] not in set(holdout)]
    if not frames:
        raise ValueError('No non-held-out depth frames for completion.')
    if len(frames) > max_views:
        frames = [frames[k] for k in np.linspace(0, len(frames) - 1, max_views).round().astype(int)]
    info = decode.probe(capture / manifest['video']['file'])
    decoded = decode.decode(info, [f['i'] for f in frames], 1280, None)
    images = np.stack([decoded.frames[f['i']] for f in frames])
    all_depths = package.read_depth(capture, manifest)
    depths = np.stack([all_depths[f['d']] for f in frames]).astype(np.float32) / 1000
    h, w = depths.shape[1:]
    moving = fusion.resize_mask(masks(torch.from_numpy(images)), h, w).numpy()
    colors = fusion.resize_images(torch.from_numpy(images), h, w).numpy()
    poses, intrinsics, image_intrinsics = [], [], []
    for f in frames:
        T, K = package.pose_of(f)
        poses.append(T)
        intrinsics.append(fusion.scale_K(torch.tensor(K), w / info.width, h / info.height).numpy())
        image_intrinsics.append(fusion.scale_K(torch.tensor(K), images.shape[2] / info.width, images.shape[1] / info.height).numpy())
    return SceneInputs(frames, images, depths, colors, moving, np.stack(poses), np.stack(intrinsics), np.stack(image_intrinsics))
