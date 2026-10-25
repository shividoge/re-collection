"""decode.py against real ffmpeg on small generated clips (skipped without an ffmpeg that has
libx264; set FFMPEG/FFPROBE like for the converter):  python -m unittest test_decode
Checks that the frames we decode once from the source are the frames video.mp4 shows, upright,
for every display rotation, and that video.mp4 keeps every frame and its timestamp."""

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import numpy as np

import decode


def has_x264() -> bool:
    try:
        out = subprocess.run([decode.FFMPEG, "-hide_banner", "-encoders"], capture_output=True, text=True).stdout
    except FileNotFoundError:
        return False
    return " libx264 " in out and (shutil.which(decode.FFPROBE) is not None or Path(decode.FFPROBE).exists())


@unittest.skipUnless(has_x264(), "needs an ffmpeg with libx264")
class Decode(unittest.TestCase):
    def make(self, folder: Path, rotation: int) -> Path:
        src = folder / "plain.mp4"
        subprocess.run([decode.FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", str(src)], check=True)
        if rotation == 0:
            return src
        out = folder / f"rot{rotation}.mp4"
        subprocess.run([decode.FFMPEG, "-v", "error", "-y", "-display_rotation", str(rotation), "-i", str(src),
                        "-c", "copy", str(out)], check=True)
        return out

    def test_frames_match_video_mp4_for_every_rotation(self):
        for rotation in (0, 90, -90, 180):
            with self.subTest(rotation=rotation), tempfile.TemporaryDirectory() as tmp:
                d = Path(tmp)
                info = decode.probe(self.make(d, rotation))
                self.assertEqual(info.frame_count, 60)
                self.assertEqual((info.width, info.height), (180, 320) if rotation % 180 else (320, 180))
                t = decode.Transcode(info, d / "video.mp4")
                wanted = [0, 17, 59]
                ours = decode.decode(info, wanted, 320, d / "keyframes")
                t.wait()  # also checks frame count and timestamps
                mp4 = decode.decode(decode.probe(d / "video.mp4"), wanted, 320, None)
                for i in wanted:
                    a, b = ours.frames[i].astype(float), mp4.frames[i].astype(float)
                    self.assertEqual(a.shape, b.shape)
                    self.assertLess(np.abs(a - b).mean(), 6, f"frame {i} differs from video.mp4")
                    self.assertGreater(np.abs(a - np.rot90(b, 2)).mean(), 20)  # a wrong turn would show
                self.assertEqual(sorted(p.name for p in (d / "keyframes").iterdir()), ["k0000.jpg", "k0001.jpg"])


if __name__ == "__main__":
    unittest.main()
