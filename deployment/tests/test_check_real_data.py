"""`deployment/check-real-data.py`: what it takes for real data, and what it lets through.

This file is scanned too, so every value with the shape of real data is put together from
pieces: none of them is written whole.
"""

import importlib.util
import subprocess
import sys
from pathlib import Path
from types import ModuleType

import pytest

DEPLOYMENT = Path(__file__).parents[1]
REPO = DEPLOYMENT.parent


def _load() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "check_real_data", DEPLOYMENT / "check-real-data.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


check = _load()

ACCOUNT = "4829" + "1057" + "3366"
ORGANIZATION = "o-" + "k3j9" + "x2m7qp"
OU = "ou-" + "k3j9" + "-" + "7hq2m4zt"
USER_POOL = "us-east-1" + "_" + "Qw3rTy9Zx"
CLOUDFRONT = "d1k3j9x2m7qp4z" + ".cloudfront" + ".net"
COGNITO = "mango-acme-prod" + ".auth.us-east-1.amazon" + "cognito.com"
MAILBOX = "maria.lopez"
AT = "@"


def _allowlist(**values: list[str]) -> object:
    rules = {rule: frozenset(values.get(rule.replace("-", "_"), [])) for rule in check.RULES}
    return check.Allowlist(values=rules, ou_roots=frozenset({"abcd"}))


def _rules(line: str) -> list[str]:
    return [finding.rule for finding in check.scan_text("file.md", line, _allowlist())]


@pytest.mark.parametrize(
    ("line", "rule"),
    [
        (f"account {ACCOUNT} of the lab", "aws-account-id"),
        (f"arn:aws:iam::{ACCOUNT}:role/Mango-acme-broker", "aws-account-id"),
        (f"s3://mango-acme-{ACCOUNT}-us-east-1-templates/v1", "aws-account-id"),
        (f'MANGO_PROVIDER_ACCOUNT="{ACCOUNT}"', "aws-account-id"),
        (f"ACCOUNT_ID={ACCOUNT}", "aws-account-id"),
        (f"{ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/mango-api", "aws-account-id"),
        (f'"aws:PrincipalOrgID": "{ORGANIZATION}"', "aws-organization-id"),
        (f"targets: [{OU}]", "aws-ou-id"),
        (f"https://cognito-idp.us-east-1.amazonaws.com/{USER_POOL}", "cognito-user-pool-id"),
        (f"open https://{CLOUDFRONT}/chat", "cloudfront-host"),
        (f"https://{CLOUDFRONT.upper()}/chat", "cloudfront-host"),
        (f"https://{COGNITO}/oauth2/authorize", "cognito-domain"),
        (f"written by {MAILBOX}{AT}gmail.com", "public-email"),
        (f"{MAILBOX}{AT}GMail.com", "public-email"),
        (f"{MAILBOX}{AT}outlook.es", "public-email"),
        (f"{MAILBOX}{AT}hotmail.com.mx", "public-email"),
        (f"{MAILBOX}{AT}yahoo.co.uk", "public-email"),
        (f"{MAILBOX}{AT}icloud.com", "public-email"),
        (f"{MAILBOX}{AT}proton.me", "public-email"),
        # Cut the way the interface cuts a long address: a grep of whole addresses misses it.
        (f"«mari…{AT}gmail.com»", "public-email"),
        (f"…opez{AT}gmail.com", "public-email"),
    ],
)
def test_it_sees_what_has_the_shape_of_real_data(line: str, rule: str) -> None:
    assert _rules(line) == [rule]


@pytest.mark.parametrize(
    "line",
    [
        # Twelve digits inside something longer are not an account id.
        f"asset.3fa9{ACCOUNT}b7c2d1e0.zip",
        f"sha256:9f{ACCOUNT}0a",
        f"1{ACCOUNT}",
        f"{ACCOUNT}7",
        f"ratio 0.{ACCOUNT}",
        f"{ACCOUNT}.5 tokens",
        f"3f0c9b1e-0000-4000-8000-{ACCOUNT}",
        f"01J{ACCOUNT}0000000000",
        # Hosts and domains that name no installation.
        "the default certificate is *.cloudfront.net",
        "`${domain}.auth.${region}.amazoncognito.com`",
        "<prefix>.auth.us-east-1.amazoncognito.com",
        "https://auth.us-east-1.amazoncognito.com",
        # Mail that is not somebody's address at a public provider.
        f"public domains ({AT}gmail.com, {AT}outlook.es) are refused",
        f"shown as …{AT}outlook.es",
        f"nombre{AT}empresa.com",
        f"{MAILBOX}{AT}gmail.com.evil.io",
        f"{MAILBOX}{AT}outlook.empresa.com",
        # Shapes that are too short to be real.
        "o-ejemplo",
        "us-east-1_Test",
        "ou-root-sandbox",
        "auto-scalinggroup1 and demo-abcdefghij12",
        # An OU under an invented root.
        "ou-abcd-11111111",
    ],
)
def test_it_lets_through_what_only_looks_like_it(line: str) -> None:
    assert _rules(line) == []


def test_an_allowed_marker_passes_and_any_other_value_of_the_rule_does_not() -> None:
    allowlist = _allowlist(aws_account_id=[ACCOUNT], public_email=[f"{MAILBOX}{AT}gmail.com"])
    other = ACCOUNT[::-1]
    text = f"{ACCOUNT}\n{other}\n{MAILBOX.title()}{AT}Gmail.com\nother.{MAILBOX}{AT}gmail.com\n"
    findings = check.scan_text("docs/install.md", text, allowlist)
    assert [(f.line, f.rule) for f in findings] == [(2, "aws-account-id"), (4, "public-email")]


def test_a_finding_says_file_line_and_rule_and_masks_the_value() -> None:
    (finding,) = check.scan_text("docs/install.md", f"one\ntwo {ACCOUNT}\n", _allowlist())
    assert str(finding).startswith("docs/install.md:2: aws-account-id: ")
    assert ACCOUNT not in str(finding)
    assert ACCOUNT[:2] in str(finding)


def test_every_finding_of_a_line_is_reported() -> None:
    line = f"arn:aws:iam::{ACCOUNT}:role/x in {ORGANIZATION}, {OU}"
    assert _rules(line) == ["aws-account-id", "aws-organization-id", "aws-ou-id"]


def test_binary_and_missing_files_are_skipped(tmp_path: Path) -> None:
    (tmp_path / "image.png").write_bytes(b"\x89PNG\0" + ACCOUNT.encode())
    (tmp_path / "notes.md").write_text(f"account {ACCOUNT}\n")
    findings = check.scan_files(tmp_path, ["image.png", "gone.md", "notes.md"], _allowlist())
    assert [f.path for f in findings] == ["notes.md"]


def test_the_command_explains_how_to_allow_a_marker(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    dirty = tmp_path / "dirty.md"
    dirty.write_text(f"account {ACCOUNT}\n")
    assert check.main([str(dirty)]) == 1
    output = capsys.readouterr().out
    assert "dirty.md:1: aws-account-id" in output
    assert check.ALLOWLIST.name in output
    assert "rewrite the commit" in output
    assert ACCOUNT not in output


def test_the_command_passes_a_clean_file(tmp_path: Path) -> None:
    clean = tmp_path / "clean.md"
    clean.write_text("account 111122223333 of nombre@empresa.com\n")
    assert check.main([str(clean)]) == 0


@pytest.mark.parametrize(
    ("content", "message"),
    [
        ('[aws-acount-id]\nallowed = ["111122223333"]\n', "unknown rules"),
        ('[aws-account-id]\nallowed = ["1111-2222-3333"]\n', "does not have the shape"),
        ('[aws-organization-id]\nallowed = ["o-ejemplo"]\n', "does not have the shape"),
        ('[aws-account-id]\nroots = ["abcd"]\n', "does not take"),
        ('[aws-ou-id]\nroots = ["ab"]\n', "does not have the shape"),
        ("[aws-account-id\n", "allowlist.toml"),
    ],
)
def test_a_broken_allowlist_is_an_error_not_an_empty_list(
    tmp_path: Path, content: str, message: str
) -> None:
    path = tmp_path / "allowlist.toml"
    path.write_text(content)
    with pytest.raises(check.AllowlistError, match=message):
        check.load_allowlist(path)


def test_the_repository_holds_nothing_shaped_like_real_data() -> None:
    findings = check.scan_files(REPO, check.versioned_files(REPO), check.load_allowlist())
    assert [str(finding) for finding in findings] == []


def test_the_allowlist_holds_no_marker_the_repository_stopped_using() -> None:
    # The list stays short: a marker nobody uses any more only widens what may slip through.
    allowlist = check.load_allowlist()
    skipped = {"deployment/real-data-allowlist.toml"}
    text = "\n".join(
        (REPO / path).read_text(encoding="utf-8", errors="replace").lower()
        for path in check.versioned_files(REPO)
        if path not in skipped and (REPO / path).is_file()
    )
    markers = [value for values in allowlist.values.values() for value in values]
    unused = sorted(value for value in markers if value.lower() not in text)
    unused += sorted(root for root in allowlist.ou_roots if f"ou-{root}-" not in text)
    assert unused == []


def test_it_runs_as_a_command_from_any_directory(tmp_path: Path) -> None:
    done = subprocess.run(  # noqa: S603
        [sys.executable, str(DEPLOYMENT / "check-real-data.py")],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        check=False,
    )
    assert done.returncode == 0, done.stdout + done.stderr
    assert "nothing shaped like real data" in done.stdout
