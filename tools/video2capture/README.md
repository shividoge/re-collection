# video2capture: any video → a Braindance capture

Turns an ordinary video (no LiDAR) into a capture package the guide can import, using
Depth Anything 3 (default **DA3NESTED-GIANT-LARGE-1.1**: multi-view depth and camera poses, plus a
metric-depth model for real-world scale) and, optionally, a **Gaussian splat** of the room trained
with gsplat. Runs on a Linux box with an NVIDIA GPU (CUDA), the GX10, or a Mac (MPS, no splat
training). Everything it makes is an estimate; the manifest says so (`"source": "video"`,
`"depth": {"estimated": true}`) and the website shows an "Estimated from a video" badge
(branch `web/video-estimated`).

## What it does

1. Samples up to 10 frames per second (as many as fit in GPU memory; longer videos are sampled
   more sparsely) and runs Depth Anything 3 on all of them at once: depth, poses, intrinsics, scale.
2. Turns the world so gravity points down (a handheld camera keeps its x axis level).
3. Decides which pixels may become part of the **static room**. It drops:
   - pixels at depth jumps (the "flying pixels" that streak between a person and the wall);
   - pixels that neighbouring frames contradict (floaters, double walls);
   - the least confident 5%, and sky;
   - people and pets (torchvision Mask R-CNN).
4. Fuses the rest into `room.bin` at 1 cm, at twice the model's resolution, coloured from the
   full-resolution video.
5. `--splat train` (default): trains `room.splat.ply` on the frames with gsplat (3DGS-MCMC,
   people masked out of the loss, depth kept close to the model's, a per-frame exposure
   correction), starting from the fused room. `--splat none` skips it. Format: `docs/capture-format.md`,
   "room splat". The viewer draws it with Spark and keeps "Points (raw)" a click away.
6. Writes `depth.bin` for the people replay from every model frame (people kept, depth edges
   removed), `frames.jsonl` with each video frame's real timestamp and pose, keyframes, the manifest.

Differences from a phone capture: depth comes at the model's sample rate (up to 10 Hz, written
in `depth.rateHz`), on the same 256×192 grid; there's no scan phase and no transcript.

The script stops with an error instead of writing a capture if the model's depth, scale, poses or
intrinsics aren't finite. Pixels without usable depth are written as depth 0, confidence 0.

## Setup on a Mac (MPS), once

```bash
cd tools/video2capture
uv venv --python 3.12 .venv
git clone https://github.com/ByteDance-Seed/Depth-Anything-3 da3
uv pip install --python .venv/bin/python -e da3 moviepy==1.0.3 addict matplotlib pycolmap evo
```

ffmpeg from Homebrew (`brew install ffmpeg`) has everything the script needs.

## Setup on Linux with an NVIDIA GPU (CUDA), once

Checked on Fedora 43 with an RTX 5060 Ti (Blackwell, sm_120). Blackwell needs PyTorch built for
CUDA 12.8 or newer; older wheels fail with "no kernel image". DA3 supports Python 3.9–3.13, so pin
3.12 even if the system Python is newer.

```bash
cd tools/video2capture
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python torch torchvision --index-url https://download.pytorch.org/whl/cu128
git clone https://github.com/ByteDance-Seed/Depth-Anything-3 da3
# --no-deps: DA3 lists xformers (optional in its code; the PyPI wheel pins another torch and would
# replace the CUDA 12.8 build) and open3d (only its benchmarks use it).
uv pip install --python .venv/bin/python --no-deps -e da3
uv pip install --python .venv/bin/python "numpy<2" trimesh einops huggingface_hub imageio opencv-python \
  omegaconf evo e3nn moviepy==1.0.3 plyfile pillow pillow_heif safetensors pycolmap typer requests addict matplotlib scipy
.venv/bin/python -c "import torch; print(torch.cuda.get_device_name(0), torch.cuda.get_arch_list())"
```

### gsplat (for `--splat train`), once

gsplat has no prebuilt wheel for current PyTorch, so it compiles (about a minute). It must be the
commit DA3 pins. Where a CUDA toolkit and a supported GCC are installed (Ubuntu, the GX10: CUDA 13,
GCC 13), that's all it takes:

```bash
git clone --recursive https://github.com/nerfstudio-project/gsplat.git gsplat-src
git -C gsplat-src checkout 0b4dddf04cb687367602c01196913cde6a743d70 && git -C gsplat-src submodule update --init --recursive
uv pip install --python .venv/bin/python ninja jaxtyping wheel
CUDA_HOME=/usr/local/cuda PATH=/usr/local/cuda/bin:$PATH TORCH_CUDA_ARCH_LIST="12.0;12.1" \
  uv pip install --python .venv/bin/python --no-build-isolation --no-deps ./gsplat-src
```

With PyTorch 2.14 (the GX10's CUDA 13 build), change `-std=c++17` to `-std=c++20` in
`gsplat-src/setup.py` first; on aarch64, `pycolmap` has no wheel (leave it out; only DA3's COLMAP
export needs it, so move its import in `da3/src/depth_anything_3/api.py` into that function).

**Fedora 43 without a CUDA toolkit or sudo** (checked with the RTX 5060 Ti). Four problems, four fixes:
the pip `nvidia-cuda-nvcc` wheel ships no `nvcc` (use NVIDIA's redist tarballs); CUDA 12.8 rejects
GCC 15 (use Homebrew's GCC 14); glibc 2.42's math headers clash with CUDA 12.8's (patch the local
copy); Homebrew GCC 14's `pthread.h` predates glibc 2.41 (forward it to the system header). From
`tools/video2capture`:

```bash
set -euo pipefail
BUILD=${BUILD:-$HOME/.cache/braindance-gsplat}; CUDA=$BUILD/cuda-12.8; mkdir -p "$BUILD/dl" "$CUDA"
brew install gcc@14
export CC=$(brew --prefix)/bin/gcc-14 CXX=$(brew --prefix)/bin/g++-14; export NVCC_CCBIN=$CXX
R=https://developer.download.nvidia.com/compute/cuda/redist
for p in cuda_nvcc/linux-x86_64/cuda_nvcc-linux-x86_64-12.8.93 cuda_cudart/linux-x86_64/cuda_cudart-linux-x86_64-12.8.90 \
         cuda_cccl/linux-x86_64/cuda_cccl-linux-x86_64-12.8.90 cuda_nvtx/linux-x86_64/cuda_nvtx-linux-x86_64-12.8.90 \
         cuda_profiler_api/linux-x86_64/cuda_profiler_api-linux-x86_64-12.8.90; do
  f=$BUILD/dl/$(basename $p)-archive.tar.xz; [ -f "$f" ] || curl -fL "$R/$p-archive.tar.xz" -o "$f"
  tar -xJf "$f" --strip-components=1 -C "$CUDA"
done
ln -sfn lib "$CUDA/lib64"
NV=$PWD/.venv/lib/python3.12/site-packages/nvidia
for p in cublas cusparse cusolver curand cufft; do ln -sf "$NV"/$p/include/*.h "$CUDA/include/"; done
sed -i -E 's/^(extern __DEVICE_FUNCTIONS_DECL__ __device_builtin__ (double|float) +(sinpi|cospi|rsqrt|sinpif|cospif|rsqrtf)\((double|float) x\));/\1 noexcept (true);/' \
  "$CUDA/include/crt/math_functions.h"
mkdir -p "$BUILD/glibc-fix" && echo '#include "/usr/include/pthread.h"' > "$BUILD/glibc-fix/pthread.h"
export CPATH=$BUILD/glibc-fix
[ -d "$BUILD/gsplat" ] || git clone https://github.com/nerfstudio-project/gsplat.git "$BUILD/gsplat"
git -C "$BUILD/gsplat" checkout 0b4dddf04cb687367602c01196913cde6a743d70 && git -C "$BUILD/gsplat" submodule update --init --recursive
export CUDA_HOME=$CUDA PATH=$CUDA/bin:$PATH TORCH_CUDA_ARCH_LIST=12.0 MAX_JOBS=8
export TORCH_DONT_CHECK_COMPILER_ABI=1   # torch's table caps CUDA 12.8 at GCC < 14; nvcc 12.8 accepts 14
uv pip install --python .venv/bin/python ninja jaxtyping wheel
uv build --wheel --no-build-isolation --python .venv/bin/python -o "$BUILD/wheels" "$BUILD/gsplat"
uv pip install --python .venv/bin/python --no-deps --reinstall "$BUILD/wheels"/gsplat-1.5.2-*.whl
```

Nothing is needed at run time: the venv loads the prebuilt extension. Check with
`.venv/bin/python -m unittest test_video2capture` (pure logic, no GPU) and a real run.

### ffmpeg on Linux

The script needs an ffmpeg with the **libx264** encoder and a decoder for the input (iPhone videos are
**HEVC**). Fedora's default `ffmpeg-free` has neither, and the script stops with a message saying so
before it writes anything. Either:

- swap in RPM Fusion's full build: `sudo dnf swap ffmpeg-free ffmpeg --allowerasing`, or
- without sudo, use a static build and point the script at it with `FFMPEG` and `FFPROBE`:

```bash
mkdir -p ffmpeg && cd ffmpeg
gh release download latest -R BtbN/FFmpeg-Builds -p 'ffmpeg-n8.1-latest-linux64-gpl-8.1.tar.xz' -p checksums.sha256
grep linux64-gpl-8.1.tar.xz checksums.sha256 | sha256sum -c - && tar -xJf ffmpeg-n8.1-*.tar.xz --strip-components=1
cd .. && export FFMPEG=$PWD/ffmpeg/bin/ffmpeg FFPROBE=$PWD/ffmpeg/bin/ffprobe
```

Ubuntu/Debian's `apt install ffmpeg` already has both.

## The model

The default, `DA3NESTED-GIANT-LARGE-1.1` (6,759,558,100 bytes, **CC BY-NC 4.0: non-commercial use
only**), downloads from Hugging Face on first run. That download stalls on venue Wi-Fi; if it does,
fetch it with a resuming loop into `models/DA3NESTED-GIANT-LARGE-1.1/` (the script uses that folder
when `model.safetensors` is there; elsewhere, pass `--model <folder>`):

```bash
M=DA3NESTED-GIANT-LARGE-1.1 SIZE=6759558100
mkdir -p models/$M && cd models/$M
curl -sSLO https://huggingface.co/depth-anything/$M/resolve/main/config.json
size() { stat -c %s "$1" 2>/dev/null || stat -f %z "$1" 2>/dev/null || echo 0; }   # Linux, then macOS
until [ "$(size model.safetensors)" -ge $SIZE ]; do
  curl -sSL -C - --speed-limit 20000 --speed-time 20 -o model.safetensors \
    https://huggingface.co/depth-anything/$M/resolve/main/model.safetensors
done
```

It needs about 8.6 GiB of GPU memory plus 0.065 GiB per frame: a 16 GB card takes about 67
frames at once, the GX10 (128 GB) up to the 240-frame cap. For the Apache-2.0 model, or a smaller
GPU or a Mac, use `DA3-BASE` (541,518,028 bytes; no metric scale, so `--median-depth` sets the
size; same loop with `M=DA3-BASE SIZE=541518028`) and pass `--model models/DA3-BASE`.

## Run: one command, video → capture → guide

From `tools/video2capture`, with the guide's data where you want it (`DATA_DIR`, as when starting
the guide; default `guide/data`):

```bash
.venv/bin/python video2capture.py ~/Videos/birthday-2015.mov --title "Mom's 70th birthday" --attendees "Priya,Sam" --import
```

`--import` runs `node guide/scripts/import.mjs` on the new folder, which copies it into the guide's
data and validates it (`guide/src/validate.mjs`). Without `--import`, import it yourself:
`node ../../guide/scripts/import.mjs out/capture-<id>`. A guide that is already running lists the
capture right away (viewer, Memory Window, museum), but only queues fact extraction: restart the guide
to start it.

Options: `--out` (default `out`), `--sample-fps` (default 10), `--max-frames` (default: what fits
in GPU memory), `--voxel` (default 0.01 m) and `--max-points` (default 2,000,000; big scenes get
coarser voxels), `--splat train|none`, `--splat-steps` (7000), `--splat-max` (1,000,000 Gaussians),
`--splat-width` (training image width, 1280), `--device mps|cuda|cpu`, `--model <folder>`. Check the
result in the viewer: if the room looks upside down or mirrored, the pose conversion in
`to_capture_pose` is the place to look.

Speed (3–10 s clips, 32–67 model frames, end to end): about 6 minutes on an RTX 5060 Ti, nearly
all of it the 7000 training steps; about 40 s with `--splat none`. The GX10 trains 2–3 times
slower than the 5060 Ti (it has less memory bandwidth), so use it only for videos that need more
frames than a 16 GB card holds.

## Checking quality

`--holdout 8` leaves every 8th model frame out of the room and the splat. `evaluate.py` then
renders each capture from those frames' poses and scores it against the real frames (PSNR, SSIM
and coverage, people and pets excluded), and draws a comparison sheet that ends with a view from
outside the recorded path:

```bash
.venv/bin/python video2capture.py clip.mov --holdout 8 --out out
.venv/bin/python evaluate.py --holdout out/capture-<id>.holdout.json \
  --capture before=<older capture of the same clip> --capture after=out/capture-<id> --sheet compare.jpg
```

On the three team clips (`team-data-1`), against the captures this script made before (DA3-BASE,
16–20 frames), PSNR on held-out frames and the share of the frame filled:

| Clip | Before: points | After: points | After: splat |
|---|---|---|---|
| IMG_9516 (bedroom, camera almost still) | 11.8 dB, 64% | 17.9 dB, 91% | 31.4 dB, 96% |
| IMG_9518 (concert hall, many people) | 6.9 dB, 64% | 19.1 dB, 97% | 23.4 dB, 88% |
| EEC77133 (lab, camera moving) | 11.2 dB, 76% | 18.6 dB, 97% | 21.9 dB, 93% |

The splat scores would be higher (31 and 28 dB for the last two) if it were allowed to guess:
it leaves empty what no frame saw, such as the room behind people who never moved, instead of
smearing colour there. The people replay draws the people in those places.

Known limits: away from the recorded path the splat gets thin and stretched where the camera
barely looked, more so the less the camera moved. "Points (raw)" in the viewer shows exactly what
was estimated. Splat files are 30–80 MB (PLY, SH degree 1): fine locally, slow over a tunnel.
