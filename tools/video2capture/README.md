# video2capture: any video → a Braindance capture

Turns an ordinary video (no LiDAR) into a capture package the guide can import, using
Depth Anything 3 (DA3-BASE, Apache-2.0) on a Mac (MPS) or a Linux box with an NVIDIA GPU (CUDA).
Everything it makes is an estimate; the manifest says so (`"source": "video"`,
`"depth": {"estimated": true}`) and the website shows an "Estimated from a video" badge
(branch `web/video-estimated`).

Differences from a phone capture: depth comes at the model's sample rate (about 2 Hz, written in
`depth.rateHz`), not the phone's 10 Hz, on the same 256×192 grid; there's no scan phase and no
transcript. The viewer's people replay picks the depth frame nearest in time (up to one
`1/depth.rateHz` away), so it plays through at either rate.

Timing: every line of `frames.jsonl` carries the video frame's real presentation time, so
variable-frame-rate videos (common from phones) stay in sync. The model frames are the exact
frames that get a `d`, spaced evenly in time.

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
  omegaconf evo e3nn moviepy==1.0.3 plyfile pillow pillow_heif safetensors pycolmap typer requests addict matplotlib
.venv/bin/python -c "import torch; print(torch.cuda.get_device_name(0), torch.cuda.get_arch_list())"
```

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

The model (541,518,028 bytes) downloads from Hugging Face on first run. That download stalls on
venue Wi-Fi; if it does, fetch it with a resuming loop into `models/DA3-BASE/` (the script uses that
folder when `model.safetensors` is there; elsewhere, pass `--model <folder>`):

```bash
mkdir -p models/DA3-BASE && cd models/DA3-BASE
curl -sSLO https://huggingface.co/depth-anything/DA3-BASE/resolve/main/config.json
size() { stat -c %s "$1" 2>/dev/null || stat -f %z "$1" 2>/dev/null || echo 0; }   # Linux, then macOS
until [ "$(size model.safetensors)" -ge 541518028 ]; do
  curl -sSL -C - --speed-limit 20000 --speed-time 20 -o model.safetensors \
    https://huggingface.co/depth-anything/DA3-BASE/resolve/main/model.safetensors
done
```

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

Options: `--out` (default `out`), `--sample-fps` (default 2), `--max-frames` (default 40, for laptop
memory), `--device mps|cuda|cpu` (default: the best available), `--model <folder>`. Check the result
in the viewer: if the room looks upside down or mirrored, the pose conversion in `to_capture_pose`
is the place to look.

Speed: about a minute per clip on Apple MPS; 6–9 s per clip (3–10 s clips, 16–20 model frames,
including transcode, keyframes and import) on an RTX 5060 Ti, where the model pass itself takes
about 0.5 s.
