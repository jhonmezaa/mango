"""Reproducible zip of a pack for AgentCore Runtime (U9: zip, no ECR).

Same lock and same entry point give a byte-identical zip on any machine: wheels only (no
code runs at install time), installer metadata that embeds local paths is dropped, entries
are sorted with a fixed timestamp and stored uncompressed (compression output depends on
the zlib build).

A pack that does not fit the Runtime's size limit that way declares `compression: deflate`
in its `build.yaml`. Its bytes are then the same with every release of the reference zlib,
which is what CPython ships with; a build made with another library gives another zip, and
the signing job, which compares its own build byte for byte with the tested one, fails.
"""

from __future__ import annotations

import importlib.util
import json
import shutil
import stat
import tempfile
import zipfile
from pathlib import Path

from mango_pack_builder.lock import PYTHON_PLATFORM, PYTHON_VERSION, run
from mango_pack_builder.pack import PACK_JSON, Pack, PackError, check_pack
from mango_packs.manifest import IdentityMode
from mango_packs.signing import MAX_ARTIFACT_BYTES

# Runtime limit for the unpacked deployment (S-M2).
MAX_UNPACKED_BYTES = 750 * 1024 * 1024
_EPOCH = (1980, 1, 1, 0, 0, 0)
# Fixed: the level is part of what makes a compressed zip reproducible.
_DEFLATE_LEVEL = 9
# Console scripts carry the absolute path of the build interpreter, and RECORD their hashes.
_DROPPED_DIRS = frozenset({"bin", "__pycache__"})
_DROPPED_METADATA = frozenset({"RECORD", "INSTALLER", "REQUESTED", "direct_url.json"})


def install_dependencies(pack: Pack, target: Path) -> None:
    run(
        [
            "uv", "pip", "install",
            "--require-hashes",
            "--no-deps",
            "--only-binary", ":all:",
            "--python-platform", PYTHON_PLATFORM,
            "--python-version", PYTHON_VERSION,
            "--default-index", "https://pypi.org/simple",
            "--no-compile-bytecode",
            "--quiet",
            "--target", str(target),
            "--requirement", str(pack.lock),
        ]
    )  # fmt: skip


# Mango's common entry point for packs that act for the caller (D37) and what it imports.
# Pure Python, copied from this repository at the commit being built.
RUNTIME_PACKAGES = ("mango_pack_runtime", "mango_aws")


def needs_runtime(pack: Pack) -> bool:
    return pack.manifest.identity_mode is not IdentityMode.SERVICE


def pack_json(pack: Pack) -> bytes:
    manifest = pack.manifest
    content: dict[str, object] = {
        "id": manifest.id,
        "version": manifest.version,
        "tools": sorted(manifest.tool_names),
    }
    if needs_runtime(pack):
        # What `mango_pack_runtime` enforces on every call: a verified caller, and a session
        # limited to these statements. A `service` pack keeps the file it always had.
        content["identity_mode"] = manifest.identity_mode.value
        content["iam"] = [
            {"actions": sorted(s.actions), "resources": sorted(s.resources)} for s in manifest.iam
        ]
        if manifest.member_chain:
            # Each call reads the member account it names, through the Read broker (D51). A
            # pack of the payer chain keeps the file it always had.
            content["identity_chain"] = manifest.identity.chain.value
    return json.dumps(content, indent=2, sort_keys=True).encode() + b"\n"


def _package_source(name: str) -> Path:
    spec = importlib.util.find_spec(name)
    if spec is None or spec.origin is None:
        raise PackError(f"{name} is not installed in the builder's environment")
    return Path(spec.origin).parent


def stage(pack: Pack, staging: Path) -> None:
    """Add Mango's files to an installed dependency tree."""
    names = [pack.manifest.runtime.entrypoint, PACK_JSON]
    if needs_runtime(pack):
        names += RUNTIME_PACKAGES
    for name in names:
        if (staging / name).exists():
            raise PackError(f"a dependency already ships a top-level {name}")
    shutil.copyfile(pack.entrypoint, staging / pack.manifest.runtime.entrypoint)
    (staging / PACK_JSON).write_bytes(pack_json(pack))
    if needs_runtime(pack):
        for name in RUNTIME_PACKAGES:
            shutil.copytree(
                _package_source(name),
                staging / name,
                ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
            )


def _included(relative: Path) -> bool:
    if relative.parts[0] in _DROPPED_DIRS or "__pycache__" in relative.parts:
        return False
    in_dist_info = len(relative.parts) > 1 and relative.parts[-2].endswith(".dist-info")
    return not (in_dist_info and relative.name in _DROPPED_METADATA)


def write_zip(staging: Path, output: Path, *, deflate: bool = False) -> None:
    files = sorted(
        (
            (path.relative_to(staging), path)
            for path in staging.rglob("*")
            if path.is_file() and not path.is_symlink()
        ),
        key=lambda entry: entry[0].as_posix(),
    )
    unpacked = 0
    output.parent.mkdir(parents=True, exist_ok=True)
    method = zipfile.ZIP_DEFLATED if deflate else zipfile.ZIP_STORED
    with zipfile.ZipFile(output, "w", compression=method, compresslevel=_DEFLATE_LEVEL) as archive:
        for relative, path in files:
            if not _included(relative):
                continue
            data = path.read_bytes()
            unpacked += len(data)
            info = zipfile.ZipInfo(relative.as_posix(), date_time=_EPOCH)
            executable = path.stat().st_mode & stat.S_IXUSR
            info.external_attr = (stat.S_IFREG | (0o755 if executable else 0o644)) << 16
            info.create_system = 3
            info.compress_type = method
            archive.writestr(info, data, compresslevel=_DEFLATE_LEVEL)
    if unpacked > MAX_UNPACKED_BYTES or output.stat().st_size > MAX_ARTIFACT_BYTES:
        output.unlink()
        raise PackError("the pack exceeds the size limits of AgentCore Runtime")


def build(pack: Pack, out_dir: Path) -> Path:
    check_pack(pack)
    output = out_dir / pack.artifact_name
    with tempfile.TemporaryDirectory() as tmp:
        staging = Path(tmp) / "staging"
        install_dependencies(pack, staging)
        stage(pack, staging)
        write_zip(staging, output, deflate=pack.build_options.compression == "deflate")
    return output
