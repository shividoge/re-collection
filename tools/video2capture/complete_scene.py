"""Generate a separate, constrained completion layer for an existing capture.

--planes completes bounded observed planar patches. --objects imports degree-0 candidate PLYs
and their camera/world transforms from an object inventory; both remain labelled generated.
Never modifies room.spz or uses held-out images to fill geometry or colors.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

import completion
import package
import splat
import spz


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--capture', required=True, type=Path, help='Experiment folder, e.g. enhance.py output')
    parser.add_argument('--planes', action='store_true')
    parser.add_argument('--objects', type=Path, help='Candidate inventory JSON: captureId, method, objects[{id,file,cameraToWorld}]')
    parser.add_argument('--holdout', type=Path)
    args = parser.parse_args()
    if not args.planes and not args.objects:
        parser.error('Choose --planes and/or --objects.')
    capture = args.capture.resolve()
    manifest = json.loads((capture / 'manifest.json').read_text())
    if not manifest['room'].get('splat'):
        parser.error('Completion needs an evidence splat in the capture.')
    holdout = json.loads(args.holdout.read_text())['frames'] if args.holdout else []
    report_path = capture / 'enhancement.json'
    if report_path.exists():
        holdout = sorted(set(holdout) | set(json.loads(report_path.read_text()).get('holdoutFrames', [])))
    points, colors = package.read_room_bin(capture / manifest['room']['bin'])
    candidates = []
    if args.planes:
        candidates.append(('inferred-planes', completion.planar_candidates(points, colors)))
    if args.objects:
        objects = json.loads(args.objects.read_text())
        if objects.get('captureId') != manifest['id'] or not isinstance(objects.get('method'), str):
            raise ValueError('Object candidates need the matching captureId and their actual generation method.')
        for obj in objects['objects']:
            candidate = splat.read_ply(args.objects.parent / obj['file'])
            candidates.append((obj['id'], completion.transform_gaussians(candidate, np.array(obj['cameraToWorld']))))
    import torch
    import fusion
    import scene_inputs

    data = scene_inputs.load(capture, fusion.MaskModel(torch.device('cuda' if torch.cuda.is_available() else 'cpu')), holdout)
    accepted, reports = [], []
    for name, candidate in candidates:
        constrained, report = completion.constrain(candidate, points, data.depths, data.poses, data.intrinsics, data.colors, data.moving)
        reports.append({'id': name, **report})
        if len(constrained['means']):
            accepted.append(constrained)
    result = {'format': 'braindance.completion', 'version': 1, 'captureId': manifest['id'],
              'sourceFrames': [f['i'] for f in data.frames], 'holdoutFrames': holdout, 'objects': reports,
              'methods': (['inferred-planes'] if args.planes else []) + ([objects['method']] if args.objects else []),
              'reviewed': False}
    if not accepted:
        (capture / 'completion-failed.json').write_text(json.dumps(result, indent=2))
        raise RuntimeError('No completion passed the evidence checks. Original scene is unchanged; see completion-failed.json.')
    merged = {k: np.concatenate([g[k] for g in accepted]) for k in accepted[0]}
    spz.write_spz(capture / 'completion.spz', merged['means'], merged['scales'], merged['quats'], merged['opacities'], merged['sh'])
    (capture / 'completion.json').write_text(json.dumps(result, indent=2))
    manifest['room']['completion'] = {'file': 'completion.spz', 'format': 'spz', 'count': len(merged['means']),
                                     'shDegree': 0, 'source': 'generated', 'report': 'completion.json'}
    (capture / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
