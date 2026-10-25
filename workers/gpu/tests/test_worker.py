"""GPU worker loop tests: a fake Convex job table, a local HTTP server standing in for R2, and a
fake pipeline. No network beyond 127.0.0.1, no keys, no GPU."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import signal
import threading
import time
from collections.abc import Callable, Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

import pytest

from workers.gpu import transfer
from workers.gpu.client import HttpConvex, WorkerApi
from workers.gpu.config import Config, ConfigError, load_config, parse_env_file
from workers.gpu.errors import (
    Cancelled,
    ConvexError,
    ConvexServerError,
    PermanentError,
    SizeMismatch,
    classify,
    is_oom,
    redact,
)
from workers.gpu.worker import STOP_MESSAGE, Worker

TOKEN = "tok-SECRET-0123456789"
SIG = "X-Amz-Signature=SECRETSIG"
PART_SIZE = 64 * 1024
SINGLE_LIMIT = 100_000


# ---- a local stand-in for R2 (GET files, PUT single objects and parts) and Convex's HTTP API --


class Store:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.files: dict[str, bytes] = {}
        self.gets: list[str] = []
        self.puts: dict[str, bytes] = {}
        self.put_headers: dict[str, dict[str, str]] = {}
        self.post_replies: list[tuple[int, bytes]] = []
        self.posts: list[dict[str, object]] = []
        self.put_statuses: list[int] = []  # replies for the next PUTs (then 200)
        self.put_count = 0
        self.get_count = 0


def make_handler(store: Store) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_: object) -> None:
            pass

        def _reply(self, status: int, body: bytes = b"", headers: dict[str, str] | None = None) -> None:
            self.send_response(status)
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            name = urlsplit(self.path).path.removeprefix("/files/")
            with store.lock:
                store.gets.append(name)
                store.get_count += 1
                data = store.files.get(name)
            self._reply(404) if data is None else self._reply(200, data)

        def do_PUT(self) -> None:
            size = int(self.headers["Content-Length"])
            body = self.rfile.read(size)
            key = urlsplit(self.path).path
            with store.lock:
                store.put_count += 1
                status = store.put_statuses.pop(0) if store.put_statuses else 200
            if len(body) < size:  # the client stopped sending
                return
            if status != 200:
                self._reply(status)
                return
            with store.lock:
                store.puts[key] = body
                store.put_headers[key] = dict(self.headers)
            self._reply(200, headers={"ETag": f'"{hashlib.md5(body).hexdigest()}"'})

        def do_POST(self) -> None:
            store.posts.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            status, body = store.post_replies.pop(0)
            self._reply(status, body, {"Content-Type": "application/json"})

    return Handler


@pytest.fixture
def server() -> Iterator[tuple[str, Store]]:
    store = Store()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(store))
    thread = threading.Thread(target=httpd.serve_forever, args=(0.02,), daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}", store
    httpd.shutdown()
    httpd.server_close()


# ---- fake Convex: the worker functions' semantics over an in-memory job table -----------------


class FakeConvex:
    def __init__(self, base: str, store: Store, clock: Callable[[], float]) -> None:
        self.base, self.store, self.clock = base, store, clock
        self.lock = threading.Lock()
        self.jobs: dict[str, dict[str, object]] = {}
        self.calls: list[tuple[str, dict[str, object]]] = []
        self.uploads: dict[str, dict[str, object]] = {}
        self.objects: dict[str, bytes] = {}
        self.claim_times: list[float] = []
        self.claim_errors: list[Exception] = []
        self.cancel_on_stage: str | None = None
        self.lease_lost_on_stage: str | None = None
        self._n = 0

    def add_job(self, kind: str, *, files: dict[str, tuple[str, bytes]], frames: int | None = 30,
                gpu: bool = True, manifest_json: str | None = None, lie_bytes: int = 0) -> str:
        """Queue a job whose inputs are `files` ({name: (area, bytes)}), served by the local server."""
        self._n += 1
        job_id = f"job{self._n}"
        for name, (_, data) in files.items():
            self.store.files[f"{job_id}/{name}"] = data
        self.jobs[job_id] = {"kind": kind, "captureId": f"cap{self._n}", "gpu": gpu, "frames": frames,
                             "status": "queued", "attempts": 0, "files": files, "manifestJson": manifest_json,
                             "lie": lie_bytes, "result": None, "error": None, "progress": []}
        return job_id

    def _job(self, args: dict[str, object]) -> dict[str, object]:
        """Every call after claim must carry the claim's attempt (the v3 protocol)."""
        j = self.jobs[str(args["jobId"])]
        assert args.get("attempt") == j["attempts"], f"attempt {args.get('attempt')} != {j['attempts']}"
        return j

    def mutation(self, name: str, args: dict[str, object]) -> object:
        return self._call(name, args)

    def action(self, name: str, args: dict[str, object]) -> object:
        return self._call(name, args)

    def _call(self, name: str, args: dict[str, object]) -> object:
        if args.get("token") != TOKEN:
            raise ConvexError("Wrong worker token.", {"code": "unauthorized"})
        rest = {k: v for k, v in args.items() if k != "token"}
        with self.lock:
            self.calls.append((name, rest))
        return getattr(self, "_" + name.split(":")[1])(rest)

    def _claim(self, a: dict[str, object]) -> object:
        self.claim_times.append(self.clock())
        if self.claim_errors:
            raise self.claim_errors.pop(0)
        max_frames = a.get("maxFrames")
        for job_id, j in self.jobs.items():
            frames = j["frames"]
            fits = frames is None or (isinstance(max_frames, int) and isinstance(frames, int) and frames <= max_frames)
            if j["status"] == "queued" and j["kind"] in a["kinds"] and (a["gpu"] or not j["gpu"]) and fits:
                j["status"] = "leased"
                j["attempts"] = int(j["attempts"]) + 1
                return {"jobId": job_id, "kind": j["kind"], "captureId": j["captureId"], "attempt": j["attempts"]}
        return None

    def _heartbeat(self, a: dict[str, object]) -> object:
        j = self._job(a)
        progress = a.get("progress")
        stage = progress["stage"] if isinstance(progress, dict) else None
        if progress:
            j["progress"].append(progress)  # type: ignore[union-attr]
        if self.lease_lost_on_stage and stage == self.lease_lost_on_stage:
            raise ConvexError("Job is not leased to this worker.", {"code": "not_leased"})
        return {"ok": True, "cancelled": bool(self.cancel_on_stage and stage == self.cancel_on_stage)}

    def _inputs(self, a: dict[str, object]) -> object:
        j, job_id = self._job(a), str(a["jobId"])
        files = j["files"]
        assert isinstance(files, dict)
        return {"manifestJson": j["manifestJson"], "files": [
            {"name": n, "area": area, "url": f"{self.base}/files/{job_id}/{n}?{SIG}", "bytes": len(data) + int(j["lie"])}
            for n, (area, data) in files.items()]}

    def _outputUrls(self, a: dict[str, object]) -> object:
        self._job(a)
        out = []
        for f in a["files"]:  # type: ignore[union-attr]
            uid = f"up{len(self.uploads) + 1}"
            self.uploads[uid] = {"name": f["name"], "bytes": f["bytes"], "area": f["area"], "contentType": f["contentType"]}
            if f["bytes"] <= SINGLE_LIMIT:
                target = {"uploadId": uid, "key": f"k/{f['name']}",
                          "single": {"url": f"{self.base}/put/{uid}?{SIG}", "headers": {"Content-Type": f["contentType"]}}}
            else:
                n = -(-f["bytes"] // PART_SIZE)
                target = {"uploadId": uid, "key": f"k/{f['name']}", "partSize": PART_SIZE,
                          "parts": [{"partNumber": i, "url": f"{self.base}/part/{uid}/{i}?{SIG}"} for i in range(1, n + 1)]}
            out.append({"name": f["name"], "target": target})
        return out

    def _finishOutput(self, a: dict[str, object]) -> object:
        self._job(a)
        up = self.uploads[str(a["uploadId"])]
        parts = a.get("parts")
        if parts is None:
            data = self.store.puts[f"/put/{a['uploadId']}"]
        else:
            chunks = []
            for p in sorted(parts, key=lambda p: p["partNumber"]):  # type: ignore[union-attr]
                body = self.store.puts[f"/part/{a['uploadId']}/{p['partNumber']}"]
                assert p["etag"] == f'"{hashlib.md5(body).hexdigest()}"'
                chunks.append(body)
            data = b"".join(chunks)
        assert len(data) == up["bytes"]
        self.objects[str(up["name"])] = data
        return {"ok": True, "bytes": len(data)}

    def _complete(self, a: dict[str, object]) -> object:
        j = self._job(a)
        j["status"], j["result"] = "done", a["result"]
        return {"ok": True}

    def _fail(self, a: dict[str, object]) -> object:
        j = self._job(a)
        j["error"] = (a["error"], a["retryable"])
        j["status"] = "queued" if a["retryable"] and int(j["attempts"]) < 3 else "failed"
        return {"ok": True}

    def names(self) -> list[str]:
        return [n for n, _ in self.calls]


# ---- fake pipeline ------------------------------------------------------------------------------


class OutOfMemoryError(RuntimeError):
    """Same class name as torch.cuda.OutOfMemoryError."""


MANIFEST = '{\r\n  "id": "cap1", "title": "Grandma’s birthday"\n}'


class FakePipeline:
    max_frames = 67
    splat_inputs = ("manifest.json", "frames.jsonl", "video.mp4", "room.bin")

    def __init__(self, mode: str = "ok") -> None:
        self.mode = mode
        self.ooms_left = 1
        self.calls: list[dict[str, object]] = []
        self.written: dict[str, bytes] = {}

    def _write(self, out: Path, name: str, data: bytes) -> None:
        (out / name).parent.mkdir(parents=True, exist_ok=True)
        (out / name).write_bytes(data)
        self.written[name] = data

    def _maybe_fail(self, should_stop: Callable[[], bool]) -> None:
        if self.mode == "permanent":
            raise PermanentError("Couldn't read the video: it has no video stream.")
        if self.mode == "oom" and self.ooms_left:
            self.ooms_left -= 1
            raise OutOfMemoryError("CUDA out of memory. Tried to allocate 2.00 GiB")
        if self.mode in ("wait", "sigterm"):
            if self.mode == "sigterm":
                os.kill(os.getpid(), signal.SIGTERM)
            deadline = time.monotonic() + 5
            while not should_stop():
                assert time.monotonic() < deadline, "the pipeline was never told to stop"
                time.sleep(0.01)
            raise Cancelled()

    def convert(self, video: Path, out: Path, *, capture_id: str, title: str, attendees: list[str],
                progress: Callable[[str, float | None, str], None], should_stop: Callable[[], bool]) -> dict[str, object]:
        self.calls.append({"video": video.read_bytes(), "name": video.name, "capture_id": capture_id,
                           "title": title, "attendees": attendees})
        progress("depth", 0.1, "Estimating depth")
        self._maybe_fail(should_stop)
        self._write(out, "manifest.json", MANIFEST.encode())
        self._write(out, "room.bin", os.urandom(200_000))  # multipart: 4 parts of 64 KiB
        self._write(out, "frames.jsonl", b'{"t":0}\n{"t":0.1}\n')
        self._write(out, "video.mp4", video.read_bytes())
        self._write(out, "thumb.jpg", b"\xff\xd8thumb")
        self._write(out, "keyframes/k0000.jpg", b"\xff\xd8k0")
        self._write(out, "keyframes/k0001.jpg", b"\xff\xd8k1")
        return json.loads(MANIFEST)

    def splat(self, capture: Path, out: Path, *, progress: Callable[[str, float | None, str], None],
              should_stop: Callable[[], bool]) -> dict[str, object]:
        self.calls.append({"inputs": sorted(p.name for p in capture.iterdir())})
        progress("training", 0.5, "Training the splat")
        self._maybe_fail(should_stop)
        self._write(out, "room.spz", os.urandom(150_000))
        return {"file": "room.spz", "format": "spz", "count": 1234, "shDegree": 0, "source": "trained-from-video"}


# ---- harness ------------------------------------------------------------------------------------


class FakeTime:
    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []
        self.on_sleep: Callable[[], None] | None = None

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds
        if self.on_sleep:
            self.on_sleep()


class Harness:
    def __init__(self, base: str, store: Store, workdir: Path, mode: str = "ok") -> None:
        self.time = FakeTime()
        self.convex = FakeConvex(base, store, lambda: self.time.now)
        self.store = store
        self.pipeline = FakePipeline(mode)
        self.workdir = workdir
        config = Config(convex_url="http://unused", worker_token=TOKEN, worker_id="test-gpu",
                        kinds=("convert", "splat"), poll_sec=10, workdir=workdir)
        self.worker = Worker(WorkerApi(self.convex, TOKEN), self.pipeline, config, sleep=self.time.sleep,
                             clock=lambda: self.time.now, heartbeat_sec=0.05, progress_gap_sec=0)

    def convert_job(self, **kw: object) -> str:
        stub = json.dumps({"title": "Sunday visit", "attendees": ["Priya", "Sam"]})
        return self.convex.add_job("convert", files={"source.mov": ("video", b"MOVIE" * 1000)},
                                   manifest_json=stub, **kw)  # type: ignore[arg-type]

    def splat_job(self) -> str:
        files = {n: ("raw", f"{n} bytes".encode()) for n in self.pipeline.splat_inputs}
        files["keyframes/k0000.jpg"] = ("raw", b"not needed")
        files["source.mov"] = ("video", b"not needed")
        return self.convex.add_job("splat", files=files)

    def job_dir_gone(self, job_id: str) -> bool:
        return not (self.workdir / job_id).exists()


@pytest.fixture
def harness(server: tuple[str, Store], tmp_path: Path) -> Harness:
    return Harness(server[0], server[1], tmp_path / "work")


@pytest.fixture(autouse=True)
def no_secrets_in_logs(caplog: pytest.LogCaptureFixture, capsys: pytest.CaptureFixture[str]) -> Iterator[None]:
    caplog.set_level(logging.DEBUG)
    yield
    out = capsys.readouterr()
    text = caplog.text + out.out + out.err
    assert TOKEN not in text and "SECRET" not in text and "127.0.0.1:" not in text


# ---- worker loop --------------------------------------------------------------------------------


def test_convert_happy_path(harness: Harness) -> None:
    job = harness.convert_job()
    harness.worker.run(once=True)

    j = harness.convex.jobs[job]
    assert j["status"] == "done" and j["error"] is None
    assert j["result"] == {"kind": "convert", "manifestJson": MANIFEST}  # exact bytes, \r\n kept
    call = harness.pipeline.calls[0]
    assert call == {"video": b"MOVIE" * 1000, "name": "source.mov", "capture_id": "cap1",
                    "title": "Sunday visit", "attendees": ["Priya", "Sam"]}
    assert harness.convex.objects == harness.pipeline.written  # incl. multipart room.bin, byte-exact
    assert {u["name"]: u["area"] for u in harness.convex.uploads.values()}["keyframes/k0001.jpg"] == "raw"
    assert sum(k.startswith("/part/") for k in harness.store.puts) == 4
    single = next(h for k, h in harness.store.put_headers.items() if k.startswith("/put/"))
    assert single["Content-Length"] and single["Content-Type"]
    by_name = {u["name"]: u["contentType"] for u in harness.convex.uploads.values()}
    assert by_name["manifest.json"] == "application/json" and by_name["frames.jsonl"] == "application/x-ndjson"
    claim_args = harness.convex.calls[0][1]
    assert claim_args == {"workerId": "test-gpu", "kinds": ["convert", "splat"], "gpu": True, "maxFrames": 67}
    assert any(p["stage"] == "depth" for p in j["progress"])  # type: ignore[union-attr]
    assert harness.job_dir_gone(job)


def test_splat_happy_path(harness: Harness) -> None:
    job = harness.splat_job()
    harness.worker.run(once=True)

    j = harness.convex.jobs[job]
    assert j["result"] == {"kind": "splat", "splat": {"file": "room.spz", "format": "spz", "count": 1234,
                                                      "shDegree": 0, "source": "trained-from-video"}}
    assert harness.pipeline.calls[0]["inputs"] == sorted(harness.pipeline.splat_inputs)
    assert sorted(harness.store.gets) == sorted(f"{job}/{n}" for n in harness.pipeline.splat_inputs)
    assert harness.convex.objects == {"room.spz": harness.pipeline.written["room.spz"]}
    assert harness.job_dir_gone(job)


@pytest.mark.parametrize("how", ["cancelled", "lease_lost"])
def test_cancel_mid_job(server: tuple[str, Store], tmp_path: Path, how: str) -> None:
    h = Harness(server[0], server[1], tmp_path / "work", mode="wait")
    if how == "cancelled":
        h.convex.cancel_on_stage = "depth"
    else:
        h.convex.lease_lost_on_stage = "depth"
    job = h.convert_job()
    h.worker.run(once=True)

    assert "worker:complete" not in h.convex.names() and "worker:fail" not in h.convex.names()
    assert "worker:outputUrls" not in h.convex.names()
    assert h.job_dir_gone(job)


def test_sigterm_mid_job_requeues_and_exits(server: tuple[str, Store], tmp_path: Path) -> None:
    h = Harness(server[0], server[1], tmp_path / "work", mode="sigterm")
    job = h.convert_job()
    old_term, old_int = signal.getsignal(signal.SIGTERM), signal.getsignal(signal.SIGINT)
    h.worker.install_signal_handlers()
    try:
        h.worker.run()  # not --once: the signal is what ends the loop
    finally:
        signal.signal(signal.SIGTERM, old_term)
        signal.signal(signal.SIGINT, old_int)

    assert h.convex.jobs[job]["error"] == (STOP_MESSAGE, True)
    assert h.convex.jobs[job]["status"] == "queued"
    assert "worker:complete" not in h.convex.names()
    assert h.convex.names().count("worker:claim") == 1
    assert h.job_dir_gone(job)


def test_download_size_mismatch_retries_then_fails_retryable(harness: Harness) -> None:
    job = harness.convert_job(lie_bytes=5)
    harness.worker.run(once=True)

    assert harness.store.gets == [f"{job}/source.mov"] * 3
    error, retryable = harness.convex.jobs[job]["error"]  # type: ignore[misc]
    assert retryable is True and "source.mov" in error and "expected 5005" in error
    assert harness.pipeline.calls == []
    assert harness.job_dir_gone(job)


def test_permanent_error_is_not_retryable(server: tuple[str, Store], tmp_path: Path) -> None:
    h = Harness(server[0], server[1], tmp_path / "work", mode="permanent")
    job = h.convert_job()
    h.worker.run(once=True)

    assert h.convex.jobs[job]["error"] == ("Couldn't read the video: it has no video stream.", False)
    assert h.convex.jobs[job]["status"] == "failed"
    assert h.job_dir_gone(job)


def test_oom_is_retryable_and_pauses_claiming(server: tuple[str, Store], tmp_path: Path) -> None:
    h = Harness(server[0], server[1], tmp_path / "work", mode="oom")
    job = h.convert_job()
    h.time.on_sleep = lambda: h.worker.request_stop() if h.convex.jobs[job]["status"] == "done" else None
    h.time.now = 1000.0
    h.worker.run()

    first_error = next(a for n, a in h.convex.calls if n == "worker:fail")
    assert first_error["retryable"] is True and "out of memory" in str(first_error["error"])
    assert h.convex.jobs[job]["status"] == "done"  # second attempt succeeded
    assert h.convex.claim_times[1] - h.convex.claim_times[0] >= 60


def test_claim_respects_kinds_and_max_frames(harness: Harness) -> None:
    too_long = harness.convert_job(frames=100)
    bake = harness.convex.add_job("bake", files={}, gpu=False, frames=None)
    fits = harness.convert_job(frames=50)
    harness.worker.run(once=True)

    assert harness.convex.jobs[fits]["status"] == "done"
    assert harness.convex.jobs[too_long]["status"] == "queued"
    assert harness.convex.jobs[bake]["status"] == "queued"


def test_idle_polling_and_claim_errors_back_off(harness: Harness) -> None:
    harness.convex.claim_errors = [ConvexServerError(f"boom with {TOKEN}"), TimeoutError("timed out")]
    harness.time.on_sleep = lambda: harness.worker.request_stop() if len(harness.time.sleeps) >= 3 else None
    harness.worker.run()

    assert harness.time.sleeps == [10, 20, 10]  # backoff on errors, then the normal poll when idle


def test_token_never_logged(harness: Harness, caplog: pytest.LogCaptureFixture) -> None:
    harness.convex.claim_errors = [RuntimeError(f"unauthorized token {TOKEN} at http://h/x?{SIG}")]
    harness.convert_job()
    harness.worker.run(once=True)
    assert "claim failed" in caplog.text and "job job1 done" in caplog.text
    assert "WorkerApi(<token hidden>)" == repr(WorkerApi(harness.convex, TOKEN))
    assert TOKEN not in repr(Config("u", TOKEN, "w", ("convert",), 1, Path(".")))
    # The autouse fixture checks every log line of every test for the token and URL signatures.


# ---- transfers stop when told to ---------------------------------------------------------------


class Stopper:
    """should_stop() that turns true once `when()` does; records the sleeps meanwhile."""

    def __init__(self, when: Callable[[], bool]) -> None:
        self.when = when
        self.slept = 0.0

    def __call__(self) -> bool:
        return self.when()

    def sleep(self, seconds: float) -> None:
        self.slept += seconds


def single_target(base: str, uid: str = "u1") -> dict[str, object]:
    return {"uploadId": uid, "key": "k", "single": {"url": f"{base}/put/{uid}?{SIG}", "headers": {}}}


def test_single_upload_stops_retrying_when_cancelled(server: tuple[str, Store], tmp_path: Path) -> None:
    base, store = server
    store.put_statuses = [503, 503, 503]
    (tmp_path / "room.bin").write_bytes(b"x" * 1000)
    stop = Stopper(lambda: store.put_count >= 1)
    with pytest.raises(Cancelled):
        transfer.upload(single_target(base), tmp_path / "room.bin", "application/octet-stream",  # type: ignore[arg-type]
                        sleep=stop.sleep, should_stop=stop)
    assert store.put_count == 1 and stop.slept <= transfer.STOP_POLL_SEC  # no retries, no full backoff


def test_multipart_upload_stops_retrying_when_cancelled(server: tuple[str, Store], tmp_path: Path) -> None:
    base, store = server
    store.put_statuses = [503] * 20
    (tmp_path / "room.bin").write_bytes(os.urandom(3 * PART_SIZE))
    target = {"uploadId": "u2", "key": "k", "partSize": PART_SIZE,
              "parts": [{"partNumber": i, "url": f"{base}/part/u2/{i}?{SIG}"} for i in (1, 2, 3)]}
    stop = Stopper(lambda: store.put_count >= 1)
    with pytest.raises(Cancelled):
        transfer.upload(target, tmp_path / "room.bin", "application/octet-stream",  # type: ignore[arg-type]
                        sleep=stop.sleep, should_stop=stop, threads=1)
    assert store.put_count == 1 and stop.slept <= transfer.STOP_POLL_SEC


def test_put_stops_mid_body(server: tuple[str, Store], tmp_path: Path) -> None:
    base, store = server
    (tmp_path / "room.bin").write_bytes(os.urandom(8 * transfer.CHUNK))
    calls = {"n": 0}

    def stop() -> bool:
        calls["n"] += 1
        return calls["n"] > 3  # after a few MiB of the body
    with pytest.raises(Cancelled):
        transfer.upload(single_target(base, "u3"), tmp_path / "room.bin", "application/octet-stream",  # type: ignore[arg-type]
                        sleep=lambda s: None, should_stop=stop)
    assert "/put/u3" not in store.puts


def test_download_stops_retrying_when_cancelled(server: tuple[str, Store], tmp_path: Path) -> None:
    base, store = server
    store.files["j/source.mov"] = b"MOVIE"
    stop = Stopper(lambda: stop.slept > 0)  # the stop comes during the first backoff wait
    with pytest.raises(Cancelled):  # the size is wrong, so it would retry
        transfer.download(f"{base}/files/j/source.mov?{SIG}", tmp_path / "source.mov", 6, sleep=stop.sleep, should_stop=stop)
    assert store.get_count == 1 and stop.slept <= transfer.STOP_POLL_SEC
    assert not (tmp_path / "source.mov").exists() and not (tmp_path / "source.mov.part").exists()


def test_backoff_wait_wakes_up_on_stop() -> None:
    flag = threading.Event()
    timer = threading.Timer(0.2, flag.set)
    timer.start()
    t0 = time.monotonic()
    with pytest.raises(Cancelled):
        transfer._wait(30.0, time.sleep, flag.is_set)
    assert time.monotonic() - t0 < 1.0


def test_parallel_reports_the_real_failure_not_the_cancellations() -> None:
    def fn(i: int, stop: Callable[[], bool]) -> int:
        if i == 2:
            time.sleep(0.05)
            raise SizeMismatch("part 2 broke")
        deadline = time.monotonic() + 5
        while not stop():
            assert time.monotonic() < deadline, "the others were never told to stop"
            time.sleep(0.01)
        raise Cancelled()
    with pytest.raises(SizeMismatch, match="part 2"):
        transfer.parallel([0, 1, 2, 3], fn, threads=4)
    assert transfer.parallel([1, 2], lambda i, stop: i * 10, threads=2) == [10, 20]


def test_sigterm_during_upload_retries_hands_the_job_back(server: tuple[str, Store], tmp_path: Path) -> None:
    h = Harness(server[0], server[1], tmp_path / "work")
    h.store.put_statuses = [503] * 100
    job = h.convert_job()
    h.time.on_sleep = lambda: h.worker.request_stop() if h.store.put_count else None
    h.worker.run(once=True)

    assert h.convex.jobs[job]["error"] == (STOP_MESSAGE, True)
    assert "worker:complete" not in h.convex.names() and "worker:finishOutput" not in h.convex.names()
    assert h.store.put_count <= h.worker._upload_threads * 2  # no third try of anything
    assert max(h.time.sleeps) <= transfer.STOP_POLL_SEC  # no full 1 s or 2 s backoff


# ---- pieces -------------------------------------------------------------------------------------


def test_classify_policy() -> None:
    import urllib.error

    def http(code: int) -> urllib.error.HTTPError:
        return urllib.error.HTTPError("room.bin", code, "x", None, None)  # type: ignore[arg-type]

    assert classify(PermanentError("Couldn't read the video: no stream."))[1] is False
    assert classify(SizeMismatch("x"))[1] is True
    assert classify(http(503))[1] and classify(http(429))[1] and classify(http(408))[1]
    assert classify(http(403))[1] is False
    assert classify(TimeoutError())[1] and classify(ConnectionResetError())[1]
    assert classify(urllib.error.URLError("refused"))[1]
    assert classify(ConvexError("Wrong token", {"code": "unauthorized"}))[1] is False
    assert classify(ConvexServerError("Server Error"))[1] is True
    assert classify(KeyError("oops"))[1] is False
    wrapped = RuntimeError("depth failed")
    wrapped.__cause__ = OutOfMemoryError("boom")
    assert is_oom(wrapped) and classify(wrapped)[1] is True
    assert is_oom(RuntimeError("CUDA out of memory. Tried to allocate"))
    assert "SECRET" not in classify(ValueError(f"bad http://r2/b/k/room.bin?{SIG}"))[0]
    assert redact(f"see https://x.r2.dev/b/captures/c/raw/room.bin?{SIG} now") == "see <url:room.bin> now"


def test_config(tmp_path: Path) -> None:
    env_file = tmp_path / "worker.env"
    env_file.write_text('# comment\nexport CONVEX_URL="https://a.convex.cloud/"\nWORKER_TOKEN=\'t0k\'\nWORKER_POLL_SEC=5\n')
    c = load_config({"BRAINDANCE_WORKER_ENV": str(env_file), "WORKER_POLL_SEC": "2", "WORKER_KINDS": "splat"})
    assert (c.convex_url, c.worker_token, c.poll_sec, c.kinds) == ("https://a.convex.cloud", "t0k", 2.0, ("splat",))
    assert c.worker_id.endswith("-gpu") and c.workdir.is_absolute()
    with pytest.raises(ConfigError, match="WORKER_TOKEN") as err:
        load_config({"BRAINDANCE_WORKER_ENV": str(tmp_path / "none"), "CONVEX_URL": "https://a"})
    assert "t0k" not in str(err.value)
    with pytest.raises(ConfigError, match="WORKER_KINDS"):
        load_config({"BRAINDANCE_WORKER_ENV": str(env_file), "WORKER_KINDS": "bake"})
    assert parse_env_file("A=1\n\n#B=2\nC = 'x y'\nnoequals\n") == {"A": "1", "C": "x y"}


def test_content_types() -> None:
    assert transfer.content_type_for("keyframes/k0001.jpg") == "image/jpeg"
    assert transfer.content_type_for("room.spz") == "application/octet-stream"
    assert transfer.content_type_for("video.mp4") == "video/mp4"


def test_http_convex(server: tuple[str, Store]) -> None:
    import urllib.error

    base, store = server
    client = HttpConvex(base)
    store.post_replies = [
        (200, json.dumps({"status": "success", "value": {"ok": True, "cancelled": False}}).encode()),
        (560, json.dumps({"status": "error", "errorMessage": "nope", "errorData": {"code": "not_leased"}}).encode()),
        (560, json.dumps({"status": "error", "errorMessage": "Server Error"}).encode()),
        (503, b"upstream down"),
    ]
    assert client.mutation("worker:heartbeat", {"jobId": "j"}) == {"ok": True, "cancelled": False}
    assert store.posts[0] == {"path": "worker:heartbeat", "args": {"jobId": "j"}, "format": "json"}
    with pytest.raises(ConvexError) as err:
        client.mutation("worker:heartbeat", {})
    assert err.value.data == {"code": "not_leased"}
    with pytest.raises(ConvexServerError):
        client.action("worker:inputs", {})
    with pytest.raises(urllib.error.HTTPError) as http_err:
        client.action("worker:inputs", {})
    assert classify(http_err.value)[1] is True
