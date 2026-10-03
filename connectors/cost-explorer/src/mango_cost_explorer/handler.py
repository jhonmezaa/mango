"""AgentCore Gateway Lambda target for the FinOps agent.

The Gateway delivers only tool arguments. The REQUEST interceptor places the caller's
access token in the reserved ``_mango_ctx`` argument (D13); this handler re-verifies it and
derives identity from the token alone (TM-C1, TM-I1). Raw events are never logged.
"""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Callable
from dataclasses import dataclass
from functools import cache
from typing import TYPE_CHECKING, Any

import boto3
from botocore.exceptions import ClientError
from pydantic import BaseModel, ValidationError

from mango_aws import CallerIdentity, CrossAccountSessions, RoleChain, build_session_policy
from mango_core.identity import (
    AccessTokenVerifier,
    IdentityError,
    UserContext,
    require_role,
    user_from_claims,
)
from mango_cost_explorer import tools
from mango_cost_explorer.inventory import INVENTORY_ACTIONS, InventoryCache, load_accounts
from mango_cost_explorer.mapping import MappingCache, load_mapping
from mango_cost_explorer.scope import AccessScope, Account, resolve_scope

if TYPE_CHECKING:
    from mypy_boto3_organizations import OrganizationsClient

logger = logging.getLogger()
logger.setLevel(logging.INFO)

RESERVED_CONTEXT_ARG = "_mango_ctx"
TOOL_NAME_KEY = "bedrockAgentCoreToolName"
TOOL_NAME_DELIMITER = "___"
INVENTORY_IDENTITY = "mango-system-inventory"
AGENT_ID = "finops"


@dataclass(frozen=True)
class Settings:
    issuer: str
    client_id: str
    broker_role_arn: str
    reader_role_arn: str
    settings_table: str

    @staticmethod
    def from_env() -> Settings:
        return Settings(
            issuer=os.environ["COGNITO_ISSUER"],
            client_id=os.environ["COGNITO_CLIENT_ID"],
            broker_role_arn=os.environ["BILLING_BROKER_ROLE_ARN"],
            reader_role_arn=os.environ["BILLING_READER_ROLE_ARN"],
            settings_table=os.environ["SETTINGS_TABLE"],
        )


@dataclass(frozen=True)
class ToolSpec:
    args_model: type[BaseModel]
    actions: tuple[str, ...]
    run: Callable[[boto3.Session, AccessScope, Any], dict[str, Any]]
    central_only: bool = False


def _ce(session: boto3.Session) -> Any:
    return session.client("ce", region_name="us-east-1")


TOOLS: dict[str, ToolSpec] = {
    "list_accounts_in_scope": ToolSpec(
        tools.NoArgs, (), lambda _s, scope, a: tools.list_accounts_in_scope(scope, a)
    ),
    "get_cost_and_usage": ToolSpec(
        tools.CostAndUsageArgs,
        ("ce:GetCostAndUsage",),
        lambda s, scope, a: tools.get_cost_and_usage(_ce(s), scope, a),
    ),
    "get_cost_forecast": ToolSpec(
        tools.ForecastArgs,
        ("ce:GetCostForecast",),
        lambda s, scope, a: tools.get_cost_forecast(_ce(s), scope, a),
    ),
    "get_anomalies": ToolSpec(
        tools.AnomaliesArgs,
        ("ce:GetAnomalies",),
        lambda s, scope, a: tools.get_anomalies(_ce(s), scope, a),
    ),
    "get_savings_plans_coverage": ToolSpec(
        tools.CoverageArgs,
        ("ce:GetSavingsPlansCoverage",),
        lambda s, scope, a: tools.get_savings_plans_coverage(_ce(s), scope, a),
    ),
    "get_savings_plans_utilization": ToolSpec(
        tools.DateRange,
        ("ce:GetSavingsPlansUtilization",),
        lambda s, scope, a: tools.get_savings_plans_utilization(_ce(s), scope, a),
        central_only=True,
    ),
    "get_savings_plans_recommendation": ToolSpec(
        tools.SavingsPlansRecommendationArgs,
        ("ce:GetSavingsPlansPurchaseRecommendation",),
        lambda s, scope, a: tools.get_savings_plans_recommendation(_ce(s), scope, a),
        central_only=True,
    ),
}


class _Runtime:
    """Per execution environment dependencies, created lazily."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.verifier = AccessTokenVerifier(settings.issuer, settings.client_id)
        self.sessions = CrossAccountSessions()
        self.chain = RoleChain(settings.broker_role_arn, settings.reader_role_arn)
        self.inventory = InventoryCache(self._load_inventory)
        dynamodb = boto3.client("dynamodb")
        # Area -> OU mapping from the Settings table, fail closed (D17, TM-A6).
        self.mapping = MappingCache(lambda: load_mapping(dynamodb, settings.settings_table))

    def _load_inventory(self) -> list[Account]:
        session = self.sessions.assume(
            self.chain,
            CallerIdentity(source_identity=INVENTORY_IDENTITY, tags={"mango_agent": AGENT_ID}),
            build_session_policy(INVENTORY_ACTIONS),
        )
        org: OrganizationsClient = session.client("organizations", region_name="us-east-1")
        return load_accounts(org)


@cache
def _runtime() -> _Runtime:
    return _Runtime(Settings.from_env())


def _error(code: str, message: str) -> dict[str, Any]:
    return {"error": {"code": code, "message": message}}


def _tool_name(context: Any) -> str | None:
    custom = getattr(getattr(context, "client_context", None), "custom", None) or {}
    raw = custom.get(TOOL_NAME_KEY)
    if not isinstance(raw, str):
        return None
    return raw.split(TOOL_NAME_DELIMITER, 1)[-1]


def _caller(user: UserContext) -> CallerIdentity:
    return CallerIdentity(
        source_identity=user.user_id,
        tags={
            "mango_user": user.user_id,
            "mango_agent": AGENT_ID,
            "mango_bu": user.business_unit or "central",
        },
    )


class _RejectedError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.payload = _error(code, message)


def _authenticate(args: dict[str, Any], runtime: _Runtime) -> UserContext:
    mango_ctx = args.pop(RESERVED_CONTEXT_ARG, None)
    token = mango_ctx.get("token") if isinstance(mango_ctx, dict) else None
    if not isinstance(token, str) or not token:
        raise _RejectedError("unauthenticated", "missing caller identity")
    try:
        user = user_from_claims(runtime.verifier.verify(token))
        # Only FinOps roles reach billing data: a Mango group alone is not enough.
        require_role(user)
    except IdentityError as exc:
        raise _RejectedError("unauthenticated", "caller identity could not be verified") from exc
    return user


def _lookup(name: str | None) -> ToolSpec:
    spec = TOOLS.get(name or "")
    if spec is None:
        raise _RejectedError("unknown_tool", "unknown tool")
    return spec


def _parse(spec: ToolSpec, args: dict[str, Any]) -> BaseModel:
    try:
        return spec.args_model.model_validate(args)
    except ValidationError as exc:
        fields = sorted({".".join(str(p) for p in e["loc"]) for e in exc.errors()})
        raise _RejectedError(
            "invalid_arguments", f"invalid arguments: {', '.join(fields)}"
        ) from exc


def _execute(
    spec: ToolSpec, user: UserContext, scope: AccessScope, parsed: BaseModel, runtime: _Runtime
) -> tuple[str, dict[str, Any]]:
    """Run the tool; returns (outcome, result). AWS errors never leak internal details."""
    try:
        if spec.central_only:
            # Denied before any cross-account call (TM-C3).
            tools.require_central(scope)
        session = (
            runtime.sessions.assume(
                runtime.chain, _caller(user), build_session_policy(spec.actions)
            )
            if spec.actions
            else boto3.Session()
        )
        return "ok", spec.run(session, scope, parsed)
    except tools.ToolError as exc:
        return "denied", _error("not_allowed", str(exc))
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "DataUnavailableException":
            return "no_data", {
                "status": "no_data",
                "message": "No data is available for this query.",
            }
        logger.exception("AWS call failed")
        return "upstream_error", _error(
            "upstream_error", "the billing service could not answer; try again later"
        )


def handle(event: dict[str, Any], context: Any, runtime: _Runtime) -> dict[str, Any]:
    args = dict(event)
    name = _tool_name(context)
    try:
        user = _authenticate(args, runtime)
        spec = _lookup(name)
        parsed = _parse(spec, args)
    except _RejectedError as rejected:
        return rejected.payload

    scope = resolve_scope(user, runtime.inventory.get(), runtime.mapping.get())
    outcome, result = _execute(spec, user, scope, parsed, runtime)
    # Operational log without arguments, tokens or results.
    logger.info(
        json.dumps(
            {
                "event": "tool.call",
                "tool": name,
                "user": user.user_id,
                "org_wide": scope.org_wide,
                "outcome": outcome,
            }
        )
    )
    return result


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    return handle(event, context, _runtime())
