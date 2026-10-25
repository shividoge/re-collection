"""GPU worker settings: `~/.config/braindance/worker.env`, overridden by real environment variables.

The file holds `KEY=VALUE` lines (optional `export ` prefix, `#` comments, optional quotes).
`BRAINDANCE_WORKER_ENV` points at a different file. Missing required keys raise `ConfigError`
naming the key; values are never printed.
"""

from __future__ import annotations

import os
import socket
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_ENV_FILE = Path("~/.config/braindance/worker.env")
KNOWN_KINDS = ("convert", "splat")


class ConfigError(Exception):
    """The worker's configuration is missing or invalid."""


@dataclass(frozen=True)
class Config:
    convex_url: str
    worker_token: str = field(repr=False)
    worker_id: str
    kinds: tuple[str, ...]
    poll_sec: float
    workdir: Path


def parse_env_file(text: str) -> dict[str, str]:
    """Parse `KEY=VALUE` lines; blank lines and `#` comments are skipped, matching quotes stripped."""
    values: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        line = line.removeprefix("export ").strip()
        key, sep, value = line.partition("=")
        if not sep:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        values[key.strip()] = value
    return values


def load_config(env: Mapping[str, str] | None = None) -> Config:
    """Read the env file (if it exists) and the environment; real env vars win."""
    env = os.environ if env is None else env
    path = Path(env.get("BRAINDANCE_WORKER_ENV") or DEFAULT_ENV_FILE).expanduser()
    values = parse_env_file(path.read_text(encoding="utf-8")) if path.is_file() else {}
    values.update({k: v for k, v in env.items() if v != ""})

    def required(key: str) -> str:
        value = values.get(key, "").strip()
        if not value:
            raise ConfigError(f"{key} is not set (put it in {path} or the environment).")
        return value

    kinds = tuple(k.strip() for k in values.get("WORKER_KINDS", "convert,splat").split(",") if k.strip())
    unknown = [k for k in kinds if k not in KNOWN_KINDS]
    if not kinds or unknown:
        raise ConfigError(f"WORKER_KINDS must be a comma-separated subset of {','.join(KNOWN_KINDS)}.")
    try:
        poll_sec = float(values.get("WORKER_POLL_SEC", "10"))
    except ValueError:
        raise ConfigError("WORKER_POLL_SEC must be a number of seconds.") from None
    if poll_sec <= 0:
        raise ConfigError("WORKER_POLL_SEC must be positive.")

    return Config(
        convex_url=required("CONVEX_URL").rstrip("/"),
        worker_token=required("WORKER_TOKEN"),
        worker_id=values.get("WORKER_ID") or f"{socket.gethostname()}-gpu",
        kinds=kinds,
        poll_sec=poll_sec,
        workdir=Path(values.get("WORKER_WORKDIR") or "~/.cache/braindance/gpu-worker").expanduser(),
    )
