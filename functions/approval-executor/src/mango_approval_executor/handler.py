"""Approval executor: AgentCore Gateway Lambda target of Mango's write tools (D27, §4.10).

The only code of Mango that changes anything in an AWS account, and the only principal that
can assume the operate broker. It runs a tool only when the call carries, in the reserved
``_mango_ctx`` argument the Gateway interceptor fills:

* the caller's access token, verified again here (identity comes from it alone), and
* an approval token signed by mango-api for exactly this person, this tool and the hash of
  these arguments, which this function spends on its request before doing anything (single
  use, and only after the Gateway spent its own mark).

It trusts neither the model nor the Gateway: a call that reaches the Lambda any other way has
no valid approval and changes nothing. The write then runs as the person who asked
(``SourceIdentity``), tagged with the approval, under a session policy that names the one
resource of this call. Events, tokens and arguments are never logged.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from functools import cache
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from pydantic import BaseModel, ValidationError

from mango_approval_executor import budgets
from mango_aws import CrossAccountSessions, RoleChain, build_session_policy
from mango_aws.operate import write_caller
from mango_core import approval, approval_use
from mango_core.identity import AccessTokenVerifier, IdentityError, UserContext, user_from_claims

logger = logging.getLogger()
logger.setLevel(logging.INFO)

RESERVED_CONTEXT_ARG = "_mango_ctx"
TOOL_NAME_KEY = "bedrockAgentCoreToolName"
TOOL_NAME_DELIMITER = "___"
_ACCOUNT_RE = re.compile(r"^arn:aws[a-z-]*:iam::(\d{12}):role/")
_PREFIX_RE = re.compile(r"^Mango-[a-z0-9]{1,12}-$")
_CONFIG = Config(retries={"mode": "standard", "max_attempts": 2}, connect_timeout=2, read_timeout=5)


@dataclass(frozen=True)
class Settings:
    issuer: str
    client_id: str
    broker_role_arn: str
    budgets_role_arn: str
    approvals_table: str
    approval_key_arn: str
    resource_prefix: str
    """``Mango-<ns>-``: every resource this function creates is named with it (rule 6)."""

    @staticmethod
    def from_env() -> Settings:
        prefix = os.environ["RESOURCE_PREFIX"]
        if not _PREFIX_RE.fullmatch(prefix):
            raise ValueError("RESOURCE_PREFIX must be Mango-<namespace>-")
        return Settings(
            issuer=os.environ["COGNITO_ISSUER"],
            client_id=os.environ["COGNITO_CLIENT_ID"],
            broker_role_arn=os.environ["OPERATE_BROKER_ROLE_ARN"],
            budgets_role_arn=os.environ["BUDGETS_OPERATOR_ROLE_ARN"],
            approvals_table=os.environ["APPROVALS_TABLE"],
            approval_key_arn=os.environ["APPROVAL_KEY_ARN"],
            resource_prefix=prefix,
        )


@dataclass(frozen=True)
class Call:
    """One approved call, with everything about who asked taken from verified tokens."""

    user: UserContext
    approval: approval.Approval


class Runtime:
    """Per execution environment dependencies."""

    def __init__(
        self,
        settings: Settings,
        *,
        verifier: AccessTokenVerifier,
        approvals: Callable[[], approval.ApprovalVerifier],
        claim: Callable[[approval.Approval, int], None],
        sessions: CrossAccountSessions,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.settings = settings
        self.verifier = verifier
        self.approvals = approvals
        self.claim = claim
        self.sessions = sessions
        self.clock = clock


@cache
def _runtime() -> Runtime:
    settings = Settings.from_env()
    kms = boto3.client("kms", config=_CONFIG)
    dynamodb = boto3.client("dynamodb", config=_CONFIG)

    @cache
    def approvals() -> approval.ApprovalVerifier:
        public_key = kms.get_public_key(KeyId=settings.approval_key_arn)["PublicKey"]
        return approval.ApprovalVerifier(public_key)

    def claim(approved: approval.Approval, now: int) -> None:
        approval_use.claim(
            dynamodb,
            settings.approvals_table,
            approved,
            mark=approval_use.EXECUTOR_MARK,
            after=approval_use.GATEWAY_MARK,
            now=now,
        )

    return Runtime(
        settings,
        verifier=AccessTokenVerifier(settings.issuer, settings.client_id),
        approvals=approvals,
        claim=claim,
        sessions=CrossAccountSessions(),
    )


def _error(code: str, message: str) -> dict[str, Any]:
    return {"error": {"code": code, "message": message}}


class _RejectedError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.payload = _error(code, message)


def _create_budget(runtime: Runtime, call: Call, args: BaseModel) -> dict[str, Any]:
    if not isinstance(args, budgets.CreateBudgetArgs):
        raise _RejectedError("invalid_arguments", "invalid arguments")
    settings = runtime.settings
    match = _ACCOUNT_RE.match(settings.budgets_role_arn)
    if match is None:
        raise _RejectedError("unavailable", "the tool is not configured")
    account_id = match.group(1)
    name = budgets.budget_name(settings.resource_prefix, args)
    session = runtime.sessions.assume(
        RoleChain(settings.broker_role_arn, settings.budgets_role_arn),
        write_caller(
            user_id=call.user.user_id,
            agent_id=call.approval.agent_id,
            approval_id=call.approval.approval_id,
        ),
        # Only the budget of this call, whatever the role allows (TM-W8).
        build_session_policy(budgets.ACTIONS, [budgets.budget_arn(account_id, name)]),
    )
    client = session.client("budgets", region_name="us-east-1", config=_CONFIG)
    return budgets.create_budget(client, account_id, name, args)


@dataclass(frozen=True)
class ToolSpec:
    args_model: type[BaseModel]
    run: Callable[[Runtime, Call, BaseModel], dict[str, Any]]
    central_only: bool = True
    """Acts on the whole organization: only central FinOps (also enforced by Cedar L2)."""


TOOLS: dict[str, ToolSpec] = {
    "create_budget": ToolSpec(budgets.CreateBudgetArgs, _create_budget),
}


def _gateway_tool(context: Any) -> str | None:
    custom = getattr(getattr(context, "client_context", None), "custom", None) or {}
    raw = custom.get(TOOL_NAME_KEY)
    return raw if isinstance(raw, str) else None


def _authorize(args: dict[str, Any], gateway_tool: str, spec: ToolSpec, runtime: Runtime) -> Call:
    """Who is calling and under which approval; both verified here, never taken on trust."""
    mango_ctx = args.pop(RESERVED_CONTEXT_ARG, None)
    token = mango_ctx.get("token") if isinstance(mango_ctx, dict) else None
    approval_token = mango_ctx.get("approval") if isinstance(mango_ctx, dict) else None
    if not isinstance(token, str) or not token:
        raise _RejectedError("unauthenticated", "missing caller identity")
    try:
        user = user_from_claims(runtime.verifier.verify(token))
    except IdentityError as exc:
        raise _RejectedError("unauthenticated", "caller identity could not be verified") from exc
    if spec.central_only and not user.is_central:
        raise _RejectedError("not_allowed", "this action is for central FinOps only")
    try:
        approved = runtime.approvals().verify(
            approval_token, subject=user.user_id, tool=gateway_tool, arguments=args
        )
    except approval.ApprovalError:
        raise _RejectedError("approval_required", "this call has no valid approval") from None
    return Call(user=user, approval=approved)


def _parse(spec: ToolSpec, args: dict[str, Any]) -> BaseModel:
    try:
        return spec.args_model.model_validate(args)
    except ValidationError as exc:
        fields = sorted({".".join(str(p) for p in e["loc"]) for e in exc.errors()})
        raise _RejectedError(
            "invalid_arguments", f"invalid arguments: {', '.join(fields)}"
        ) from exc


def _log(tool: str | None, outcome: str, call: Call | None = None) -> None:
    # Operational log without arguments, tokens or results.
    logger.info(
        json.dumps(
            {
                "event": "tool.write",
                "tool": tool,
                "user": call.user.user_id if call else None,
                "approval": call.approval.approval_id if call else None,
                "outcome": outcome,
            }
        )
    )


def handle(event: dict[str, Any], context: Any, runtime: Runtime) -> dict[str, Any]:
    args = dict(event)
    gateway_tool = _gateway_tool(context)
    name = gateway_tool.split(TOOL_NAME_DELIMITER, 1)[-1] if gateway_tool else None
    spec = TOOLS.get(name or "")
    call: Call | None = None
    if gateway_tool is None or spec is None:
        _log(name, "unknown_tool")
        return _error("unknown_tool", "unknown tool")
    try:
        call = _authorize(args, gateway_tool, spec, runtime)
        parsed = _parse(spec, args)
        try:
            # Spent before anything is changed: a second delivery of this call does nothing.
            runtime.claim(call.approval, int(runtime.clock()))
        except approval_use.ApprovalUsedError:
            raise _RejectedError("approval_used", "this approval was already used") from None
        result = spec.run(runtime, call, parsed)
    except _RejectedError as rejected:
        _log(name, str(rejected.payload["error"]["code"]), call)
        return rejected.payload
    except budgets.ToolFailedError as failed:
        _log(name, failed.code, call)
        return _error(failed.code, str(failed))
    except (ClientError, BotoCoreError):
        # AWS errors never leak internal details.
        logger.exception("write failed")
        _log(name, "upstream_error", call)
        return _error("upstream_error", "the change could not be applied")
    _log(name, "ok", call)
    return result


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    return handle(event, context, _runtime())
