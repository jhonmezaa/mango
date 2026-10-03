"""Normalized `tools/list` of a pack, from its built zip or from its lock (spec §4.2 step 4).

`probe.py` starts the server and asks. Here is where it runs: in a container without
network (CI), as a local process, or in a local venv while developing.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any

from mango_pack_builder import probe
from mango_pack_builder.build import stage
from mango_pack_builder.lock import PYTHON_VERSION, run
from mango_pack_builder.pack import Pack, PackError
from mango_packs.tools import normalize_tools

# Same Python as the Runtime (PYTHON_3_13), pinned by digest (multi-arch index).
CONTAINER_IMAGE = (
    "python:3.13.15-slim@sha256:7c61056e61ac89e852de05f3dc6fa51a6dd2181797bceed46aa725dd7cb2cd3b"
)
_CONTAINER_TIMEOUT_SECONDS = 600


def extract(artifact: Path, target: Path) -> None:
    with zipfile.ZipFile(artifact) as archive:
        for info in archive.infolist():
            destination = (target / info.filename).resolve()
            if not destination.is_relative_to(target.resolve()):
                raise PackError(f"unsafe path in the zip: {info.filename}")
        archive.extractall(target)


def _normalize(result: dict[str, Any]) -> list[dict[str, Any]]:
    if result.get("nextCursor"):
        raise PackError("tools/list is paginated; the snapshot must cover every tool")
    return normalize_tools(result.get("tools"))


def list_tools(directory: Path, command: list[str], path: str) -> list[dict[str, Any]]:
    """Normalized tools served by the pack in `directory`, run as a local process."""
    try:
        return _normalize(probe.tools_list(directory, command, path))
    except probe.ProbeError as error:
        raise PackError(str(error)) from error


def list_tools_in_container(pack: Pack, artifact: Path) -> list[dict[str, Any]]:
    """Run the built zip in a container without network (TM-P3).

    The upstream server cannot reach the internet, the runner's files or its credentials:
    it only sees the unpacked zip, read-only. What comes back is the JSON printed by
    `probe.py`, which is parsed and compared like any other untrusted answer.
    """
    runtime = pack.manifest.runtime
    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / "pack"
        extract(artifact, target)
        Path(tmp).chmod(0o755)
        command = [
            "docker", "run", "--rm",
            "--network", "none",
            "--read-only",
            "--tmpfs", "/tmp",  # noqa: S108 - scratch space inside the container
            "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges",
            "--pids-limit", "256",
            "--memory", "2g",
            "--user", "65534:65534",
            "--platform", "linux/arm64",
            "--volume", f"{target}:/pack:ro",
            "--volume", f"{Path(probe.__file__).resolve()}:/probe.py:ro",
            "--workdir", "/pack",
            CONTAINER_IMAGE,
            "python", "-S", "/probe.py", "/pack", runtime.entrypoint, runtime.path,
        ]  # fmt: skip
        try:
            result = subprocess.run(  # noqa: S603 - fixed argument list, no shell
                command, check=False, capture_output=True, timeout=_CONTAINER_TIMEOUT_SECONDS
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise PackError(f"could not run the pack in a container: {error}") from error
    if result.returncode != 0 or len(result.stdout) > 2 * probe.MAX_RESPONSE_BYTES:
        stderr = result.stderr.decode(errors="replace")[-4000:]
        raise PackError(f"the pack did not answer tools/list in the container:\n{stderr}")
    try:
        answer = json.loads(result.stdout)
    except ValueError as error:
        raise PackError("the container did not print a tools/list result") from error
    if not isinstance(answer, dict):
        raise PackError("the container did not print a tools/list result")
    return _normalize(answer)


def list_tools_from_artifact(pack: Pack, artifact: Path) -> list[dict[str, Any]]:
    """Run the built zip as a local process. Needs Linux arm64 and Python 3.13.

    `-S` keeps the builder's own site-packages out: only the zip and the standard library
    are importable, as in the Runtime.
    """
    runtime = pack.manifest.runtime
    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp)
        extract(artifact, target)
        return list_tools(target, [sys.executable, "-S", runtime.entrypoint], runtime.path)


def list_tools_from_lock(pack: Pack) -> list[dict[str, Any]]:
    """Run the entry point on this machine, with the locked dependencies in a fresh venv."""
    runtime = pack.manifest.runtime
    with tempfile.TemporaryDirectory() as tmp:
        venv = Path(tmp) / "venv"
        python = venv / "bin" / "python"
        run(["uv", "venv", "--python", PYTHON_VERSION, "--quiet", str(venv)])
        run(
            [
                "uv", "pip", "install",
                "--python", str(python),
                "--require-hashes",
                "--no-deps",
                "--only-binary", ":all:",
                "--default-index", "https://pypi.org/simple",
                "--quiet",
                "--requirement", str(pack.lock),
            ]
        )  # fmt: skip
        directory = Path(tmp) / "pack"
        directory.mkdir()
        stage(pack, directory)
        return list_tools(directory, [str(python), runtime.entrypoint], runtime.path)


def snapshot_json(tools: list[dict[str, Any]]) -> bytes:
    return json.dumps(tools, indent=2, sort_keys=True, ensure_ascii=False).encode() + b"\n"
