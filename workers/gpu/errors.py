"""Errors the GPU worker raises, and how a failure is reported to Convex.

`classify(exc)` turns any exception into `(message, retryable)` for `worker.fail`:

- Retryable (the job goes back to the queue, up to 3 attempts):
  - network trouble: connection errors, timeouts, HTTP 5xx, 408 and 429;
  - a downloaded or uploaded file whose size doesn't match (`SizeMismatch`);
  - `TransientError`, and Convex server errors that aren't a deliberate `ConvexError`;
  - CUDA out of memory (class name `OutOfMemoryError` or "CUDA out of memory" in the message).
    The pipeline has already retried in-process with fewer frames, so on a shared GPU this is
    usually contention; the worker also stops claiming for a minute (`is_oom`).
- Not retryable (the job fails and the family sees the message):
  - `PermanentError`: bad input, e.g. no video stream, undecodable video, model output not finite;
  - a `ConvexError` (the backend refused on purpose) and other HTTP 4xx;
  - anything else: a code bug repeats deterministically, so retrying only wastes GPU time.

Messages are plain sentences for the family, never tracebacks (the worker logs those locally),
and never contain URLs: presigned URLs are credentials, so `redact` cuts them down to a file name.
"""

from __future__ import annotations

import re
import urllib.error
from collections.abc import Iterator


class Cancelled(Exception):
    """The job was cancelled (by Convex, or because the worker is shutting down)."""


class PermanentError(Exception):
    """Bad input that will fail the same way every time. The message is shown to the family."""


class TransientError(Exception):
    """A failure that may well pass on another attempt."""


class SizeMismatch(TransientError):
    """A transferred file doesn't have the size Convex said it would."""


class ConvexError(Exception):
    """A deliberate error from a Convex function (`throw new ConvexError(data)`)."""

    def __init__(self, message: str, data: object = None) -> None:
        super().__init__(message)
        self.data = data


class ConvexServerError(Exception):
    """Any other error from a Convex function (uncaught exception, validation, overload)."""


_URL = re.compile(r"https?://[^\s'\"<>]+")


def redact(text: str) -> str:
    """Replace every URL in `text` with `<url:last-path-part>`, dropping host and query."""

    def short(match: re.Match[str]) -> str:
        path = match.group(0).split("?", 1)[0].rstrip("/")
        return f"<url:{path.rsplit('/', 1)[-1]}>"

    return _URL.sub(short, text)


def _chain(exc: BaseException) -> Iterator[BaseException]:
    seen: set[int] = set()
    cur: BaseException | None = exc
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        yield cur
        cur = cur.__cause__ or cur.__context__


def is_oom(exc: BaseException) -> bool:
    """True if `exc` (or anything it was raised from) is a CUDA out-of-memory error."""
    return any(
        type(e).__name__ == "OutOfMemoryError" or "CUDA out of memory" in str(e) for e in _chain(exc)
    )


def _http_status(exc: BaseException) -> int | None:
    return exc.code if isinstance(exc, urllib.error.HTTPError) else None


def _is_convex_error(exc: BaseException) -> bool:
    # Duck-typed so a ConvexError from the `convex` PyPI package is treated the same.
    return type(exc).__name__ == "ConvexError" and hasattr(exc, "data")


def _text(exc: BaseException, limit: int = 300) -> str:
    text = redact(str(exc)).strip() or type(exc).__name__
    return text if len(text) <= limit else text[: limit - 1] + "…"


def classify(exc: BaseException) -> tuple[str, bool]:
    """Return `(message for the family, retryable)` for a failed job (policy in the module docstring)."""
    if is_oom(exc):
        return "The GPU ran out of memory (it is shared with other work). The job will try again.", True
    if isinstance(exc, PermanentError):
        return _text(exc), False
    if isinstance(exc, SizeMismatch):
        return f"A file didn't transfer completely: {_text(exc)}", True
    if isinstance(exc, TransientError):
        return _text(exc), True
    status = _http_status(exc)
    if status is not None:
        retry = status >= 500 or status in (408, 429)
        return f"Moving files to or from storage failed (HTTP {status}).", retry
    if isinstance(exc, TimeoutError):
        return "The network timed out while moving files.", True
    if isinstance(exc, (urllib.error.URLError, ConnectionError)):
        reason = exc.reason if isinstance(exc, urllib.error.URLError) else exc
        return f"The network failed: {_text(reason) if isinstance(reason, BaseException) else redact(str(reason))}", True
    if _is_convex_error(exc):
        return f"The server refused the job's request: {_text(exc)}", False
    if isinstance(exc, ConvexServerError):
        return f"The server had a problem: {_text(exc)}", "ValidationError" not in str(exc)
    return f"Something went wrong in the GPU worker ({type(exc).__name__}: {_text(exc)}).", False
