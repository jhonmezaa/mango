"""`deployment/check-bedrock-quotas.py`: what the Bedrock quotas of an account are enough for.

The quota that matters is the one applied to the account, which can be far under the AWS
default; and under the default it cannot be raised from Service Quotas. The tests hold both,
and that a model is matched to its quota by name or not at all.
"""

import importlib.util
import json
import sys
from collections.abc import Sequence
from pathlib import Path
from types import ModuleType

import pytest

REPO = Path(__file__).parents[2]
SONNET = "us.anthropic.claude-sonnet-4-6"
HAIKU = "us.anthropic.claude-haiku-4-5-20251001-v1:0"


def _load() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "mango_bedrock_quotas", REPO / "deployment" / "check-bedrock-quotas.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # Dataclasses look their module up by name while the class is being built.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


quotas = _load()


def _quota(code: str, name: str, value: float) -> dict[str, object]:
    return {"QuotaCode": code, "QuotaName": name, "Value": value, "Adjustable": True}


class FakeAws:
    """`aws` as the script calls it: Bedrock's model list, Service Quotas and one table."""

    def __init__(self, applied: dict[str, float], catalog: list[dict[str, object]] | None = None):
        self.calls: list[list[str]] = []
        self.catalog = catalog
        self.defaults = {"L-REQ46": 10000.0, "L-TOK46": 6000000.0, "L-REQ45": 10000.0}
        self.quotas = [
            _quota(
                "L-REQ46",
                "Cross-region model inference requests per minute for Anthropic Claude Sonnet 4.6",
                applied.get("L-REQ46", 10000),
            ),
            _quota(
                "L-TOK46",
                "Cross-region model inference tokens per minute for Anthropic Claude Sonnet 4.6",
                applied.get("L-TOK46", 6000000),
            ),
            _quota(
                "L-GLOBAL",
                "Global cross-region model inference requests per minute"
                " for Anthropic Claude Sonnet 4.6",
                7,
            ),
            _quota(
                "L-REQ45",
                "Cross-region model inference requests per minute for Anthropic Claude Haiku 4.5",
                applied.get("L-REQ45", 10000),
            ),
            _quota("L-BATCH", "Records per batch inference job for Claude Sonnet 4.6", 100000),
            # Two quotas that would both fit a model called "Twin": never guessed between.
            _quota("L-TWIN1", "On-demand model inference requests per minute for Acme Twin", 1),
            _quota("L-TWIN2", "On-demand model inference requests per minute for Acme Twin V2", 2),
        ]

    def __call__(self, arguments: Sequence[str]) -> str:
        self.calls.append(list(arguments))
        service, operation = arguments[0], arguments[1]
        if (service, operation) == ("bedrock", "list-foundation-models"):
            return json.dumps(
                {
                    "modelSummaries": [
                        {
                            "modelId": "anthropic.claude-sonnet-4-6",
                            "modelName": "Claude Sonnet 4.6",
                            "providerName": "Anthropic",
                        },
                        {
                            "modelId": "anthropic.claude-haiku-4-5-20251001-v1:0",
                            "modelName": "Claude Haiku 4.5",
                            "providerName": "Anthropic",
                        },
                        {"modelId": "acme.twin", "modelName": "Twin", "providerName": "Acme"},
                    ]
                }
            )
        if (service, operation) == ("service-quotas", "list-service-quotas"):
            return json.dumps({"Quotas": self.quotas})
        if (service, operation) == ("service-quotas", "get-aws-default-service-quota"):
            code = arguments[arguments.index("--quota-code") + 1]
            if code not in self.defaults:
                raise quotas.QuotaError("NoSuchResourceException")
            return json.dumps({"Quota": {"Value": self.defaults[code]}})
        if (service, operation) == ("dynamodb", "get-item"):
            assert arguments[arguments.index("--table-name") + 1] == "Mango-acme-Settings"
            if self.catalog is None:
                return "{}"
            return json.dumps({"Item": {"models": {"S": json.dumps(self.catalog)}}})
        raise AssertionError(arguments)


def test_reads_the_models_of_the_release_when_nothing_is_installed(
    capsys: pytest.CaptureFixture[str],
) -> None:
    aws = FakeAws({})
    assert quotas.models_of_release() == [SONNET, HAIKU]
    assert quotas.main([], run=aws) == 0
    out = capsys.readouterr().out
    assert "10,000 applied, AWS default 10,000 (L-REQ46)" in out
    assert "OK: every quota is at least the AWS default." in out
    # Nothing but reads, and nothing of an installation.
    assert {(call[0], call[1]) for call in aws.calls} == {
        ("bedrock", "list-foundation-models"),
        ("service-quotas", "list-service-quotas"),
        ("service-quotas", "get-aws-default-service-quota"),
    }


def test_a_quota_under_the_default_fails_and_says_it_takes_a_support_case(
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert quotas.main(["--model", SONNET], run=FakeAws({"L-REQ46": 10})) == 1
    out = capsys.readouterr().out
    assert "requests per minute: 10 applied, AWS default 10,000 (L-REQ46)" in out
    assert "about 10 chat turns a minute" in out
    assert "about 5 with one round of tools per turn" in out
    assert "BELOW THE AWS DEFAULT (L-REQ46)" in out
    assert "Support Center console" in out
    assert "ACTION NEEDED" in out


def test_a_quota_at_the_default_but_short_of_what_the_tasks_serve_is_only_a_warning(
    capsys: pytest.CaptureFixture[str],
) -> None:
    aws = FakeAws({"L-REQ46": 200})
    aws.defaults["L-REQ46"] = 200.0
    assert quotas.main(["--model", SONNET], run=aws) == 0
    out = capsys.readouterr().out
    assert f"LOW: two mango-api tasks serve about {quotas.ACTIVE_PEOPLE} active people" in out
    assert "Request increase at account level" in out
    assert "BELOW THE AWS DEFAULT" not in out


def test_tokens_cap_the_turns_when_they_are_the_scarce_quota() -> None:
    (report,) = quotas.check(FakeAws({"L-TOK46": 33000}), [SONNET], "us-east-1")
    assert report.turns_per_minute == 33000 // quotas.TOKENS_PER_TURN
    assert [limit.code for limit in report.below_default] == ["L-TOK46"]


def test_the_quota_follows_the_kind_of_id() -> None:
    assert quotas.kind_and_base(SONNET) == ("Cross-region", "anthropic.claude-sonnet-4-6")
    assert quotas.kind_and_base("global.anthropic.claude-sonnet-4-6") == (
        "Global cross-region",
        "anthropic.claude-sonnet-4-6",
    )
    assert quotas.kind_and_base("amazon.nova-lite-v1:0") == ("On-demand", "amazon.nova-lite-v1:0")
    (report,) = quotas.check(FakeAws({}), ["global.anthropic.claude-sonnet-4-6"], "us-east-1")
    assert report.requests is not None and report.requests.code == "L-GLOBAL"
    # Its default could not be read: reported as unknown, not as fine or as low.
    assert report.requests.default is None and report.below_default == []


def test_a_model_without_exactly_one_quota_by_its_name_is_not_guessed(
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert quotas.main(["--model", "acme.twin", "--model", "acme.unknown"], run=FakeAws({})) == 1
    out = capsys.readouterr().out
    assert out.count("NOT READ") == 2
    assert "Bedrock does not list this model here" in out
    assert "L-TWIN" not in out


def test_after_installing_it_reads_the_enabled_models_of_the_installation(
    capsys: pytest.CaptureFixture[str],
) -> None:
    catalog: list[dict[str, object]] = [
        {"id": SONNET, "enabled": True},
        {"id": HAIKU, "enabled": False},
    ]
    aws = FakeAws({}, catalog)
    assert quotas.main(["--namespace", "acme"], run=aws) == 0
    out = capsys.readouterr().out
    assert SONNET in out and HAIKU not in out
    get_item = next(call for call in aws.calls if call[:2] == ["dynamodb", "get-item"])
    assert "--projection-expression" in get_item


def test_an_installation_without_catalog_is_an_error_not_an_empty_pass(
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert quotas.main(["--namespace", "acme"], run=FakeAws({}, None)) == 1
    assert "NOT CHECKED: no model catalog in Mango-acme-Settings" in capsys.readouterr().err


def test_a_catalog_id_that_is_not_shaped_like_one_is_not_printed(
    capsys: pytest.CaptureFixture[str],
) -> None:
    catalog: list[dict[str, object]] = [{"id": "x\x1b[2J", "enabled": True}]
    assert quotas.main(["--namespace", "acme"], run=FakeAws({}, catalog)) == 1
    captured = capsys.readouterr()
    assert "\x1b" not in captured.out + captured.err


@pytest.mark.parametrize(
    "arguments",
    [
        ["--namespace", "Acme; rm"],
        ["--model", "--profile"],
        ["--model", "a b"],
        ["--region", "us-east-1 --profile other"],
    ],
)
def test_arguments_that_are_not_what_they_claim_never_reach_aws(arguments: list[str]) -> None:
    aws = FakeAws({})
    with pytest.raises(SystemExit):
        quotas.main(arguments, run=aws)
    assert aws.calls == []
