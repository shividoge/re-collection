"""The worker's Convex calls against the backend's real validators, not just the fake backend.

`worker_contract.json` is what `worker_contract.ts` prints from backend/convex/worker.ts: each
function's kind and its Convex `args`/`returns` validators, plus WORKER_PROTOCOL. Every call the
worker makes in the loop tests' scenarios (claim, heartbeat with progress, inputs, outputUrls,
finishOutput single and multipart, complete for convert and splat, fail) is checked against it,
and so is every reply the fake backend gives, so the fake can't drift either.

`test_contract_file_matches_the_backend` regenerates the JSON with bun when the backend's packages
are installed (`cd backend && bun install`; or BD_BACKEND_DIR=<a checkout's backend/>) and fails
if the committed file is stale.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from workers.gpu.client import WORKER_PROTOCOL
from workers.gpu.tests.test_worker import FakeConvex, Harness, Store, server  # noqa: F401  (fixture)

HERE = Path(__file__).resolve().parent
CONTRACT = json.loads((HERE / "worker_contract.json").read_text())
FUNCTIONS: dict[str, dict] = CONTRACT["functions"]


def problems(v: dict, x: object, path: str = "args") -> list[str]:
    """Why `x` (a JSON value) doesn't satisfy the Convex validator JSON `v`; [] if it does."""
    t = v["type"]
    is_number = isinstance(x, (int, float)) and not isinstance(x, bool)
    simple = {"any": True, "null": x is None, "string": isinstance(x, str), "number": is_number,
              "boolean": isinstance(x, bool), "id": isinstance(x, str)}
    if t in simple:
        return [] if simple[t] else [f"{path}: expected {t}, got {x!r}"]
    if t == "literal":
        ok = x == v["value"] and isinstance(x, bool) == isinstance(v["value"], bool)
        return [] if ok else [f"{path}: expected {v['value']!r}, got {x!r}"]
    if t == "array":
        if not isinstance(x, list):
            return [f"{path}: expected an array, got {x!r}"]
        return [p for i, item in enumerate(x) for p in problems(v["value"], item, f"{path}[{i}]")]
    if t == "object":
        if not isinstance(x, dict):
            return [f"{path}: expected an object, got {x!r}"]
        fields: dict[str, dict] = v["value"]
        out = [f"{path}.{k}: not accepted by the backend" for k in x if k not in fields]
        for k, f in fields.items():
            if k in x:
                out += problems(f["fieldType"], x[k], f"{path}.{k}")
            elif not f["optional"]:
                out.append(f"{path}.{k}: required by the backend, missing")
        return out
    if t == "union":
        branches = [problems(b, x, path) for b in v["value"]]
        return [] if any(not b for b in branches) else [f"{path}: matches no variant ({'; '.join(min(branches, key=len))})"]
    if t == "record":
        if not isinstance(x, dict):
            return [f"{path}: expected a record, got {x!r}"]
        return [p for k, item in x.items() for p in problems(v["keys"], k, f"{path} key") + problems(v["values"]["fieldType"], item, f"{path}.{k}")]
    raise AssertionError(f"validator type {t!r} isn't handled here; extend problems()")


class ContractConvex(FakeConvex):
    """The fake backend, with every call and reply checked against the real validators."""

    checked: list[str]
    mismatches: list[str]

    def _checked(self, kind: str, name: str, args: dict[str, object]) -> object:
        fn = FUNCTIONS[name.removeprefix("worker:")]
        bad = [] if fn["kind"] == kind else [f"{name} is a {fn['kind']} in the backend; the worker calls it as a {kind}"]
        bad += problems(fn["args"], json.loads(json.dumps(args)), name)  # exactly what HttpConvex sends
        if bad:
            self.mismatches += bad
            raise AssertionError(f"the backend would reject {name}: {bad}")
        reply = self._call(name, args)
        if bad := problems(fn["returns"], json.loads(json.dumps(reply)), f"{name} reply"):
            self.mismatches += bad
            raise AssertionError(f"the fake backend's {name} reply doesn't match the real one: {bad}")
        self.checked.append(name)
        return reply

    def mutation(self, name: str, args: dict[str, object]) -> object:
        return self._checked("mutation", name, args)

    def action(self, name: str, args: dict[str, object]) -> object:
        return self._checked("action", name, args)


def contract_harness(base: str, store: Store, workdir: Path, mode: str = "ok") -> Harness:
    h = Harness(base, store, workdir, mode)
    fake = ContractConvex(base, store, lambda: h.time.now)
    fake.checked, fake.mismatches = [], []
    h.convex = fake
    h.worker._api._client = fake  # type: ignore[attr-defined]
    # A refused claim would make the loop retry forever: give up after a few polls.
    h.time.on_sleep = lambda: h.worker.request_stop() if len(h.time.sleeps) > 5 else None
    return h


def test_protocol_matches_the_backend() -> None:
    assert CONTRACT["protocol"] == WORKER_PROTOCOL


def test_every_worker_call_matches_the_backend_validators(server: tuple[str, Store], tmp_path: Path) -> None:  # noqa: F811
    h = contract_harness(server[0], server[1], tmp_path / "ok")
    convert, splat = h.convert_job(), h.splat_job()
    h.worker.run(once=True)
    h.worker.run(once=True)
    assert h.convex.mismatches == []
    assert h.convex.jobs[convert]["status"] == "done" and h.convex.jobs[splat]["status"] == "done"
    assert any(n == "worker:finishOutput" and "parts" in a for n, a in h.convex.calls)  # multipart too
    assert any(n == "worker:heartbeat" and "progress" in a for n, a in h.convex.calls)

    failing = contract_harness(server[0], server[1], tmp_path / "fail", mode="permanent")
    failing.convert_job()
    failing.worker.run(once=True)
    assert failing.convex.mismatches == []
    assert "worker:fail" in failing.convex.checked

    checked = set(h.convex.checked) | set(failing.convex.checked)
    assert checked == {f"worker:{n}" for n in FUNCTIONS}, f"not exercised: {set(FUNCTIONS) - {c[7:] for c in checked}}"


def test_the_checker_catches_a_mismatch() -> None:
    inputs = FUNCTIONS["inputs"]["args"]
    assert problems(inputs, {"token": "t", "jobId": "j", "attempt": 1}) == []
    assert problems(inputs, {"token": "t", "jobId": "j"}) == ["args.attempt: required by the backend, missing"]
    assert problems(inputs, {"token": "t", "jobId": "j", "attempt": 1, "extra": 1}) == ["args.extra: not accepted by the backend"]
    assert problems(inputs, {"token": "t", "jobId": "j", "attempt": True})  # a bool isn't a number


def _backend_dir() -> Path:
    return Path(os.environ.get("BD_BACKEND_DIR") or HERE.parents[2] / "backend")


@pytest.mark.skipif(not shutil.which("bun") or not (_backend_dir() / "node_modules" / "convex").is_dir(),
                    reason="needs bun and the backend's packages (cd backend && bun install)")
def test_contract_file_matches_the_backend() -> None:
    worker_ts = _backend_dir() / "convex" / "worker.ts"
    out = subprocess.run(["bun", str(HERE / "worker_contract.ts"), str(worker_ts)], capture_output=True, text=True,
                         timeout=120)
    assert out.returncode == 0, out.stderr
    assert json.loads(out.stdout) == CONTRACT, (
        f"{worker_ts} changed: regenerate workers/gpu/tests/worker_contract.json (see worker_contract.ts) and "
        "make the worker match it")
