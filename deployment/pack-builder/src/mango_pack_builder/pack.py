"""A pack directory under `packs/`: manifest, hashed lock and entry point."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import yaml
from pydantic import ValidationError

from mango_packs.manifest import IdentityMode, PackManifest, PackSource, StrictModel

MANIFEST = "manifest.yaml"
REQUIREMENTS = "requirements.in"
LOCK = "requirements.lock"
# Optional upper bounds for the lock's resolution: only needed when the newest release of a
# dependency has no wheel for the Runtime's platform. The lock stays the only source of what
# is installed (every entry pinned by hash); this file only steers which versions it pins.
CONSTRAINTS = "constraints.txt"
SNAPSHOT = "tools.snapshot.json"
# Written into the zip next to the entry point: the tools the entry point may serve.
PACK_JSON = "pack.json"
# What Mango's common entry point (`mango_pack_runtime`) needs from the pack's own lock.
RUNTIME_REQUIREMENTS = ("boto3", "cryptography")
# What a server of Mango's own code (`source.kind: mango`) names in its `requirements.in`: the
# official MCP SDK, which `mango_pack_runtime.server` serves, and the entry point's needs.
OWN_CODE_REQUIREMENTS = ("mcp", *RUNTIME_REQUIREMENTS)
# Servers the common entry point cannot serve over member accounts (`mango_pack_runtime.server`
# wraps `MCPServer` of the official SDK only).
OWN_CODE_FORBIDDEN = ("fastmcp",)
# Files of the server's own package that go into the zip: Python sources and the typing marker.
_OWN_CODE_SUFFIXES = frozenset({".py"})
_OWN_CODE_NAMES = frozenset({"py.typed"})

_MAX_MANIFEST_BYTES = 64 * 1024
_REQUIREMENT = re.compile(r"^(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)==(?P<version>[^\s;\\]+)")
# Optional build settings of a pack (today, only whether its zip is compressed).
BUILD = "build.yaml"
_HASH = re.compile(r"--hash=sha256:(?P<sha256>[0-9a-f]{64})")
# One upper bound per line: no URLs, no options, no extras, no markers.
_CONSTRAINT = re.compile(
    r"^(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)<(?P<version>[0-9]+(\.[0-9]+){0,3})$"
)

# A direct dependency of a pack of Mango's own code: an exact release, nothing else.
_EXACT = re.compile(r"^(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)==(?P<version>[0-9][A-Za-z0-9.!+]*)$")

Locked = dict[str, tuple[str, frozenset[str]]]
"""Each locked package (normalized name) with its version and sha256 hashes."""


class PackError(Exception):
    """The pack directory breaks a rule of the pack format."""


class BuildOptions(StrictModel):
    """How the zip of a pack is written (``build.yaml``). Not part of the signed manifest:
    the signature covers the bytes of the zip these options produce."""

    # `stored` gives the same bytes with any zlib. `deflate` is for a pack that does not fit
    # the Runtime's 250 MB limit otherwise; its bytes are the same with every release of the
    # reference zlib (1.2 and 1.3 checked), and the signing job compares them byte for byte
    # with the zip the build job tested, so another library can only fail the build.
    compression: Literal["stored", "deflate"] = "stored"


def normalize_name(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


@dataclass(frozen=True)
class Pack:
    directory: Path
    manifest: PackManifest

    @property
    def lock(self) -> Path:
        return self.directory / LOCK

    @property
    def requirements(self) -> Path:
        return self.directory / REQUIREMENTS

    @property
    def constraints(self) -> Path | None:
        """The pack's upper bounds for the lock, if it declares any."""
        path = self.directory / CONSTRAINTS
        return path if path.is_file() else None

    @property
    def build_options(self) -> BuildOptions:
        path = self.directory / BUILD
        if not path.is_file():
            return BuildOptions()
        try:
            return BuildOptions.model_validate(yaml.safe_load(path.read_bytes()))
        except (yaml.YAMLError, ValidationError) as error:
            raise PackError(f"{path} is not a valid build file:\n{error}") from error

    @property
    def code_module(self) -> str:
        """Top-level package of a pack of Mango's own code: its id, with ``_`` for ``-``."""
        return self.manifest.id.replace("-", "_")

    @property
    def code(self) -> Path | None:
        """The package of the server's own code, for a pack of Mango's own code."""
        if not self.manifest.source.own_code:
            return None
        return self.directory / self.code_module

    def code_files(self) -> list[Path]:
        """Every file of the server's own package that goes into the zip, sorted.

        Only Python sources (and ``py.typed``) are allowed: anything else (a symlink, a
        binary, a stray data file) fails, so what is reviewed in the diff is what runs.
        """
        code = self.code
        if code is None:
            return []
        if not (code / "__init__.py").is_file() or code.is_symlink():
            raise PackError(f"{code.name}/__init__.py not found: the pack's own code package")
        files: list[Path] = []
        for path in sorted(code.rglob("*")):
            relative = path.relative_to(code)
            if "__pycache__" in relative.parts or path.suffix == ".pyc":
                continue
            if path.is_symlink():
                raise PackError(f"{code.name}/{relative} is a symlink")
            if path.is_dir():
                continue
            if path.suffix not in _OWN_CODE_SUFFIXES and path.name not in _OWN_CODE_NAMES:
                raise PackError(f"{code.name}/{relative}: only Python sources go in the pack")
            files.append(path)
        return files

    @property
    def entrypoint(self) -> Path:
        return self.directory / self.manifest.runtime.entrypoint

    @property
    def snapshot(self) -> Path:
        return self.directory / SNAPSHOT

    @property
    def artifact_name(self) -> str:
        return f"{self.manifest.id}-{self.manifest.version}.zip"


def load_pack(directory: Path) -> Pack:
    path = directory / MANIFEST
    if not path.is_file():
        raise PackError(f"{path} not found")
    raw = path.read_bytes()
    if len(raw) > _MAX_MANIFEST_BYTES:
        raise PackError(f"{path} is too large")
    try:
        manifest = PackManifest.model_validate(yaml.safe_load(raw))
    except yaml.YAMLError as error:
        raise PackError(f"{path} is not valid YAML: {error}") from error
    except ValidationError as error:
        raise PackError(f"{path} is not a valid manifest:\n{error}") from error
    if manifest.id != directory.name:
        raise PackError(f"manifest id {manifest.id!r} must match its directory {directory.name!r}")
    return Pack(directory=directory, manifest=manifest)


def parse_lock(text: str) -> Locked:
    """Map each locked package to its version and sha256 hashes.

    Fails on anything that is not `name==version` with at least one hash: a requirement
    without a hash, a URL, an editable install or an extra index would bypass the pinning.
    """
    locked: Locked = {}
    for block in _logical_lines(text):
        match = _REQUIREMENT.match(block)
        if match is None:
            raise PackError(f"lock entry is not 'name==version': {block[:80]!r}")
        hashes = frozenset(found.group("sha256") for found in _HASH.finditer(block))
        if not hashes:
            raise PackError(f"lock entry without sha256 hashes: {match.group('name')}")
        name = normalize_name(match.group("name"))
        if name in locked:
            raise PackError(f"lock pins {name} more than once")
        locked[name] = (match.group("version"), hashes)
    if not locked:
        raise PackError("the lock is empty")
    return locked


def _logical_lines(text: str) -> list[str]:
    blocks: list[str] = []
    current = ""
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        current += line.removesuffix("\\").strip() + " "
        if not line.endswith("\\"):
            blocks.append(current.strip())
            current = ""
    if current:
        blocks.append(current.strip())
    return blocks


def parse_constraints(text: str) -> dict[str, str]:
    """Upper bounds of a pack's ``constraints.txt``: ``name<version`` and nothing else.

    A constraint can only hold a dependency back to an older release. It cannot add a
    package, an index, a URL or a hash, so it never widens what the lock may install.
    """
    bounds: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        match = _CONSTRAINT.fullmatch(line)
        if match is None:
            raise PackError(f"{CONSTRAINTS}: only 'name<version' lines are allowed: {line[:80]!r}")
        name = normalize_name(match.group("name"))
        if name in bounds:
            raise PackError(f"{CONSTRAINTS} bounds {name} more than once")
        bounds[name] = match.group("version")
    if not bounds:
        raise PackError(f"{CONSTRAINTS} is empty; remove it")
    return bounds


def _requirement_lines(pack: Pack) -> list[str]:
    return [
        line.strip()
        for line in pack.requirements.read_text().splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]


def _check_upstream(pack: Pack, source: PackSource, locked: Locked) -> set[str]:
    """One line, the upstream package, pinned in the lock with the wheel the manifest names."""
    expected = f"{source.package}=={source.version}"
    if _requirement_lines(pack) != [expected]:
        raise PackError(f"{REQUIREMENTS} must contain exactly {expected!r}")
    version, hashes = locked.get(normalize_name(source.package), ("", frozenset()))
    if version != source.version:
        raise PackError(f"the lock pins {source.package}=={version}, not {source.version}")
    if source.sha256 not in hashes:
        raise PackError("source.sha256 is not one of the hashes the lock pins for the package")
    return {normalize_name(source.package)}


def _check_own_code(pack: Pack, locked: Locked) -> set[str]:
    """The server's dependencies, each one exact, and the package of its code.

    ``requirements.in`` names only direct dependencies, each ``name==version`` (no URLs,
    options, extras or markers): the official MCP SDK and what the common entry point needs,
    never ``fastmcp``. The lock pins each one at that version, and everything else by hash.
    """
    direct: dict[str, str] = {}
    for line in _requirement_lines(pack):
        match = _EXACT.fullmatch(line)
        if match is None:
            raise PackError(f"{REQUIREMENTS}: only exact 'name==version' lines: {line[:80]!r}")
        name = normalize_name(match.group("name"))
        if name in direct:
            raise PackError(f"{REQUIREMENTS} names {name} more than once")
        direct[name] = match.group("version")
    missing = sorted(name for name in OWN_CODE_REQUIREMENTS if name not in direct)
    if missing:
        raise PackError(f"{REQUIREMENTS} must name {missing}: the pack's server needs them")
    for name, version in sorted(direct.items()):
        pinned = locked.get(name, ("", frozenset()))[0]
        if pinned != version:
            raise PackError(f"the lock pins {name}=={pinned or '(nothing)'}, not {version}")
    forbidden = sorted(name for name in OWN_CODE_FORBIDDEN if name in locked)
    if forbidden:
        raise PackError(f"the lock pins {forbidden}: own code is served by the official MCP SDK")
    pack.code_files()  # the package exists and holds only Python sources
    return set(direct)


def check_pack(pack: Pack) -> None:
    """Offline consistency checks between manifest, requirements, lock and entry point."""
    source = pack.manifest.source
    if not pack.entrypoint.is_file():
        raise PackError(f"entry point {pack.entrypoint.name} not found")
    locked = parse_lock(pack.lock.read_text())
    if isinstance(source, PackSource):
        direct = _check_upstream(pack, source, locked)
    else:
        direct = _check_own_code(pack, locked)
    _ = pack.build_options  # a malformed build.yaml fails here, before anything is built
    if pack.constraints is not None:
        bounds = parse_constraints(pack.constraints.read_text())
        if direct & bounds.keys():
            raise PackError(f"{CONSTRAINTS} must not bound what {REQUIREMENTS} pins")
        unused = sorted(name for name in bounds if name not in locked)
        if unused:
            raise PackError(f"{CONSTRAINTS} bounds packages the lock does not pin: {unused}")
    if pack.manifest.identity_mode is not IdentityMode.SERVICE:
        # Mango's common entry point is copied into the zip without dependencies of its own.
        missing = sorted(name for name in RUNTIME_REQUIREMENTS if name not in locked)
        if missing:
            raise PackError(f"the lock must pin {missing}: the pack's entry point needs them")
