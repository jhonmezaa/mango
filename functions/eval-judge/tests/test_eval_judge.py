"""The evaluator of the evals (D110): the canary that fails closed and the judge of one case."""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError, EventStreamError
from moto import mock_aws

from mango_core.evals_harness import Capture, EvalsHarness
from mango_core.playground import PlaygroundHarness
from mango_eval_judge import handler
from mango_eval_judge.canary import Canary
from mango_eval_judge.config import ConfigError, Settings

NS = "test"
ACCOUNT = "123456789012"
REGION = "us-east-1"
JUDGE = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
SONNET = "us.anthropic.claude-sonnet-4-6"
RUNTIME = "harness_Mango_test_a_evals-AbCdEfGhIj"
OWN = f"/aws/bedrock-agentcore/runtimes/{RUNTIME}-live"
HARNESS_ARN = f"arn:aws:bedrock-agentcore:{REGION}:{ACCOUNT}:harness/Mango_test_a_evals-AbCdEfGhIj"
ENV = {
    "MANGO_NAMESPACE": NS,
    "AWS_REGION": REGION,
    "MANGO_ACCOUNT_ID": ACCOUNT,
    "SETTINGS_TABLE": "settings",
    "BUDGETS_TABLE": "budgets",
    "EVALUATORS": json.dumps({JUDGE: "Mango_test_judge_0-AbCdEfGhIj"}),
    "CANARY_MODEL": JUDGE,
    "MODEL_PRICES": json.dumps({JUDGE: {"input": 1.0, "output": 5.0}}),
    "EVALUATION_FEE_USD": "0.0015",
    "CANARY_MONTHLY_USD": "1",
    "GUARDRAIL_ID": "gr123456",
    "GUARDRAIL_VERSION": "1",
}


def _entry(model: str, input_usd: str, output_usd: str, *, enabled: bool = True) -> dict[str, Any]:
    """A model of the catalog as mango-api writes it (``ModelEntry``, prices per million)."""
    return {
        "id": model,
        "name": model,
        "provider": "Anthropic",
        "enabled": enabled,
        "supports_tools": True,
        "input_usd": input_usd,
        "output_usd": output_usd,
        "cache_read_usd": "0",
        "cache_write_usd": "0",
    }


def _catalog(db: Any, *models: dict[str, Any]) -> None:
    db.put_item(
        TableName="settings",
        Item={
            "PK": {"S": "MODELS"},
            "SK": {"S": "CATALOG"},
            "models": {"S": json.dumps(list(models))},
            "version": {"N": "1"},
        },
    )


@dataclass
class FakeLogs:
    groups: dict[str, list[str]] = field(default_factory=dict)
    calls: list[dict[str, Any]] = field(default_factory=list)

    def filter_log_events(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        group = kwargs["logGroupName"]
        if group not in self.groups:
            raise ClientError({"Error": {"Code": "ResourceNotFoundException"}}, "FilterLogEvents")
        pattern = kwargs["filterPattern"]
        needle = pattern.split('"')[1] if pattern.startswith("{") else pattern.strip('"')
        return {"events": [{"message": m} for m in self.groups[group] if needle in m]}


@dataclass
class FakeAgentCore:
    logs: FakeLogs
    content_to_shared: bool = False
    capture: bool = True
    label: str = "PASS"
    invocations: list[dict[str, Any]] = field(default_factory=list)
    evaluations: list[dict[str, Any]] = field(default_factory=list)
    fail: Exception | None = None

    def invoke_harness(self, **request: Any) -> dict[str, Any]:
        self.invocations.append(request)
        if self.fail is not None:
            raise self.fail
        session = request["runtimeSessionId"]
        text = request["messages"][0]["content"][0]["text"]
        span = json.dumps(
            {
                "traceId": "t1",
                "spanId": "s1",
                "startTimeUnixNano": 1,
                "attributes": {"session.id": session, "gen_ai.input.messages": text},
            }
        )
        if self.capture:
            self.logs.groups.setdefault(OWN, []).append(span)
        if self.content_to_shared:
            self.logs.groups.setdefault("aws/spans", []).append(span)
        return {"stream": [{"metadata": {"usage": {"inputTokens": 40, "outputTokens": 20}}}]}

    def evaluate(self, **request: Any) -> dict[str, Any]:
        self.evaluations.append(request)
        return {
            "evaluationResults": [
                {
                    "label": self.label,
                    "value": 1.0,
                    "explanation": "the agent said the expected thing: " + "x" * 50,
                    "tokenUsage": {"inputTokens": 900, "outputTokens": 100},
                }
            ]
        }


def _table(db: Any, name: str) -> None:
    db.create_table(
        TableName=name,
        KeySchema=[
            {"AttributeName": "PK", "KeyType": "HASH"},
            {"AttributeName": "SK", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": "PK", "AttributeType": "S"},
            {"AttributeName": "SK", "AttributeType": "S"},
        ],
        BillingMode="PAY_PER_REQUEST",
    )


@dataclass
class Env:
    db: Any
    logs: FakeLogs
    agentcore: FakeAgentCore
    settings: Settings
    slept: list[float]

    def canary(self) -> Canary:
        return Canary(
            self.settings,
            dynamodb=self.db,
            logs=self.logs,  # type: ignore[arg-type]
            agentcore=self.agentcore,  # type: ignore[arg-type]
            sleep=self.slept.append,
        )

    def capture(self) -> Capture:
        item = self.db.get_item(
            TableName="settings", Key={"PK": {"S": "EVALS"}, "SK": {"S": "CAPTURE"}}
        )["Item"]
        return Capture.from_item(item)

    def harness(self, *models: str) -> None:
        deployed = PlaygroundHarness(HARNESS_ARN, "3", models, "2026-11-05T12:00:00+00:00")
        self.db.put_item(TableName="settings", Item=EvalsHarness(deployed, RUNTIME).item())

    def spent(self) -> Decimal:
        period = time.strftime("%Y-%m", time.gmtime())
        item = self.db.get_item(
            TableName="budgets", Key={"PK": {"S": "AGENT#evals"}, "SK": {"S": period}}
        ).get("Item", {})
        return Decimal(item.get("spent", {}).get("N", "0"))


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    with mock_aws():
        db = boto3.client("dynamodb", region_name=REGION)
        _table(db, "settings")
        _table(db, "budgets")
        deployed = PlaygroundHarness(HARNESS_ARN, "3", (JUDGE,), "2026-11-05T12:00:00+00:00")
        db.put_item(TableName="settings", Item=EvalsHarness(deployed, RUNTIME).item())
        db.put_item(
            TableName="settings",
            Item=Capture("pending", "3", "2026-11-05T12:00:00+00:00").item(),
        )
        _catalog(db, _entry(JUDGE, "1", "5"), _entry(SONNET, "3", "15"))
        logs = FakeLogs({OWN: [], "aws/spans": []})
        yield Env(db, logs, FakeAgentCore(logs), Settings.from_env(ENV), [])


# --- The canary ---------------------------------------------------------------------------


def test_the_canary_verifies_content_only_in_its_own_log_group(env: Env) -> None:
    capture = env.canary().run("3")

    assert capture.status == "verified"
    assert env.capture().verified_for("3")
    (call,) = env.agentcore.invocations
    assert call["tools"] == [] and call["allowedTools"] == []
    assert call["maxTokens"] == 64
    assert call["harnessArn"] == HARNESS_ARN
    # Paid, from its own scope (rule 4), and closed: no pending turn is left.
    assert env.spent() > 0
    left = env.db.scan(TableName="budgets")["Items"]
    assert not [i for i in left if i["PK"]["S"].startswith("TURN#")]
    # The smoke Evaluate asked about the canary's own session.
    (evaluation,) = env.agentcore.evaluations
    assert evaluation["evaluatorId"] == "Mango_test_judge_0-AbCdEfGhIj"


def test_content_in_aws_spans_fails_closed(env: Env, caplog: pytest.LogCaptureFixture) -> None:
    env.agentcore.content_to_shared = True
    with caplog.at_level(logging.INFO):
        capture = env.canary().run("3")

    assert capture.status == "failed"
    assert env.capture().reason == "content_in_shared_log"
    assert not env.capture().verified_for("3")
    assert "evals canary failed: content_in_shared_log" in caplog.text
    # No case content was ever involved, and the marker is not logged either.
    marker = env.agentcore.invocations[0]["messages"][0]["content"][0]["text"].split()[-1]
    assert marker not in caplog.text


def test_no_content_in_its_own_log_group_fails_closed(env: Env) -> None:
    env.agentcore.capture = False
    capture = env.canary().run("3")

    assert capture.status == "failed"
    assert capture.reason == "no_content"
    assert sum(env.slept) >= 9 * 60


def test_a_denied_turn_logs_its_code_and_action_never_the_message(
    env: Env, caplog: pytest.LogCaptureFixture
) -> None:
    message = (
        "User: arn:aws:sts::111122223333:assumed-role/Mango-test-EvalJudge/x is not authorized"
        " to perform: bedrock-agentcore:InvokeAgentRuntime on resource: arn:aws:bedrock-agentcore"
    )
    env.agentcore.fail = ClientError(
        {"Error": {"Code": "AccessDeniedException", "Message": message}}, "InvokeHarness"
    )
    with caplog.at_level(logging.INFO):
        capture = env.canary().run("3")

    assert capture.reason == "turn_failed"
    assert (
        "evals canary turn failed: ClientError code=AccessDeniedException"
        " operation=InvokeHarness action=bedrock-agentcore:InvokeAgentRuntime"
    ) in caplog.text
    assert "111122223333" not in caplog.text
    assert "not authorized" not in caplog.text
    # The reserved turn is closed even when it failed.
    left = env.db.scan(TableName="budgets")["Items"]
    assert not [i for i in left if i["PK"]["S"].startswith("TURN#")]


def test_a_stream_error_logs_its_code_never_the_message(
    env: Env, caplog: pytest.LogCaptureFixture
) -> None:
    env.agentcore.fail = EventStreamError(
        {"Error": {"Code": "runtimeClientError", "Message": "the model said: secreto"}},
        "InvokeHarness",
    )
    with caplog.at_level(logging.INFO):
        capture = env.canary().run("3")

    assert capture.reason == "turn_failed"
    assert (
        "evals canary turn failed: EventStreamError code=runtimeClientError operation=InvokeHarness"
    ) in caplog.text
    assert "secreto" not in caplog.text


def test_an_odd_error_code_is_not_logged_as_is(env: Env, caplog: pytest.LogCaptureFixture) -> None:
    env.agentcore.fail = ClientError(
        {"Error": {"Code": "no such code\nforged line"}}, "InvokeHarness"
    )
    with caplog.at_level(logging.INFO):
        env.canary().run("3")

    assert "code=other operation=InvokeHarness" in caplog.text
    assert "forged line" not in caplog.text


def test_without_budget_nothing_is_invoked(env: Env) -> None:
    env.settings = Settings.from_env({**ENV, "CANARY_MONTHLY_USD": "0"})
    capture = env.canary().run("3")

    assert capture.reason == "budget_exceeded"
    assert env.agentcore.invocations == []


def test_a_newer_harness_is_left_to_its_own_canary(env: Env) -> None:
    capture = env.canary().run("2")

    assert capture.status == "pending"
    assert env.capture().harness_version == "3"
    assert env.capture().status == "pending"
    assert env.agentcore.invocations == []


def test_the_auxiliary_model_is_used_when_the_harness_has_it(env: Env) -> None:
    # Even when a cheaper model is enabled too: the release's auxiliary is preferred.
    cheap = "us.anthropic.claude-cheap-v1:0"
    env.harness(SONNET, JUDGE, cheap)
    _catalog(
        env.db, _entry(JUDGE, "1", "5"), _entry(SONNET, "3", "15"), _entry(cheap, "0.1", "0.5")
    )

    assert env.canary().run("3").status == "verified"
    (call,) = env.agentcore.invocations
    assert call["model"]["bedrockModelConfig"]["modelId"] == JUDGE


def test_only_sonnet_enabled_the_canary_uses_sonnet(env: Env) -> None:
    # The installation of 2026-11-06: the organization enabled only Sonnet, not the auxiliary.
    env.harness(SONNET)
    _catalog(env.db, _entry(JUDGE, "1", "5", enabled=False), _entry(SONNET, "3", "15"))

    capture = env.canary().run("3")

    assert capture.status == "verified"
    assert env.capture().verified_for("3")
    (call,) = env.agentcore.invocations
    assert call["model"]["bedrockModelConfig"]["modelId"] == SONNET
    # Reserved and settled at Sonnet's catalog price (per million): 40 in, 20 out.
    turns = [
        i
        for i in env.db.scan(TableName="budgets")["Items"]
        if i["PK"]["S"].startswith("DAY#MODEL#") and SONNET in i["PK"]["S"]
    ]
    assert turns
    sonnet_cost = (Decimal(40) * 3 + Decimal(20) * 15) / 1_000_000
    assert env.spent() >= sonnet_cost
    assert env.spent() < Decimal(1)


def test_without_the_auxiliary_the_cheapest_model_wins_ties_by_id(env: Env) -> None:
    a, b = "us.anthropic.model-a-v1:0", "us.anthropic.model-b-v1:0"
    env.harness(SONNET, b, a)
    _catalog(env.db, _entry(SONNET, "3", "15"), _entry(b, "0.8", "4"), _entry(a, "0.8", "4"))

    assert env.canary().run("3").status == "verified"
    assert env.agentcore.invocations[0]["model"]["bedrockModelConfig"]["modelId"] == a


def test_a_model_disabled_since_the_harness_was_published_is_not_used(env: Env) -> None:
    env.harness(JUDGE, SONNET)
    _catalog(env.db, _entry(JUDGE, "1", "5", enabled=False), _entry(SONNET, "3", "15"))

    assert env.canary().run("3").status == "verified"
    assert env.agentcore.invocations[0]["model"]["bedrockModelConfig"]["modelId"] == SONNET


@pytest.mark.parametrize(
    "models",
    [
        # Priced, but not a model of the harness.
        (_entry(SONNET, "3", "15"),),
        # A model of the harness, without a price.
        (_entry(JUDGE, "0", "0"),),
        # A model of the harness, disabled.
        (_entry(JUDGE, "1", "5", enabled=False),),
        (),
    ],
)
def test_no_model_with_a_known_price_fails_closed(
    env: Env, caplog: pytest.LogCaptureFixture, models: tuple[dict[str, Any], ...]
) -> None:
    _catalog(env.db, *models)
    with caplog.at_level(logging.INFO):
        capture = env.canary().run("3")

    assert capture.status == "failed"
    assert env.capture().reason == "canary_model_unpriced"
    assert "evals canary failed: canary_model_unpriced" in caplog.text
    assert env.agentcore.invocations == []


@pytest.mark.parametrize("models", [None, "not json", '{"id": "x"}', '[{"id": "x"}]'])
def test_a_missing_or_malformed_catalog_fails_closed(env: Env, models: str | None) -> None:
    key = {"PK": {"S": "MODELS"}, "SK": {"S": "CATALOG"}}
    if models is None:
        env.db.delete_item(TableName="settings", Key=key)
    else:
        env.db.put_item(TableName="settings", Item={**key, "models": {"S": models}})

    assert env.canary().run("3").reason == "model_catalog_unavailable"
    assert env.agentcore.invocations == []


# --- The judge ----------------------------------------------------------------------------


def _session_spans(env: Env, session: str) -> None:
    env.logs.groups[OWN].append(
        json.dumps({"traceId": "t9", "startTimeUnixNano": 5, "attributes": {"session.id": session}})
    )


def _judge_event(session: str, expected: str = "Un resumen por servicio") -> dict[str, Any]:
    return {
        "action": "judge",
        "session_id": session,
        "expected": expected,
        "judge_model": JUDGE,
        "started_at": int(time.time()) - 30,
    }


def _clients(env: Env) -> tuple[Any, Any, Any]:
    return (env.db, env.logs, env.agentcore)


def test_the_judge_answers_the_verdict_never_the_explanation(
    env: Env, caplog: pytest.LogCaptureFixture
) -> None:
    session = "s" * 64
    _session_spans(env, session)
    with caplog.at_level(logging.DEBUG):
        out = handler.handle(_judge_event(session), env.settings, _clients(env))

    assert out == {
        "status": "scored",
        "passed": True,
        "label": "PASS",
        "input_tokens": 900,
        "output_tokens": 100,
        "evaluations": 1,
    }
    (request,) = env.agentcore.evaluations
    assert request["evaluationTarget"] == {"traceIds": ["t9"]}
    reference = request["evaluationReferenceInputs"][0]
    assert reference["expectedResponse"] == {"text": "Un resumen por servicio"}
    assert "Un resumen" not in caplog.text
    assert "explanation" not in json.dumps(out)
    # It reads the evals runtime's own log groups, nothing else.
    assert {c["logGroupName"] for c in env.logs.calls} <= {OWN, OWN.replace("-live", "-DEFAULT")}


@pytest.mark.parametrize("label", ["FAIL", "Very Good", "PASS!", ""])
def test_anything_but_the_exact_pass_label_fails(env: Env, label: str) -> None:
    session = "s" * 64
    _session_spans(env, session)
    env.agentcore.label = label
    out = handler.handle(_judge_event(session), env.settings, _clients(env))
    assert out["passed"] is False


def test_a_session_without_telemetry_is_not_scored(env: Env) -> None:
    out = handler.handle(_judge_event("n" * 64), env.settings, _clients(env))
    assert out["status"] == "no_trace"
    assert env.agentcore.evaluations == []


@pytest.mark.parametrize(
    "change",
    [
        {"judge_model": "us.anthropic.claude-sonnet-4-6"},
        {"session_id": "../../etc"},
        {"expected": ""},
        {"started_at": 1},
        {"started_at": True},
        {"extra": "x"},
    ],
)
def test_invalid_judge_events_are_refused(env: Env, change: dict[str, Any]) -> None:
    with pytest.raises(handler.InvalidEventError):
        handler.handle({**_judge_event("s" * 64), **change}, env.settings, _clients(env))
    assert env.agentcore.evaluations == []


def test_unknown_actions_are_refused(env: Env) -> None:
    for event in ({"action": "evaluate"}, {"action": "canary", "harness_version": "x"}, []):
        with pytest.raises(handler.InvalidEventError):
            handler.handle(event, env.settings, _clients(env))


def test_every_judge_needs_a_price() -> None:
    with pytest.raises(ConfigError):
        Settings.from_env(
            {**ENV, "MODEL_PRICES": json.dumps({"other.model": {"input": 1, "output": 1}})}
        )


def test_the_canary_model_needs_no_release_price() -> None:
    # It is priced from the model catalog, like every turn mango-api reserves.
    settings = Settings.from_env({**ENV, "CANARY_MODEL": SONNET})
    assert SONNET not in settings.prices
