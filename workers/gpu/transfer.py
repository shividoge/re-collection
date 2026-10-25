"""Download and upload files through presigned R2 URLs (stdlib only).

Presigned URLs are credentials: nothing here logs or raises with a URL in it, only file names.

Every transfer takes `should_stop` and checks it before each try, during backoff waits (in
quarter-second slices) and between 1 MiB chunks of a download or a PUT body, raising `Cancelled`,
so a stopping worker hands its job back within seconds instead of after the remaining retries.
"""

from __future__ import annotations

import http.client
import logging
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import NotRequired, TypedDict, TypeVar

from .errors import Cancelled, SizeMismatch, classify

log = logging.getLogger("braindance.gpu.transfer")

CHUNK = 1 << 20
TIMEOUT_SEC = 30.0  # per socket operation; bounds how long a stalled transfer delays a stop
TRIES = 3
STOP_POLL_SEC = 0.25

T = TypeVar("T")
Item = TypeVar("Item")
Sleep = Callable[[float], object]
ShouldStop = Callable[[], bool]


class PartUrl(TypedDict):
    partNumber: int
    url: str


class SingleUrl(TypedDict):
    url: str
    headers: dict[str, str]


class UploadTarget(TypedDict):
    uploadId: str
    key: str
    partSize: NotRequired[int]
    parts: NotRequired[list[PartUrl]]
    single: NotRequired[SingleUrl]


class FinishedPart(TypedDict):
    partNumber: int
    etag: str


_TYPES = {
    ".json": "application/json",
    ".jsonl": "application/x-ndjson",
    ".mp4": "video/mp4",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".bin": "application/octet-stream",
    ".spz": "application/octet-stream",
    ".ply": "application/octet-stream",
}


def content_type_for(name: str) -> str:
    """The Content-Type to store a capture file with."""
    return _TYPES.get(Path(name).suffix.lower(), "application/octet-stream")


def _check(should_stop: ShouldStop | None) -> None:
    if should_stop is not None and should_stop():
        raise Cancelled()


def _wait(seconds: float, sleep: Sleep, should_stop: ShouldStop | None) -> None:
    """Sleep `seconds`, waking every STOP_POLL_SEC to raise `Cancelled` once `should_stop()`."""
    if should_stop is None:
        sleep(seconds)
        return
    left = seconds
    while left > 0:
        _check(should_stop)
        step = min(STOP_POLL_SEC, left)
        sleep(step)
        left -= step
    _check(should_stop)


def _with_retries(what: str, fn: Callable[[], T], *, sleep: Sleep, should_stop: ShouldStop | None = None,
                  tries: int = TRIES) -> T:
    """Run `fn`, retrying retryable failures (see `errors.classify`) with 1 s, 2 s, ... backoff.
    Stops (raising `Cancelled`) before any try or during any wait once `should_stop()`."""
    for attempt in range(1, tries + 1):
        _check(should_stop)
        try:
            return fn()
        except Cancelled:
            raise
        except Exception as exc:
            message, retryable = classify(exc)
            if not retryable or attempt == tries:
                raise
            log.warning("%s failed (try %d of %d): %s", what, attempt, tries, message)
            _wait(2.0 ** (attempt - 1), sleep, should_stop)
    raise AssertionError("unreachable")


def parallel(items: list[Item], fn: Callable[[Item, ShouldStop], T], *, threads: int,
             should_stop: ShouldStop | None = None) -> list[T]:
    """`[fn(item, stop) for item in items]` on `threads` threads. When one call fails, the others
    are told to stop (their `stop()` turns true), and this waits for all of them, then raises the
    first error that isn't the resulting `Cancelled` (so a real failure is never reported as a
    cancellation)."""
    abort = threading.Event()

    def stop() -> bool:
        return abort.is_set() or (should_stop is not None and should_stop())

    def run(item: Item) -> T:
        try:
            return fn(item, stop)
        except BaseException:
            abort.set()
            raise

    with ThreadPoolExecutor(max_workers=max(1, threads)) as pool:
        futures = [pool.submit(run, item) for item in items]
    errors = [e for e in (f.exception() for f in futures) if e is not None]
    if errors:
        raise next((e for e in errors if not isinstance(e, Cancelled)), errors[0])
    return [f.result() for f in futures]


def download(
    url: str,
    dest: Path,
    expected_bytes: int,
    *,
    sleep: Sleep = time.sleep,
    should_stop: ShouldStop | None = None,
) -> None:
    """Stream `url` to `dest` (via a temp file, then rename), checking the size. 3 tries."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")

    def once() -> None:
        got = 0
        with urllib.request.urlopen(url, timeout=TIMEOUT_SEC) as resp, open(tmp, "wb") as out:
            while chunk := resp.read(CHUNK):
                _check(should_stop)
                out.write(chunk)
                got += len(chunk)
        if got != expected_bytes:
            raise SizeMismatch(f"{dest.name}: got {got} bytes, expected {expected_bytes}.")
        os.replace(tmp, dest)

    try:
        _with_retries(f"download {dest.name}", once, sleep=sleep, should_stop=should_stop)
    finally:
        tmp.unlink(missing_ok=True)
    log.info("downloaded %s (%d bytes)", dest.name, expected_bytes)


def _put(url: str, body: bytes, headers: Mapping[str, str], name: str, should_stop: ShouldStop | None = None) -> str:
    """PUT `body` with exactly `headers` + Content-Length; return the ETag response header. The body
    goes out 1 MiB at a time, checking `should_stop` in between."""
    parts = urllib.parse.urlsplit(url)
    conn_cls = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
    conn = conn_cls(parts.netloc, timeout=TIMEOUT_SEC)
    try:
        conn.putrequest("PUT", parts.path + (f"?{parts.query}" if parts.query else ""), skip_accept_encoding=True)
        for key, value in headers.items():
            if key.lower() != "content-length":
                conn.putheader(key, value)
        conn.putheader("Content-Length", str(len(body)))
        conn.endheaders()
        view = memoryview(body)
        for start in range(0, len(body), CHUNK):
            _check(should_stop)
            conn.send(view[start:start + CHUNK])
        resp = conn.getresponse()
        resp.read()
        if not 200 <= resp.status < 300:
            raise urllib.error.HTTPError(name, resp.status, resp.reason, resp.headers, None)
        return resp.getheader("ETag") or ""
    finally:
        conn.close()


def upload(
    target: UploadTarget,
    path: Path,
    content_type: str,
    content_encoding: str | None = None,
    *,
    sleep: Sleep = time.sleep,
    should_stop: ShouldStop | None = None,
    threads: int = 4,
) -> list[FinishedPart] | None:
    """Upload `path` to a single presigned PUT or to multipart part URLs.

    Single: sends exactly the target's headers (adding Content-Type/-Encoding only if the target
    left them out) and returns None. Multipart: splits by `partSize`, PUTs parts in parallel with
    3 tries each, and returns `[{partNumber, etag}]` for `finishOutput`.
    """
    size = path.stat().st_size
    if "single" in target:
        single = target["single"]
        headers = dict(single["headers"])
        present = {k.lower() for k in headers}
        if "content-type" not in present:
            headers["Content-Type"] = content_type
        if content_encoding and "content-encoding" not in present:
            headers["Content-Encoding"] = content_encoding
        _check(should_stop)
        body = path.read_bytes()
        _with_retries(f"upload {path.name}", lambda: _put(single["url"], body, headers, path.name, should_stop),
                      sleep=sleep, should_stop=should_stop)
        log.info("uploaded %s (%d bytes)", path.name, size)
        return None

    part_size = target.get("partSize")
    urls = sorted(target.get("parts", []), key=lambda p: p["partNumber"])
    if not part_size or not urls:
        raise ValueError(f"Upload target for {path.name} has neither a single URL nor parts.")
    if len(urls) != -(-size // part_size):
        raise ValueError(f"Upload target for {path.name} has {len(urls)} parts; {size} bytes need {-(-size // part_size)}.")

    def put_part(part: PartUrl, stop: ShouldStop) -> FinishedPart:
        _check(stop)
        n = part["partNumber"]
        with open(path, "rb") as f:
            f.seek((n - 1) * part_size)
            body = f.read(part_size)
        etag = _with_retries(f"upload {path.name} part {n}", lambda: _put(part["url"], body, {}, path.name, stop),
                             sleep=sleep, should_stop=stop)
        if not etag:
            raise ValueError(f"Storage returned no ETag for {path.name} part {n}.")
        return {"partNumber": n, "etag": etag}

    finished = parallel(urls, put_part, threads=threads, should_stop=should_stop)
    log.info("uploaded %s (%d bytes, %d parts)", path.name, size, len(finished))
    return finished
