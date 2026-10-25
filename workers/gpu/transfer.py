"""Download and upload files through presigned R2 URLs (stdlib only).

Presigned URLs are credentials: nothing here logs or raises with a URL in it, only file names.
"""

from __future__ import annotations

import http.client
import logging
import os
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
TIMEOUT_SEC = 60.0
TRIES = 3

T = TypeVar("T")
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


def _with_retries(what: str, fn: Callable[[], T], *, sleep: Sleep, tries: int = TRIES) -> T:
    """Run `fn`, retrying retryable failures (see `errors.classify`) with 1 s, 2 s, ... backoff."""
    for attempt in range(1, tries + 1):
        try:
            return fn()
        except Cancelled:
            raise
        except Exception as exc:
            message, retryable = classify(exc)
            if not retryable or attempt == tries:
                raise
            log.warning("%s failed (try %d of %d): %s", what, attempt, tries, message)
            sleep(2.0 ** (attempt - 1))
    raise AssertionError("unreachable")


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
                if should_stop and should_stop():
                    raise Cancelled()
                out.write(chunk)
                got += len(chunk)
        if got != expected_bytes:
            raise SizeMismatch(f"{dest.name}: got {got} bytes, expected {expected_bytes}.")
        os.replace(tmp, dest)

    try:
        _with_retries(f"download {dest.name}", once, sleep=sleep)
    finally:
        tmp.unlink(missing_ok=True)
    log.info("downloaded %s (%d bytes)", dest.name, expected_bytes)


def _put(url: str, body: bytes, headers: Mapping[str, str], name: str) -> str:
    """PUT `body` with exactly `headers` + Content-Length; return the ETag response header."""
    parts = urllib.parse.urlsplit(url)
    conn_cls = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
    conn = conn_cls(parts.netloc, timeout=TIMEOUT_SEC)
    try:
        conn.putrequest("PUT", parts.path + (f"?{parts.query}" if parts.query else ""), skip_accept_encoding=True)
        for key, value in headers.items():
            if key.lower() != "content-length":
                conn.putheader(key, value)
        conn.putheader("Content-Length", str(len(body)))
        conn.endheaders(body)
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
        body = path.read_bytes()
        _with_retries(f"upload {path.name}", lambda: _put(single["url"], body, headers, path.name), sleep=sleep)
        log.info("uploaded %s (%d bytes)", path.name, size)
        return None

    part_size = target.get("partSize")
    urls = sorted(target.get("parts", []), key=lambda p: p["partNumber"])
    if not part_size or not urls:
        raise ValueError(f"Upload target for {path.name} has neither a single URL nor parts.")
    if len(urls) != -(-size // part_size):
        raise ValueError(f"Upload target for {path.name} has {len(urls)} parts; {size} bytes need {-(-size // part_size)}.")

    def put_part(part: PartUrl) -> FinishedPart:
        if should_stop and should_stop():
            raise Cancelled()
        n = part["partNumber"]
        with open(path, "rb") as f:
            f.seek((n - 1) * part_size)
            body = f.read(part_size)
        etag = _with_retries(f"upload {path.name} part {n}", lambda: _put(part["url"], body, {}, path.name), sleep=sleep)
        if not etag:
            raise ValueError(f"Storage returned no ETag for {path.name} part {n}.")
        return {"partNumber": n, "etag": etag}

    with ThreadPoolExecutor(max_workers=threads) as pool:
        finished = list(pool.map(put_part, urls))
    log.info("uploaded %s (%d bytes, %d parts)", path.name, size, len(finished))
    return finished
