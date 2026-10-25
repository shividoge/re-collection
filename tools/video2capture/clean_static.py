"""Carve people from an existing dense room using the recording's masks and depth.

Uses the already solved camera poses, so long clips need no new DA3/window alignment.
Only removes geometry. Occluded surfaces remain empty. Writes a separate, static-only
package with the original video, camera path and keyframes; never modifies the input.
"""
from __future__ import annotations

import argparse
import json
import shutil
import uuid
from pathlib import Path

import av
import cv2
import numpy as np
import torch

import fusion
import package


def observations(source: Path, manifest: dict, cache: Path, device: torch.device):
    frames = [f for f in package.read_frames(source / 'frames.jsonl') if f.get('d') is not None]
    if not frames:
        raise ValueError('The input needs camera frames with depth indices.')
    width = 1008
    height = round(width * manifest['video']['height'] / manifest['video']['width'])
    # A cache belongs to this exact source package and mask settings.
    signature = json.dumps([manifest['id'], frames, width, height, 0.25, 16], sort_keys=True)
    if cache.exists():
        saved = np.load(cache)
        if str(saved['signature']) != signature:
            raise ValueError('Mask cache belongs to different input/settings; use a new cache path.')
        masks = saved['masks']
    else:
        wanted = {f['i']: j for j, f in enumerate(frames)}
        masks = np.zeros((len(frames), height, width), dtype=bool)
        model = fusion.MaskModel(device)
        seen = set()
        with av.open(str(source / manifest['video']['file'])) as video:
            for i, frame in enumerate(video.decode(video=0)):
                if i not in wanted:
                    continue
                rgb = cv2.resize(frame.to_ndarray(format='rgb24'), (width, height), interpolation=cv2.INTER_AREA)
                mask = model(torch.from_numpy(rgb[None]), score=0.25, batch=1)
                masks[wanted[i]] = fusion.dilate(mask, 6)[0].numpy()
                seen.add(i)
                if len(seen) % 25 == 0:
                    print(f'Masked {len(seen)}/{len(frames)} frames', flush=True)
        if len(seen) != len(wanted):
            raise ValueError('Video ended before all depth observations were decoded.')
        np.savez_compressed(cache, masks=masks, signature=signature)
        del model
        torch.cuda.empty_cache()
    mm = package.read_depth(source, manifest)
    depths = torch.from_numpy(mm.astype(np.float32) / 1000).to(device)
    return frames, masks, depths


def classify(points: np.ndarray, colors: np.ndarray, source: Path, manifest: dict, frames: list[dict], masks: np.ndarray,
             depths: torch.Tensor, video_size: tuple[int, int], device: torch.device):
    """Keep geometry supported by unmasked depth; reject foreground/person intersections.

    A person mask can cover a real surface behind it. Only count person evidence
    when the point matches that pixel's depth and color. Repeated clean evidence
    outweighs ambiguous intersections. A clear ray reaching a farther surface
    contradicts a floating point. Three clean observations are required.
    """
    xyz = torch.from_numpy(points).to(device)
    rgb = torch.from_numpy(colors).to(device).float()
    clean = torch.zeros(len(points), dtype=torch.int32, device=device)
    person = torch.zeros_like(clean)
    free = torch.zeros_like(clean)
    h, w = masks.shape[1:]
    dh, dw = depths.shape[1:]
    def images():
        wanted = {f['i'] for f in frames}
        with av.open(str(source / manifest['video']['file'])) as video:
            for i, image in enumerate(video.decode(video=0)):
                if i in wanted:
                    yield cv2.resize(image.to_ndarray(format='rgb24'), (w, h), interpolation=cv2.INTER_AREA)

    for j, (frame, image) in enumerate(zip(frames, images(), strict=True)):
        image = torch.from_numpy(image).to(device).float()
        pose, K = package.pose_of(frame)
        K = fusion.scale_K(torch.tensor(K, dtype=torch.float32, device=device), w / video_size[0], h / video_size[1])
        pose = torch.tensor(pose, dtype=torch.float32, device=device)
        mask = torch.from_numpy(masks[j]).to(device)
        for start in range(0, len(points), 500_000):
            end = start + 500_000
            u, v, z = fusion.project(xyz[start:end], K, pose)
            x, y = u.round().long(), v.round().long()
            inside = (z > 0) & (x >= 0) & (x < w) & (y >= 0) & (y < h)
            x, y = x.clamp(0, w - 1), y.clamp(0, h - 1)
            d = depths[frame['d']][((y.float() + .5) * dh / h).long().clamp(max=dh-1),
                                   ((x.float() + .5) * dw / w).long().clamp(max=dw-1)]
            valid = inside & (d > 0)
            foreground = mask[y, x]
            # The 256px replay depth is coarser than the 1008px dense room.
            tolerance = torch.maximum(d * .06, torch.full_like(d, .12))
            color_error = (rgb[start:end] - image[y, x]).abs().mean(1)
            # A mask alone is an occlusion, not evidence that a point is a person.
            # Require the source pixel's color AND depth to support that attribution.
            person_tolerance = torch.maximum(d * .025, torch.full_like(d, .06))
            person[start:end] += (valid & foreground & ((z - d).abs() <= person_tolerance) & (color_error < 28)).int()
            clean[start:end] += (valid & ~foreground & ((z - d).abs() <= tolerance) & (color_error < 35)).int()
            # An unobstructed ray reaching a farther surface contradicts a static point
            # here. This catches held dishes / floating fragments even outside person masks.
            free[start:end] += (valid & ~foreground & (z < d - tolerance)).int()
        if j % 50 == 0:
            print(f'Checked geometry in view {j}/{len(frames)}', flush=True)
    contradicted = (free >= 5) & (free > clean * .5)
    person_fragment = (person >= 3) & (clean <= person * 2) & (free >= 3)
    keep = (clean >= 3) & ~contradicted & ~person_fragment
    return keep.cpu().numpy(), clean.cpu().numpy(), person.cpu().numpy(), free.cpu().numpy()


def reviewed_exclusions(points: np.ndarray, frames: list[dict], video_size: tuple[int, int], recipe: dict) -> np.ndarray:
    """Reviewed image polygons extruded only through the specified camera-depth interval."""
    w, h = recipe['imageSize']
    remove = np.zeros(len(points), dtype=bool)
    for region in recipe['regions']:
        frame = min(frames, key=lambda f: abs(f['t'] - region['time']))
        pose, K = package.pose_of(frame)
        K = fusion.scale_K(torch.from_numpy(K), w / video_size[0], h / video_size[1]).numpy()
        mask = np.zeros((h, w), dtype=np.uint8)
        cv2.fillPoly(mask, [np.asarray(region['polygon'], dtype=np.int32)], 1)
        near, far = region['depthRange']
        if not 0 < near < far:
            raise ValueError('Exclusion depthRange must be positive and increasing.')
        for start in range(0, len(points), 500_000):
            cam = (points[start:start + 500_000] - pose[:3, 3]) @ pose[:3, :3]
            z = -cam[:, 2]
            u = np.rint(K[0, 0] * cam[:, 0] / np.maximum(z, 1e-6) + K[0, 2]).astype(np.int64)
            v = np.rint(-K[1, 1] * cam[:, 1] / np.maximum(z, 1e-6) + K[1, 2]).astype(np.int64)
            inside = (z >= near) & (z <= far) & (u >= 0) & (u < w) & (v >= 0) & (v < h)
            remove[start:start + 500_000] |= inside & (mask[v.clip(0, h - 1), u.clip(0, w - 1)] > 0)
    return remove


def clean_static(source: Path, out: Path, cache: Path, exclusions: Path | None = None):
    if out.exists():
        raise ValueError(f'Output already exists: {out}')
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    manifest = json.loads((source / 'manifest.json').read_text())
    frames, masks, depths = observations(source, manifest, cache, device)
    points, colors = package.read_room_bin(source / manifest['room']['bin'])
    keep, clean, person, free = classify(points, colors, source, manifest, frames, masks, depths,
                                   (manifest['video']['width'], manifest['video']['height']), device)
    recipe = json.loads(exclusions.read_text()) if exclusions else None
    reviewed_removed = 0
    if recipe:
        if recipe['source'] != manifest['id']:
            raise ValueError('Reviewed exclusions belong to another capture.')
        excluded = reviewed_exclusions(points, frames, (manifest['video']['width'], manifest['video']['height']), recipe)
        reviewed_removed = int((keep & excluded).sum())
        keep &= ~excluded
    if not keep.any():
        raise ValueError('No supported static geometry survived; refusing an empty package.')
    shutil.copytree(source, out)
    package.write_room_bin(out / manifest['room']['bin'], points[keep], colors[keep])
    if manifest['room'].get('ply'):
        package.write_room_ply(out / manifest['room']['ply'], points[keep], colors[keep])
    # A trained splat can span the removed people even when its center is outside a mask.
    # Do not offer that unvalidated representation in the static-only alternative.
    splat = manifest['room'].pop('splat', None)
    if splat:
        (out / splat['file']).unlink()
    # Null depth indices are the existing contract for camera-only frames. Every viewer,
    # including older clients, keeps the path/video but cannot replay people in this package.
    camera_frames = package.read_frames(source / 'frames.jsonl')
    for frame in camera_frames:
        frame['d'] = None
    (out / 'frames.jsonl').write_text(''.join(json.dumps(f) + '\n' for f in camera_frames))
    original_id = manifest['id']
    manifest['id'] = str(uuid.uuid4())
    manifest['room']['points'] = int(keep.sum())
    manifest.setdefault('warnings', []).append('Static environment only: people and uncertain foreground geometry removed using masks across the recording. Hidden surfaces remain empty. People replay and the original splat are omitted; source video is retained.')
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    report = {'source': original_id, 'id': manifest['id'], 'device': str(device), 'views': len(frames),
              'before': len(points), 'after': int(keep.sum()), 'reviewed_removed': reviewed_removed, 'exclusions': recipe, 'person_rejected': int(((person >= 3) & (clean <= person * 2) & (free >= 3)).sum()), 'free_space_rejected': int(((free >= 5) & (free > clean * .5)).sum()),
              'unsupported': int((clean < 3).sum()), 'settings': {'mask_score': .25, 'mask_padding_px': 16, 'person_depth_relative': .025, 'person_depth_min_m': .06, 'person_color_mae': 28, 'static_color_mae': 35, 'static_min_views': 3, 'static_to_person_ratio': 2, 'free_min_views': 5, 'free_to_static_ratio': .5}, 'representation': 'points', 'replay': False}
    (out / 'cleaning.json').write_text(json.dumps(report, indent=2))
    np.savez_compressed(cache.with_suffix('.votes.npz'), keep=keep, clean=clean, person=person, free=free)
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--exclude-regions', type=Path, help='Reviewed source-specific camera polygons with depth intervals')
    args = parser.parse_args()
    clean_static(args.source, args.out, args.cache, args.exclude_regions)
