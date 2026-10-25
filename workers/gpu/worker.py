"""The GPU worker: claim convert/splat jobs from Convex, run the pipeline, upload the results.

Protocol: docs/architecture-v3.md §7 and backend/convex/worker.ts. Run from the repo root:

    python -m workers.gpu.worker            # loop forever
    python -m workers.gpu.worker --once     # process one job, then exit

While a job runs, a heartbeat thread extends its lease every 30 s (and soon after each new
progress stage). If Convex says the job was cancelled or isn't ours any more, the pipeline is told
to stop and nothing is reported. SIGTERM/SIGINT stop the current job and hand it straight back to
the queue (`fail(retryable=True)`); a second SIGINT exits at once.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import shutil
import signal
import sys
import threading
import time
import traceback
from collections.abc import Callable, Mapping
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path, PurePosixPath
from types import FrameType
from typing import Protocol, cast

from . import transfer
from .client import Claim, InputFile, Inputs, JobResult, OutputFile, Progress, SplatInfo, WorkerApi, is_lease_lost
from .config import Config
from .errors import Cancelled, PermanentError, SizeMismatch, classify, is_oom, redact

log = logging.getLogger("braindance.gpu")

STOP_MESSAGE = "The GPU worker was stopped; the job goes back to the queue."
OOM_PAUSE_SEC = 60.0
MAX_CLAIM_BACKOFF_SEC = 60.0

ProgressFn = Callable[[str, float | None, str], None]
StopFn = Callable[[], bool]
Sleep = Callable[[float], object]


class Pipeline(Protocol):
    """The GPU work itself (workers/gpu/pipeline.py). Created once; models stay loaded."""

    max_frames: int
    splat_inputs: tuple[str, ...]

    def convert(
        self, video: Path, out: Path, *, capture_id: str, title: str, attendees: list[str],
        progress: ProgressFn, should_stop: StopFn,
    ) -> Mapping[str, object]: ...

    def splat(self, capture: Path, out: Path, *, progress: ProgressFn, should_stop: StopFn) -> Mapping[str, object]: ...


class _Job:
    """One running job: its stop flag, latest progress and heartbeat thread."""

    def __init__(self, api: WorkerApi, claim: Claim, heartbeat_sec: float, gap_sec: float) -> None:
        self.claim = claim
        self.id = claim["jobId"]
        self.stop = threading.Event()
        self.cancelled = False  # Convex said stop: cancelled, or the lease isn't ours any more
        self._api = api
        self._interval = heartbeat_sec
        self._gap = gap_sec
        self._lock = threading.Lock()
        self._progress: Progress | None = None
        self._wake = threading.Event()
        self._done = threading.Event()
        self._thread = threading.Thread(target=self._beat_loop, name=f"heartbeat-{self.id}", daemon=True)

    def should_stop(self) -> bool:
        return self.stop.is_set()

    def check(self) -> None:
        if self.stop.is_set():
            raise Cancelled()

    def progress(self, stage: str, fraction: float | None, message: str) -> None:
        with self._lock:
            changed = self._progress is None or self._progress["stage"] != stage
            self._progress = {"stage": stage, "fraction": fraction, "message": message}
        if changed:
            self._wake.set()

    def start(self) -> None:
        self._thread.start()

    def finish(self) -> None:
        self._done.set()
        self._wake.set()
        self._thread.join(timeout=5)

    def _beat_loop(self) -> None:
        last = float("-inf")
        while not self._done.is_set():
            woke = self._wake.wait(self._interval)
            self._wake.clear()
            if self._done.is_set():
                return
            wait = last + self._gap - time.monotonic()
            if woke and wait > 0 and self._done.wait(wait):
                return
            self._beat()
            last = time.monotonic()
            if self.cancelled:
                return

    def _beat(self) -> None:
        with self._lock:
            progress = self._progress  # replaced, never mutated, so no copy needed
        try:
            reply = self._api.heartbeat(self.id, progress)
        except Exception as exc:
            if is_lease_lost(exc):
                log.warning("job %s is no longer leased to this worker; stopping it", self.id)
                self._cancel()
            else:
                log.warning("heartbeat for job %s failed (keeps going): %s", self.id, redact(str(exc)))
            return
        if reply.get("cancelled") or not reply.get("ok", True):
            log.info("Convex cancelled job %s; stopping it", self.id)
            self._cancel()

    def _cancel(self) -> None:
        self.cancelled = True
        self.stop.set()


class Worker:
    def __init__(
        self,
        api: WorkerApi,
        pipeline: Pipeline,
        config: Config,
        *,
        sleep: Sleep | None = None,
        clock: Callable[[], float] = time.monotonic,
        heartbeat_sec: float = 30.0,
        progress_gap_sec: float = 5.0,
        upload_threads: int = 4,
    ) -> None:
        self._api = api
        self._pipeline = pipeline
        self._config = config
        self._shutdown = threading.Event()
        self._sleep: Sleep = sleep or self._shutdown.wait
        self._clock = clock
        self._heartbeat_sec = heartbeat_sec
        self._gap_sec = progress_gap_sec
        self._upload_threads = upload_threads
        self._job: _Job | None = None
        self._pause_until = float("-inf")
        self._interrupts = 0

    # ---- stopping ---------------------------------------------------------------------------

    def request_stop(self) -> None:
        """Stop claiming; tell a running job to stop (it then goes back to the queue)."""
        self._shutdown.set()
        if job := self._job:
            job.stop.set()

    def handle_signal(self, signum: int, _frame: FrameType | None) -> None:
        if signum == signal.SIGINT:
            self._interrupts += 1
            if self._interrupts > 1:
                log.warning("second interrupt: exiting now")
                os._exit(130)
        log.info("received %s: stopping", signal.Signals(signum).name)
        self.request_stop()

    def install_signal_handlers(self) -> None:
        signal.signal(signal.SIGTERM, self.handle_signal)
        signal.signal(signal.SIGINT, self.handle_signal)

    # ---- the loop -----------------------------------------------------------------------------

    def run(self, once: bool = False) -> None:
        """Claim and process jobs until stopped (or after one job with `once`)."""
        poll = self._config.poll_sec
        backoff = poll
        log.info("GPU worker %s polling for %s (maxFrames %d)", self._config.worker_id,
                 ",".join(self._config.kinds), self._pipeline.max_frames)
        while not self._shutdown.is_set():
            pause = self._pause_until - self._clock()
            if pause > 0:
                self._sleep(pause)
                continue
            try:
                claim = self._api.claim(self._config.worker_id, list(self._config.kinds), True, self._pipeline.max_frames)
            except Exception as exc:
                log.warning("claim failed (%s), retrying in %.0f s: %s", type(exc).__name__, backoff, redact(str(exc)))
                self._sleep(backoff)
                backoff = min(MAX_CLAIM_BACKOFF_SEC, backoff * 2)
                continue
            backoff = poll
            if claim is None:
                self._sleep(poll)
                continue
            self.process(claim)
            if once:
                break
        log.info("GPU worker stopped")

    def process(self, claim: Claim) -> None:
        """Run one claimed job end to end and report it (complete, fail, or nothing if cancelled)."""
        job = _Job(self._api, claim, self._heartbeat_sec, self._gap_sec)
        self._job = job
        if self._shutdown.is_set():
            job.stop.set()
        root = self._config.workdir / re.sub(r"[^A-Za-z0-9_-]", "_", job.id)
        log.info("job %s: %s for capture %s (attempt %d)", job.id, claim["kind"], claim["captureId"], claim["attempt"])
        job.start()
        try:
            result = self._run(job, root)
            if job.cancelled:
                raise Cancelled()
            self._api.complete(job.id, result)
            log.info("job %s done", job.id)
        except Cancelled:
            if self._shutdown.is_set() and not job.cancelled:
                self._fail(job, STOP_MESSAGE, True)
            else:
                log.info("job %s cancelled", job.id)
        except Exception as exc:
            message, retryable = classify(exc)
            log.error("job %s failed (%s): %s\n%s", job.id, "will retry" if retryable else "permanent",
                      message, redact(traceback.format_exc()))
            if is_oom(exc):
                self._pause_until = self._clock() + OOM_PAUSE_SEC
                log.warning("GPU out of memory: not claiming for %.0f s", OOM_PAUSE_SEC)
            if job.cancelled:
                log.info("job %s is no longer ours; not reporting the failure", job.id)
            else:
                self._fail(job, message, retryable)
        finally:
            job.finish()
            self._job = None
            shutil.rmtree(root, ignore_errors=True)

    def _fail(self, job: _Job, message: str, retryable: bool) -> None:
        try:
            self._api.fail(job.id, message, retryable)
        except Exception as exc:
            log.warning("couldn't report job %s as failed (its lease will expire instead): %s", job.id, redact(str(exc)))

    # ---- job kinds ----------------------------------------------------------------------------

    def _run(self, job: _Job, root: Path) -> JobResult:
        shutil.rmtree(root, ignore_errors=True)
        inp, out = root / "in", root / "out"
        inp.mkdir(parents=True)
        out.mkdir()
        job.progress("downloading", None, "Downloading the inputs")
        inputs = self._api.inputs(job.id)
        kind = job.claim["kind"]
        if kind == "convert":
            return self._convert(job, inputs, inp, out)
        if kind == "splat":
            return self._splat(job, inputs, inp, out)
        raise PermanentError(f"The GPU worker can't run {kind} jobs.")

    def _convert(self, job: _Job, inputs: Inputs, inp: Path, out: Path) -> JobResult:
        videos = [f for f in inputs["files"] if f["area"] == "video" and f["name"].startswith("source.")]
        if not videos:
            raise PermanentError("The uploaded video is missing, so there is nothing to convert.")
        video = self._download(job, videos[0], inp)
        title, attendees = _stub_fields(inputs["manifestJson"])
        self._pipeline.convert(video, out, capture_id=job.claim["captureId"], title=title, attendees=attendees,
                               progress=job.progress, should_stop=job.should_stop)
        job.check()
        manifest = out / "manifest.json"
        if not manifest.is_file():
            raise RuntimeError("The converter finished without writing manifest.json.")
        manifest_json = manifest.read_bytes().decode("utf-8")
        self._upload_all(job, out, _package_files(out))
        return {"kind": "convert", "manifestJson": manifest_json}

    def _splat(self, job: _Job, inputs: Inputs, inp: Path, out: Path) -> JobResult:
        raw = {f["name"]: f for f in inputs["files"] if f["area"] == "raw"}
        missing = [n for n in self._pipeline.splat_inputs if n not in raw]
        if missing:
            raise PermanentError(f"The capture is missing {', '.join(missing)}, which the splat needs.")
        for name in self._pipeline.splat_inputs:
            self._download(job, raw[name], inp)
        info = _splat_info(self._pipeline.splat(inp, out, progress=job.progress, should_stop=job.should_stop))
        job.check()
        if not (out / info["file"]).is_file():
            raise RuntimeError(f"The splat step didn't write {info['file']}.")
        self._upload_all(job, out, [info["file"]])
        return {"kind": "splat", "splat": info}

    # ---- transfers ----------------------------------------------------------------------------

    def _download(self, job: _Job, file: InputFile, inp: Path) -> Path:
        job.check()
        dest = _safe_path(inp, file["name"])
        job.progress("downloading", None, f"Downloading {file['name']}")
        transfer.download(file["url"], dest, int(file["bytes"]), sleep=self._sleep, should_stop=job.should_stop)
        return dest

    def _upload_all(self, job: _Job, root: Path, names: list[str]) -> None:
        """Ask for upload targets for every file, upload them in parallel, finish each one."""
        job.check()
        files: list[OutputFile] = [
            {"name": n, "bytes": (root / n).stat().st_size, "contentType": transfer.content_type_for(n), "area": "raw"}
            for n in names
        ]
        total = sum(f["bytes"] for f in files) or 1
        job.progress("uploading", 0.0, f"Uploading {len(files)} files")
        targets = {t["name"]: t["target"] for t in self._api.output_urls(job.id, files)}
        if missing := [f["name"] for f in files if f["name"] not in targets]:
            raise RuntimeError(f"Convex returned no upload target for {', '.join(missing)}.")
        lock = threading.Lock()
        done = {"bytes": 0, "files": 0}

        def one(f: OutputFile) -> None:
            target = targets[f["name"]]
            parts = transfer.upload(target, root / f["name"], f["contentType"], sleep=self._sleep,
                                    should_stop=job.should_stop, threads=self._upload_threads)
            job.check()
            stored = self._api.finish_output(job.id, target["uploadId"], parts)
            if stored != f["bytes"]:
                raise SizeMismatch(f"{f['name']}: storage has {stored} bytes, expected {f['bytes']}.")
            with lock:
                done["bytes"] += f["bytes"]
                done["files"] += 1
                job.progress("uploading", done["bytes"] / total, f"Uploaded {done['files']} of {len(files)} files")

        with ThreadPoolExecutor(self._upload_threads) as pool:
            futures = [pool.submit(one, f) for f in files]
            try:
                for fut in as_completed(futures):
                    fut.result()
            except BaseException:
                for fut in futures:
                    fut.cancel()
                raise


def _stub_fields(manifest_json: str | None) -> tuple[str, list[str]]:
    """Title and attendees from the backend's stub manifest for a video, if it has them."""
    try:
        data = json.loads(manifest_json) if manifest_json else None
    except ValueError:
        data = None
    if not isinstance(data, dict):
        return "", []
    title = data.get("title")
    attendees = data.get("attendees")
    return (
        title if isinstance(title, str) else "",
        [a for a in attendees if isinstance(a, str)] if isinstance(attendees, list) else [],
    )


def _package_files(out: Path) -> list[str]:
    """Every file under `out` as a relative POSIX name (keyframes/k0001.jpg), skipping dotfiles."""
    names = (p.relative_to(out) for p in out.rglob("*") if p.is_file())
    return sorted(p.as_posix() for p in names if not any(part.startswith(".") for part in p.parts))


def _safe_path(root: Path, name: str) -> Path:
    rel = PurePosixPath(name)
    if not rel.parts or rel.is_absolute() or ".." in rel.parts:
        raise PermanentError(f"The server sent an unsafe file name: {name!r}.")
    return root.joinpath(*rel.parts)


def _splat_info(info: Mapping[str, object]) -> SplatInfo:
    """Check the pipeline's splat description and keep exactly the fields Convex accepts."""
    file, fmt, count, sh, source = (info.get(k) for k in ("file", "format", "count", "shDegree", "source"))
    if not (isinstance(file, str) and fmt in ("spz", "3dgs-ply") and isinstance(count, int)
            and isinstance(sh, int) and source in ("trained-from-video", "trained-from-lidar-capture")):
        raise RuntimeError(f"The splat step returned an incomplete description: {sorted(info)}.")
    return cast(SplatInfo, {"file": file, "format": fmt, "count": count, "shDegree": sh, "source": source})


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m workers.gpu.worker", description="Braindance GPU worker")
    parser.add_argument("--once", action="store_true", help="wait for one job, process it, then exit")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    from .client import HttpConvex
    from .config import ConfigError, load_config

    try:
        config = load_config()
    except ConfigError as exc:
        log.error("%s", exc)
        return 2
    config.workdir.mkdir(parents=True, exist_ok=True)
    api = WorkerApi(HttpConvex(config.convex_url), config.worker_token)

    from .pipeline import make_pipeline  # heavy: loads torch and the models

    worker = Worker(api, make_pipeline(), config)
    worker.install_signal_handlers()
    worker.run(once=args.once)
    return 0


if __name__ == "__main__":
    sys.exit(main())
