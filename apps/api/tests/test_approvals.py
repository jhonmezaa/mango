"""Write tools with approval (D27; threat model ``write-tools-approval-threat-model.md``):
the tier, the policies with dual approval, and the requests from the chat to their execution,
against moto DynamoDB, the release's real connector catalog and a fake Gateway."""

from __future__ import annotations

import dataclasses
import json
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import boto3
import pytest
from fastapi.testclient import TestClient
from moto import mock_aws

from mango_api import app as app_module
from mango_api import approvals as approvals_module
from mango_api.approval_executor import ApprovedCall, Execution, Outcome
from mango_api.approval_policy import (
    DEFAULT_POLICY,
    Condition,
    Policy,
    Tier,
    TierInputs,
    TierReason,
    decide,
)
from mango_api.approvals import ApprovalDeps
from mango_api.approvals_store import (
    INDEX_BY_REQUESTER,
    INDEX_BY_STATE,
    ApprovalConflictError,
    ApprovalStore,
    Signature,
)
from mango_api.mcp_catalog import McpCatalog
from mango_api.probe import RateLimiter
from mango_api.published import PublishedAgent
from mango_api.tool_policies import (
    PolicyConflictError,
    PolicyStore,
    PolicyUnavailableError,
    ToolPolicyDeps,
)
from mango_core.approval import call_hash
from mango_core.identity import UserContext

from .harness_wire import wire_stream
from .test_admin import RecordingAudit, _code, _table
from .test_app import (
    HOST,
    KEY,
    TOKENS,
    FakeBedrock,
    FakeBudgets,
    FakeConversations,
    FakeLimits,
    FakeModelCatalog,
    FakePublished,
    FakeVerifier,
    _events,
    _settings,
    served,
)

CONNECTORS = Path(__file__).parents[3] / "connectors"
TOOL = "aws-budgets.create_budget"
GATEWAY_TOOL = "ops___create_budget"
READ_TOOL = "cost-explorer.get_cost_and_usage"
URL = "/api/approvals"
POLICIES = "/api/approvals/policies"
EXP = 4_000_000_000

# requester: central FinOps, not an administrator. approver / approver2: the same. lead: an
# area lead (not an approver). admin / admin2: administrators.
for name, claims in {
    "requester": {"sub": "user-10", "mango_role": "finops-central", "mango_email": "r@x.co"},
    "approver": {"sub": "user-11", "mango_role": "finops-central", "mango_email": "a1@x.co"},
    "approver2": {"sub": "user-12", "mango_role": "finops-central", "mango_email": "a2@x.co"},
    "lead": {"sub": "user-13", "mango_role": "bu-lead", "mango_business_unit": "security"},
    "admin2": {"sub": "admin-2", "mango_role": "finops-central", "mango_admin": "true"},
}.items():
    TOKENS[name] = {**claims, "exp": EXP}


def _h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@dataclass
class RoleAuthorizer:
    """Mirrors the platform policies (``test_cedar_policies.py`` evaluates the real ones)."""

    deny_use: bool = False
    decisions: list[tuple[str, str, bool]] = field(default_factory=list)

    def is_allowed(self, user: Any, action: str, _rt: str, _rid: str, _agent: Any = None) -> bool:
        if action == "ViewApprovals":
            allowed = True
        elif action == "ApproveToolCall":
            allowed = user.is_admin or user.role == "finops-central"
        elif action == "UseAgent":
            allowed = not self.deny_use
        else:
            allowed = bool(user.is_admin)
        self.decisions.append((user.user_id, action, allowed))
        return allowed


class StalledStream:
    """What the harness sends in the laboratory: the model message that calls the write tool
    and its usage, then nothing. It never gets past the Gateway's refusal, so reading on ends
    in the client's read timeout."""

    def __init__(self, events: list[dict[str, Any]]) -> None:
        self._events = events
        self.closed = False

    def __iter__(self) -> Iterator[dict[str, Any]]:
        yield from self._events
        raise TimeoutError("The read operation timed out")

    def close(self) -> None:
        self.closed = True


@dataclass
class WriteAgentCore:
    """A harness whose model calls the write tool: the Gateway refuses it (no approval)."""

    arguments: list[str] = field(default_factory=lambda: ['{"name":"team-a","amount_usd":100}'])
    tool_name: str = f"mango___{GATEWAY_TOOL}"
    requests: list[dict[str, Any]] = field(default_factory=list)
    stalls: bool = False
    """Answer as the real harness does (``StalledStream``)."""
    streams: list[StalledStream] = field(default_factory=list)

    def invoke_harness(self, **request: Any) -> dict[str, Any]:
        self.requests.append(request)
        if self.stalls:
            return {"stream": self._stalled()}
        stream: list[dict[str, Any]] = [
            {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": "Lo preparo."}}}
        ]
        for n, arguments in enumerate(self.arguments, start=1):
            half = len(arguments) // 2
            stream += [
                {
                    "contentBlockStart": {
                        "contentBlockIndex": n,
                        "start": {"toolUse": {"toolUseId": f"t{n}", "name": self.tool_name}},
                    }
                },
                # The input arrives in pieces.
                *(
                    {
                        "contentBlockDelta": {
                            "contentBlockIndex": n,
                            "delta": {"toolUse": {"input": piece}},
                        }
                    }
                    for piece in (arguments[:half], arguments[half:])
                ),
                {"contentBlockStop": {"contentBlockIndex": n}},
                {
                    "contentBlockStart": {
                        "contentBlockIndex": 50 + n,
                        "start": {"toolResult": {"toolUseId": f"t{n}", "status": "error"}},
                    }
                },
            ]
        stream += [
            {"messageStop": {"stopReason": "end_turn"}},
            {"metadata": {"usage": {"inputTokens": 100, "outputTokens": 10}}},
        ]
        return {"stream": stream}

    def _stalled(self) -> StalledStream:
        events: list[dict[str, Any]] = [
            {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": "Lo preparo."}}}
        ]
        for n, arguments in enumerate(self.arguments, start=1):
            events += [
                {
                    "contentBlockStart": {
                        "contentBlockIndex": n,
                        "start": {"toolUse": {"toolUseId": f"t{n}", "name": self.tool_name}},
                    }
                },
                {
                    "contentBlockDelta": {
                        "contentBlockIndex": n,
                        "delta": {"toolUse": {"input": arguments}},
                    }
                },
                {"contentBlockStop": {"contentBlockIndex": n}},
            ]
        events += [
            {"messageStop": {"stopReason": "tool_use"}},
            {"metadata": {"usage": {"inputTokens": 100, "outputTokens": 10}}},
        ]
        self.streams.append(StalledStream(events))
        return self.streams[-1]


@dataclass
class FakeExecutor:
    result: Execution = Execution(Outcome.EXECUTED)  # noqa: RUF009 - immutable value
    calls: list[tuple[ApprovedCall, str]] = field(default_factory=list)
    mark_gateway: Any = None
    """Called with the approval id when the "Gateway" spends the approval."""

    def run(self, call: ApprovedCall, *, access_token: str, token_expires_at: int) -> Execution:
        self.calls.append((call, access_token))
        if self.result.outcome is not Outcome.NOT_RUN and self.mark_gateway is not None:
            self.mark_gateway(call.approval_id)
        return self.result


def write_agent(**changes: Any) -> PublishedAgent:
    agent = served(tools=(READ_TOOL, TOOL), approval_tools=[TOOL])
    return dataclasses.replace(
        agent,
        allowed_tools=("@mango/finops___get_cost_and_usage", f"@mango/{GATEWAY_TOOL}"),
        gateway_tools=("finops___get_cost_and_usage", GATEWAY_TOOL),
        write_tools=((GATEWAY_TOOL, TOOL),),
        **changes,
    )


def _approvals_table(db: Any, name: str) -> None:
    db.create_table(
        TableName=name,
        KeySchema=[
            {"AttributeName": "PK", "KeyType": "HASH"},
            {"AttributeName": "SK", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": n, "AttributeType": "S"}
            for n in ("PK", "SK", "state_pk", "requester_pk", "sort")
        ],
        GlobalSecondaryIndexes=[
            {
                "IndexName": index,
                "KeySchema": [
                    {"AttributeName": key, "KeyType": "HASH"},
                    {"AttributeName": "sort", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
            }
            for index, key in ((INDEX_BY_STATE, "state_pk"), (INDEX_BY_REQUESTER, "requester_pk"))
        ],
        BillingMode="PAY_PER_REQUEST",
    )


@dataclass
class Env:
    client: TestClient
    db: Any
    audit: RecordingAudit
    authorizer: RoleAuthorizer
    agentcore: WriteAgentCore
    executor: FakeExecutor
    published: FakePublished
    conversations: FakeConversations
    policies: PolicyStore
    store: ApprovalStore
    deps: ApprovalDeps
    clock: list[datetime]

    def advance(self, **delta: int) -> None:
        self.clock[0] += timedelta(**delta)

    def ask(self, token: str = "requester", arguments: str | None = None) -> dict[str, Any]:
        """A chat turn in which the agent calls the write tool; returns the request shown."""
        if arguments is not None:
            self.agentcore.arguments = [arguments]
        response = self.client.post("/api/chat", headers=_h(token), json={"message": "crea uno"})
        assert response.status_code == 200, response.text
        shown = [data for kind, data in _events(response.text) if kind == "approval"]
        assert len(shown) == 1, _events(response.text)
        return shown[0]

    def set_policy(self, **rule: Any) -> None:
        """An approved policy, written the way the store does."""
        policy = Policy(**rule)
        self.db.put_item(
            TableName="settings",
            Item={
                "PK": {"S": "TOOL_POLICY"},
                "SK": {"S": TOOL},
                "rule": {"S": json.dumps(policy.rule())},
                "version": {"N": "1"},
            },
        )

    def post(self, token: str, path: str, body: dict[str, Any] | None = None) -> Any:
        return self.client.post(f"{URL}/{path}", headers=_h(token), json=body or {})


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    clock = [datetime(2026, 10, 2, 12, tzinfo=UTC)]
    catalog = McpCatalog.load(CONNECTORS)
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        _table(db, "settings")
        _approvals_table(db, "approvals")
        audit, authorizer = RecordingAudit(), RoleAuthorizer()
        published = FakePublished(agents={"finops": write_agent()})
        store, policies = ApprovalStore(db, "approvals"), PolicyStore(db, "settings")
        executor = FakeExecutor()

        def mark(approval_id: str) -> None:
            db.update_item(
                TableName="approvals",
                Key={"PK": {"S": f"APPROVAL#{approval_id}"}, "SK": {"S": "META"}},
                UpdateExpression="SET gateway_used_at = :now",
                ExpressionAttributeValues={":now": {"N": "1"}},
            )

        executor.mark_gateway = mark
        deps = ApprovalDeps(
            store=store,
            policies=policies,
            catalog=lambda: catalog,
            published=published,  # type: ignore[arg-type]
            audit=audit,  # type: ignore[arg-type]
            clock=lambda: clock[0],
            executor=executor,
        )
        agentcore, conversations = WriteAgentCore(), FakeConversations()

        def factory(s: Any) -> app_module.Services:
            return app_module.Services(
                settings=s,
                verifier=FakeVerifier(),  # type: ignore[arg-type]
                authorizer=authorizer,  # type: ignore[arg-type]
                budgets=FakeBudgets(),  # type: ignore[arg-type]
                conversations=conversations,  # type: ignore[arg-type]
                audit=audit,  # type: ignore[arg-type]
                agentcore=agentcore,
                bedrock=FakeBedrock(),
                settings_store=None,  # type: ignore[arg-type]
                budget_limits=FakeLimits(),  # type: ignore[arg-type]
                probe=None,  # type: ignore[arg-type]
                published=published,  # type: ignore[arg-type]
                model_catalog=FakeModelCatalog(),  # type: ignore[arg-type]
                invocation_key=KEY,
                approvals=deps,
                tool_policies=ToolPolicyDeps(
                    store=policies,
                    catalog=lambda: catalog,
                    audit=audit,  # type: ignore[arg-type]
                    rate_limiter=RateLimiter(limit=50, window_seconds=3600),
                    clock=lambda: clock[0],
                ),
            )

        asgi = app_module.create_app(_settings(), services_factory=factory)
        client = TestClient(asgi, base_url=f"http://{HOST}")  # type: ignore[arg-type]
        yield Env(
            client,
            db,
            audit,
            authorizer,
            agentcore,
            executor,
            published,
            conversations,
            policies,
            store,
            deps,
            clock,
        )


# --- The tier is computed from the real arguments (TM-W4) -------------------------------------

AMOUNT = Policy(condition=Condition.AMOUNT, amount_usd=Decimal(500), approvers=2)
COUNT = Policy(condition=Condition.COUNT, count=5)
PROD = Policy(condition=Condition.ENVIRONMENT, environment="prod")
INPUTS = TierInputs(amount="amount_usd", count="count", environment="env")


@pytest.mark.parametrize(
    ("policy", "arguments", "tier", "reason"),
    [
        (DEFAULT_POLICY, {"amount_usd": 1}, Tier.APPROVERS, TierReason.ALWAYS),
        (AMOUNT, {"amount_usd": 500}, Tier.SELF, TierReason.BELOW),
        (AMOUNT, {"amount_usd": 0.01}, Tier.SELF, TierReason.BELOW),
        (AMOUNT, {"amount_usd": 500.01}, Tier.APPROVERS, TierReason.ABOVE),
        (COUNT, {"count": 5}, Tier.SELF, TierReason.BELOW),
        (COUNT, {"count": 6}, Tier.APPROVERS, TierReason.ABOVE),
        (PROD, {"env": "staging"}, Tier.SELF, TierReason.BELOW),
        (PROD, {"env": "prod"}, Tier.APPROVERS, TierReason.ABOVE),
    ],
)
def test_the_tier_follows_the_policy(
    policy: Policy, arguments: dict[str, Any], tier: Tier, reason: TierReason
) -> None:
    decision = decide(policy, INPUTS, arguments)
    assert (decision.tier, decision.reason) == (tier, reason)


@pytest.mark.parametrize(
    ("policy", "arguments"),
    [
        (AMOUNT, {}),
        (AMOUNT, {"amount_usd": None}),
        (AMOUNT, {"amount_usd": "5"}),  # a number as text is not a number
        (AMOUNT, {"amount_usd": True}),
        (AMOUNT, {"amount_usd": 0}),
        (AMOUNT, {"amount_usd": -5}),
        (AMOUNT, {"amount_usd": float("nan")}),
        (AMOUNT, {"amount_usd": float("inf")}),
        (AMOUNT, {"amount_usd": [5]}),
        (AMOUNT, {"amount": 5}),  # the value in a field the release does not name
        (COUNT, {"count": 2.5}),
        (COUNT, {"count": "2"}),
        (COUNT, {}),
        (PROD, {}),
        (PROD, {"env": "dev"}),
        (PROD, {"env": "PROD"}),
        (PROD, {"env": 1}),
    ],
)
def test_a_value_that_is_missing_or_unreadable_means_approvers(
    policy: Policy, arguments: dict[str, Any]
) -> None:
    decision = decide(policy, INPUTS, arguments)
    assert (decision.tier, decision.reason) == (Tier.APPROVERS, TierReason.UNKNOWN)


def test_a_tool_that_declares_no_value_always_needs_approvers() -> None:
    assert decide(AMOUNT, TierInputs(), {"amount_usd": 1}).tier is Tier.APPROVERS
    assert TierInputs(amount="amount_usd").conditions() == (Condition.ALWAYS, Condition.AMOUNT)


@pytest.mark.parametrize(
    "rule",
    [
        {"approvers": 0},
        {"approvers": 4},
        {"expires_hours": 12},
        {"condition": Condition.AMOUNT},
        {"condition": Condition.AMOUNT, "amount_usd": Decimal(0)},
        {"condition": Condition.COUNT, "count": 0},
        {"condition": Condition.ENVIRONMENT, "environment": "dev"},
    ],
)
def test_invalid_policies_cannot_exist(rule: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        Policy(**rule)


# --- Policies: read by everyone, changed by two administrators (TM-W6) ------------------------


def _proposal(**changes: Any) -> dict[str, Any]:
    return {
        "base_version": 0,
        "condition": "amount",
        "amount_usd": "500",
        "approvers": 2,
        "expires_hours": 4,
        "reason": "Small budgets need no second person",
        **changes,
    }


def _propose(env: Env, token: str = "admin", **changes: Any) -> Any:
    return env.client.post(
        f"{POLICIES}/{TOOL}/changes", headers=_h(token), json=_proposal(**changes)
    )


def test_an_unconfigured_write_tool_always_asks_for_one_approver(env: Env) -> None:
    body = env.client.get(POLICIES, headers=_h("lead")).json()
    assert body == {
        "tools": [
            {
                "tool": TOOL,
                "server_name": "AWS Budgets",
                "description": (
                    "Crear un presupuesto mensual de costo en AWS Budgets, sin notificaciones."
                ),
                "conditions": ["always", "amount"],
                "policy": {
                    "condition": "always",
                    "amount_usd": None,
                    "count": None,
                    "environment": None,
                    "approvers": 1,
                    "expires_hours": 24,
                },
                "version": 0,
                "pending_change_id": None,
            }
        ],
        "changes": [],
    }


def test_a_policy_changes_only_when_another_administrator_approves(env: Env) -> None:
    created = _propose(env)
    assert created.status_code == 201, created.json()
    change_id = created.json()["change_id"]
    # Nothing changed yet, and only administrators read the proposals.
    assert env.policies.policy(TOOL) == DEFAULT_POLICY
    assert env.client.get(POLICIES, headers=_h("lead")).json()["changes"] == []
    listed = env.client.get(POLICIES, headers=_h("admin2")).json()
    assert listed["tools"][0]["pending_change_id"] == change_id
    assert listed["changes"][0]["status"] == "pending"

    own = env.client.post(f"{POLICIES}/changes/{change_id}/approve", headers=_h("admin"), json={})
    assert (own.status_code, _code(own)) == (403, "same_approver")
    assert env.policies.policy(TOOL) == DEFAULT_POLICY

    approved = env.client.post(
        f"{POLICIES}/changes/{change_id}/approve", headers=_h("admin2"), json={}
    )
    assert approved.status_code == 200, approved.json()
    tool = approved.json()["tools"][0]
    assert tool["version"] == 1 and tool["pending_change_id"] is None
    assert tool["policy"] == {
        "condition": "amount",
        "amount_usd": "500",
        "count": None,
        "environment": None,
        "approvers": 2,
        "expires_hours": 4,
    }
    assert approved.json()["changes"][0]["status"] == "approved"
    events = [e for e, _u, d in env.audit.events if d.get("outcome") == "applied"]
    assert events == ["approval.policy.propose", "approval.policy.approve"]
    assert [d["error"] for _u, d in env.audit.named("approval.policy.approve", "rejected")] == [
        "same_approver"
    ]


def test_the_store_refuses_the_proposer_even_if_the_check_is_skipped(env: Env) -> None:
    change_id = _propose(env).json()["change_id"]
    change = env.policies.change(change_id)
    assert change is not None
    with pytest.raises(PolicyConflictError):
        env.policies.approve(change, actor="admin-1", actor_email=None, now=env.clock[0])
    assert env.policies.policy(TOOL) == DEFAULT_POLICY


@pytest.mark.parametrize(
    ("changes", "status", "code"),
    [
        ({"condition": "count", "count": 3, "amount_usd": None}, 422, "condition_unsupported"),
        ({"condition": "environment", "environment": "prod"}, 422, "condition_unsupported"),
        ({"condition": "amount", "amount_usd": None}, 422, "invalid_policy"),
        ({"condition": "always", "approvers": 1, "expires_hours": 24}, 422, "no_change"),
        ({"base_version": 3}, 409, "version_conflict"),
        ({"approvers": 4}, 422, "invalid_request"),
        ({"expires_hours": 12}, 422, "invalid_request"),
        ({"amount_usd": "-5"}, 422, "invalid_request"),
        ({"reason": ""}, 422, "invalid_request"),
        ({"extra": 1}, 422, "invalid_request"),
    ],
)
def test_invalid_proposals_are_refused(
    env: Env, changes: dict[str, Any], status: int, code: str
) -> None:
    response = _propose(env, **changes)
    assert (response.status_code, _code(response)) == (status, code)


def test_one_open_proposal_per_tool_and_only_for_write_tools(env: Env) -> None:
    assert _propose(env).status_code == 201
    again = _propose(env, approvers=3)
    assert (again.status_code, _code(again)) == (409, "already_pending")
    read_tool = env.client.post(
        f"{POLICIES}/{READ_TOOL}/changes", headers=_h("admin"), json=_proposal()
    )
    assert read_tool.status_code == 404


def test_reject_and_withdraw_leave_the_policy_alone(env: Env) -> None:
    first = _propose(env).json()["change_id"]
    own = env.client.post(
        f"{POLICIES}/changes/{first}/reject", headers=_h("admin"), json={"reason": "no"}
    )
    assert (own.status_code, _code(own)) == (403, "same_approver")
    rejected = env.client.post(
        f"{POLICIES}/changes/{first}/reject", headers=_h("admin2"), json={"reason": "too high"}
    )
    assert rejected.json()["changes"][0]["status"] == "rejected"
    env.advance(minutes=1)
    second = _propose(env).json()["change_id"]
    other = env.client.post(f"{POLICIES}/changes/{second}/withdraw", headers=_h("admin2"), json={})
    assert other.status_code == 403
    withdrawn = env.client.post(
        f"{POLICIES}/changes/{second}/withdraw", headers=_h("admin"), json={}
    )
    # Newest first.
    assert [(c["change_id"], c["status"]) for c in withdrawn.json()["changes"]] == [
        (second, "withdrawn"),
        (first, "rejected"),
    ]
    assert env.policies.policy(TOOL) == DEFAULT_POLICY
    assert _propose(env).status_code == 201  # the tool is free again


def test_a_proposal_expires_and_a_stale_one_cannot_be_applied(env: Env) -> None:
    change_id = _propose(env).json()["change_id"]
    env.advance(days=8)
    late = env.client.post(f"{POLICIES}/changes/{change_id}/approve", headers=_h("admin2"), json={})
    assert (late.status_code, _code(late)) == (410, "expired")
    assert env.client.get(POLICIES, headers=_h("admin")).json()["changes"][0]["status"] == "expired"


@pytest.mark.parametrize("token", ["lead", "requester"])
def test_only_administrators_change_policies(env: Env, token: str) -> None:
    assert _propose(env, token).status_code == 403
    change_id = _propose(env).json()["change_id"]
    for action in ("approve", "withdraw"):
        response = env.client.post(
            f"{POLICIES}/changes/{change_id}/{action}", headers=_h(token), json={}
        )
        assert response.status_code == 403
    assert env.policies.policy(TOOL) == DEFAULT_POLICY


def test_no_policy_change_without_its_audit_record(env: Env) -> None:
    env.audit.fail_outcomes = {"requested"}
    response = _propose(env)
    assert (response.status_code, _code(response)) == (503, "audit_unavailable")
    env.audit.fail_outcomes = set()
    assert env.client.get(POLICIES, headers=_h("admin")).json()["changes"] == []


def test_a_stored_policy_that_cannot_be_read_is_never_guessed(env: Env) -> None:
    env.db.put_item(
        TableName="settings",
        Item={
            "PK": {"S": "TOOL_POLICY"},
            "SK": {"S": TOOL},
            "rule": {"S": '{"condition":"amount","approvers":1,"expires_hours":24}'},
            "version": {"N": "1"},
        },
    )
    with pytest.raises(PolicyUnavailableError):
        env.policies.policy(TOOL)
    # The chat falls back to the default: approvers (fail closed).
    assert env.ask()["tier"] == "approvers"


# --- The chat turns a refused write call into a request ---------------------------------------


def test_a_write_call_becomes_a_request_with_the_real_arguments(env: Env) -> None:
    shown = env.ask()
    assert shown["status"] == "pending" and shown["tier"] == "approvers"
    assert shown["tool"] == TOOL and shown["server_name"] == "AWS Budgets"
    # What the tool does comes from the release, never from the model (R3).
    assert shown["description"].startswith("Crear un presupuesto mensual")
    assert shown["arguments"] == {"name": "team-a", "amount_usd": 100}
    assert shown["rule"] == {
        "condition": "always",
        "reason": "always",
        "amount_usd": None,
        "count": None,
        "environment": None,
        "approvers": 1,
        "expires_hours": 24,
    }
    assert shown["approvals_needed"] == 1 and shown["mine"] is True
    assert shown["requested_by_email"] == "r@x.co"
    assert shown["expires_at"] == "2026-10-03T12:00:00+00:00"
    # Nothing ran, and the harness got the tool in its signed invocation.
    assert env.executor.calls == []
    ((_user, detail),) = env.audit.named("approval.request")
    assert detail["args_hash"] == call_hash(GATEWAY_TOOL, shown["arguments"])
    assert "team-a" not in json.dumps(env.audit.events)
    record = env.store.get(shown["approval_id"])
    assert record is not None and record.agent_version == 3


def test_the_tier_uses_the_stored_policy_and_the_call_arguments(env: Env) -> None:
    env.set_policy(condition=Condition.AMOUNT, amount_usd=Decimal(500), approvers=2)
    below = env.ask(arguments='{"name":"a","amount_usd":500}')
    assert (below["tier"], below["rule"]["reason"], below["approvals_needed"]) == (
        "self",
        "below",
        0,
    )
    above = env.ask(arguments='{"name":"b","amount_usd":501}')
    assert (above["tier"], above["rule"]["reason"], above["approvals_needed"]) == (
        "approvers",
        "above",
        2,
    )
    # The model cannot lower the tier with a value it words differently (TM-W4).
    unknown = env.ask(arguments='{"name":"c","amount_usd":"5"}')
    assert (unknown["tier"], unknown["rule"]["reason"]) == ("approvers", "unknown")


@pytest.mark.parametrize(
    "arguments", ["", "not json", "[1,2]", '"text"', '{"name":"a","amount_usd":NaN}']
)
def test_calls_whose_arguments_cannot_be_shown_create_no_request(env: Env, arguments: str) -> None:
    env.agentcore.arguments = [arguments] if arguments else ["null"]
    response = env.client.post("/api/chat", headers=_h("requester"), json={"message": "x"})
    kinds = [kind for kind, _ in _events(response.text)]
    assert "approval" not in kinds and "done" in kinds
    assert env.audit.named("approval.request") == []


def test_the_same_call_is_requested_once_and_a_turn_is_capped(env: Env) -> None:
    same = '{"name":"a","amount_usd":1}'
    env.agentcore.arguments = [same, '{"amount_usd":1.0,"name":"a"}']
    response = env.client.post("/api/chat", headers=_h("requester"), json={"message": "x"})
    assert [k for k, _ in _events(response.text)].count("approval") == 1
    env.agentcore.arguments = [f'{{"name":"b{n}","amount_usd":1}}' for n in range(6)]
    response = env.client.post("/api/chat", headers=_h("requester"), json={"message": "x"})
    assert [k for k, _ in _events(response.text)].count("approval") == (
        approvals_module.MAX_REQUESTS_PER_TURN
    )


def test_a_person_cannot_pile_up_open_requests(env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(approvals_module, "MAX_OPEN_PER_USER", 2)
    env.ask(arguments='{"name":"a","amount_usd":1}')
    env.ask(arguments='{"name":"b","amount_usd":1}')
    env.agentcore.arguments = ['{"name":"c","amount_usd":1}']
    response = env.client.post("/api/chat", headers=_h("requester"), json={"message": "x"})
    assert "approval" not in [k for k, _ in _events(response.text)]


def test_tools_that_are_not_write_tools_of_the_agent_create_no_request(env: Env) -> None:
    env.agentcore.tool_name = "mango___ops___delete_budget"
    response = env.client.post("/api/chat", headers=_h("requester"), json={"message": "x"})
    assert "approval" not in [k for k, _ in _events(response.text)]
    # A name that only ends like the write tool is another tool.
    env.agentcore.tool_name = f"evil{GATEWAY_TOOL}"
    response = env.client.post("/api/chat", headers=_h("requester"), json={"message": "x"})
    assert "approval" not in [k for k, _ in _events(response.text)]


def test_no_request_without_its_audit_record(env: Env) -> None:
    env.audit.fail_outcomes = {"applied"}
    response = env.client.post("/api/chat", headers=_h("requester"), json={"message": "x"})
    assert "approval" not in [k for k, _ in _events(response.text)]
    env.audit.fail_outcomes = set()
    assert env.client.get(URL, headers=_h("approver")).json()["items"] == []


def test_the_message_remembers_its_requests(env: Env) -> None:
    stored: list[dict[str, Any]] = []

    def add_message(*args: Any, **kwargs: Any) -> str:
        stored.append({"args": args, **kwargs})
        return "m" * 32

    env.conversations.add_message = add_message  # type: ignore[method-assign]
    shown = env.ask()
    assert stored[-1]["approvals"] == [shown["approval_id"]]


def test_the_turn_ends_well_once_the_request_exists(env: Env) -> None:
    """The harness stalls on the refused call: the turn must not wait for it (and fail on the
    read timeout a minute later), nor let the model call the tool again."""
    env.agentcore.stalls = True
    stored: list[dict[str, Any]] = []
    add_message = env.conversations.add_message

    def record(*args: Any, **kwargs: Any) -> str:
        stored.append({"args": args, **kwargs})
        return add_message(*args, **kwargs)

    env.conversations.add_message = record  # type: ignore[method-assign]
    response = env.client.post("/api/chat", headers=_h("requester"), json={"message": "crea uno"})
    events = _events(response.text)
    kinds = [kind for kind, _ in events]
    assert "error" not in kinds
    assert kinds.index("approval") < kinds.index("done") == len(kinds) - 1
    done = events[-1][1]
    assert done["stop_reason"] == "tool_use" and done["usage"]["input_tokens"] == 100
    # The write call is shown as refused and the connection to the harness is dropped.
    tools = [data for kind, data in events if kind == "tool"]
    assert [tool["status"] for tool in tools] == ["started", "error"]
    (stream,) = env.agentcore.streams
    assert stream.closed and len(env.agentcore.requests) == 1
    # The answer keeps its request, and the turn is paid and audited as any other.
    shown = next(data for kind, data in events if kind == "approval")
    assert stored[-1]["approvals"] == [shown["approval_id"]]
    ((_user, completed),) = env.audit.named("agent.completed", outcome=None)
    assert completed["input_tokens"] == 100 and completed["stop_reason"] == "tool_use"
    # The session was left waiting for the tool: the next turn starts another one, with the
    # stored history and what happened to the request.
    conversation = shown["conversation_id"]
    assert env.conversations.sessions[("user-10", conversation)].used_at == 0
    env.post("requester", f"{shown['approval_id']}/cancel")
    env.agentcore.arguments, env.agentcore.stalls = [], False
    env.client.post(
        "/api/chat",
        headers=_h("requester"),
        json={"message": "gracias", "conversation_id": conversation},
    )
    first, second = env.agentcore.requests
    assert second["runtimeSessionId"] != first["runtimeSessionId"]
    assert len(second["messages"]) > 1  # the stored history, not only the new message
    assert GATEWAY_TOOL in second["messages"][-1]["content"][0]["text"]


# --- Self confirmation (below the threshold) --------------------------------------------------


def _self_request(env: Env) -> dict[str, Any]:
    env.set_policy(condition=Condition.AMOUNT, amount_usd=Decimal(500))
    return env.ask()


def test_confirming_runs_exactly_what_was_shown_as_the_person_who_asked(env: Env) -> None:
    shown = _self_request(env)
    response = env.post("requester", f"{shown['approval_id']}/confirm")
    assert response.status_code == 200, response.json()
    body = response.json()
    assert body["status"] == "executed" and body["decided_by"] == "user-10"
    ((call, access_token),) = env.executor.calls
    assert access_token == "requester"
    assert call == ApprovedCall(
        approval_id=shown["approval_id"],
        subject="user-10",
        agent_id="finops",
        agent_version=3,
        gateway_tool=GATEWAY_TOOL,
        arguments='{"amount_usd":100,"name":"team-a"}',
        args_hash=call_hash(GATEWAY_TOOL, {"name": "team-a", "amount_usd": 100}),
    )
    applied = [e for e, _u, d in env.audit.events if d.get("outcome") == "applied"]
    assert applied[-2:] == ["approval.self_confirm", "approval.execute"]
    # Running an action is using the agent: that decision is made (and audited) again.
    assert ("user-10", "UseAgent", True) in env.authorizer.decisions
    # Once.
    again = env.post("requester", f"{shown['approval_id']}/confirm")
    assert (again.status_code, _code(again)) == (409, "version_conflict")
    assert len(env.executor.calls) == 1


def test_cancelling_runs_nothing(env: Env) -> None:
    shown = _self_request(env)
    body = env.post("requester", f"{shown['approval_id']}/cancel").json()
    assert body["status"] == "cancelled"
    assert env.executor.calls == []
    assert env.audit.named("approval.self_cancel")[0][1]["approval_id"] == shown["approval_id"]
    late = env.post("requester", f"{shown['approval_id']}/confirm")
    assert late.status_code == 409


@pytest.mark.parametrize("token", ["approver", "admin", "lead"])
def test_only_who_asked_confirms_cancels_or_runs(env: Env, token: str) -> None:
    shown = _self_request(env)
    for action in ("confirm", "cancel", "execute"):
        response = env.post(token, f"{shown['approval_id']}/{action}")
        assert response.status_code == 404, (action, response.json())
    assert env.client.get(f"{URL}/{shown['approval_id']}", headers=_h(token)).status_code == 404
    assert env.executor.calls == []


def test_a_call_above_the_threshold_cannot_be_self_confirmed(env: Env) -> None:
    shown = env.ask()  # default policy: approvers
    assert env.post("requester", f"{shown['approval_id']}/confirm").status_code == 404
    assert env.post("requester", f"{shown['approval_id']}/execute").status_code == 409
    assert env.executor.calls == []


def test_a_request_expires_and_is_audited_once(env: Env) -> None:
    shown = _self_request(env)
    env.advance(hours=25)
    late = env.post("requester", f"{shown['approval_id']}/confirm")
    assert (late.status_code, _code(late)) == (410, "expired")
    detail = env.client.get(f"{URL}/{shown['approval_id']}", headers=_h("requester")).json()
    assert detail["status"] == "expired"
    assert len(env.audit.named("approval.expire")) == 1
    assert env.executor.calls == []


def test_nothing_runs_when_the_agent_lost_the_tool_or_the_user_lost_the_agent(env: Env) -> None:
    shown = _self_request(env)
    env.published.agents["finops"] = served()  # a new version without the write tool
    lost = env.post("requester", f"{shown['approval_id']}/confirm")
    assert (lost.status_code, _code(lost)) == (409, "tool_unavailable")
    env.published.agents["finops"] = write_agent()
    env.authorizer.deny_use = True
    assert env.post("requester", f"{shown['approval_id']}/confirm").status_code == 403
    assert env.executor.calls == []


def test_no_decision_without_its_audit_record(env: Env) -> None:
    shown = _self_request(env)
    env.audit.fail_outcomes = {"requested"}
    response = env.post("requester", f"{shown['approval_id']}/confirm")
    assert (response.status_code, _code(response)) == (503, "audit_unavailable")
    assert env.executor.calls == []


def test_a_call_refused_before_the_tool_can_be_run_again(env: Env) -> None:
    shown = _self_request(env)
    env.executor.result = Execution(Outcome.NOT_RUN, "gateway_refused")
    body = env.post("requester", f"{shown['approval_id']}/confirm").json()
    assert (body["status"], body["error"]) == ("approved", "gateway_refused")
    env.executor.result = Execution(Outcome.EXECUTED)
    assert env.post("requester", f"{shown['approval_id']}/execute").json()["status"] == "executed"
    assert len(env.executor.calls) == 2


@pytest.mark.parametrize(
    "result",
    [
        Execution(Outcome.TOOL_ERROR, "already_exists"),
        Execution(Outcome.UNKNOWN, "gateway_http_502"),
    ],
)
def test_a_call_that_may_have_run_is_never_run_again(env: Env, result: Execution) -> None:
    shown = _self_request(env)
    env.executor.result = result
    body = env.post("requester", f"{shown['approval_id']}/confirm").json()
    assert (body["status"], body["error"]) == ("failed", result.error)
    assert env.post("requester", f"{shown['approval_id']}/execute").status_code == 409
    assert len(env.executor.calls) == 1
    assert env.audit.named("approval.execute_failed", "rejected")[0][1]["error"] == result.error


def test_without_the_signing_key_nothing_can_be_run(env: Env) -> None:
    shown = _self_request(env)
    env.deps.executor = None
    response = env.post("requester", f"{shown['approval_id']}/confirm")
    assert (response.status_code, _code(response)) == (503, "execution_unavailable")


# --- Approvers (above the threshold) ----------------------------------------------------------


def _two_signature_request(env: Env) -> str:
    env.set_policy(condition=Condition.ALWAYS, approvers=2, expires_hours=4)
    return str(env.ask()["approval_id"])


def test_n_different_people_sign_and_then_who_asked_runs_it(env: Env) -> None:
    approval_id = _two_signature_request(env)
    first = env.post("approver", f"{approval_id}/approve", {"note": "ok"}).json()
    assert first["status"] == "pending"
    assert [(s["user_id"], s["email"], s["note"]) for s in first["signatures"]] == [
        ("user-11", "a1@x.co", "ok")
    ]
    assert first["can_sign"] is False  # this person already signed
    assert env.post("requester", f"{approval_id}/execute").status_code == 409  # not yet

    second = env.post("approver2", f"{approval_id}/approve").json()
    assert second["status"] == "approved" and len(second["signatures"]) == 2
    assert env.executor.calls == []  # approving runs nothing

    # Approvers cannot run it: it runs with the session of who asked (rule 5).
    assert env.post("approver", f"{approval_id}/execute").status_code == 404
    done = env.post("requester", f"{approval_id}/execute").json()
    assert done["status"] == "executed"
    ((call, access_token),) = env.executor.calls
    assert (call.subject, access_token) == ("user-10", "requester")
    assert [d["signatures"] for _u, d in env.audit.named("approval.approve")] == [1, 2]


def test_who_asked_never_signs_and_nobody_signs_twice(env: Env) -> None:
    approval_id = _two_signature_request(env)
    own = env.post("requester", f"{approval_id}/approve")
    assert (own.status_code, _code(own)) == (403, "own_request")
    assert env.post("approver", f"{approval_id}/approve").status_code == 200
    twice = env.post("approver", f"{approval_id}/approve")
    assert (twice.status_code, _code(twice)) == (409, "already_signed")
    detail = env.client.get(f"{URL}/{approval_id}", headers=_h("approver2")).json()
    assert detail["status"] == "pending" and len(detail["signatures"]) == 1
    refused = [d["error"] for _u, d in env.audit.named("approval.approve", "rejected")]
    assert refused == ["own_request", "already_signed"]


def test_the_store_enforces_the_separation_of_duties_on_its_own(env: Env) -> None:
    """The DynamoDB condition, without the checks of the use case (TM-W5)."""
    approval_id = _two_signature_request(env)
    record = env.store.get(approval_id)
    assert record is not None
    now = env.clock[0]

    def signature(user: str) -> Signature:
        return Signature(user_id=user, email=None, at="t")

    with pytest.raises(ApprovalConflictError):
        env.store.sign(record, signature("user-10"), now=now)  # who asked
    env.store.sign(record, signature("user-11"), now=now)
    with pytest.raises(ApprovalConflictError):
        env.store.sign(record, signature("user-12"), now=now)  # a stale read
    fresh = env.store.get(approval_id)
    assert fresh is not None
    with pytest.raises(ApprovalConflictError):
        env.store.sign(fresh, signature("user-11"), now=now)  # twice
    with pytest.raises(ApprovalConflictError):
        env.store.sign(fresh, signature("user-12"), now=now + timedelta(hours=5))  # expired
    assert env.store.sign(fresh, signature("user-12"), now=now) is True


def test_rejecting_needs_a_reason_and_closes_the_request(env: Env) -> None:
    approval_id = _two_signature_request(env)
    assert env.post("approver", f"{approval_id}/reject", {}).status_code == 422
    own = env.post("requester", f"{approval_id}/reject", {"reason": "x"})
    assert (own.status_code, _code(own)) == (403, "own_request")
    body = env.post("approver", f"{approval_id}/reject", {"reason": "Hazlo en staging"}).json()
    assert (body["status"], body["note"], body["decided_by_email"]) == (
        "rejected",
        "Hazlo en staging",
        "a1@x.co",
    )
    assert env.post("approver2", f"{approval_id}/approve").status_code == 409
    assert env.post("requester", f"{approval_id}/execute").status_code == 409


def test_who_asked_may_cancel_before_it_runs(env: Env) -> None:
    approval_id = _two_signature_request(env)
    env.post("approver", f"{approval_id}/approve")
    env.post("approver2", f"{approval_id}/approve")
    assert env.post("requester", f"{approval_id}/cancel").json()["status"] == "cancelled"
    assert env.post("requester", f"{approval_id}/execute").status_code == 409
    assert env.audit.named("approval.cancel")[0][0] == "user-10"


def test_an_approved_request_still_expires_before_it_runs(env: Env) -> None:
    approval_id = _two_signature_request(env)
    env.post("approver", f"{approval_id}/approve")
    env.post("approver2", f"{approval_id}/approve")
    env.advance(hours=5)
    late = env.post("requester", f"{approval_id}/execute")
    assert (late.status_code, _code(late)) == (410, "expired")
    assert env.executor.calls == []


def test_signing_after_the_expiry_is_refused(env: Env) -> None:
    approval_id = _two_signature_request(env)
    env.advance(hours=5)
    late = env.post("approver", f"{approval_id}/approve")
    assert (late.status_code, _code(late)) == (410, "expired")


def test_area_leads_cannot_decide(env: Env) -> None:
    approval_id = _two_signature_request(env)
    assert env.post("lead", f"{approval_id}/approve").status_code == 403
    assert env.post("lead", f"{approval_id}/reject", {"reason": "x"}).status_code == 403


# --- Who sees what (TM-W9) --------------------------------------------------------------------


def test_approvers_see_the_inbox_and_everyone_else_only_their_own(env: Env) -> None:
    approval_id = _two_signature_request(env)
    inbox = env.client.get(URL, headers=_h("approver")).json()
    assert inbox["can_decide"] is True
    (item,) = inbox["items"]
    assert (item["approval_id"], item["mine"], item["can_sign"]) == (approval_id, False, True)
    # The conversation belongs to who asked.
    assert item["conversation_id"] is None
    own = env.client.get(URL, headers=_h("requester")).json()
    assert own["items"][0]["mine"] is True and own["items"][0]["can_sign"] is False
    assert own["items"][0]["conversation_id"]
    lead = env.client.get(URL, headers=_h("lead")).json()
    assert lead == {"items": [], "can_decide": False}
    assert env.client.get(f"{URL}/{approval_id}", headers=_h("lead")).status_code == 404
    assert env.client.get(f"{URL}/{'0' * 32}", headers=_h("approver")).status_code == 404


def test_self_confirmations_stay_out_of_the_inbox(env: Env) -> None:
    shown = _self_request(env)
    assert env.client.get(URL, headers=_h("approver")).json()["items"] == []
    assert env.client.get(URL, headers=_h("requester")).json()["items"] == []
    by_conversation = env.client.get(
        URL, headers=_h("requester"), params={"conversation_id": shown["conversation_id"]}
    ).json()
    assert [i["approval_id"] for i in by_conversation["items"]] == [shown["approval_id"]]
    # Someone else asking for that conversation gets nothing.
    other = env.client.get(
        URL, headers=_h("approver"), params={"conversation_id": shown["conversation_id"]}
    ).json()
    assert other["items"] == []


def test_resolved_requests_move_to_the_other_list(env: Env) -> None:
    approval_id = _two_signature_request(env)
    env.post("approver", f"{approval_id}/reject", {"reason": "no"})
    assert env.client.get(URL, headers=_h("approver")).json()["items"] == []
    resolved = env.client.get(URL, headers=_h("approver"), params={"view": "resolved"}).json()
    assert [(i["approval_id"], i["status"]) for i in resolved["items"]] == [
        (approval_id, "rejected")
    ]
    assert env.client.get(URL, headers=_h("approver"), params={"view": "all"}).status_code == 422


def test_an_approved_request_waits_in_the_pending_list_until_it_runs(env: Env) -> None:
    approval_id = _two_signature_request(env)
    env.post("approver", f"{approval_id}/approve")
    env.post("approver2", f"{approval_id}/approve")
    for token in ("approver", "requester"):
        pending = env.client.get(URL, headers=_h(token)).json()
        assert [(i["approval_id"], i["status"], i["executed_at"]) for i in pending["items"]] == [
            (approval_id, "approved", None)
        ]
        resolved = env.client.get(URL, headers=_h(token), params={"view": "resolved"}).json()
        assert resolved["items"] == []

    assert env.post("requester", f"{approval_id}/execute").json()["status"] == "executed"
    assert env.client.get(URL, headers=_h("approver")).json()["items"] == []
    (item,) = env.client.get(URL, headers=_h("approver"), params={"view": "resolved"}).json()[
        "items"
    ]
    assert (item["approval_id"], item["status"]) == (approval_id, "executed")
    assert item["executed_at"]


def test_an_approved_request_that_expires_shows_as_resolved(env: Env) -> None:
    approval_id = _two_signature_request(env)
    env.post("approver", f"{approval_id}/approve")
    env.post("approver2", f"{approval_id}/approve")
    env.advance(hours=5)
    assert env.client.get(URL, headers=_h("approver")).json()["items"] == []
    resolved = env.client.get(URL, headers=_h("approver"), params={"view": "resolved"}).json()
    assert [(i["approval_id"], i["status"]) for i in resolved["items"]] == [
        (approval_id, "expired")
    ]


def test_expired_requests_show_as_resolved(env: Env) -> None:
    approval_id = _two_signature_request(env)
    env.advance(hours=5)
    assert env.client.get(URL, headers=_h("approver")).json()["items"] == []
    resolved = env.client.get(URL, headers=_h("approver"), params={"view": "resolved"}).json()
    assert [(i["approval_id"], i["status"]) for i in resolved["items"]] == [
        (approval_id, "expired")
    ]


def test_every_route_needs_a_session(env: Env) -> None:
    for method, path in [
        ("GET", URL),
        ("GET", POLICIES),
        ("GET", f"{URL}/{'0' * 32}"),
        ("POST", f"{URL}/{'0' * 32}/confirm"),
        ("POST", f"{URL}/{'0' * 32}/approve"),
        ("POST", f"{POLICIES}/{TOOL}/changes"),
    ]:
        assert env.client.request(method, path, json={}).status_code == 401, path


# --- The agent learns the outcome from mango-api (TM-W12) -------------------------------------


def test_the_next_turn_tells_the_agent_what_happened_once(env: Env) -> None:
    shown = _self_request(env)
    env.post("requester", f"{shown['approval_id']}/confirm")
    conversation = shown["conversation_id"]
    env.agentcore.arguments = []
    env.client.post(
        "/api/chat",
        headers=_h("requester"),
        json={"message": "gracias", "conversation_id": conversation},
    )
    sent = env.agentcore.requests[-1]["messages"][-1]["content"][0]["text"]
    assert sent.endswith("gracias")
    assert f"- {GATEWAY_TOOL}: was confirmed and executed successfully." in sent
    assert "team-a" not in sent  # the outcome only, nothing of the call or its answer
    env.client.post(
        "/api/chat",
        headers=_h("requester"),
        json={"message": "otra", "conversation_id": conversation},
    )
    assert env.agentcore.requests[-1]["messages"][-1]["content"][0]["text"] == "otra"


def test_running_is_rate_limited_per_person(env: Env) -> None:
    shown = _self_request(env)
    env.deps.run_limiter = RateLimiter(limit=1, window_seconds=60)
    env.executor.result = Execution(Outcome.NOT_RUN, "gateway_refused")
    assert env.post("requester", f"{shown['approval_id']}/confirm").status_code == 200
    limited = env.post("requester", f"{shown['approval_id']}/execute")
    assert (limited.status_code, _code(limited)) == (429, "rate_limited")
    assert limited.headers["Retry-After"].isdigit()
    assert len(env.executor.calls) == 1


# --- A write tool call cut by the token cap (D74) ---------------------------------------------
# The cap may fall while the model writes the input of the write tool. The stream is
# botocore's own (``harness_wire``): the pieces of ``toolUse`` that arrived, ``messageStop``
# with ``max_tokens``, the usage and the error the harness ends the invocation with.

WHOLE = '{"name":"team-a","amount_usd":100}'


def _write_call(*pieces: str, stop: bool = True) -> list[dict[str, Any]]:
    start = {"toolUse": {"toolUseId": "t1", "name": f"mango___{GATEWAY_TOOL}"}}
    return [
        {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": "Lo preparo."}}},
        {"contentBlockStart": {"contentBlockIndex": 1, "start": start}},
        *(
            {"contentBlockDelta": {"contentBlockIndex": 1, "delta": {"toolUse": {"input": piece}}}}
            for piece in pieces
        ),
        *([{"contentBlockStop": {"contentBlockIndex": 1}}] if stop else []),
    ]


def _turn_with(env: Env, *events: dict[str, Any], stop_reason: str) -> list[tuple[str, Any]]:
    """A chat turn whose model message is ``events`` and ends with ``stop_reason``. After a
    cap the harness ends the invocation with its error, as it does in an installation."""

    def invoke_harness(**request: Any) -> dict[str, Any]:
        env.agentcore.requests.append(request)
        return {
            "stream": wire_stream(
                *events,
                {"messageStop": {"stopReason": stop_reason}},
                {"metadata": {"usage": {"inputTokens": 100, "outputTokens": 10}}},
                error="runtimeClientError" if stop_reason == "max_tokens" else None,
            )
        }

    env.agentcore.invoke_harness = invoke_harness  # type: ignore[method-assign]
    response = env.client.post("/api/chat", headers=_h("requester"), json={"message": "crea uno"})
    assert response.status_code == 200, response.text
    return _events(response.text)


@pytest.mark.parametrize("stop", [True, False])
@pytest.mark.parametrize("cut", [1, 9, len(WHOLE) // 2, len(WHOLE) - 1])
def test_a_write_call_cut_mid_arguments_asks_for_no_confirmation(
    env: Env, cut: int, stop: bool
) -> None:
    stored: list[dict[str, Any]] = []
    add_message = env.conversations.add_message

    def record(*args: Any, **kwargs: Any) -> str:
        stored.append({"args": args, **kwargs})
        return add_message(*args, **kwargs)

    env.conversations.add_message = record  # type: ignore[method-assign]
    pieces = (WHOLE[: cut // 2], WHOLE[cut // 2 : cut])
    events = _turn_with(env, *_write_call(*pieces, stop=stop), stop_reason="max_tokens")
    kinds = [kind for kind, _ in events]
    # No request exists: nothing to show, to sign or to run.
    assert "approval" not in kinds
    assert env.audit.named("approval.request") == []
    assert env.store.by_requester("user-10") == []
    assert env.client.get(URL, headers=_h("requester")).json()["items"] == []
    assert env.executor.calls == []
    # What the person gets: the text, the tool as started and failed, and a normal end. No
    # error, and nothing of the half-written input.
    assert "error" not in kinds and kinds[-1] == "done"
    assert [data for kind, data in events if kind == "tool"] == [
        {"name": GATEWAY_TOOL, "status": "started"},
        {"name": GATEWAY_TOOL, "status": "error"},
    ]
    done = events[-1][1]
    assert done["stop_reason"] == "max_tokens"
    assert done["usage"] == {"input_tokens": 100, "output_tokens": 10}
    assert "team" not in json.dumps(events) and "team" not in json.dumps(env.audit.events)
    # The stored answer: the text up to the call, the tool, and no request.
    answer = stored[-1]
    assert answer["args"][2:4] == ("assistant", "Lo preparo.\n\n")
    assert answer["approvals"] == []
    # Audited as a turn that ended at its cap, with the usage of that call.
    ((_user, completed),) = env.audit.named("agent.completed", outcome=None)
    assert (completed["stop_reason"], completed["input_tokens"]) == ("max_tokens", 100)
    assert completed["tools"] == [GATEWAY_TOOL]
    # The session of that turn is not continued.
    conversation = next(data for kind, data in events if kind == "conversation")
    assert env.conversations.sessions[("user-10", conversation["conversation_id"])].used_at == 0


def test_no_cut_of_the_arguments_but_the_empty_one_can_become_a_request(env: Env) -> None:
    user = UserContext("user-10", "finops-central", None, False, email="r@x.co")
    for cut in range(1, len(WHOLE)):
        call = approvals_module.WriteCall(GATEWAY_TOOL, WHOLE[:cut])
        made = approvals_module.request_call(
            env.deps, user, write_agent(), "c" * 32, call=call, seen=set()
        )
        assert made is None, WHOLE[:cut]
    assert env.store.by_requester("user-10") == []
    assert env.audit.named("approval.request") == []
    # The whole input and the empty one are the only two that become a request.
    for arguments, shown in ((WHOLE, '{"amount_usd":100,"name":"team-a"}'), ("", "{}")):
        call = approvals_module.WriteCall(GATEWAY_TOOL, arguments)
        made = approvals_module.request_call(
            env.deps, user, write_agent(), "c" * 32, call=call, seen=set()
        )
        assert made is not None and made.arguments == shown


@pytest.mark.xfail(
    strict=True,
    reason=(
        "Defect, reported and not fixed here: a write call the cap cut before any piece of its "
        "input arrives with an empty input, which request_call reads as a call with no "
        "arguments ({}). A request is created, with its card, for a call the model never "
        "finished writing. See the report m1-harness-error-paths-2026-10-07."
    ),
)
@pytest.mark.parametrize("stop", [True, False])
def test_a_write_call_cut_before_any_argument_asks_for_no_confirmation(
    env: Env, stop: bool
) -> None:
    events = _turn_with(env, *_write_call(stop=stop), stop_reason="max_tokens")
    assert [data for kind, data in events if kind == "approval"] == []
    assert env.audit.named("approval.request") == []
    assert env.store.by_requester("user-10") == []


def test_a_call_without_arguments_is_shown_empty_and_runs_exactly_that(env: Env) -> None:
    """The chain a request with no arguments goes through: the one a model makes on purpose
    and, today, the one left by a call cut before its input (the test above)."""
    env.set_policy(condition=Condition.AMOUNT, amount_usd=Decimal(500))
    events = _turn_with(env, *_write_call(), stop_reason="tool_use")
    (shown,) = [data for kind, data in events if kind == "approval"]
    # The card shows the tool and no arguments: that is the call.
    assert shown["arguments"] == {} and shown["tool"] == TOOL
    # Its value cannot be read, so it is never below a threshold: who asked cannot confirm
    # it alone (fail closed).
    assert (shown["tier"], shown["rule"]["reason"]) == ("approvers", "unknown")
    assert env.post("requester", f"{shown['approval_id']}/confirm").status_code != 200
    assert env.executor.calls == []
    assert env.post("approver", f"{shown['approval_id']}/approve").json()["status"] == "approved"
    assert env.post("requester", f"{shown['approval_id']}/execute").json()["status"] == "executed"
    # What runs is what was shown and signed: the same tool, the same (empty) arguments.
    ((call, _token),) = env.executor.calls
    assert (call.gateway_tool, call.arguments) == (GATEWAY_TOOL, "{}")
    assert call.args_hash == call_hash(GATEWAY_TOOL, shown["arguments"])
    ((_user, detail),) = env.audit.named("approval.request")
    assert detail["args_hash"] == call.args_hash
