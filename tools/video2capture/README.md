# video2capture: any video → a Braindance capture

Turns an ordinary video (no LiDAR) into a capture package the guide can import, using
Depth Anything 3 (DA3-BASE, Apache-2.0) on a Mac (MPS) or any CUDA box. Everything it makes is an
estimate; the manifest says so and the website shows an "Estimated from a video" badge
(branch `web/video-estimated`).

## Setup (once, ~10 min)

```bash
cd tools/video2capture
uv venv --python 3.12 .venv
git clone https://github.com/ByteDance-Seed/Depth-Anything-3 da3
uv pip install --python .venv/bin/python -e da3 moviepy==1.0.3 addict matplotlib pycolmap evo
```

The model (541,518,028 bytes) downloads from Hugging Face on first run. That download stalls on
venue Wi-Fi; if it does, fetch it with a resuming loop into `models/DA3-BASE/` (the script uses that
folder when `model.safetensors` is there):

```bash
mkdir -p models/DA3-BASE && cd models/DA3-BASE
curl -sSLO https://huggingface.co/depth-anything/DA3-BASE/resolve/main/config.json
until [ "$(stat -f %z model.safetensors 2>/dev/null || echo 0)" -ge 541518028 ]; do
  curl -sSL -C - --speed-limit 20000 --speed-time 20 -o model.safetensors \
    https://huggingface.co/depth-anything/DA3-BASE/resolve/main/model.safetensors
done
```

## Run

```bash
.venv/bin/python video2capture.py ~/Downloads/IMG_9518.MOV --title "Cal Hacks booth" --out out
npm --prefix ../../guide run import -- "$PWD/out/capture-<id>"   # absolute path: npm runs the script from guide/
```

Options: `--attendees "Priya,Sam"`, `--sample-fps` (default 2), `--max-frames` (default 40, for laptop memory), `--device mps|cuda|cpu`. Check the result
in the viewer: if the room looks upside down or mirrored, the pose conversion in `to_capture_pose`
is the place to look.
