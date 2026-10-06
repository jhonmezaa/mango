#!/usr/bin/env python3
"""Fail if a versioned file holds something shaped like real data of an installation (D59).

The repository is public. gitleaks looks for secrets; an account id, an organization id or
the mail address of a person is not a secret, so nothing automatic saw them. The real values
cannot be listed here, so the check goes by shape: whatever looks like one of the identifiers
below and is not a known invented marker (``real-data-allowlist.toml``) is a finding.

Rules:

- ``aws-account-id``: twelve digits on their own, in an ARN or in a bucket name. Twelve digits
  inside a longer number, a hex digest, a decimal or a UUID are not an account id.
- ``aws-organization-id``: ``o-`` and 10 to 32 lowercase letters or digits.
- ``aws-ou-id``: ``ou-<root>-<8 to 32 characters>``.
- ``cognito-user-pool-id``: ``<region>_<9 characters>``.
- ``cloudfront-host``: a host under ``cloudfront.net`` (``*.cloudfront.net`` is not one).
- ``cognito-domain``: a host under ``amazoncognito.com`` that carries a domain prefix.
- ``public-email``: an address, whole or cut with an ellipsis, of a public mail provider.

Usage: ``check-real-data.py [file ...]``. Without arguments it reads every file git tracks
plus the new ones git does not ignore. Values are printed masked: the logs of CI are public
too. Exit code: 0 clean, 1 findings, 2 a broken allowlist. Standard library and ``git`` only.
"""

from __future__ import annotations

import re
import subprocess
import sys
import tomllib
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ALLOWLIST = Path(__file__).resolve().with_name("real-data-allowlist.toml")

ACCOUNT = "aws-account-id"
ORGANIZATION = "aws-organization-id"
OU = "aws-ou-id"
USER_POOL = "cognito-user-pool-id"
CLOUDFRONT = "cloudfront-host"
COGNITO_DOMAIN = "cognito-domain"
EMAIL = "public-email"

_UUID = re.compile(r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}")
_HOST_START = r"(?<![A-Za-z0-9.-])"
_PROVIDERS = (
    r"gmail\.com|googlemail\.com|icloud\.com|me\.com|mac\.com|msn\.com|proton\.me|pm\.me"
    r"|protonmail\.(?:com|ch)"
    r"|(?:outlook|hotmail|live|yahoo|ymail)\.[a-z]{2,3}(?:\.[a-z]{2})?"
)

PATTERNS: dict[str, re.Pattern[str]] = {
    # Not glued to letters or digits (a hex digest now and then holds twelve digits in a row,
    # which made a test of infra fail by chance) and not the digits of a decimal.
    ACCOUNT: re.compile(r"(?<![0-9A-Za-z])(?<![0-9]\.)[0-9]{12}(?![0-9A-Za-z])(?!\.[0-9])"),
    ORGANIZATION: re.compile(r"(?<![0-9A-Za-z-])o-[a-z0-9]{10,32}(?![0-9A-Za-z-])"),
    OU: re.compile(r"(?<![0-9A-Za-z-])ou-(?P<root>[a-z0-9]{4,32})-[a-z0-9]{8,32}(?![0-9A-Za-z-])"),
    USER_POOL: re.compile(
        r"(?<![0-9A-Za-z-])[a-z]{2}(?:-[a-z]+)+-[0-9]_[A-Za-z0-9]{9}(?![0-9A-Za-z])"
    ),
    CLOUDFRONT: re.compile(_HOST_START + r"(?:[a-z0-9-]+\.)+cloudfront\.net(?![A-Za-z0-9-])", re.I),
    COGNITO_DOMAIN: re.compile(
        _HOST_START + r"(?:[a-z0-9-]+\.)+amazoncognito\.com(?![A-Za-z0-9-])", re.I
    ),
    # The local part may be cut («ana…@», «…ez@»); the domain is not the start of another one.
    EMAIL: re.compile(
        r"(?P<local>[A-Za-z0-9._%+…-]*)@(?:" + _PROVIDERS + r")(?![A-Za-z0-9-]|\.[A-Za-z0-9])",
        re.I,
    ),
}
RULES = tuple(PATTERNS)
CASE_INSENSITIVE = {CLOUDFRONT, COGNITO_DOMAIN, EMAIL}


class AllowlistError(Exception):
    pass


@dataclass(frozen=True)
class Allowlist:
    values: dict[str, frozenset[str]]
    ou_roots: frozenset[str]

    def allows(self, rule: str, value: str, match: re.Match[str]) -> bool:
        if rule == OU and match.group("root") in self.ou_roots:
            return True
        return _normalized(rule, value) in self.values[rule]


@dataclass(frozen=True)
class Finding:
    path: str
    line: int
    rule: str
    value: str

    def __str__(self) -> str:
        return f"{self.path}:{self.line}: {self.rule}: {mask(self.value)}"


def _normalized(rule: str, value: str) -> str:
    return value.lower() if rule in CASE_INSENSITIVE else value


def mask(value: str) -> str:
    """Enough to find the value in its line, without copying it to a public log."""
    return f"{value[:2]}…{value[-2:]} ({len(value)} characters)"


def load_allowlist(path: Path = ALLOWLIST) -> Allowlist:
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as error:
        raise AllowlistError(f"{path.name}: {error}") from error
    unknown = sorted(set(data) - set(RULES))
    if unknown:
        raise AllowlistError(f"{path.name}: unknown rules {unknown}; the rules are {list(RULES)}")
    values: dict[str, frozenset[str]] = {}
    for rule in RULES:
        table = data.get(rule, {})
        extra = sorted(set(table) - ({"allowed", "roots"} if rule == OU else {"allowed"}))
        if extra:
            raise AllowlistError(f"{path.name}: [{rule}] does not take {extra}")
        allowed = table.get("allowed", [])
        for value in allowed:
            # A marker that the rule does not match allows nothing: it is a typo or a leftover.
            if not isinstance(value, str) or not PATTERNS[rule].fullmatch(value):
                raise AllowlistError(f"{path.name}: [{rule}] {value!r} does not have the shape")
        values[rule] = frozenset(_normalized(rule, value) for value in allowed)
    roots = data.get(OU, {}).get("roots", [])
    for root in roots:
        if not isinstance(root, str) or not re.fullmatch(r"[a-z0-9]{4,32}", root):
            raise AllowlistError(f"{path.name}: [{OU}] root {root!r} does not have the shape")
    return Allowlist(values=values, ou_roots=frozenset(roots))


def _matches(rule: str, line: str) -> Iterator[re.Match[str]]:
    if rule == ACCOUNT:
        # The last group of a UUID is twelve hex characters, sometimes all of them digits.
        line = _UUID.sub(lambda found: "x" * len(found.group(0)), line)
    for match in PATTERNS[rule].finditer(line):
        if rule == COGNITO_DOMAIN and match.group(0).lower().startswith(("auth.", "auth-fips.")):
            continue  # no domain prefix: `${prefix}.auth.<region>.amazoncognito.com` in a template
        if rule == EMAIL and not re.search(r"[A-Za-z0-9]", match.group("local")):
            continue  # `@gmail.com`, `…@outlook.es`: a domain, not somebody's address
        yield match


def scan_text(path: str, text: str, allowlist: Allowlist) -> list[Finding]:
    findings = []
    for number, line in enumerate(text.splitlines(), start=1):
        for rule in RULES:
            for match in _matches(rule, line):
                if not allowlist.allows(rule, match.group(0), match):
                    findings.append(Finding(path, number, rule, match.group(0)))
    return findings


def scan_files(root: Path, paths: Iterable[str], allowlist: Allowlist) -> list[Finding]:
    findings = []
    for path in paths:
        try:
            data = (root / path).read_bytes()
        except OSError:
            continue  # deleted in the working tree, or a broken link
        if b"\0" in data[:8192]:
            continue  # binary
        findings += scan_text(path, data.decode("utf-8", errors="replace"), allowlist)
    return findings


def versioned_files(root: Path) -> list[str]:
    """Tracked files, and new ones that are not ignored: what the next commit may carry."""
    listed = subprocess.run(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],  # noqa: S607
        cwd=root,
        check=True,
        capture_output=True,
    )
    return sorted({name for name in listed.stdout.decode("utf-8").split("\0") if name})


HELP = f"""
Each line above is `file:line: rule: value`, with the value masked.

- If the value is real (an account, an organization, a user pool, a host or the address of a
  person of any installation): replace it with a marker the repository already uses. If it
  is already in a commit, a new commit on top is not enough: rewrite the commit that added it.
- If it is an invented marker: add it to deployment/{ALLOWLIST.name}, under the table of its
  rule, with a comment that says what it is. First check that it is not a real value of any
  installation (the real ones live in a local folder outside the repository).
"""


def main(arguments: list[str]) -> int:
    try:
        allowlist = load_allowlist()
    except AllowlistError as error:
        print(f"check-real-data: {error}", file=sys.stderr)
        return 2
    paths = arguments or versioned_files(REPO)
    findings = scan_files(Path.cwd() if arguments else REPO, paths, allowlist)
    if not findings:
        print(f"check-real-data: {len(paths)} files, nothing shaped like real data")
        return 0
    for finding in findings:
        print(finding)
    print(f"\ncheck-real-data: {len(findings)} findings in {len({f.path for f in findings})} files")
    print(HELP)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
