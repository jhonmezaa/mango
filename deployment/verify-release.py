#!/usr/bin/env python3
"""Verify a Mango release before installing it (D58, TM-D3, TM-D16).

Checks, without trusting the place the files came from:

1. ``manifest.sig.json`` is signed by the provider's key (``packs/signing-key.pub`` of the
   repository at the version being installed, or the key given with ``--public-key``).
2. The signed manifest is the one next to it.
3. Every template named by the manifest has the digest the manifest states (and every asset,
   when the files are at hand).
4. The templates of the stacks nested in Core (D99) are there with their digest, and every
   nested stack of every template is created from one of them: CloudFormation reads them from
   the regional assets bucket, so a template the manifest does not name would go unverified.

Usage, either:

    verify-release.py --directory dist/release/<label>
    verify-release.py --bucket <templates bucket> --label <label> [--public-key file.pem]

The second form downloads manifest, signature, templates and nested templates with the
caller's credentials (a principal of a customer organization). Standard library, ``openssl``
and ``aws`` only.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

PAYLOAD_TYPE = "application/vnd.mango.release.v1+json"
ALGORITHM = "ECDSA_SHA_256"
DEFAULT_KEY = Path(__file__).resolve().parent.parent / "packs" / "signing-key.pub"
# How a TemplateURL names a nested template: an asset of the release, named by its hash.
NESTED_KEY = re.compile(r"mango/assets/[0-9a-f]{64}\.json")


class ReleaseError(Exception):
    """The release is not what the provider signed."""


def signed_message(payload: bytes) -> bytes:
    kind = PAYLOAD_TYPE.encode()
    return b"DSSEv1 %d %b %d %b" % (len(kind), kind, len(payload), payload)


def verify_signature(envelope: dict[str, object], public_key: Path) -> bytes:
    """Return the signed payload, or raise. The payload is not parsed before this passes."""
    signature = envelope.get("signature")
    if envelope.get("payload_type") != PAYLOAD_TYPE or not isinstance(signature, dict):
        raise ReleaseError("not a signed Mango release manifest")
    if signature.get("algorithm") != ALGORITHM:
        raise ReleaseError("unexpected signature algorithm")
    try:
        payload = base64.b64decode(str(envelope["payload"]), validate=True)
        value = base64.b64decode(str(signature["value"]), validate=True)
    except (KeyError, ValueError) as error:
        raise ReleaseError("malformed signature envelope") from error
    with tempfile.TemporaryDirectory() as work:
        message = Path(work) / "message"
        message.write_bytes(signed_message(payload))
        der = Path(work) / "signature"
        der.write_bytes(value)
        result = subprocess.run(  # noqa: S603 - fixed command, no shell
            [  # noqa: S607
                "openssl",
                "dgst",
                "-sha256",
                "-verify",
                str(public_key),
                "-signature",
                str(der),
                str(message),
            ],
            capture_output=True,
            check=False,
        )
    if result.returncode != 0:
        raise ReleaseError("the signature is not from the provider's key")
    return payload


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_directory(directory: Path, public_key: Path) -> dict[str, object]:
    envelope = json.loads((directory / "manifest.sig.json").read_text())
    payload = verify_signature(envelope, public_key)
    if payload != (directory / "manifest.json").read_bytes():
        raise ReleaseError("manifest.json is not the signed manifest")
    manifest = json.loads(payload)
    checked = 0
    for kind, folder, name in (
        ("templates", "global-s3-assets", "file"),
        ("assets", "regional-s3-assets", "key"),
    ):
        for entry in manifest[kind]:
            file = directory / folder / Path(entry[name]).name
            if not file.exists():
                if kind == "templates":
                    raise ReleaseError(f"missing template {file.name}")
                continue
            if sha256(file) != entry["sha256"]:
                raise ReleaseError(f"{file.name} is not the file the manifest names")
            checked += 1
    checked += verify_nested(directory, manifest)
    manifest["_checked_files"] = checked
    return manifest


def nested_keys(template: dict[str, object], bucket: str) -> list[str]:
    """Keys of the templates the nested stacks of a template are created from, in ``bucket``."""
    keys = []
    resources = template.get("Resources", {})
    for resource in resources.values() if isinstance(resources, dict) else []:
        if not isinstance(resource, dict) or resource.get("Type") != "AWS::CloudFormation::Stack":
            continue
        properties = resource.get("Properties") or {}
        url = json.dumps(properties.get("TemplateURL"))
        found = NESTED_KEY.findall(url)
        # The key alone is not enough: CloudFormation reads the bucket the URL names.
        if len(found) != 1 or f"/{bucket}/{found[0]}" not in url:
            raise ReleaseError("a nested stack is not created from a template of the release")
        keys.append(found[0])
    return keys


def verify_nested(directory: Path, manifest: dict[str, object]) -> int:
    """Nested templates are required, unlike other assets: each is IaC that gets installed."""
    entries = manifest.get("nested_templates", [])
    if not isinstance(entries, list):
        raise ReleaseError("malformed list of nested templates")
    files = {str(e["key"]): directory / "regional-s3-assets" / Path(e["key"]).name for e in entries}
    for entry in entries:
        file = files[str(entry["key"])]
        if not file.exists():
            raise ReleaseError(f"missing nested template {entry['file']}")
        if sha256(file) != entry["sha256"]:
            raise ReleaseError(f"{entry['file']} is not the file the manifest names")
    provider = manifest.get("provider")
    regions = manifest.get("regions")
    if not isinstance(provider, dict) or not isinstance(regions, list) or len(regions) != 1:
        raise ReleaseError("malformed provider or regions in the manifest")
    bucket = f"{provider['templates_bucket']}-{regions[0]}"
    named: list[str] = []
    templates = manifest["templates"]
    if not isinstance(templates, list):
        raise ReleaseError("malformed list of templates")
    for path in [
        *(directory / "global-s3-assets" / Path(t["file"]).name for t in templates),
        *files.values(),
    ]:
        named += nested_keys(json.loads(path.read_text()), bucket)
    if sorted(named) != sorted(files):
        raise ReleaseError("the nested stacks and the nested templates of the manifest differ")
    return len(entries)


def download(bucket: str, label: str, directory: Path) -> None:
    """Manifest, signature, templates and nested templates; other assets are read by
    CloudFormation, not by people."""

    def fetch(name: str, target: Path, source: str = bucket, key: str | None = None) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(  # noqa: S603
            [  # noqa: S607
                "aws",
                "s3api",
                "get-object",
                "--bucket",
                source,
                "--key",
                key or f"mango/{label}/{name}",
                str(target),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            raise ReleaseError(
                f"cannot read {name} of {label}: {result.stderr.strip().splitlines()[-1]}"
            )

    fetch("manifest.json", directory / "manifest.json")
    fetch("manifest.sig.json", directory / "manifest.sig.json")
    # Names come from an unverified file here: only plain template names are fetched, and the
    # signature is checked before anything is believed.
    for entry in json.loads((directory / "manifest.json").read_text()).get("templates", []):
        name = str(entry.get("file", ""))
        if not name.endswith(".template.json") or "/" in name or name.startswith("."):
            raise ReleaseError("unexpected template name in the manifest")
        fetch(name, directory / "global-s3-assets" / name)
    # Nested templates (D99) are assets: in the regional bucket of the release's Region, under
    # a key made only of their hash.
    manifest = json.loads((directory / "manifest.json").read_text())
    regions = manifest.get("regions") or []
    for entry in manifest.get("nested_templates", []):
        key = str(entry.get("key", ""))
        if not NESTED_KEY.fullmatch(key) or len(regions) != 1:
            raise ReleaseError("unexpected nested template in the manifest")
        name = Path(key).name
        fetch(name, directory / "regional-s3-assets" / name, f"{bucket}-{regions[0]}", key)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--directory", type=Path, help="a release built by `mise run dist`")
    parser.add_argument("--bucket", help="templates bucket of the provider")
    parser.add_argument("--label", help="release label, e.g. v0.1.0")
    parser.add_argument(
        "--public-key", type=Path, default=DEFAULT_KEY, help="PEM of the provider's signing key"
    )
    args = parser.parse_args()
    if (args.directory is None) == (args.bucket is None) or (args.bucket and not args.label):
        parser.error("give --directory, or --bucket with --label")
    try:
        if args.directory:
            manifest = verify_directory(args.directory, args.public_key)
        else:
            with tempfile.TemporaryDirectory() as work:
                download(args.bucket, args.label, Path(work))
                manifest = verify_directory(Path(work), args.public_key)
    except (ReleaseError, OSError, ValueError, KeyError) as error:
        sys.exit(f"NOT VERIFIED: {error}")
    print(
        f"Verified {manifest['name']} {manifest['label']}"
        f" (commit {str(manifest['source_revision'])[:12]})"
    )
    print(f"  signed by the provider's key; {manifest['_checked_files']} files match the manifest")
    print(f"  image {manifest['image']['digest']}")
    for entry in manifest["templates"]:
        print(f"  {entry['file']:<26}sha256:{entry['sha256']}")


if __name__ == "__main__":
    main()
