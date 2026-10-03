"""Command line of the pack pipeline. `.github/workflows/packs.yml` runs these steps in order."""

from __future__ import annotations

import argparse
import hashlib
import sys
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

import boto3
from pydantic import ValidationError

from mango_pack_builder.build import build
from mango_pack_builder.kms import KmsSigner, sign_statement
from mango_pack_builder.lock import check_lock, write_lock
from mango_pack_builder.pack import PackError, check_pack, load_pack
from mango_pack_builder.snapshot import (
    list_tools_from_artifact,
    list_tools_from_lock,
    list_tools_in_container,
    snapshot_json,
)
from mango_packs.signing import (
    PackSignatureError,
    PackStatement,
    file_digest,
    verify_envelope,
    verify_file,
)
from mango_packs.tools import PackToolsError, check_tools, tools_hash


def _check(args: argparse.Namespace) -> None:
    pack = load_pack(args.pack)
    check_pack(pack)
    error = pack.manifest.quarantine_error(datetime.now(UTC))
    if error is not None:
        raise PackError(error)
    if not pack.snapshot.is_file():
        raise PackError(f"{pack.snapshot.name} not found; run the 'snapshot --update' command")
    print(f"{pack.manifest.id} {pack.manifest.version}: manifest, lock and entry point are valid")


def _lock(args: argparse.Namespace) -> None:
    pack = load_pack(args.pack)
    write_lock(pack, datetime.now(UTC))
    print(f"wrote {pack.lock}")


def _check_lock(args: argparse.Namespace) -> None:
    pack = load_pack(args.pack)
    check_pack(pack)
    check_lock(pack, datetime.now(UTC))
    print(f"{pack.lock.name} is reproducible from {pack.requirements.name}")


def _build(args: argparse.Namespace) -> None:
    pack = load_pack(args.pack)
    artifact = build(pack, args.out)
    digest = file_digest(artifact)
    print(f"{artifact} sha256:{digest.sha256} ({digest.size} bytes)")


def _snapshot(args: argparse.Namespace) -> None:
    pack = load_pack(args.pack)
    check_pack(pack)
    if args.container and args.artifact is None:
        raise PackError("--container needs --artifact")
    if args.container:
        tools = list_tools_in_container(pack, args.artifact)
    elif args.artifact is not None:
        tools = list_tools_from_artifact(pack, args.artifact)
    else:
        tools = list_tools_from_lock(pack)
    if args.update:
        pack.snapshot.write_bytes(snapshot_json(tools))
        print(f"wrote {pack.snapshot}; set tools_hash to {tools_hash(tools)} if it changed")
        return
    check_tools(pack.manifest, tools)
    if not pack.snapshot.is_file() or pack.snapshot.read_bytes() != snapshot_json(tools):
        raise PackToolsError(f"{pack.snapshot.name} is stale; run 'snapshot --update'")
    print(f"tools/list matches the manifest: {len(tools)} tools, {pack.manifest.tools_hash}")


def _statement(args: argparse.Namespace) -> None:
    pack = load_pack(args.pack)
    check_pack(pack)
    if args.artifact.name != pack.artifact_name:
        raise PackError(f"the artifact must be named {pack.artifact_name}")
    statement = PackStatement(
        schema_version=1,
        manifest=pack.manifest,
        artifact=file_digest(args.artifact),
        sbom=file_digest(args.sbom),
        lock_sha256=hashlib.sha256(pack.lock.read_bytes()).hexdigest(),
        source_revision=args.revision,
    )
    args.out.write_bytes(statement.payload())
    print(f"wrote {args.out}")


def _load_statement(path: Path, directory: Path) -> PackStatement:
    statement = PackStatement.model_validate_json(path.read_bytes())
    _verify_files(statement, directory)
    return statement


def _verify_files(statement: PackStatement, directory: Path) -> None:
    verify_file(statement.artifact, directory / statement.artifact.file)
    verify_file(statement.sbom, directory / statement.sbom.file)


def _sign(args: argparse.Namespace) -> None:
    statement = _load_statement(args.statement, args.statement.parent)
    signer = KmsSigner(boto3.client("kms"), args.key_id)
    envelope = sign_statement(statement, signer, args.public_key.read_bytes())
    args.out.write_bytes(envelope)
    print(f"wrote {args.out} for {statement.manifest.id} {statement.manifest.version}")


def _verify(args: argparse.Namespace) -> None:
    statement = verify_envelope(args.envelope.read_bytes(), args.public_key.read_bytes())
    _verify_files(statement, args.envelope.parent)
    manifest = statement.manifest
    print(
        f"verified {manifest.id} {manifest.version} (artifact sha256:{statement.artifact.sha256})"
    )


def _public_key(args: argparse.Namespace) -> None:
    signer = KmsSigner(boto3.client("kms"), args.key_id)
    args.out.write_bytes(signer.public_key_pem())
    print(f"wrote {args.out}")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="mango-pack-builder", description=__doc__)
    commands = parser.add_subparsers(required=True)

    def command(
        name: str, handler: Callable[[argparse.Namespace], None], summary: str
    ) -> argparse.ArgumentParser:
        sub = commands.add_parser(name, help=summary)
        sub.set_defaults(handler=handler)
        return sub

    def pack_command(
        name: str, handler: Callable[[argparse.Namespace], None], summary: str
    ) -> argparse.ArgumentParser:
        sub = command(name, handler, summary)
        sub.add_argument("pack", type=Path, help="pack directory, e.g. packs/aws-pricing")
        return sub

    pack_command("check", _check, "validate manifest, lock and quarantine (offline)")
    pack_command("lock", _lock, "write the hashed lock for the manifest's cutoff")
    pack_command("check-lock", _check_lock, "fail if the lock is not reproducible")

    sub = pack_command("build", _build, "build the reproducible zip")
    sub.add_argument("--out", type=Path, required=True, help="output directory")

    sub = pack_command("snapshot", _snapshot, "start the server and compare its tools/list")
    sub.add_argument("--artifact", type=Path, help="run this built zip (Linux arm64 only)")
    sub.add_argument(
        "--container", action="store_true", help="run the zip in a container without network"
    )
    sub.add_argument("--update", action="store_true", help="rewrite tools.snapshot.json")

    sub = pack_command("statement", _statement, "write the statement to be signed")
    sub.add_argument("--artifact", type=Path, required=True)
    sub.add_argument("--sbom", type=Path, required=True)
    sub.add_argument("--revision", required=True, help="git commit of the build")
    sub.add_argument("--out", type=Path, required=True)

    sub = command("sign", _sign, "sign a statement with the KMS key")
    sub.add_argument("--statement", type=Path, required=True)
    sub.add_argument("--key-id", required=True, help="ARN of the asymmetric KMS key")
    sub.add_argument("--public-key", type=Path, required=True, help="trusted public key (PEM)")
    sub.add_argument("--out", type=Path, required=True)

    sub = command("verify", _verify, "verify a signed pack offline")
    sub.add_argument("--envelope", type=Path, required=True)
    sub.add_argument("--public-key", type=Path, required=True, help="trusted public key (PEM)")

    sub = command("public-key", _public_key, "export the public key of the KMS key")
    sub.add_argument("--key-id", required=True)
    sub.add_argument("--out", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        args.handler(args)
    except (PackError, PackToolsError, PackSignatureError, ValidationError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0
