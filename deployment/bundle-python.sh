#!/usr/bin/env bash
# Bundle a uv workspace package and its dependencies into a Lambda-ready directory.
# Third-party dependencies are installed from Linux arm64 wheels only (no source builds);
# workspace packages are pure Python and copied from their src/ directories.
#
# Usage: deployment/bundle-python.sh <workspace-package-name> <output-dir>
set -euo pipefail

# Callers such as the CDK CLI may force colored output; requirement files must stay plain.
unset FORCE_COLOR CLICOLOR_FORCE
export NO_COLOR=1

package="$1"
out="$2"
root="$(cd "$(dirname "$0")/.." && pwd)"

mkdir -p "$out"
req="$(mktemp)"
trap 'rm -f "$req"' EXIT

uv --color never export --project "$root" --package "$package" --no-dev --no-emit-workspace \
  --frozen --no-header --format requirements-txt > "$req"

if grep -qvE '^\s*(#|$)' "$req"; then
  uv --color never pip install --quiet --requirement "$req" --target "$out" \
    --python-platform aarch64-manylinux2014 --python-version 3.13 --only-binary :all:
fi

# Copy the package itself and every workspace package it depends on.
for src in $(uv --color never export --project "$root" --package "$package" --no-dev --only-emit-workspace \
  --frozen --no-header --format requirements-txt | sed -nE 's#^-e \./(.*)$#\1#p'); do
  cp -R "$root/$src/src/." "$out/"
done

# The bundle names its asset (hash of this directory): it must be the same in every checkout.
# Console scripts carry the path of the local interpreter in their first line, and Lambda
# never runs them.
rm -rf "$out/bin"
find "$out" -name '__pycache__' -type d -prune -exec rm -rf {} +
find "$out" -name '*.dist-info' -type d -path '*/tests/*' -prune -exec rm -rf {} + 2>/dev/null || true
