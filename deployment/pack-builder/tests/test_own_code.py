"""Packs of Mango's own code (``source.kind: mango``): a server written in this repository.

The example pack below is the smallest one the format allows. It lives only here: the real
packs are under ``packs/``.
"""

from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path
from typing import Any

import pytest

from mango_pack_builder.build import pack_json, stage, write_zip
from mango_pack_builder.cli import main
from mango_pack_builder.pack import PackError, check_pack, load_pack
from mango_pack_builder.snapshot import list_tools, snapshot_json
from mango_pack_runtime.guard import ACCOUNT_PATTERN, REGION_PATTERN
from mango_packs.tools import check_tools, tools_hash

from .conftest import write_manifest

PACK_ID = "own-pack"
MODULE = "own_pack"
VERSIONS = {"mcp": "2.3.0", "boto3": "1.43.115", "cryptography": "50.0.2"}
REQUIREMENTS = "".join(f"{name}=={version}\n" for name, version in VERSIONS.items())
LOCK = "".join(
    f"{name}=={version} --hash=sha256:{digit * 64}\n"
    for (name, version), digit in zip(
        [*VERSIONS.items(), ("botocore", "1.43.115"), ("pydantic", "2.14.1")],
        "abcde",
        strict=True,
    )
)

ENTRYPOINT = """\
from mango_pack_runtime.server import load

pack = load()  # before the server is imported: nothing it creates sees the pack role

from own_pack.server import mcp  # noqa: E402

pack.serve(mcp)
"""

SERVER = '''\
"""A server of Mango's own: the official MCP SDK, boto3 inside the call."""

from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations

mcp = MCPServer("own-pack")
READ = ToolAnnotations(readOnlyHint=True, destructiveHint=False)


@mcp.tool(annotations=READ)
def describe_things(max_items: int = 10, region: str | None = None) -> str:
    """Describe things."""
    return f"{max_items} in {region}"


@mcp.tool()
def not_in_the_manifest() -> str:
    """Never served."""
    return "never"
'''


def own_manifest(tools_hash_value: str = "sha256:" + "f" * 64) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "id": PACK_ID,
        "version": "0.1.0-1",
        "name": "Own",
        "description": "A pack of Mango's own code, for tests.",
        "source": {"kind": "mango", "version": "0.1.0", "exclude_newer": "2026-01-01T00:00:00Z"},
        "data_tier": "account_data",
        "identity_mode": "central_only",
        "identity": {"chain": "member"},
        "iam": [
            {
                "actions": ["cloudwatch:DescribeAlarms"],
                "resources": ["arn:aws:cloudwatch:*:*:alarm:*"],
            }
        ],
        "egress": {"aws": ["sts", "cloudwatch"]},
        "tools": [{"name": "describe_things", "access": "read"}],
        "tools_hash": tools_hash_value,
    }


@pytest.fixture
def own_pack(tmp_path: Path) -> Path:
    directory = tmp_path / "packs" / PACK_ID
    (directory / MODULE).mkdir(parents=True)
    (directory / "tests").mkdir()
    write_manifest(directory, own_manifest())
    (directory / "requirements.in").write_text(REQUIREMENTS)
    (directory / "requirements.lock").write_text(LOCK)
    (directory / "entrypoint.py").write_text(ENTRYPOINT)
    (directory / MODULE / "__init__.py").write_text("")
    (directory / MODULE / "server.py").write_text(SERVER)
    (directory / MODULE / "py.typed").write_text("")
    (directory / "tests" / "test_server.py").write_text("def test_nothing():\n    pass\n")
    return directory


def test_a_pack_of_own_code_is_valid(own_pack: Path) -> None:
    pack = load_pack(own_pack)
    check_pack(pack)
    assert pack.code == own_pack / MODULE
    assert [path.name for path in pack.code_files()] == ["__init__.py", "py.typed", "server.py"]


@pytest.mark.parametrize(
    ("requirements", "match"),
    [
        ("mcp==2.3.0\nboto3==1.43.115\n", r"must name \['cryptography'\]"),
        (REQUIREMENTS + "mcp==2.3.0\n", "more than once"),
        (REQUIREMENTS.replace("mcp==2.3.0", "mcp>=2.3"), "exact 'name==version'"),
        (REQUIREMENTS.replace("mcp==2.3.0", "mcp[cli]==2.3.0"), "exact 'name==version'"),
        (REQUIREMENTS.replace("mcp==2.3.0", "mcp==2.3.0 ; python_version>'3'"), "exact"),
        (REQUIREMENTS + "https://example.test/x.whl\n", "exact 'name==version'"),
        (REQUIREMENTS + "-e ./local\n", "exact 'name==version'"),
        (REQUIREMENTS + "--extra-index-url https://example.test/simple\n", "exact"),
        (REQUIREMENTS.replace("2.3.0", "2.4.0"), r"pins mcp==2\.3\.0, not 2\.4\.0"),
        (REQUIREMENTS + "requests==2.33.0\n", r"pins requests==\(nothing\)"),
    ],
)
def test_requirements_name_exact_direct_dependencies(
    own_pack: Path, requirements: str, match: str
) -> None:
    (own_pack / "requirements.in").write_text(requirements)
    with pytest.raises(PackError, match=match):
        check_pack(load_pack(own_pack))


def test_own_code_is_never_served_by_fastmcp(own_pack: Path) -> None:
    (own_pack / "requirements.lock").write_text(LOCK + f"fastmcp==4.1.2 --hash=sha256:{'9' * 64}\n")
    with pytest.raises(PackError, match="official MCP SDK"):
        check_pack(load_pack(own_pack))


def test_constraints_cannot_bound_a_direct_dependency(own_pack: Path) -> None:
    (own_pack / "constraints.txt").write_text("pydantic<2.15\n")
    check_pack(load_pack(own_pack))
    (own_pack / "constraints.txt").write_text("mcp<2.4\n")
    with pytest.raises(PackError, match=r"must not bound what requirements\.in pins"):
        check_pack(load_pack(own_pack))


def test_the_code_package_holds_only_python_sources(own_pack: Path) -> None:
    code = own_pack / MODULE
    (code / "__pycache__").mkdir()
    (code / "__pycache__" / "server.cpython-313.pyc").write_bytes(b"\x00")
    (code / "sub").mkdir()
    (code / "sub" / "__init__.py").write_text("")
    pack = load_pack(own_pack)
    assert [p.relative_to(code).as_posix() for p in pack.code_files()] == [
        "__init__.py",
        "py.typed",
        "server.py",
        "sub/__init__.py",
    ]
    (code / "data.json").write_text("{}")
    with pytest.raises(PackError, match="only Python sources"):
        check_pack(load_pack(own_pack))
    (code / "data.json").unlink()
    (code / "link.py").symlink_to(own_pack / "entrypoint.py")
    with pytest.raises(PackError, match="symlink"):
        check_pack(load_pack(own_pack))
    (code / "link.py").unlink()
    (code / "__init__.py").unlink()
    with pytest.raises(PackError, match=r"own_pack/__init__\.py not found"):
        check_pack(load_pack(own_pack))


def test_the_zip_carries_the_code_the_entry_point_and_the_common_runtime(
    own_pack: Path, staging: Path, tmp_path: Path
) -> None:
    pack = load_pack(own_pack)
    stage(pack, staging)
    write_zip(staging, tmp_path / "pack.zip")
    with zipfile.ZipFile(tmp_path / "pack.zip") as archive:
        names = set(archive.namelist())
        assert archive.read(f"{MODULE}/server.py") == SERVER.encode()
    assert {f"{MODULE}/__init__.py", f"{MODULE}/py.typed", f"{MODULE}/server.py"} <= names
    assert {"entrypoint.py", "pack.json", "mango_pack_runtime/server.py"} <= names
    assert {"mango_aws/__init__.py"} <= names
    # The pack's tests and its manifest stay in the repository.
    assert not [name for name in names if name.startswith(("tests/", "manifest"))]
    content = json.loads(pack_json(pack))
    assert (content["identity_mode"], content["identity_chain"]) == ("central_only", "member")


def test_a_dependency_cannot_shadow_the_own_code(own_pack: Path, staging: Path) -> None:
    (staging / MODULE).mkdir()
    with pytest.raises(PackError, match=f"already ships a top-level {MODULE}"):
        stage(load_pack(own_pack), staging)


def test_a_pack_id_that_names_a_runtime_package_is_refused(tmp_path: Path) -> None:
    directory = tmp_path / "packs" / "mango-aws"
    (directory / "mango_aws").mkdir(parents=True)
    write_manifest(directory, {**own_manifest(), "id": "mango-aws"})
    (directory / "requirements.in").write_text(REQUIREMENTS)
    (directory / "requirements.lock").write_text(LOCK)
    (directory / "entrypoint.py").write_text(ENTRYPOINT)
    (directory / "mango_aws" / "__init__.py").write_text("")
    with pytest.raises(PackError, match="cannot be named mango_aws"):
        stage(load_pack(directory), tmp_path / "staging")


def test_tools_list_of_own_code_through_the_common_runtime(own_pack: Path, tmp_path: Path) -> None:
    """What `snapshot` does with the lock, run with this repository's SDK and boto3: the
    official SDK serves the code, and the common entry point lists the member chain's
    arguments and only the tools of the manifest."""
    pack = load_pack(own_pack)
    directory = tmp_path / "unpacked"
    directory.mkdir()
    stage(pack, directory)
    tools = list_tools(directory, [sys.executable, "entrypoint.py"], "/mcp")
    assert [tool["name"] for tool in tools] == ["describe_things"]
    schema = tools[0]["inputSchema"]
    assert schema["required"] == ["account_id"]
    assert schema["properties"]["account_id"]["pattern"] == ACCOUNT_PATTERN
    assert {"type": "string", "pattern": REGION_PATTERN} in schema["properties"]["region"]["anyOf"]
    assert tools[0]["annotations"]["readOnlyHint"] is True

    # The snapshot is reviewed and pinned like an upstream pack's; `check` then passes.
    write_manifest(own_pack, own_manifest(tools_hash(tools)))
    (own_pack / "tools.snapshot.json").write_bytes(snapshot_json(tools))
    check_tools(load_pack(own_pack).manifest, tools)
    assert main(["check", str(own_pack)]) == 0
