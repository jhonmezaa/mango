"""`toolchain.toml` records the versions that write a pack's zip and its signed statement.

A push that only changes `mise.toml` or `uv.lock` does not start the packs workflow. Raising
one of these versions must, so it has to change a file that does: these tests fail until
`toolchain.toml` says what those two files say.
"""

import tomllib
from pathlib import Path
from typing import Any

REPO = Path(__file__).parents[3]
TOOLCHAIN = REPO / "deployment" / "pack-builder" / "toolchain.toml"

# The interpreter runs the builder (`zipfile`, zlib, `json`) and uv unpacks the wheels.
TOOLS = {"python", "uv"}
# PyYAML reads the manifest; pydantic validates it and serializes the statement.
PACKAGES = {"pydantic", "pydantic-core", "pyyaml"}


def _toml(path: Path) -> dict[str, Any]:
    return tomllib.loads(path.read_text())


def _locked(name: str) -> str:
    versions = [
        package["version"]
        for package in _toml(REPO / "uv.lock")["package"]
        if package["name"] == name
    ]
    assert len(versions) == 1, f"uv.lock pins {name} {len(versions)} times"
    version: str = versions[0]
    return version


def test_it_records_every_version_that_writes_a_pack() -> None:
    toolchain = _toml(TOOLCHAIN)
    assert set(toolchain) == {"tools", "packages"}
    assert set(toolchain["tools"]) == TOOLS
    assert set(toolchain["packages"]) == PACKAGES


def test_its_tools_are_the_ones_of_mise() -> None:
    mise = _toml(REPO / "mise.toml")
    recorded = _toml(TOOLCHAIN)["tools"]
    assert recorded == {name: mise["tools"][name] for name in TOOLS}, (
        "mise.toml has another Python or uv: change deployment/pack-builder/toolchain.toml "
        "in the same commit, so that the packs are built and signed again"
    )
    # uv picks the interpreter from this variable, not from `[tools]`.
    assert mise["env"]["UV_PYTHON"] == recorded["python"]


def test_its_packages_are_the_ones_of_the_lock() -> None:
    recorded = _toml(TOOLCHAIN)["packages"]
    assert recorded == {name: _locked(name) for name in PACKAGES}, (
        "uv.lock has another version of what writes the signed statement: change "
        "deployment/pack-builder/toolchain.toml in the same commit, so that the packs are "
        "built and signed again"
    )
