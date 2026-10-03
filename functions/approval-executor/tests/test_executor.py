"""Approval executor (D27): it writes only with a verified caller and a verified approval."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

import pytest
from botocore.exceptions import ClientError
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils

from mango_approval_executor import budgets, handler
from mango_core import approval, approval_use
from mango_core.identity import IdentityError

NOW = 1_800_000_000
TOOL = "ops___create_budget"
ARGS: dict[str, Any] = {"name": "team-a", "amount_usd": 250}
APPROVAL_ID = "b" * 32
KEY = ec.generate_private_key(ec.SECP256R1())
PAYER = "222222222222"
TOKENS = {
    "central-token": {"sub": "u-central", "mango_role": "finops-central"},
    "other-central-token": {"sub": "u-central-2", "mango_role": "finops-central"},
    "bu-token": {"sub": "u-bu", "mango_role": "bu-lead", "mango_business_unit": "security"},
}
SETTINGS = handler.Settings(
    issuer="https://issuer",
    client_id="client",
    broker_role_arn="arn:aws:iam::111111111111:role/Mango-poc-OperateBroker",
    budgets_role_arn=f"arn:aws:iam::{PAYER}:role/Mango-poc-BudgetsOperator",
    approvals_table="approvals",
    approval_key_arn="arn:aws:kms:us-east-1:111111111111:key/abc",
    resource_prefix="Mango-poc-",
)


class _Verifier:
    def verify(self, token: str) -> dict[str, Any]:
        if token not in TOKENS:
            raise IdentityError("invalid access token")
        return TOKENS[token]


@dataclass
class _Budgets:
    created: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None

    def create_budget(self, **kwargs: Any) -> dict[str, Any]:
        if self.error:
            raise ClientError({"Error": {"Code": self.error, "Message": "secret detail"}}, "x")
        self.created.append(kwargs)
        return {}


@dataclass
class _Sessions:
    budgets: _Budgets
    calls: list[tuple[Any, Any, str]] = field(default_factory=list)

    def assume(self, chain: Any, caller: Any, policy: str) -> Any:
        self.calls.append((chain, caller, policy))
        return SimpleNamespace(client=lambda *_a, **_k: self.budgets)


@dataclass
class _Claims:
    used: list[str] = field(default_factory=list)
    refuse: bool = False

    def __call__(self, approved: approval.Approval, _now: int) -> None:
        if self.refuse or approved.approval_id in self.used:
            raise approval_use.ApprovalUsedError
        self.used.append(approved.approval_id)


@dataclass
class Env:
    runtime: handler.Runtime
    budgets: _Budgets
    sessions: _Sessions
    claims: _Claims


@pytest.fixture
def env() -> Env:
    public = KEY.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    fake_budgets = _Budgets()
    sessions, claims = _Sessions(fake_budgets), _Claims()
    runtime = handler.Runtime(
        SETTINGS,
        verifier=_Verifier(),  # type: ignore[arg-type]
        approvals=lambda: approval.ApprovalVerifier(public, clock=lambda: NOW),
        claim=claims,
        sessions=sessions,  # type: ignore[arg-type]
        clock=lambda: NOW,
    )
    return Env(runtime, fake_budgets, sessions, claims)


def _approval_token(
    arguments: dict[str, Any] = ARGS,
    *,
    subject: str = "u-central",
    tool: str = TOOL,
    key: ec.EllipticCurvePrivateKey = KEY,
    expires_at: int = NOW + 60,
) -> str:
    claims = approval.encode_claims(
        approval_id=APPROVAL_ID,
        subject=subject,
        tool=tool,
        args_hash=approval.call_hash(tool, arguments),
        agent_id="finops",
        expires_at=expires_at,
    )
    signature = key.sign(
        approval.signing_digest(claims), ec.ECDSA(utils.Prehashed(hashes.SHA256()))
    )
    return approval.assemble(claims, signature)


def _ctx(tool: str = TOOL) -> Any:
    return SimpleNamespace(client_context=SimpleNamespace(custom={handler.TOOL_NAME_KEY: tool}))


def _call(
    env: Env,
    arguments: dict[str, Any] | None = None,
    *,
    token: str | None = "central-token",
    approval_token: str | None = None,
    tool: str = TOOL,
) -> dict[str, Any]:
    event: dict[str, Any] = dict(ARGS if arguments is None else arguments)
    mango_ctx: dict[str, Any] = {}
    if token is not None:
        mango_ctx["token"] = token
    if approval_token is not None:
        mango_ctx["approval"] = approval_token
    event["_mango_ctx"] = mango_ctx
    return handler.handle(event, _ctx(tool), env.runtime)


def test_an_approved_call_creates_the_budget_as_the_person_who_asked(env: Env) -> None:
    result = _call(env, approval_token=_approval_token())
    assert result == {
        "status": "created",
        "budget_name": "Mango-poc-team-a",
        "amount_usd": "250.00",
        "period": "MONTHLY",
        "account_ids": [],
    }
    assert env.budgets.created == [
        {
            "AccountId": PAYER,
            "Budget": {
                "BudgetName": "Mango-poc-team-a",
                "BudgetType": "COST",
                "TimeUnit": "MONTHLY",
                "BudgetLimit": {"Amount": "250.00", "Unit": "USD"},
            },
        }
    ]
    assert env.claims.used == [APPROVAL_ID]
    ((chain, caller, policy),) = env.sessions.calls
    assert (chain.broker_role_arn, chain.target_role_arn) == (
        SETTINGS.broker_role_arn,
        SETTINGS.budgets_role_arn,
    )
    assert caller.source_identity == "u-central"
    assert caller.tags == {
        "mango_user": "u-central",
        "mango_agent": "finops",
        "mango_approval": APPROVAL_ID,
    }
    # The session can touch only the budget of this call (TM-W8).
    assert json.loads(policy)["Statement"] == [
        {
            "Effect": "Allow",
            "Action": ["budgets:ModifyBudget"],
            "Resource": [f"arn:aws:budgets::{PAYER}:budget/Mango-poc-team-a"],
        }
    ]


def test_account_filters_are_part_of_the_approved_call(env: Env) -> None:
    arguments = {**ARGS, "account_ids": ["333333333333", "111111111111"]}
    result = _call(env, arguments, approval_token=_approval_token(arguments))
    assert result["account_ids"] == ["111111111111", "333333333333"]
    assert env.budgets.created[0]["Budget"]["CostFilters"] == {
        "LinkedAccount": ["111111111111", "333333333333"]
    }


@pytest.mark.parametrize(
    ("kwargs", "code"),
    [
        ({"token": None, "approval_token": "x"}, "unauthenticated"),
        ({"token": "forged", "approval_token": "x"}, "unauthenticated"),
        ({"token": "bu-token", "approval_token": "x"}, "not_allowed"),  # not central FinOps
        ({"approval_token": None}, "approval_required"),  # the Lambda invoked without one
        ({"approval_token": "v1.forged.forged"}, "approval_required"),
    ],
)
def test_nothing_is_written_without_a_caller_and_an_approval(
    env: Env, kwargs: dict[str, Any], code: str
) -> None:
    assert _call(env, **kwargs)["error"]["code"] == code
    assert env.budgets.created == [] and env.sessions.calls == [] and env.claims.used == []


@pytest.mark.parametrize(
    ("arguments", "token"),
    [
        ({**ARGS, "amount_usd": 999999}, _approval_token()),  # other arguments (TM-W2)
        (ARGS, _approval_token(subject="u-central-2")),  # approved for someone else
        (ARGS, _approval_token(tool="ops___delete_budget")),
        (ARGS, _approval_token(expires_at=NOW - 1)),
        (ARGS, _approval_token(key=ec.generate_private_key(ec.SECP256R1()))),
    ],
)
def test_an_approval_for_another_call_writes_nothing(
    env: Env, arguments: dict[str, Any], token: str
) -> None:
    assert _call(env, arguments, approval_token=token)["error"]["code"] == "approval_required"
    assert env.budgets.created == [] and env.claims.used == []


def test_an_approval_is_spent_before_writing_and_only_once(env: Env) -> None:
    token = _approval_token()
    assert _call(env, approval_token=token)["status"] == "created"
    assert _call(env, approval_token=token)["error"]["code"] == "approval_used"
    assert len(env.budgets.created) == 1


def test_an_approval_the_gateway_did_not_spend_is_refused(env: Env) -> None:
    env.claims.refuse = True
    assert _call(env, approval_token=_approval_token())["error"]["code"] == "approval_used"
    assert env.budgets.created == []


@pytest.mark.parametrize(
    "arguments",
    [
        {"name": "team a", "amount_usd": 10},
        {"name": "../x", "amount_usd": 10},
        {"name": "team-a", "amount_usd": 0},
        {"name": "team-a", "amount_usd": "10"},
        {"name": "team-a", "amount_usd": 10, "account_ids": ["12"]},
        {"name": "team-a", "amount_usd": 10, "notify": "someone@example.com"},
        {"name": "team-a"},
    ],
)
def test_invalid_arguments_are_refused_before_the_approval_is_spent(
    env: Env, arguments: dict[str, Any]
) -> None:
    result = _call(env, arguments, approval_token=_approval_token(arguments))
    assert result["error"]["code"] == "invalid_arguments"
    assert env.claims.used == [] and env.budgets.created == []


def test_unknown_tools_are_refused(env: Env) -> None:
    result = _call(env, approval_token=_approval_token(), tool="ops___delete_everything")
    assert result["error"]["code"] == "unknown_tool"
    assert handler.handle({}, SimpleNamespace(), env.runtime)["error"]["code"] == "unknown_tool"


def test_aws_errors_do_not_leak_and_duplicates_have_their_own_code(
    env: Env, caplog: pytest.LogCaptureFixture
) -> None:
    env.budgets.error = "DuplicateRecordException"
    assert _call(env, approval_token=_approval_token())["error"]["code"] == "already_exists"
    env.budgets.error = "AccessDeniedException"
    env.claims.used.clear()
    with caplog.at_level(logging.INFO):
        result = _call(env, approval_token=_approval_token())
    assert result == {
        "error": {"code": "upstream_error", "message": "the change could not be applied"}
    }
    # The operational log names the tool, the user and the approval; never the arguments.
    events = [r.getMessage() for r in caplog.records if "tool.write" in r.getMessage()]
    assert json.loads(events[-1]) == {
        "event": "tool.write",
        "tool": "create_budget",
        "user": "u-central",
        "approval": APPROVAL_ID,
        "outcome": "upstream_error",
    }
    assert "team-a" not in " ".join(events)


def test_the_budget_name_always_carries_the_installation_prefix() -> None:
    args = budgets.CreateBudgetArgs(name="x", amount_usd=1.5)
    assert budgets.budget_name("Mango-poc-", args) == "Mango-poc-x"
    assert (
        budgets.budget_arn(PAYER, "Mango-poc-x") == f"arn:aws:budgets::{PAYER}:budget/Mango-poc-x"
    )


def test_settings_reject_a_prefix_that_is_not_the_installation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in (
        "COGNITO_ISSUER",
        "COGNITO_CLIENT_ID",
        "OPERATE_BROKER_ROLE_ARN",
        "BUDGETS_OPERATOR_ROLE_ARN",
        "APPROVALS_TABLE",
        "APPROVAL_KEY_ARN",
    ):
        monkeypatch.setenv(name, "x")
    monkeypatch.setenv("RESOURCE_PREFIX", "")
    with pytest.raises(ValueError, match="RESOURCE_PREFIX"):
        handler.Settings.from_env()
    monkeypatch.setenv("RESOURCE_PREFIX", "Mango-poc-")
    assert handler.Settings.from_env().resource_prefix == "Mango-poc-"
