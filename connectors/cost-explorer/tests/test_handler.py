from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

import pytest
from botocore.exceptions import ClientError

from mango_core.identity import IdentityError
from mango_cost_explorer import handler
from mango_cost_explorer.scope import Account

ACCOUNTS = [
    Account("111111111111", "Sandbox", ("r", "ou-sbx")),
    Account("222222222222", "Audit", ("r", "ou-sec")),
]
TOKENS = {
    "bu-token": {"sub": "u-bu", "mango_role": "bu-lead", "mango_business_unit": "security"},
    "central-token": {"sub": "u-central", "mango_role": "finops-central"},
    # A Mango group (and even a business unit) without a FinOps role.
    "group-token": {
        "sub": "u-group",
        "mango_business_unit": "security",
        "cognito:groups": ["bu-security", "mango-agent-creator"],
    },
}


class _Verifier:
    def verify(self, token: str) -> dict[str, Any]:
        if token not in TOKENS:
            raise IdentityError("invalid access token")
        return TOKENS[token]


@dataclass
class _Sessions:
    calls: list[tuple[str, str]] = field(default_factory=list)

    def assume(self, _chain: Any, caller: Any, policy: str) -> Any:
        self.calls.append((caller.source_identity, policy))
        return SimpleNamespace()


def _runtime() -> Any:
    rt = SimpleNamespace(
        mapping=SimpleNamespace(get=lambda: {"security": frozenset({"ou-sec"})}),
        verifier=_Verifier(),
        sessions=_Sessions(),
        chain=None,
        inventory=SimpleNamespace(get=lambda: ACCOUNTS),
    )
    return rt


def _ctx(tool: str) -> Any:
    return SimpleNamespace(
        client_context=SimpleNamespace(custom={"bedrockAgentCoreToolName": f"finops___{tool}"})
    )


def test_missing_identity_is_rejected() -> None:
    result = handler.handle({}, _ctx("list_accounts_in_scope"), _runtime())
    assert result["error"]["code"] == "unauthenticated"


def test_forged_identity_is_rejected() -> None:
    event = {"_mango_ctx": {"token": "forged-by-model"}}
    result = handler.handle(event, _ctx("list_accounts_in_scope"), _runtime())
    assert result["error"]["code"] == "unauthenticated"


def test_group_without_finops_role_is_rejected_before_any_aws_call() -> None:
    rt = _runtime()
    event = {"_mango_ctx": {"token": "group-token"}}
    for tool in ("list_accounts_in_scope", "get_cost_and_usage"):
        result = handler.handle(dict(event), _ctx(tool), rt)
        assert result["error"]["code"] == "unauthenticated"
    assert rt.sessions.calls == []


def test_identity_comes_only_from_token() -> None:
    event = {"_mango_ctx": {"token": "bu-token"}}
    result = handler.handle(event, _ctx("list_accounts_in_scope"), _runtime())
    assert result == {
        "org_wide": False,
        "accounts": [
            {
                "account_id": "222222222222",
                "name": "Audit",
                "business_units": ["security"],
                "ou_path": [],
            }
        ],
    }


def test_identity_fields_in_arguments_are_rejected() -> None:
    event = {"_mango_ctx": {"token": "bu-token"}, "mango_role": "finops-central"}
    result = handler.handle(event, _ctx("list_accounts_in_scope"), _runtime())
    assert result["error"]["code"] == "invalid_arguments"


def test_unknown_tool() -> None:
    event = {"_mango_ctx": {"token": "bu-token"}}
    result = handler.handle(event, _ctx("delete_everything"), _runtime())
    assert result["error"]["code"] == "unknown_tool"


def test_org_wide_tool_denied_to_bu_lead_without_assuming_roles() -> None:
    rt = _runtime()
    event = {"_mango_ctx": {"token": "bu-token"}}
    result = handler.handle(event, _ctx("get_savings_plans_recommendation"), rt)
    assert result["error"]["code"] == "not_allowed"
    assert rt.sessions.calls == []


def test_tool_assumes_role_with_user_identity_and_minimal_policy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rt = _runtime()
    monkeypatch.setitem(
        handler.TOOLS,
        "get_cost_forecast",
        handler.ToolSpec(
            handler.tools.ForecastArgs, ("ce:GetCostForecast",), lambda _s, _sc, _a: {"ok": True}
        ),
    )
    event = {
        "_mango_ctx": {"token": "central-token"},
        "start_date": "2099-01-01",
        "end_date": "2099-02-01",
    }
    assert handler.handle(event, _ctx("get_cost_forecast"), rt) == {"ok": True}
    source_identity, policy = rt.sessions.calls[0]
    assert source_identity == "u-central"
    assert "ce:GetCostForecast" in policy
    assert "ce:GetCostAndUsage" not in policy


@pytest.mark.parametrize("tool", sorted(handler.TOOLS))
def test_every_tool_has_minimal_actions(tool: str) -> None:
    for action in handler.TOOLS[tool].actions:
        assert "*" not in action


def _failing_tool(code: str) -> handler.ToolSpec:
    def run(_s: Any, _sc: Any, _a: Any) -> dict[str, Any]:
        raise ClientError({"Error": {"Code": code, "Message": "internal detail"}}, "Op")

    return handler.ToolSpec(handler.tools.CoverageArgs, ("ce:GetSavingsPlansCoverage",), run)


@pytest.mark.parametrize(
    ("code", "expected"),
    [("DataUnavailableException", "no_data"), ("ThrottlingException", "upstream_error")],
)
def test_aws_errors_are_translated_without_internals(
    monkeypatch: pytest.MonkeyPatch, code: str, expected: str
) -> None:
    monkeypatch.setitem(handler.TOOLS, "get_savings_plans_coverage", _failing_tool(code))
    event = {
        "_mango_ctx": {"token": "bu-token"},
        "start_date": "2026-09-01",
        "end_date": "2026-10-01",
    }
    result = handler.handle(event, _ctx("get_savings_plans_coverage"), _runtime())
    assert expected in str(result)
    assert "internal detail" not in str(result)
