"""Hashed, time-boxed lock of a pack's upstream package (spec §4.2 step 1, TM-M4)."""

from __future__ import annotations

import subprocess
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from mango_pack_builder.pack import (
    CONSTRAINTS,
    LOCK,
    REQUIREMENTS,
    Pack,
    PackError,
    parse_constraints,
)

PYTHON_VERSION = "3.13"
# Platform of AgentCore Runtime zip deployments (S-M2).
PYTHON_PLATFORM = "aarch64-manylinux2014"


def run(command: list[str], cwd: Path | None = None) -> None:
    """Run a build tool with a fixed argument list (never through a shell)."""
    result = subprocess.run(command, cwd=cwd, check=False, capture_output=True, text=True)  # noqa: S603
    if result.returncode != 0:
        raise PackError(f"{' '.join(command[:3])} failed:\n{result.stderr.strip()[-4000:]}")


def _compile(pack: Pack, output: Path) -> None:
    cutoff = pack.manifest.source.exclude_newer.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    constraints: list[str] = []
    if pack.constraints is not None:
        # Validated before uv reads it: upper bounds only, never an option or a URL.
        parse_constraints(pack.constraints.read_text())
        constraints = ["--constraint", CONSTRAINTS]
    # Relative paths and a fixed header keep the lock identical on every machine.
    run(
        [
            "uv", "pip", "compile", REQUIREMENTS,
            *constraints,
            "--universal",
            "--python-version", PYTHON_VERSION,
            "--generate-hashes",
            "--exclude-newer", cutoff,
            "--no-header",
            "--no-annotate",
            "--default-index", "https://pypi.org/simple",
            "--quiet",
            "--output-file", str(output.resolve()),
        ],
        cwd=pack.directory,
    )  # fmt: skip


def write_lock(pack: Pack, now: datetime) -> None:
    _require_quarantine(pack, now)
    _compile(pack, pack.lock)


def check_lock(pack: Pack, now: datetime) -> None:
    """Fail unless the committed lock is what the cutoff of the manifest resolves to."""
    _require_quarantine(pack, now)
    with tempfile.TemporaryDirectory() as tmp:
        fresh = Path(tmp) / LOCK
        _compile(pack, fresh)
        if fresh.read_bytes() != pack.lock.read_bytes():
            raise PackError(
                f"{LOCK} is not what {REQUIREMENTS} resolves to with source.exclude_newer; "
                "regenerate it with the 'lock' command and review the diff"
            )


def _require_quarantine(pack: Pack, now: datetime) -> None:
    error = pack.manifest.quarantine_error(now)
    if error is not None:
        raise PackError(error)
