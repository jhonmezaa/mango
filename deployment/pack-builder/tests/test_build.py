import hashlib
import json
import shutil
import stat
import zipfile
from pathlib import Path

import pytest

from mango_pack_builder.build import RUNTIME_PACKAGES, pack_json, stage, write_zip
from mango_pack_builder.pack import PackError, check_pack, load_pack

from .conftest import LOCK, TOOLS, manifest_for, write_manifest


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_zip_is_byte_identical_across_builds(staging: Path, pack_dir: Path, tmp_path: Path) -> None:
    pack = load_pack(pack_dir)
    stage(pack, staging)
    # A second tree created later, in another place and in another order.
    other = tmp_path / "elsewhere" / "staging"
    other.parent.mkdir()
    for path in sorted(staging.rglob("*"), reverse=True):
        if path.is_file():
            target = other / path.relative_to(staging)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(path, target)
    (other / "bin" / "dep").write_text("#!/another/machine/python\n")
    (other / "dep-2.0.dist-info" / "RECORD").write_text("../../bin/dep,sha256=y,2\n")

    write_zip(staging, tmp_path / "a.zip")
    write_zip(other, tmp_path / "b.zip")
    assert _sha256(tmp_path / "a.zip") == _sha256(tmp_path / "b.zip")


def test_zip_contents(staging: Path, pack_dir: Path, tmp_path: Path) -> None:
    pack = load_pack(pack_dir)
    stage(pack, staging)
    write_zip(staging, tmp_path / "pack.zip")
    with zipfile.ZipFile(tmp_path / "pack.zip") as archive:
        names = archive.namelist()
        assert names == sorted(names)
        assert set(names) == {
            "dep-2.0.dist-info/METADATA",
            "dep/__init__.py",
            "dep/_native.so",
            "entrypoint.py",
            "pack.json",
            "tools.json",
        }
        assert archive.read("pack.json") == pack_json(pack)
        assert b'"tools": [\n    "get_thing"\n  ]' in archive.read("pack.json")
        for info in archive.infolist():
            assert info.date_time == (1980, 1, 1, 0, 0, 0)
            assert info.compress_type == zipfile.ZIP_STORED
            mode = stat.S_IMODE(info.external_attr >> 16)
            assert mode == (0o755 if info.filename.endswith(".so") else 0o644)


def test_dependency_cannot_shadow_mango_files(staging: Path, pack_dir: Path) -> None:
    (staging / "pack.json").write_text('{"tools": ["read_file"]}')
    with pytest.raises(PackError, match="already ships a top-level"):
        stage(load_pack(pack_dir), staging)


# --- Packs over account data carry Mango's common entry point (D37) -------------------------

ACCOUNT_DATA = {
    "data_tier": "account_data",
    "identity_mode": "central_only",
    "egress": {"aws": ["sts", "ce"]},
    "iam": [
        {
            "actions": ["ce:GetCostForecast", "ce:GetCostAndUsage"],
            "resources": ["*"],
            "reason": "Cost Explorer does not accept ARNs.",
        }
    ],
}
RUNTIME_LOCK = (
    LOCK
    + f"boto3==1.43.101 --hash=sha256:{'d' * 64}\n"
    + (f"cryptography==50.0.1 --hash=sha256:{'e' * 64}\n")
)


def _account_data_pack(pack_dir: Path) -> Path:
    write_manifest(pack_dir, {**manifest_for(TOOLS[:1]), **ACCOUNT_DATA})
    (pack_dir / "requirements.lock").write_text(RUNTIME_LOCK)
    return pack_dir


def test_a_service_pack_zip_is_what_it_always_was(staging: Path, pack_dir: Path) -> None:
    """Pricing must keep its signed bytes: nothing of the common runtime is added to it."""
    pack = load_pack(pack_dir)
    stage(pack, staging)
    assert json.loads(pack_json(pack)) == {
        "id": "fake-pack",
        "tools": ["get_thing"],
        "version": "1.0.0-1",
    }
    assert not (staging / "mango_pack_runtime").exists()
    assert not (staging / "mango_aws").exists()


def test_an_account_data_pack_ships_the_common_entry_point(
    staging: Path, pack_dir: Path, tmp_path: Path
) -> None:
    pack = load_pack(_account_data_pack(pack_dir))
    check_pack(pack)
    stage(pack, staging)
    assert json.loads(pack_json(pack)) == {
        "id": "fake-pack",
        "version": "1.0.0-1",
        "tools": ["get_thing"],
        "identity_mode": "central_only",
        # What each call's session is limited to: the statements of the signed manifest.
        "iam": [{"actions": ["ce:GetCostAndUsage", "ce:GetCostForecast"], "resources": ["*"]}],
    }
    write_zip(staging, tmp_path / "pack.zip")
    with zipfile.ZipFile(tmp_path / "pack.zip") as archive:
        names = set(archive.namelist())
    for module in ("identity", "credentials", "guard", "config", "server", "__init__"):
        assert f"mango_pack_runtime/{module}.py" in names
    assert {"mango_aws/__init__.py", "mango_aws/broker.py"} <= names
    # Only those two packages of Mango: the pack never gets mango-api's or the Gateway's code.
    mango = {name.split("/")[0] for name in names if name.startswith("mango")}
    assert mango == {"mango_pack_runtime", "mango_aws"}
    assert not [name for name in names if "__pycache__" in name]


def test_the_common_entry_point_imports_nothing_else_of_mango() -> None:
    """It runs inside the zip, where only the two copied packages exist."""
    import ast  # noqa: PLC0415
    import importlib.util  # noqa: PLC0415

    for package in RUNTIME_PACKAGES:
        spec = importlib.util.find_spec(package)
        assert spec is not None and spec.origin is not None
        for source in Path(spec.origin).parent.glob("*.py"):
            for node in ast.walk(ast.parse(source.read_text())):
                modules = (
                    [alias.name for alias in node.names]
                    if isinstance(node, ast.Import)
                    else [node.module or ""]
                    if isinstance(node, ast.ImportFrom)
                    else []
                )
                for module in modules:
                    root = module.split(".")[0]
                    assert not root.startswith("mango_") or root in RUNTIME_PACKAGES, (
                        source.name,
                        module,
                    )


def test_an_account_data_pack_needs_what_the_entry_point_imports_in_its_lock(
    pack_dir: Path,
) -> None:
    write_manifest(pack_dir, {**manifest_for(TOOLS[:1]), **ACCOUNT_DATA})
    with pytest.raises(PackError, match=r"boto3.*cryptography"):
        check_pack(load_pack(pack_dir))


def test_a_dependency_cannot_shadow_the_common_entry_point(staging: Path, pack_dir: Path) -> None:
    (staging / "mango_pack_runtime").mkdir()
    with pytest.raises(PackError, match="mango_pack_runtime"):
        stage(load_pack(_account_data_pack(pack_dir)), staging)


# --- Packs of the member chain and compressed zips (D51) -------------------------------------


def test_a_member_pack_says_which_chain_it_uses(pack_dir: Path) -> None:
    write_manifest(
        pack_dir, {**manifest_for(TOOLS[:1]), **ACCOUNT_DATA, "identity": {"chain": "member"}}
    )
    (pack_dir / "requirements.lock").write_text(RUNTIME_LOCK)
    content = json.loads(pack_json(load_pack(pack_dir)))
    assert (content["identity_mode"], content["identity_chain"]) == ("central_only", "member")
    # A pack of the payer chain keeps the file it always had: no new key.
    assert "identity_chain" not in json.loads(pack_json(load_pack(_account_data_pack(pack_dir))))


def test_a_pack_may_ask_for_a_compressed_zip_and_it_is_still_reproducible(
    staging: Path, pack_dir: Path, tmp_path: Path
) -> None:
    (staging / "dep" / "big.py").write_text("VALUE = 1\n" * 5000)
    assert load_pack(pack_dir).build_options.compression == "stored"
    (pack_dir / "build.yaml").write_text("compression: deflate\n")
    pack = load_pack(pack_dir)
    assert pack.build_options.compression == "deflate"
    check_pack(pack)
    stage(pack, staging)
    write_zip(staging, tmp_path / "stored.zip")
    write_zip(staging, tmp_path / "a.zip", deflate=True)
    write_zip(staging, tmp_path / "b.zip", deflate=True)
    assert _sha256(tmp_path / "a.zip") == _sha256(tmp_path / "b.zip")
    assert (tmp_path / "a.zip").stat().st_size < (tmp_path / "stored.zip").stat().st_size
    with (
        zipfile.ZipFile(tmp_path / "a.zip") as archive,
        zipfile.ZipFile(tmp_path / "stored.zip") as stored,
    ):
        assert archive.namelist() == stored.namelist()
        for info in archive.infolist():
            assert info.compress_type == zipfile.ZIP_DEFLATED
            assert info.date_time == (1980, 1, 1, 0, 0, 0)
            assert archive.read(info) == stored.read(info.filename)


@pytest.mark.parametrize(
    "content", ["compression: gzip\n", "compression: deflate\nlevel: 1\n", "- deflate\n", ": x"]
)
def test_a_build_file_the_builder_does_not_understand_stops_the_build(
    pack_dir: Path, content: str
) -> None:
    (pack_dir / "build.yaml").write_text(content)
    with pytest.raises(PackError, match="build file"):
        check_pack(load_pack(pack_dir))
