"""decode.py against real ffmpeg on small generated clips (skipped without an ffmpeg that has
libx264; set FFMPEG/FFPROBE like for the converter):  python -m unittest test_decode
Checks that the frames we decode once from the source are the frames video.mp4 shows, upright,
for every display rotation and mirror (and that ffmpeg's own autorotation agrees), that video.mp4
keeps every frame and its timestamp, and that its first frame plays at 0 like frame t 0."""

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import numpy as np

import decode

ORIENTATIONS = [(0, False, False), (90, False, False), (-90, False, False), (180, False, False),
                (0, True, False), (0, False, True), (90, True, False), (90, False, True)]


def has_x264() -> bool:
    try:
        out = subprocess.run([decode.FFMPEG, "-hide_banner", "-encoders"], capture_output=True, text=True).stdout
    except FileNotFoundError:
        return False
    return " libx264 " in out and (shutil.which(decode.FFPROBE) is not None or Path(decode.FFPROBE).exists())


def ffmpeg(*args: str) -> None:
    subprocess.run([decode.FFMPEG, "-v", "error", "-y", *args], check=True)


def plain(folder: Path, audio: bool = False) -> Path:
    """A 2 s clip whose frames are unevenly spaced (like a phone's variable frame rate)."""
    src = folder / "plain.mp4"
    inputs = ["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2"]
    if audio:
        inputs += ["-f", "lavfi", "-i", "sine=frequency=440:duration=2"]
    ffmpeg(*inputs, "-vf", "settb=1/600,setpts='(N/30+0.011*mod(N\\,3))/TB'", "-fps_mode", "passthrough",
           "-enc_time_base:v", "1/600", "-video_track_timescale", "600", "-c:v", "libx264", "-pix_fmt", "yuv420p",
           *(["-c:a", "aac"] if audio else []), str(src))
    return src


def first_frame_autorotated(path: Path, w: int, h: int) -> np.ndarray:
    """Frame 0 as ffmpeg's own autorotation shows it (an independent reference)."""
    out = subprocess.run([decode.FFMPEG, "-v", "error", "-i", str(path), "-frames:v", "1", "-f", "rawvideo",
                          "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(out, np.uint8).reshape(h, w, 3)


def side_data(path: Path) -> list:
    out = subprocess.run([decode.FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_streams", "-of", "json",
                          str(path)], capture_output=True, text=True, check=True).stdout
    return json.loads(out)["streams"][0].get("side_data_list", [])


def stream_starts(path: Path) -> dict[str, float]:
    out = subprocess.run([decode.FFPROBE, "-v", "error", "-show_entries", "stream=codec_type,start_time", "-of", "json",
                          str(path)], capture_output=True, text=True, check=True).stdout
    return {s["codec_type"]: float(s["start_time"]) for s in json.loads(out)["streams"]}


@unittest.skipUnless(has_x264(), "needs an ffmpeg with libx264")
class Decode(unittest.TestCase):
    def make(self, folder: Path, rotation: int, hflip: bool = False, vflip: bool = False) -> Path:
        src = plain(folder)
        if not (rotation or hflip or vflip):
            return src
        out = folder / f"rot{rotation}{'h' * hflip}{'v' * vflip}.mp4"
        flags = ["-display_rotation", str(rotation)] + ["-display_hflip"] * hflip + ["-display_vflip"] * vflip
        ffmpeg(*flags, "-i", str(src), "-c", "copy", str(out))
        return out

    def test_frames_match_video_mp4_for_every_rotation_and_mirror(self):
        for rotation, hflip, vflip in ORIENTATIONS:
            with self.subTest(rotation=rotation, hflip=hflip, vflip=vflip), tempfile.TemporaryDirectory() as tmp:
                d = Path(tmp)
                src = self.make(d, rotation, hflip, vflip)
                info = decode.probe(src)
                self.assertEqual(info.frame_count, 60)
                self.assertAlmostEqual(float(info.times[1]), 1 / 30 + 0.011, places=2)  # uneven spacing survived
                self.assertEqual((info.width, info.height), (180, 320) if rotation % 180 else (320, 180))
                t = decode.Transcode(info, d / "video.mp4")
                wanted = [0, 17, 59]
                ours = decode.decode(info, wanted, 320, d / "keyframes")
                t.wait()  # also checks frame count and timestamps
                self.assertEqual([s for s in side_data(d / "video.mp4") if s.get("side_data_type") == "Display Matrix"], [])
                mp4 = decode.decode(decode.probe(d / "video.mp4"), wanted, 320, None)
                for i in wanted:
                    a, b = ours.frames[i].astype(float), mp4.frames[i].astype(float)
                    self.assertEqual(a.shape, b.shape)
                    self.assertLess(np.abs(a - b).mean(), 6, f"frame {i} differs from video.mp4")
                    self.assertGreater(np.abs(a - np.rot90(b, 2)).mean(), 20)  # a wrong turn would show
                    self.assertGreater(np.abs(a - b[:, ::-1]).mean(), 20)  # and so would a mirror
                ref = first_frame_autorotated(src, info.width, info.height).astype(float)
                self.assertLess(np.abs(ours.frames[0].astype(float) - ref).mean(), 6, "ffmpeg shows it differently")
                names = sorted(p.name for p in (d / "keyframes").iterdir())
                self.assertEqual(names, [f"k{s:04d}.jpg" for s in range(int(info.duration - 1e-3) + 1)])

    def test_unsupported_display_matrix_is_refused(self):
        with self.assertRaisesRegex(decode.ConvertError, "quarter-turn or a mirror"):
            decode.Orientation.from_matrix((46341, 46341, 0, -46341, 46341, 0, 0, 0, 1 << 30))  # 45 degrees
        self.assertEqual(decode.Orientation.from_matrix((-65536, 0, 0, 0, 65536, 0, 0, 0, 1 << 30)),
                         decode.Orientation(flip_cols=True))

    def test_video_mp4_starts_at_the_first_video_frame(self):
        # Video starting 0.5 s after the audio (and after the file's start), and the other way round.
        for video_delay, audio_delay in ((0.5, 0.0), (0.0, 0.3)):
            with self.subTest(video_delay=video_delay, audio_delay=audio_delay), tempfile.TemporaryDirectory() as tmp:
                d = Path(tmp)
                src = plain(d, audio=True)
                late = d / "late.mp4"
                ffmpeg("-itsoffset", str(video_delay), "-i", str(src), "-itsoffset", str(audio_delay), "-i", str(src),
                       "-map", "0:v", "-map", "1:a", "-c", "copy", str(late))
                self.assertAlmostEqual(stream_starts(late)["video"] - stream_starts(late)["audio"],
                                       video_delay - audio_delay, delta=0.05)
                info = decode.probe(late)
                self.assertEqual(float(info.times[0]), 0.0)
                t = decode.Transcode(info, d / "video.mp4")
                ours = decode.decode(info, [0, 30], 320, None)
                t.wait()  # checks video.mp4's frame times against frames.jsonl's t, absolutely
                got = decode.packet_times(d / "video.mp4")
                self.assertEqual(len(got), 60)
                self.assertLess(abs(float(got[0])), 1e-3)  # frame t 0 plays at video time 0
                starts = stream_starts(d / "video.mp4")
                # Audio keeps its place relative to the picture (cut where it came before the first frame).
                self.assertAlmostEqual(starts["audio"] - starts["video"], max(0.0, audio_delay - video_delay), delta=0.05)
                mp4 = decode.decode(decode.probe(d / "video.mp4"), [0, 30], 320, None)
                for i in (0, 30):
                    self.assertLess(np.abs(ours.frames[i].astype(float) - mp4.frames[i].astype(float)).mean(), 6)


if __name__ == "__main__":
    unittest.main()
