"""Align a dense reconstruction to the original phone's ARKit world without dropping points.

Both packages must use the same video orientation. Writes a new package; originals stay intact.
Run in the converter environment: python align_capture.py <capture> --reference <phone> --out <folder>
"""
from __future__ import annotations

import argparse
import json
import shutil
import uuid
from pathlib import Path

import numpy as np

import package
import splat
import spz
from compare_lidar import world_rotation
from geometry import rot_to_quat


def align_capture(source: Path, reference: Path, out: Path) -> None:
    manifest = json.loads((source / 'manifest.json').read_text())
    phone = json.loads((reference / 'manifest.json').read_text())
    shape = lambda m: (m['video']['width'], m['video']['height'])
    if shape(manifest) != shape(phone):
        raise ValueError('The packages must use the same video orientation.')
    reference_frames = {f['i']: f for f in package.read_frames(reference / 'frames.jsonl') if f.get('phase') == 'moment'}
    frames = package.read_frames(source / 'frames.jsonl')
    pairs = [(package.pose_of(f)[0], package.pose_of(reference_frames[f['i']])[0])
             for f in frames if f.get('phase') == 'moment' and f.get('i') in reference_frames]
    if len(pairs) < 3:
        raise ValueError('Not enough matching video frames to align this recording.')
    ours, target = np.stack([p[0] for p in pairs]), np.stack([p[1] for p in pairs])
    rotation = world_rotation(ours, target)
    translation = target[:, :3, 3].mean(0) - rotation @ ours[:, :3, 3].mean(0)
    transform = np.eye(4)
    transform[:3, :3], transform[:3, 3] = rotation, translation
    error = np.linalg.norm(ours[:, :3, 3] @ rotation.T + translation - target[:, :3, 3], axis=1)
    if out.exists():
        raise ValueError(f'Output already exists: {out}')
    shutil.copytree(source, out)
    points, colors = package.read_room_bin(source / manifest['room']['bin'])
    package.write_room_bin(out / manifest['room']['bin'], points @ rotation.T + translation, colors)
    if manifest['room'].get('ply'):
        package.write_room_ply(out / manifest['room']['ply'], points @ rotation.T + translation, colors)
    for frame in frames:
        pose, _ = package.pose_of(frame)
        frame['T'] = (transform @ pose).T.reshape(-1).tolist()
    (out / 'frames.jsonl').write_text(''.join(json.dumps(f) + '\n' for f in frames))
    info = manifest['room'].get('splat')
    if info:
        g = spz.read_spz(source / info['file']) if info['format'] == 'spz' else splat.read_ply(source / info['file'])
        if g['sh'].shape[1] not in (1, 4):
            raise ValueError('Only degree 0 and 1 splats can be aligned by this command.')
        g['means'] = g['means'] @ rotation.T + translation
        # Rotate each Gaussian's local axes in the same world frame as the cloud and cameras.
        w, xyz = g['quats'][:, :1], g['quats'][:, 1:]
        rw, rv = rot_to_quat(rotation)[0], rot_to_quat(rotation)[1:]
        g['quats'] = np.concatenate([rw * w - (xyz * rv).sum(1, keepdims=True), rw * xyz + w * rv + np.cross(rv, xyz)], axis=1)
        if g['sh'].shape[1] == 4:
            # Degree-one SH is a directional vector in the basis (-y, z, -x).
            vectors = np.stack([-g['sh'][:, 3], -g['sh'][:, 1], g['sh'][:, 2]], axis=1)
            vectors = np.einsum('ij,njc->nic', rotation, vectors)
            g['sh'][:, 1], g['sh'][:, 2], g['sh'][:, 3] = -vectors[:, 1], vectors[:, 2], -vectors[:, 0]
        spz.write_spz(out / 'room.spz', g['means'], g['scales'], g['quats'], g['opacities'], g['sh'])
        if info['file'] != 'room.spz':
            (out / info['file']).unlink()
        info.update(file='room.spz', format='spz')
    manifest['id'] = str(uuid.uuid4())
    manifest.setdefault('warnings', []).append('The room, camera path and splat were aligned to the original phone poses; no points were removed.')
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    print(json.dumps({'id': manifest['id'], 'points': len(points), 'path_rmse_m': float(np.sqrt(np.mean(error ** 2))), 'out': str(out)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--reference', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    align_capture(args.source, args.reference, args.out)
