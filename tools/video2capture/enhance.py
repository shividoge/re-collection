"""Improve an existing capture without changing the original or a deployed GPU worker.

python enhance.py --capture /path/capture --out /path/experiment --holdout /path/holdout.json
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--capture', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--holdout', type=Path, help='Original conversion holdout.json; identical frames stay excluded')
    parser.add_argument('--passes', type=float, default=100)
    parser.add_argument('--width', type=int, default=1920)
    parser.add_argument('--cap', type=int, default=1_500_000)
    parser.add_argument('--keep', type=int, default=1_000_000)
    args = parser.parse_args()
    if args.passes <= 0 or args.width < 64 or args.cap < 100 or not 0 < args.keep <= args.cap:
        parser.error('Use positive passes, width >= 64 and 0 < keep <= cap with cap >= 100.')
    source, out = args.capture.resolve(), args.out.resolve()
    if out == source or source in out.parents:
        parser.error('Output must be outside the source capture.')
    if out.exists() and any(out.iterdir()):
        parser.error('Output must be empty; the source capture is never overwritten.')
    manifest = json.loads((source / 'manifest.json').read_text())
    holdout = json.loads(args.holdout.read_text())['frames'] if args.holdout else []
    out.mkdir(parents=True, exist_ok=True)
    # Copies make the experiment portable and prevent accidental writes through symlinks.
    shutil.copytree(source, out, dirs_exist_ok=True)
    import torch
    import fusion
    import splat
    import spz

    torch.manual_seed(0)
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    masks = fusion.MaskModel(torch.device(device))
    timings: dict[str, float] = {}
    g = splat.train_from_package(out, masks, device, holdout_frames=holdout, passes=args.passes,
                                width=args.width, batch=1, cap=args.cap, keep_max=args.keep,
                                detail=True, timings=timings)
    spz.write_spz(out / 'room.spz', g['means'], g['scales'], g['quats'], g['opacities'], g['sh'])
    manifest['room']['splat'] = {'file': 'room.spz', 'format': 'spz', 'count': len(g['means']),
                               'shDegree': 1, 'source': 'trained-from-video' if manifest.get('source') == 'video' else 'trained-from-lidar-capture'}
    manifest['room'].pop('completion', None)  # Completion must be checked again after retraining.
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    report = {'source': str(source), 'holdoutFrames': holdout, 'passes': args.passes,
              'width': args.width, 'cap': args.cap, 'keep': args.keep, 'timings': timings}
    (out / 'enhancement.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
