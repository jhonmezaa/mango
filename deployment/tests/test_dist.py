"""`deployment/dist.py`: what a release publishes and how it treats a key that already exists.

Assets of every release share one prefix and are named after their content (D69). The tests
here hold the two things that makes safe: the zip of an asset depends only on its files, and a
published key with other bytes ends the release instead of being skipped.
"""

import base64
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

REPO = Path(__file__).parents[2]
BUCKET = "mango-releases-example-us-east-1"


def _load() -> ModuleType:
    spec = importlib.util.spec_from_file_location("mango_dist", REPO / "deployment" / "dist.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


dist = _load()


class FakeStore:
    """The assets bucket as the publisher sees it: `aws s3api` with conditional writes."""

    def __init__(self, *, keeps_checksum: bool = True) -> None:
        self.objects: dict[str, bytes] = {}
        self.keeps_checksum = keeps_checksum
        self.calls: list[list[str]] = []
        self.put_error: str | None = None

    def _run(self, command: tuple[str, ...]) -> subprocess.CompletedProcess[str]:
        self.calls.append(list(command))
        assert command[:2] == ("aws", "s3api")
        operation = command[2]
        option = {
            command[i]: command[i + 1] for i in range(3, len(command) - 1) if command[i][:2] == "--"
        }
        assert option["--bucket"] == BUCKET
        key = option["--key"]

        def done(code: int, out: str = "", err: str = "") -> subprocess.CompletedProcess[str]:
            return subprocess.CompletedProcess(list(command), code, out, err)

        if operation == "put-object":
            assert option["--if-none-match"] == "*"
            if self.put_error:
                return done(254, err=self.put_error)
            if key in self.objects:
                return done(
                    254, err="An error occurred (PreconditionFailed) when calling the PutObject"
                )
            body = Path(option["--body"]).read_bytes()
            # S3 rejects a body that is not the stated digest.
            assert base64.b64decode(option["--checksum-sha256"]) == hashlib.sha256(body).digest()
            self.objects[key] = body
            return done(0, out="{}")
        if operation == "head-object":
            assert option["--checksum-mode"] == "ENABLED"
            head: dict[str, Any] = {"ContentLength": len(self.objects[key])}
            if self.keeps_checksum:
                digest = hashlib.sha256(self.objects[key]).digest()
                head |= {
                    "ChecksumSHA256": base64.b64encode(digest).decode(),
                    "ChecksumType": "FULL_OBJECT",
                }
            return done(0, out=json.dumps(head))
        if operation == "get-object":
            Path(command[-1]).write_bytes(self.objects[key])
            return done(0, out="{}")
        raise AssertionError(f"unexpected call: {operation}")

    def attempt(self, *command: str, env: dict[str, str] | None = None) -> Any:
        return self._run(command)

    def run(self, *command: str, cwd: Path | None = None, env: dict[str, str] | None = None) -> str:
        result = self._run(command)
        assert result.returncode == 0
        return result.stdout.strip()

    def operations(self) -> list[str]:
        return [call[2] for call in self.calls]


@pytest.fixture
def store(monkeypatch: pytest.MonkeyPatch) -> FakeStore:
    fake = FakeStore()
    monkeypatch.setattr(dist, "attempt", fake.attempt)
    monkeypatch.setattr(dist, "run", fake.run)
    return fake


def _asset(tmp_path: Path, content: bytes) -> tuple[str, Path]:
    file = tmp_path / ("a" * 64 + ".zip")
    file.write_bytes(content)
    return dist.ASSETS_PREFIX + file.name, file


def test_a_new_asset_is_uploaded_with_its_digest(store: FakeStore, tmp_path: Path) -> None:
    key, file = _asset(tmp_path, b"built")

    assert dist.put_asset(BUCKET, key, file, {}) is True

    assert store.objects == {key: b"built"}
    assert store.operations() == ["put-object"]


def test_a_published_asset_with_the_same_bytes_is_not_uploaded_again(
    store: FakeStore, tmp_path: Path
) -> None:
    key, file = _asset(tmp_path, b"built")
    store.objects[key] = b"built"

    assert dist.put_asset(BUCKET, key, file, {}) is False

    # The digest S3 keeps is enough: nothing is downloaded.
    assert store.operations() == ["put-object", "head-object"]


def test_a_published_asset_with_other_bytes_ends_the_release(
    store: FakeStore, tmp_path: Path
) -> None:
    key, file = _asset(tmp_path, b"built now")
    store.objects[key] = b"published before"

    with pytest.raises(SystemExit) as failure:
        dist.put_asset(BUCKET, key, file, {})

    message = str(failure.value)
    assert key in message
    assert "already published with other content" in message
    assert hashlib.sha256(b"published before").hexdigest() in message
    assert hashlib.sha256(b"built now").hexdigest() in message
    assert store.objects[key] == b"published before"


@pytest.mark.parametrize(("published", "same"), [(b"built", True), (b"other", False)])
def test_an_asset_published_without_a_stored_digest_is_read_back(
    store: FakeStore, tmp_path: Path, published: bytes, same: bool
) -> None:
    store.keeps_checksum = False
    key, file = _asset(tmp_path, b"built")
    store.objects[key] = published

    if same:
        assert dist.put_asset(BUCKET, key, file, {}) is False
    else:
        with pytest.raises(SystemExit, match="already published with other content"):
            dist.put_asset(BUCKET, key, file, {})

    assert store.operations() == ["put-object", "head-object", "get-object"]


def test_a_partial_digest_of_s3_is_not_believed(
    store: FakeStore, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A multipart upload keeps a digest of digests: it is not the sha256 of the object."""
    key, file = _asset(tmp_path, b"built")
    store.objects[key] = b"other"
    fake_head = json.dumps(
        {
            "ChecksumSHA256": base64.b64encode(hashlib.sha256(b"built").digest()).decode(),
            "ChecksumType": "COMPOSITE",
        }
    )
    real = store.run

    def run(*command: str, cwd: Path | None = None, env: dict[str, str] | None = None) -> str:
        return fake_head if command[2] == "head-object" else real(*command, env=env)

    monkeypatch.setattr(dist, "run", run)

    with pytest.raises(SystemExit, match="already published with other content"):
        dist.put_asset(BUCKET, key, file, {})


def test_an_upload_that_fails_for_another_reason_ends_the_release(
    store: FakeStore, tmp_path: Path
) -> None:
    key, file = _asset(tmp_path, b"built")
    store.put_error = "An error occurred (AccessDenied) when calling the PutObject operation"

    with pytest.raises(SystemExit, match="cannot upload"):
        dist.put_asset(BUCKET, key, file, {})

    assert store.operations() == ["put-object"]


def test_publishing_uploads_only_what_is_new_and_the_manifest_last(
    store: FakeStore,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    out = tmp_path / "release"
    (out / "regional-s3-assets").mkdir(parents=True)
    (out / "global-s3-assets").mkdir()
    (out / "regional-s3-assets" / "old.zip").write_bytes(b"shared with the last release")
    (out / "regional-s3-assets" / "new.zip").write_bytes(b"changed in this one")
    (out / "global-s3-assets" / "Core.template.json").write_text("{}")
    (out / "manifest.json").write_text("{}")
    (out / "manifest.sig.json").write_text("{}")
    store.objects[dist.ASSETS_PREFIX + "old.zip"] = b"shared with the last release"
    templates: list[str] = []

    def put_new(bucket: str, key: str, file: Path, content_type: str, env: dict[str, str]) -> None:
        templates.append(f"{bucket}/{key}")

    monkeypatch.setattr(dist, "put_new", put_new)
    dist.publish(
        {"label": "v1.2.3", "bucket": BUCKET.removesuffix("-us-east-1")}, out, "us-east-1", {}
    )

    assert sorted(store.objects) == ["mango/assets/new.zip", "mango/assets/old.zip"]
    # Templates and manifest stay under the label, in the templates bucket.
    assert templates == [
        "mango-releases-example/mango/v1.2.3/Core.template.json",
        "mango-releases-example/mango/v1.2.3/manifest.json",
        "mango-releases-example/mango/v1.2.3/manifest.sig.json",
    ]
    assert "1 new, 1 already published" in capsys.readouterr().out


def test_the_image_is_built_on_bases_pinned_by_digest_and_dated_like_the_zips() -> None:
    dockerfile = (REPO / "apps" / "api" / "Dockerfile").read_text()
    bases = re.findall(r"^FROM (\S+)", dockerfile, re.M)
    assert len(bases) == 3
    for base in bases:
        # The tag stays for people and for Dependabot; the digest is what is pulled.
        assert re.fullmatch(r"[a-z0-9./-]+:[0-9][a-z0-9.-]*@sha256:[0-9a-f]{64}", base), base
    epoch = datetime(*dist.ZIP_EPOCH, tzinfo=UTC).timestamp()
    assert int(dist.IMAGE_EPOCH) == epoch
    assert f"--date=@{dist.IMAGE_EPOCH}" in dockerfile


def _tree(root: Path, files: dict[str, bytes]) -> Path:
    for name, content in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    return root


def test_the_zip_of_an_asset_depends_only_on_its_files(tmp_path: Path) -> None:
    files = {"handler.py": b"print('a')\n", "pkg/__init__.py": b"", "pkg/lib.so": b"\x7fELF"}
    first = _tree(tmp_path / "first", files)
    # Same files, written in another order, with other dates and other permission bits.
    second = _tree(tmp_path / "second", dict(reversed(files.items())))
    os.utime(second / "handler.py", (1_000_000_000, 1_000_000_000))
    (second / "pkg" / "lib.so").chmod(0o755)
    (second / "handler.py").chmod(0o600)

    dist.zip_directory(first, tmp_path / "first.zip")
    dist.zip_directory(second, tmp_path / "second.zip")

    assert (tmp_path / "first.zip").read_bytes() == (tmp_path / "second.zip").read_bytes()
    with zipfile.ZipFile(tmp_path / "first.zip") as archive:
        assert archive.namelist() == ["handler.py", "pkg/__init__.py", "pkg/lib.so"]
        assert {info.date_time for info in archive.infolist()} == {dist.ZIP_EPOCH}

    (second / "handler.py").write_bytes(b"print('b')\n")
    dist.zip_directory(second, tmp_path / "third.zip")
    assert (tmp_path / "third.zip").read_bytes() != (tmp_path / "first.zip").read_bytes()


def _cdk_out(root: Path, key: str) -> Path:
    asset = _tree(root / "asset.abc", {"handler.py": b"print('a')\n"})
    for stack in dist.STACKS:
        (root / f"{stack}.template.json").write_text("{}")
        files = (
            {
                "abc": {
                    "source": {"path": asset.name, "packaging": "zip"},
                    "destinations": {"current": {"objectKey": key}},
                },
                # The stack's own template is published as a template, not as an asset.
                "template": {
                    "source": {"path": "Core.template.json", "packaging": "file"},
                    "destinations": {"current": {"objectKey": "mango/assets/0f.json"}},
                },
            }
            if stack == "Core"
            else {}
        )
        (root / f"{stack}.assets.json").write_text(json.dumps({"files": files}))
    return root


def test_assets_are_listed_under_the_shared_prefix_whatever_the_label(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(dist, "CDK_OUT", _cdk_out(tmp_path / "cdk.out", "mango/assets/abc.zip"))

    listed = [
        dist.package({"label": label}, tmp_path / label) for label in ("v1.0.0", "v1.0.1-gabc1234")
    ]

    assert listed[0] == listed[1]
    assert [entry["key"] for entry in listed[0]] == ["mango/assets/abc.zip"]
    built = tmp_path / "v1.0.0" / "regional-s3-assets" / "abc.zip"
    assert listed[0][0]["sha256"] == hashlib.sha256(built.read_bytes()).hexdigest()


def test_a_description_that_names_the_release_ends_the_build(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cdk_out = _cdk_out(tmp_path / "cdk.out", "mango/assets/abc.zip")
    (cdk_out / "Payer.template.json").write_text(
        json.dumps({"Description": "(Mango) mango-hub v1.0.0 billing reader"})
    )
    monkeypatch.setattr(dist, "CDK_OUT", cdk_out)

    with pytest.raises(SystemExit, match="Payer: the description names the release"):
        dist.package({"label": "v1.0.0"}, tmp_path / "out")


@pytest.mark.parametrize("key", ["mango/v1.0.0/abc.zip", "mango/assets/deep/abc.zip", "abc.zip"])
def test_an_asset_outside_the_shared_prefix_ends_the_build(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, key: str
) -> None:
    monkeypatch.setattr(dist, "CDK_OUT", _cdk_out(tmp_path / "cdk.out", key))

    with pytest.raises(SystemExit, match="outside the assets prefix"):
        dist.package({"label": "v1.0.0"}, tmp_path / "out")
