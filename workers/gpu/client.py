"""The worker's Convex calls (`backend/convex/worker.ts`), with the token added in one place.

`WorkerApi` wraps any client with `.mutation(name, args)` and `.action(name, args)`: the real one
is `HttpConvex` (Convex's HTTP API over stdlib urllib), tests pass a fake.

Why not the `convex` PyPI client: its PyO3 calls hold the GIL while they wait on the network, so
one heartbeat during a network outage froze every Python thread, including the pipeline and the
signal handler (checked with convex 0.8.1). Plain HTTP requests release the GIL and have timeouts.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Literal, NotRequired, Protocol, TypedDict, cast

from .errors import ConvexError, ConvexServerError
from .transfer import FinishedPart, UploadTarget

JobKind = Literal["facts", "bake", "convert", "splat"]

# The job protocol this worker speaks (backend WORKER_PROTOCOL; claim refuses any other): every
# call after claim carries the claim's `attempt`, and outputs go to that attempt's own keys.
WORKER_PROTOCOL = 2
Area = Literal["raw", "derived", "video"]


class ConvexLike(Protocol):
    def mutation(self, name: str, args: dict[str, object]) -> object: ...
    def action(self, name: str, args: dict[str, object]) -> object: ...


class Claim(TypedDict):
    jobId: str
    kind: JobKind
    captureId: str
    attempt: int


class Progress(TypedDict):
    stage: str
    fraction: float | None
    message: str


class Heartbeat(TypedDict):
    ok: bool
    cancelled: bool


class InputFile(TypedDict):
    name: str
    area: Area
    url: str
    bytes: int


class Inputs(TypedDict):
    manifestJson: str | None
    files: list[InputFile]


class OutputFile(TypedDict):
    name: str
    bytes: int
    contentType: str
    area: Literal["raw", "derived"]
    contentEncoding: NotRequired[str]


class OutputTarget(TypedDict):
    name: str
    target: UploadTarget


class SplatInfo(TypedDict):
    file: str
    format: Literal["spz", "3dgs-ply"]
    count: int
    shDegree: int
    source: Literal["trained-from-video", "trained-from-lidar-capture"]


class ConvertResult(TypedDict):
    kind: Literal["convert"]
    manifestJson: str


class SplatResult(TypedDict):
    kind: Literal["splat"]
    splat: SplatInfo


JobResult = ConvertResult | SplatResult

# ConvexError `data.code` values (or message phrases) that mean the job is no longer ours. The
# backend answers `cancelled` to any call from an attempt that lost the job's lease.
LEASE_LOST_CODES = frozenset({"not_leased", "lease_lost", "lease_expired", "not_found", "cancelled"})
_LEASE_LOST_PHRASES = ("not leased", "lease expired", "lease lost", "job not found")


def is_lease_lost(exc: BaseException) -> bool:
    """True if a Convex error says the job isn't this attempt's any more (any call after claim)."""
    if type(exc).__name__ != "ConvexError":
        return False
    data = getattr(exc, "data", None)
    if isinstance(data, dict) and data.get("code") in LEASE_LOST_CODES:
        return True
    text = f"{exc} {data if isinstance(data, str) else ''}".lower()
    return any(p in text for p in _LEASE_LOST_PHRASES)


class HttpConvex:
    """Calls Convex functions with `POST <deployment>/api/{mutation,action}`."""

    def __init__(self, url: str, timeout: float = 60.0) -> None:
        self._url = url.rstrip("/")
        self._timeout = timeout

    def mutation(self, name: str, args: dict[str, object]) -> object:
        return self._call("mutation", name, args)

    def action(self, name: str, args: dict[str, object]) -> object:
        return self._call("action", name, args)

    def _call(self, kind: str, name: str, args: dict[str, object]) -> object:
        body = json.dumps({"path": name, "args": args, "format": "json"}).encode()
        req = urllib.request.Request(
            f"{self._url}/api/{kind}", data=body, method="POST", headers={"Content-Type": "application/json"}
        )
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                reply = json.loads(resp.read())
        except urllib.error.HTTPError as err:
            try:
                reply = json.loads(err.read())
            except ValueError:
                raise urllib.error.HTTPError(name, err.code, err.reason, err.headers, None) from None
            if not isinstance(reply, dict) or "status" not in reply:
                message = reply.get("message", err.reason) if isinstance(reply, dict) else err.reason
                raise ConvexServerError(f"{name}: HTTP {err.code}: {message}") from None
        if reply.get("status") == "success":
            return reply.get("value")
        message = str(reply.get("errorMessage", "unknown error"))
        if "errorData" in reply:
            raise ConvexError(message, reply["errorData"])
        raise ConvexServerError(f"{name}: {message}")


class WorkerApi:
    """One method per `worker.*` function; holds the token so the loop never sees it."""

    def __init__(self, client: ConvexLike, token: str) -> None:
        self._client = client
        self._token = token

    def __repr__(self) -> str:
        return "WorkerApi(<token hidden>)"

    def _call(self, kind: Literal["mutation", "action"], name: str, args: dict[str, object]) -> object:
        call = self._client.mutation if kind == "mutation" else self._client.action
        try:
            return call(name, {"token": self._token, **args})
        except Exception as exc:
            if self._token and self._token in str(exc):
                raise ConvexServerError(str(exc).replace(self._token, "<token>")) from None
            raise

    def claim(self, worker_id: str, kinds: list[str], gpu: bool, max_frames: int) -> Claim | None:
        args: dict[str, object] = {"workerId": worker_id, "kinds": kinds, "gpu": gpu, "maxFrames": max_frames,
                                   "protocol": WORKER_PROTOCOL}
        return cast(Claim | None, self._call("mutation", "worker:claim", args))

    # Every call after claim carries the claim's `attempt`: Convex ignores calls from a worker
    # whose lease was taken over, and keys the job's uploads by attempt.

    def heartbeat(self, job_id: str, attempt: int, progress: Progress | None = None) -> Heartbeat:
        args: dict[str, object] = {"jobId": job_id, "attempt": attempt}
        if progress is not None:
            args["progress"] = dict(progress)
        return cast(Heartbeat, self._call("mutation", "worker:heartbeat", args))

    def inputs(self, job_id: str, attempt: int) -> Inputs:
        return cast(Inputs, self._call("action", "worker:inputs", {"jobId": job_id, "attempt": attempt}))

    def output_urls(self, job_id: str, attempt: int, files: list[OutputFile]) -> list[OutputTarget]:
        args: dict[str, object] = {"jobId": job_id, "attempt": attempt, "files": [dict(f) for f in files]}
        return cast(list[OutputTarget], self._call("action", "worker:outputUrls", args))

    def finish_output(self, job_id: str, attempt: int, upload_id: str, parts: list[FinishedPart] | None = None) -> int:
        """Finish one upload; returns the stored object's size in bytes."""
        args: dict[str, object] = {"jobId": job_id, "attempt": attempt, "uploadId": upload_id}
        if parts is not None:
            args["parts"] = [dict(p) for p in parts]
        reply = cast(dict[str, object], self._call("action", "worker:finishOutput", args))
        return int(cast(int, reply["bytes"]))

    def complete(self, job_id: str, attempt: int, result: JobResult) -> None:
        self._call("mutation", "worker:complete", {"jobId": job_id, "attempt": attempt, "result": dict(result)})

    def fail(self, job_id: str, attempt: int, error: str, retryable: bool) -> None:
        self._call("mutation", "worker:fail", {"jobId": job_id, "attempt": attempt, "error": error, "retryable": retryable})
