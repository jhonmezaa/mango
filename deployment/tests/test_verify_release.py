"""verify-release.py: the templates of the stacks nested in Core are verified too (D99)."""

from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

REPO = Path(__file__).parents[2]
KEY = "mango/assets/" + "b" * 64 + ".json"


def _load() -> ModuleType:
    path = REPO / "deployment" / "verify-release.py"
    spec = importlib.util.spec_from_file_location("mango_verify_release", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


verify = _load()


def _release(root: Path, url: Any = None) -> dict[str, Any]:
    """A release directory with Core naming one nested template; its manifest, unsigned."""
    (root / "global-s3-assets").mkdir(parents=True)
    (root / "regional-s3-assets").mkdir(parents=True)
    url = url or {
        "Fn::Join": [
            "",
            [
                "https://s3.us-east-1.",
                {"Ref": "AWS::URLSuffix"},
                f"/mango-releases-example-us-east-1/{KEY}",
            ],
        ]
    }
    stack = {"Type": "AWS::CloudFormation::Stack", "Properties": {"TemplateURL": url}}
    (root / "global-s3-assets" / "Core.template.json").write_text(
        json.dumps({"Resources": {"Ops": stack}})
    )
    nested = root / "regional-s3-assets" / Path(KEY).name
    nested.write_text(json.dumps({"Resources": {"Alarm": {"Type": "AWS::CloudWatch::Alarm"}}}))
    return {
        "regions": ["us-east-1"],
        "provider": {"templates_bucket": "mango-releases-example"},
        "templates": [{"file": "Core.template.json"}],
        "nested_templates": [
            {
                "key": KEY,
                "file": "CoreOps.nested.template.json",
                "parent": "Core",
                "sha256": hashlib.sha256(nested.read_bytes()).hexdigest(),
            }
        ],
    }


def test_a_nested_template_of_the_manifest_is_verified(tmp_path: Path) -> None:
    assert verify.verify_nested(tmp_path, _release(tmp_path)) == 1


def test_a_changed_nested_template_is_not_verified(tmp_path: Path) -> None:
    manifest = _release(tmp_path)
    (tmp_path / "regional-s3-assets" / Path(KEY).name).write_text('{"Resources": {}}')
    with pytest.raises(verify.ReleaseError, match="is not the file the manifest names"):
        verify.verify_nested(tmp_path, manifest)


def test_a_missing_nested_template_is_not_verified(tmp_path: Path) -> None:
    manifest = _release(tmp_path)
    (tmp_path / "regional-s3-assets" / Path(KEY).name).unlink()
    with pytest.raises(verify.ReleaseError, match="missing nested template"):
        verify.verify_nested(tmp_path, manifest)


def test_a_nested_stack_the_manifest_does_not_name_is_not_verified(tmp_path: Path) -> None:
    manifest = _release(tmp_path)
    manifest["nested_templates"] = []
    with pytest.raises(verify.ReleaseError, match="nested templates of the manifest differ"):
        verify.verify_nested(tmp_path, manifest)


def test_a_nested_stack_from_outside_the_release_is_not_verified(tmp_path: Path) -> None:
    manifest = _release(tmp_path, url="https://example.invalid/other.json")
    with pytest.raises(verify.ReleaseError, match="not created from a template of the release"):
        verify.verify_nested(tmp_path, manifest)


def test_a_nested_stack_from_another_bucket_is_not_verified(tmp_path: Path) -> None:
    other = {
        "Fn::Join": ["", ["https://s3.us-east-1.", {"Ref": "AWS::URLSuffix"}, f"/elsewhere/{KEY}"]]
    }
    manifest = _release(tmp_path, url=other)
    with pytest.raises(verify.ReleaseError, match="not created from a template of the release"):
        verify.verify_nested(tmp_path, manifest)


# --- Images (D117 (2)) -------------------------------------------------------------------------

API = "sha256:" + "a" * 64
RENDER = "sha256:" + "c" * 64


def _with_images(root: Path, in_core: list[str], in_nested: list[str]) -> dict[str, Any]:
    manifest = _release(root)
    core = root / "global-s3-assets" / "Core.template.json"
    template = json.loads(core.read_text())
    template["Resources"]["Api"] = {"Properties": {"Image": [f"repo@{d}" for d in in_core]}}
    core.write_text(json.dumps(template))
    nested = root / "regional-s3-assets" / Path(KEY).name
    body = json.loads(nested.read_text())
    body["Resources"]["Render"] = {"Properties": {"ImageUri": [f"repo@{d}" for d in in_nested]}}
    nested.write_text(json.dumps(body))
    manifest["nested_templates"][0]["sha256"] = hashlib.sha256(nested.read_bytes()).hexdigest()
    manifest["images"] = [
        {"name": "mango-api", "tag": "v1.2.3", "digest": API},
        {"name": "render-document", "tag": "render-document-v1.2.3", "digest": RENDER},
    ]
    return manifest


def test_the_templates_run_exactly_the_images_of_the_manifest(tmp_path: Path) -> None:
    verify.verify_images(tmp_path, _with_images(tmp_path, [API], [RENDER]))


@pytest.mark.parametrize(
    ("in_core", "in_nested"),
    [
        ([API], []),  # an image of the manifest that nothing runs
        ([API], ["sha256:" + "d" * 64]),  # an image the manifest does not sign
        ([API, "sha256:" + "d" * 64], [RENDER]),
    ],
)
def test_an_image_the_manifest_does_not_name_is_not_verified(
    tmp_path: Path, in_core: list[str], in_nested: list[str]
) -> None:
    with pytest.raises(verify.ReleaseError, match="images"):
        verify.verify_images(tmp_path, _with_images(tmp_path, in_core, in_nested))


def test_a_release_before_render_document_names_only_the_image_of_mango_api() -> None:
    images = verify.manifest_images({"image": {"digest": API}})
    assert images == [{"name": "mango-api", "digest": API}]
    with pytest.raises(verify.ReleaseError):
        verify.manifest_images({"images": [{"name": "x", "digest": "latest"}]})
