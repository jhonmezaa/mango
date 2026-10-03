#!/usr/bin/env bash
# Build one MCP pack (D19): validate, audit, build the reproducible zip, compare the server's
# tools/list with the manifest and write the statement to be signed. Nothing is signed or
# published here; `.github/workflows/packs.yml` signs in a separate job.
#
# Usage: deployment/build-pack.sh <pack-dir> <output-dir> [<tested-zip>]
#
# With <tested-zip>, the pack server is not started: the zip built here must be byte for byte
# the one another job already tested. The signing job uses it so that no third-party code
# runs next to the signing credentials, and nothing that code touched is signed.
set -euo pipefail

unset FORCE_COLOR CLICOLOR_FORCE
export NO_COLOR=1

pack_dir="$1"
out="$2"
tested="${3:-}"
root="$(cd "$(dirname "$0")/.." && pwd)"
builder=(uv --color never run --project "$root" --frozen --package mango-pack-builder python -m mango_pack_builder)

"${builder[@]}" check "$pack_dir"
# Needs PyPI: the committed lock must be what the manifest's cutoff resolves to.
"${builder[@]}" check-lock "$pack_dir"

rm -rf "$out"
mkdir -p "$out"
"${builder[@]}" build "$pack_dir" --out "$out"
artifact="$(find "$out" -maxdepth 1 -name '*.zip')"
base="${artifact%.zip}"

# Known vulnerabilities in the locked versions, and the SBOM (CycloneDX) of the pack.
uvx --color never pip-audit==2.10.1 --strict --require-hashes --disable-pip \
  --requirement "$pack_dir/requirements.lock" --format cyclonedx-json --output "$base.sbom.cdx.json"

# Reproducibility: a second build from scratch must give the same bytes.
again="$(mktemp -d)"
trap 'rm -rf "$again"' EXIT
"${builder[@]}" build "$pack_dir" --out "$again" > /dev/null
cmp "$artifact" "$again/$(basename "$artifact")"

if [ -n "$tested" ]; then
  cmp "$artifact" "$tested"
# The server is third-party code: in CI (Linux arm64, the platform of AgentCore Runtime) the
# built zip runs in a container without network. Elsewhere the zip may not run at all, so
# the same lock and entry point run in a local venv, enough to compare tools/list while
# developing. MANGO_PACK_SNAPSHOT=container forces the container (Docker on arm64).
elif [ "${MANGO_PACK_SNAPSHOT:-}" = "container" ] || [ "$(uname -s)-$(uname -m)" = "Linux-aarch64" ]; then
  "${builder[@]}" snapshot "$pack_dir" --artifact "$artifact" --container
else
  "${builder[@]}" snapshot "$pack_dir"
fi

"${builder[@]}" statement "$pack_dir" --artifact "$artifact" --sbom "$base.sbom.cdx.json" \
  --revision "${GITHUB_SHA:-$(git -C "$root" rev-parse HEAD)}" --out "$base.statement.json"
