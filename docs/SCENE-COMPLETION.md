# Detailed scenes from ordinary video

Srinivas requested both faithful rendering near recorded viewpoints and a complete, explorable
scene beyond them. Approximate dimensions are acceptable; recognizable objects and their
recorded appearance take priority. This updates the earlier rule that every unseen region must
remain empty, without changing the grounding rules for facts or narration.

## Representation

Keep the existing Three.js/Spark viewer. A scene has two independently stored layers:

- **Evidence:** trained room splats, optimized only against real frames. Preserve the original
  capture, moving-person replay and source video.
- **Completion:** generated object surfaces and inferred room structure in the same world frame.
  Always labelled as generated, independently switchable, and excluded from fact extraction.

Generated content must not replace a successful reconstruction merely because it looks smoother.
Observed object fronts constrain appearance; unobserved backs come from a learned shape prior.
One object identity spans multiple frames. Never independently generate and stack a copy per frame.

## Implementation order

1. Establish real-video reference renders, held-out frames and wider inspection viewpoints.
2. Improve evidence training: preserve spatial coverage at initialization and pruning, train at
   higher image resolution, and bound GPU memory by staging training images on the CPU.
3. Identify static objects across views, keep their masks, source frame IDs and depth support.
4. Generate candidate objects with SAM 3D Objects on the GX10 in an isolated environment.
   Align using the source camera and depth pointmap, then verify against other real views.
5. Admit completion only where it does not contradict visible geometry. Keep failure explicit
   and retain the evidence layer when an object cannot be completed reliably.
6. Add bounded room-surface completion supported by detected planes, without treating inferred
   walls as measurements. A completely unseen room layout remains a hypothesis.
7. Review both layers from the original camera, held-out cameras and wider viewpoints.

## Acceptance

Compare the same source clips with identical held-out frame IDs. Report image fidelity and
coverage for real viewpoints, plus object visibility and consistency under orbit/fly navigation.
Wider views have no ground truth, so visual review must not be described as reconstruction accuracy.
Check moving people separately. Generated texture, geometry and identity must not flicker or
duplicate between frames. Failure of generation must leave the original scene usable.

The first experiment runs locally, without changing an active worker or deploying the backend.
Model setup, measured results and remaining integration work are recorded below as completed.

## First experiment, October 25

Implemented `enhance.py`, which copies a capture to a separate output directory and retrains
its evidence splat at 1920 pixels, 100 passes, a 1.5M training budget and a 1M export budget.
Images stay on the CPU between batches. Spatially distributed samples survive initialization
and pruning, and RGB edges receive extra training weight. These changes are experimental;
the queued GPU worker's quality settings have not changed.

On the team's EEC77133 lab clip, holding out frames 12, 36, 59 and 83 from fusion/training:

- Baseline: PSNR 22.16 dB, SSIM 0.877, coverage 96.7%, 500,000 splats.
- Detail experiment: PSNR 22.83 dB, SSIM 0.889, coverage 96.2%, 1,000,000 splats, 17 MB SPZ.
- Training took 169 s on Fedora's RTX 5060 Ti. Preparation/pruning took another 9 s.

This is a modest recorded-view improvement, with slightly lower coverage. It does **not** meet
the requested complete-room target. The comparison tests the full configuration, not the
individual contribution of each change. Camera/depth estimates come from the original
conversion, which used the whole clip; held-out here means excluded from fusion/splat RGB fitting.

`complete_scene.py --planes` separately fits and fills bounded patches of observed planes.
Against the same training frames, it rejects candidates in observed free space, removes
duplicates near the original cloud, and copies source RGB where generated surfaces meet
recorded depth. This produced 72,061 extra splats, 468 KB, from 161,688 candidates. It is
geometric plane inference, **not SAM 3D output**. It does not reconstruct missing furniture or
invent a complete unseen room. The viewer exposes it through a default-off Generated completion
control, sharing one Spark renderer with the evidence layer.

Local experiment artifacts: `/tmp/bd-scene-completion/`. The `web/scene-lab.html` development
entry displays real local captures without using Convex, public storage or family session data.

Reproduce from the repo root using the converter environment and a full ffmpeg:

```sh
python tools/video2capture/enhance.py --capture /path/capture --out /path/experiment --holdout /path/holdout.json
python tools/video2capture/complete_scene.py --capture /path/experiment --planes --holdout /path/holdout.json
python tools/video2capture/evaluate.py --holdout /path/holdout.json --capture before=/path/capture --capture after=/path/experiment --sheet /path/comparison.jpg
```

`evaluate.py` scores the evidence layer. Completion requires a separate visual check; its
numbers must not be inferred from the evidence-only scores. `complete_scene.py --objects`
is an import boundary for degree-0 candidate splats with a known rigid transform. No automatic
object inventory, SAM inference adapter, learned-object result or queue integration is claimed.

## GX10 connection and remaining model work

Verified SSH: `ssh -i ~/.ssh/id_ed25519_gx10 asus@100.104.38.89` (Tailscale host `gx10-f548`).
The GPU is a GB10 with 128 GB unified memory; architecture is aarch64. Existing converter:
`~/braindance/video2capture/.venv/bin/python`, torch 2.14.1/cu130. No worker was running when
inspected. Keep experiments under `~/braindance/scene-completion/`; do not replace the converter.

The official SAM 3D source is cloned at `~/braindance/scene-completion/sam-3d-objects`.
On Oct 25 the GX10 was authenticated as `srinivasib` using `hf auth login` and its browser
device-authorization flow. Credentials stay in the GX10's private HF cache, never in this
repo. `HfApi().whoami()` succeeds, but downloading `facebook/sam-3d-objects/pipeline.yaml`
returns `GatedRepoError`. This account still shows Meta's access-request form; model access
must be approved before downloading weights. Videos need not be uploaded to Hugging Face.

Meta's published environment pins x86-64/CUDA 12.1 packages, including native spconv,
PyTorch3D and Kaolin dependencies. The GX10 needs a compatible isolated ARM/CUDA environment.
Its Docker socket is not accessible to the current SSH user. No dependency builds or system
permission changes have been run. Resolve the runtime, download the approved weights, then
test one masked object with a depth pointmap before integrating multi-view object association
and appearance refinement. Existing model research is not a guarantee of quality on these clips.

References: [SAM 3D setup](https://github.com/facebookresearch/sam-3d-objects/blob/main/doc/setup.md),
[SAM 3D inference](https://github.com/facebookresearch/sam-3d-objects/blob/main/notebook/inference.py).

Validation: 58 converter tests exercised (the three codec tests were rerun with the full ffmpeg),
219 web tests, 9 shared-codec tests and web typecheck pass. Lint reports existing warnings.
Browser check: loaded the real enhanced capture, enabled completion, orbited by dragging, then
disabled completion; no page errors. Inspected screenshots of the evidence, combined scene and
orbit view. T3 screenshot automation timed out twice; the fallback used headless Chromium with
SwiftShader at 640×480. It rendered slowly, so this does not establish tablet performance.
No production build, backend deployment or active-worker modification was performed.
