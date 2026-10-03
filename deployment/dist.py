#!/usr/bin/env python3
"""Build a Mango release and, with ``--publish``, publish it to the provider account (D58).

A release is what a customer installs with CloudFormation and nothing else:

* ``global-s3-assets/``: the templates (``Core``, ``Payer``, ``OrgAccess``, ``Member``).
* ``regional-s3-assets/``: every file the templates read (Lambda code, the SPA, signed packs).
* the ``mango-api`` image, in the provider's repository, named by digest in the template.
* ``manifest.json``: the digest of each of those, signed with the provider's key.

Nothing is built in the customer account (rules 1 and 2). Published keys are never
overwritten: a build that is not exactly the tagged version gets its own label.

Without ``--publish`` it builds everything but the image and leaves the result in
``dist/release/<label>/``: those templates point at a target that does not exist and are only
good for the checks (cdk-nag, cfn-guard, Checkov).

Standard library only, plus the ``aws``, ``docker``, ``pnpm`` and ``openssl`` commands.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
INFRA = ROOT / "infra"
CDK_OUT = INFRA / "cdk.out"
STACKS = ("Core", "PackNetwork", "Payer", "OrgAccess", "Member")
REGIONS = ("us-east-1",)
SIGNING_ALGORITHM = "ECDSA_SHA_256"
# What the signature covers is bound to this type (DSSE): a pack signature is not a release
# signature, although the same key makes both (TM-D5).
PAYLOAD_TYPE = "application/vnd.mango.release.v1+json"
# Zip entries carry this date, so the same sources always give the same bytes.
ZIP_EPOCH = (1980, 1, 1, 0, 0, 0)
UNPUBLISHED = {
    "providerAccount": "000000000000",
    "bucket": "mango-releases-unpublished",
    "imageRepository": "mango-provider/api",
    "imageDigest": "sha256:" + "0" * 64,
}


def run(*command: str, cwd: Path = ROOT, env: dict[str, str] | None = None) -> str:
    """Run a command and return its output; its errors end the build."""
    result = subprocess.run(  # noqa: S603 - fixed commands, no shell
        command, cwd=cwd, env=env, check=False, capture_output=True, text=True
    )
    if result.returncode != 0:
        sys.exit(f"{' '.join(command[:4])}… failed:\n{result.stdout}{result.stderr}")
    return result.stdout.strip()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def release_version() -> str:
    match = re.search(
        r"^version:\s*([0-9]+\.[0-9]+\.[0-9]+)\s*$", (ROOT / "release.yaml").read_text(), re.M
    )
    if not match:
        sys.exit("release.yaml has no version")
    return match.group(1)


def release_label(version: str) -> tuple[str, str]:
    """``v<version>`` only for a clean tree at that tag; anything else gets a build suffix."""
    revision = run("git", "rev-parse", "HEAD")
    dirty = bool(run("git", "status", "--porcelain"))
    tags = run("git", "tag", "--points-at", "HEAD").split()
    if not dirty and f"v{version}" in tags:
        return f"v{version}", revision
    suffix = f"g{revision[:7]}" + (f".d{int(time.time())}" if dirty else "")
    return f"v{version}-{suffix}", revision


def zip_directory(source: Path, target: Path) -> None:
    """Deterministic zip: sorted entries, fixed date, only the permission bits that matter."""
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(p for p in source.rglob("*") if p.is_file()):
            info = zipfile.ZipInfo(path.relative_to(source).as_posix(), ZIP_EPOCH)
            info.compress_type = zipfile.ZIP_DEFLATED
            executable = os.access(path, os.X_OK)
            info.external_attr = (0o755 if executable else 0o644) << 16
            archive.writestr(info, path.read_bytes())


def package(target: dict[str, str], out: Path) -> list[dict[str, Any]]:
    """Copy templates and assets out of the CDK output, under the names the templates use."""
    templates = out / "global-s3-assets"
    assets = out / "regional-s3-assets"
    templates.mkdir(parents=True)
    assets.mkdir(parents=True)
    prefix = f"mango/{target['label']}/"
    listed: dict[str, dict[str, Any]] = {}
    for stack in STACKS:
        shutil.copyfile(CDK_OUT / f"{stack}.template.json", templates / f"{stack}.template.json")
        manifest = json.loads((CDK_OUT / f"{stack}.assets.json").read_text())
        for asset in manifest.get("files", {}).values():
            source = CDK_OUT / asset["source"]["path"]
            # The stack's own template is a CDK asset too; it is published as a template.
            if source.name.endswith(".template.json"):
                continue
            for destination in asset["destinations"].values():
                key = destination["objectKey"]
                if not key.startswith(prefix) or "/" in key[len(prefix) :]:
                    sys.exit(f"{stack}: asset key outside the release prefix: {key}")
                file = assets / key[len(prefix) :]
                if not file.exists():
                    if asset["source"]["packaging"] == "zip":
                        zip_directory(source, file)
                    else:
                        shutil.copyfile(source, file)
                listed[key] = {"key": key, "sha256": sha256(file), "size": file.stat().st_size}
        if manifest.get("dockerImages"):
            sys.exit(
                f"{stack}: a release ships no CDK image asset (the image is published by digest)"
            )
    return sorted(listed.values(), key=lambda entry: entry["key"])


def member_template_sha256() -> str:
    template = json.loads((CDK_OUT / "OrgAccess.template.json").read_text())
    return str(template["Outputs"]["MemberTemplateSha256"]["Value"])


def publisher_environment(role_arn: str | None) -> dict[str, str]:
    """Credentials of the release publisher: its role when one is named, else the caller's."""
    env = dict(os.environ)
    if not role_arn:
        return env
    credentials = json.loads(
        run(
            "aws", "sts", "assume-role", "--role-arn", role_arn,
            "--role-session-name", "mango-dist",
            "--duration-seconds", "3600", "--query", "Credentials", "--output", "json",
        )
    )  # fmt: skip
    env.pop("AWS_PROFILE", None)
    env.update(
        AWS_ACCESS_KEY_ID=credentials["AccessKeyId"],
        AWS_SECRET_ACCESS_KEY=credentials["SecretAccessKey"],
        AWS_SESSION_TOKEN=credentials["SessionToken"],
    )
    return env


def publish_image(target: dict[str, str], region: str, env: dict[str, str]) -> str:
    """Build the mango-api image for arm64, push it and return the digest the registry holds."""
    registry = f"{target['providerAccount']}.dkr.ecr.{region}.amazonaws.com"
    reference = f"{registry}/{target['imageRepository']}:{target['label']}"
    password = run("aws", "ecr", "get-login-password", "--region", region, env=env)
    login = subprocess.run(  # noqa: S603
        ["docker", "login", "--username", "AWS", "--password-stdin", registry],  # noqa: S607
        input=password, text=True, capture_output=True, check=False,
    )  # fmt: skip
    if login.returncode != 0:
        sys.exit(f"docker login failed: {login.stderr}")
    try:
        # One manifest, no attestation index: the digest in the template is the image itself.
        run(
            "docker", "buildx", "build", "--platform", "linux/arm64",
            "--provenance=false", "--sbom=false",
            "--file", "apps/api/Dockerfile", "--tag", reference, "--push", ".",
        )  # fmt: skip
    finally:
        subprocess.run(["docker", "logout", registry], capture_output=True, check=False)  # noqa: S603, S607
    digest = run(
        "aws", "ecr", "describe-images", "--region", region,
        "--registry-id", target["providerAccount"],
        "--repository-name", target["imageRepository"],
        "--image-ids", f"imageTag={target['label']}",
        "--query", "imageDetails[0].imageDigest", "--output", "text", env=env,
    )  # fmt: skip
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        sys.exit(f"the registry returned no digest for {reference}: {digest}")
    return digest


def signed_message(payload: bytes) -> bytes:
    """DSSE pre-authentication encoding, as `mango_packs.signing` does for packs."""
    kind = PAYLOAD_TYPE.encode()
    return b"DSSEv1 %d %b %d %b" % (len(kind), kind, len(payload), payload)


def sign_manifest(out: Path, key_id: str, region: str, env: dict[str, str]) -> None:
    payload = (out / "manifest.json").read_bytes()
    digest = hashlib.sha256(signed_message(payload)).digest()
    signature = run(
        "aws", "kms", "sign", "--region", region, "--key-id", key_id, "--message-type", "DIGEST",
        "--signing-algorithm", SIGNING_ALGORITHM, "--message", base64.b64encode(digest).decode(),
        "--query", "Signature", "--output", "text", env=env,
    )  # fmt: skip
    envelope = {
        "payload_type": PAYLOAD_TYPE,
        "payload": base64.b64encode(payload).decode(),
        "signature": {"algorithm": SIGNING_ALGORITHM, "key_id": key_id, "value": signature},
    }
    (out / "manifest.sig.json").write_text(json.dumps(envelope, indent=2) + "\n")
    # Never publish a signature the installations' key does not verify.
    run(sys.executable, str(ROOT / "deployment/verify-release.py"), "--directory", str(out))


def put_new(bucket: str, key: str, file: Path, content_type: str, env: dict[str, str]) -> None:
    """Upload one small object; a key that exists is an error (labels are never reused)."""
    run(
        "aws", "s3api", "put-object", "--bucket", bucket, "--key", key, "--body", str(file),
        "--content-type", content_type, "--if-none-match", "*", env=env,
    )  # fmt: skip


def publish(target: dict[str, str], out: Path, region: str, env: dict[str, str]) -> None:
    prefix = f"mango/{target['label']}/"
    regional = f"{target['bucket']}-{region}"
    for file in sorted((out / "regional-s3-assets").iterdir()):
        # Asset names are content hashes: an existing key already holds these bytes.
        run("aws", "s3", "cp", str(file), f"s3://{regional}/{prefix}{file.name}", "--no-overwrite",
            "--only-show-errors", env=env)  # fmt: skip
    for file in sorted((out / "global-s3-assets").iterdir()):
        put_new(target["bucket"], prefix + file.name, file, "application/json", env)
    # The manifest goes last: a release without it is not complete.
    for name in ("manifest.json", "manifest.sig.json"):
        put_new(target["bucket"], prefix + name, out / name, "application/json", env)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument(
        "--publish", action="store_true", help="push the image and upload the release"
    )
    args = parser.parse_args()

    version = release_version()
    label, revision = release_label(version)
    region = REGIONS[0]
    target = {**UNPUBLISHED, "label": label}
    env = dict(os.environ)
    if args.publish:
        try:
            target["providerAccount"] = os.environ["MANGO_PROVIDER_ACCOUNT"]
            target["bucket"] = os.environ["MANGO_DIST_BUCKET"]
        except KeyError as missing:
            sys.exit(
                f"--publish needs {missing.args[0]} (and MANGO_DIST_BUCKET, MANGO_PROVIDER_ACCOUNT)"
            )
        target["imageRepository"] = os.environ.get(
            "MANGO_IMAGE_REPOSITORY", target["imageRepository"]
        )
        env = publisher_environment(os.environ.get("MANGO_PUBLISHER_ROLE_ARN"))

    out = ROOT / "dist" / "release" / label
    if out.exists():
        shutil.rmtree(out)

    print(f"Mango {label} ({revision[:12]})")
    print("· building the SPA")
    run("pnpm", "--filter", "@mango/web", "build")
    if args.publish:
        print("· building and pushing the mango-api image")
        target["imageDigest"] = publish_image(target, region, env)
        print(f"  {target['imageDigest']}")
    print("· synthesizing the templates")
    if CDK_OUT.exists():
        shutil.rmtree(CDK_OUT)
    run("npx", "cdk", "synth", "--quiet", "-c", f"release={json.dumps(target)}", cwd=INFRA)
    print("· packaging templates and assets")
    assets = package(target, out)
    templates = [
        {"file": f"{stack}.template.json", "sha256": sha256(file), "size": file.stat().st_size}
        for stack in STACKS
        for file in [out / "global-s3-assets" / f"{stack}.template.json"]
    ]
    manifest = {
        "schema_version": 1,
        "name": "mango-hub",
        "version": version,
        "label": label,
        "source_revision": revision,
        "published": args.publish,
        "regions": list(REGIONS),
        "provider": {
            "account": target["providerAccount"],
            "templates_bucket": target["bucket"],
            "assets_bucket": f"{target['bucket']}-<region>",
            "image_repository": target["imageRepository"],
        },
        "image": {"digest": target["imageDigest"]},
        "member_template_sha256": member_template_sha256(),
        "templates": templates,
        "assets": assets,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    size = sum(entry["size"] for entry in assets) / 1024 / 1024
    print(
        f"  {len(templates)} templates, {len(assets)} assets ({size:.0f} MB)"
        f" in {out.relative_to(ROOT)}"
    )

    if not args.publish:
        print("Not published: these templates name a target that does not exist (checks only).")
        return
    print("· signing the manifest")
    sign_manifest(
        out, os.environ.get("MANGO_SIGNING_KEY", "alias/mango-provider-signing"), region, env
    )
    print("· uploading")
    publish(target, out, region, env)
    base = f"https://{target['bucket']}.s3.amazonaws.com/mango/{label}"
    print(f"Published {label}:")
    for stack in ("Payer", "OrgAccess", "PackNetwork", "Core"):
        print(f"  {stack:<12}{base}/{stack}.template.json")
    print(f"  {'manifest':<12}{base}/manifest.json")


if __name__ == "__main__":
    main()
