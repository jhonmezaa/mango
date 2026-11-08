"""MCP Apps of remote MCP tools in the chat (D125 (3), (4)).

A remote tool whose signed profile curates an interface (``_meta.ui``, A1) gets an app under
the answer that called it. The turn keeps what the app needs, in the person's partition of
``Conversations`` (``APP#<conversation>#<app>``): the tool's input and its answer, already cut
by the ``RESPONSE`` interceptor. The SPA reads the app with its HTML, checks the hash again and
draws it in the runner of the second origin, which answers the app's bridge.

* ``GET /api/conversations/{conversation}/apps/{app}``: the app, its curated HTML (from the
  release's signed profile, never from the server: the Gateway has no ``resources/read``,
  D98 (16)), the input and the answer of its call, and how many calls it has made this turn.
* ``POST /api/conversations/{conversation}/apps/{app}/calls``: a ``tools/call`` of the app.
  mango-api decides it as it decides the model's call: the tool must be one the app may call
  (``calls`` of the profile) and one the conversation's agent may use now (its published
  version, the registration ``active``, the signed approved catalog and ``UseRemoteMcp``),
  the budget must have room, and the Gateway gets the person's token and an invocation
  signature that names only that tool (Cedar L2, interceptor). Read tools only: a remote
  profile has nothing else (D93 (2)).

Security notes (threat model ``ui-sandbox``: TM-UI6, TM-UI7, TM-UI8, TM-UI10;
security-best-practices, FastAPI):
* Every route needs a verified access token and ``OwnConversation`` with the owner of the
  record (row-level security on the partition first): someone else's app answers 404.
* An app makes at most ``CALLS_PER_TURN`` calls (counted with a conditional write on its
  record) and a person ``CALLS_PER_MINUTE`` calls of all their apps (shared limiter).
* Bodies forbid extra fields; the arguments are bounded in size and depth. Responses use
  explicit models. The arguments and the answers never reach a log or the audit trail: each
  call is audited (``mcp_app.call``, origin ``app``) with its tool and outcome only, before
  its answer leaves (fail closed).
"""

# No `from __future__ import annotations`: FastAPI resolves route annotations at runtime.
import asyncio
import json
import logging
import secrets
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Annotated, Any, Literal

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, Path
from pydantic import BaseModel, ConfigDict, Field, field_validator

from mango_api.audit import AuditLog
from mango_api.gateway_mcp import AppCallOutcome, GatewayAppCalls
from mango_api.harness import AppCall
from mango_api.published import PublishedAgent
from mango_api.rate_limits import Limiter
from mango_api.remote_mcp_store import ApprovedRemotes
from mango_api.remote_release import ReleaseRemotes, RemoteReleaseUnavailableError
from mango_api.web import ApiError, Caller, rate_limited
from mango_core import remote_mcp
from mango_core.identity import UserContext
from mango_packs.remote import ToolUi

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient

logger = logging.getLogger(__name__)

APP_PREFIX = "APP#"
CALLS_PER_TURN = 20
"""Calls one app may make in its turn (TM-UI6; the design's «{n} de 20 llamadas»)."""
CALLS_PER_MINUTE = 30
"""Calls of all the apps of one person per minute (TM-UI6)."""
MAX_ARGUMENT_CHARS = 16 * 1024
MAX_ARGUMENT_DEPTH = 8
EVENT_CALL = "mcp_app.call"
ID_PATTERN = r"^[0-9a-f]{32}$"
TOOL_PATTERN = r"^[A-Za-z][A-Za-z0-9_-]{0,63}$"


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


# --- Models ---------------------------------------------------------------------------------


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AppTextBlock(_Strict):
    type: Literal["text"] = "text"
    text: str


class AppToolResult(_Strict):
    """``CallToolResult`` as an app gets it: the text blocks of the answer and its error mark."""

    content: list[AppTextBlock]
    is_error: bool


class McpAppOut(_Strict):
    app_id: str
    registration_id: str
    service: str
    """The name of the remote MCP («Azure DevOps»): the label «app de {MCP}» (TM-UI10)."""
    tool: str
    html: str
    """The curated HTML of the signed profile; the SPA checks ``html_sha256`` before drawing."""
    html_sha256: str
    tool_input: dict[str, Any]
    tool_result: AppToolResult
    calls_used: int
    calls_limit: int


class McpAppCallIn(_Strict):
    name: Annotated[str, Field(pattern=TOOL_PATTERN)]
    arguments: dict[str, Any] = {}

    @field_validator("arguments")
    @classmethod
    def _bounded(cls, value: dict[str, Any]) -> dict[str, Any]:
        if len(json.dumps(value, separators=(",", ":"))) > MAX_ARGUMENT_CHARS:
            raise ValueError("arguments too large")
        if _depth(value) > MAX_ARGUMENT_DEPTH:
            raise ValueError("arguments nested too deep")
        return value


class McpAppCallOut(_Strict):
    result: AppToolResult
    calls_used: int
    calls_limit: int


def _depth(value: object, level: int = 0) -> int:
    if isinstance(value, dict):
        return max((_depth(v, level + 1) for v in value.values()), default=level + 1)
    if isinstance(value, list):
        return max((_depth(v, level + 1) for v in value), default=level + 1)
    return level


# --- Store ----------------------------------------------------------------------------------


@dataclass(frozen=True)
class AppInstance:
    app_id: str
    owner: str
    """The partition the record was read from: never a value of the request."""
    conversation_id: str
    turn_id: str
    agent_id: str
    registration_id: str
    profile_id: str
    tool: str
    tool_input: str
    tool_output: str
    calls: int


class McpAppStoreUnavailableError(Exception):
    pass


class McpAppStore:
    """The apps of a person's conversations, in their partition of ``Conversations`` (RLS)."""

    def __init__(self, clients: Callable[[str], "DynamoDBClient"], table: str) -> None:
        self._clients = clients
        self._table = table

    @staticmethod
    def _key(user_id: str, conversation_id: str, app_id: str) -> dict[str, Any]:
        return {
            "PK": {"S": f"USER#{user_id}"},
            "SK": {"S": f"{APP_PREFIX}{conversation_id}#{app_id}"},
        }

    def put(self, instance: AppInstance) -> None:
        item = {
            **self._key(instance.owner, instance.conversation_id, instance.app_id),
            "turn_id": {"S": instance.turn_id},
            "agent_id": {"S": instance.agent_id},
            "registration_id": {"S": instance.registration_id},
            "profile_id": {"S": instance.profile_id},
            "tool": {"S": instance.tool},
            "tool_input": {"S": instance.tool_input},
            "tool_output": {"S": instance.tool_output},
            "calls": {"N": "0"},
            "created_at": {"S": _now()},
        }
        self._clients(instance.owner).put_item(
            TableName=self._table, Item=item, ConditionExpression="attribute_not_exists(SK)"
        )

    def get(self, user_id: str, conversation_id: str, app_id: str) -> AppInstance | None:
        try:
            item = (
                self._clients(user_id)
                .get_item(
                    TableName=self._table,
                    Key=self._key(user_id, conversation_id, app_id),
                    ConsistentRead=True,
                )
                .get("Item")
            )
        except (BotoCoreError, ClientError) as exc:
            raise McpAppStoreUnavailableError("apps cannot be read") from exc
        if item is None:
            return None
        return AppInstance(
            app_id=app_id,
            owner=user_id,
            conversation_id=conversation_id,
            turn_id=item["turn_id"]["S"],
            agent_id=item["agent_id"]["S"],
            registration_id=item["registration_id"]["S"],
            profile_id=item["profile_id"]["S"],
            tool=item["tool"]["S"],
            tool_input=item.get("tool_input", {}).get("S", "{}"),
            tool_output=item.get("tool_output", {}).get("S", ""),
            calls=int(item.get("calls", {}).get("N", "0")),
        )

    def take_call(self, instance: AppInstance, limit: int) -> int | None:
        """Count one call of the app; the new count, or ``None`` when it reached ``limit``."""
        try:
            answer = self._clients(instance.owner).update_item(
                TableName=self._table,
                Key=self._key(instance.owner, instance.conversation_id, instance.app_id),
                UpdateExpression="ADD calls :one",
                ConditionExpression="attribute_exists(SK) AND calls < :limit",
                ExpressionAttributeValues={":one": {"N": "1"}, ":limit": {"N": str(limit)}},
                ReturnValues="UPDATED_NEW",
            )
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                return None
            raise McpAppStoreUnavailableError("the call cannot be counted") from exc
        except BotoCoreError as exc:
            raise McpAppStoreUnavailableError("the call cannot be counted") from exc
        return int(answer["Attributes"]["calls"]["N"])


# --- Use cases ------------------------------------------------------------------------------


@dataclass
class McpAppsDeps:
    store: McpAppStore
    release: ReleaseRemotes
    approved: ApprovedRemotes | None
    gateway: GatewayAppCalls | None
    agent: Callable[[str, UserContext], PublishedAgent | None]
    """The agent as this person may use it now (``usable_by``), or ``None``."""
    budget_open: Callable[[UserContext, str], bool]
    """Whether the person's and the agent's budgets have room (raises when unknown)."""
    calls: Limiter
    audit: AuditLog


def _profile_app(
    deps: McpAppsDeps, registration_id: str, tool: str
) -> tuple[str, str, int, ToolUi] | None:
    """``(profile id, service name, max chars, app)`` of a remote tool, from the signed
    catalog (which profile the registration is) and the release (what the profile curates)."""
    approved = deps.approved.get(registration_id) if deps.approved is not None else None
    if approved is None or tool not in approved.tools:
        return None
    try:
        remote = deps.release.get(approved.profile_id)
    except RemoteReleaseUnavailableError:
        return None
    if remote is None:
        return None
    app = remote.profile.apps.get(tool)
    if app is None or app.resource_uri not in remote.ui_resources:
        return None
    return remote.profile.id, remote.profile.name, remote.profile.max_result_chars, app


def _split(gateway_tool: str) -> tuple[str, str] | None:
    target, separator, tool = gateway_tool.partition(remote_mcp.TOOL_SEPARATOR)
    registration = remote_mcp.registration_of_target(target) if separator else None
    return (registration, tool) if registration is not None and tool else None


def app_tools(deps: McpAppsDeps | None, agent: PublishedAgent) -> frozenset[str]:
    """Gateway names of the agent's remote tools that have an app (what the turn records)."""
    if deps is None:
        return frozenset()
    names: set[str] = set()
    for registration, _, gateway in agent.remote_tools:
        split = _split(gateway)
        if split is not None and _profile_app(deps, registration, split[1]) is not None:
            names.add(gateway)
    return frozenset(names)


def create_apps(  # noqa: PLR0917 - the turn's own ids, in the order a turn knows them
    deps: McpAppsDeps | None,
    user_id: str,
    conversation_id: str,
    turn_id: str,
    agent: PublishedAgent,
    calls: list[AppCall],
) -> list[dict[str, str]]:
    """Store the app of each call of the turn; what the message keeps of each one (ids and
    the tool, never the answer). An app that cannot be stored is left out: the answer is not."""
    if deps is None:
        return []
    registrations = {gateway: reg for reg, _, gateway in agent.remote_tools}
    apps: list[dict[str, str]] = []
    for call in calls:
        split = _split(call.gateway_tool)
        registration = registrations.get(call.gateway_tool)
        if split is None or registration != split[0]:
            continue
        found = _profile_app(deps, registration, split[1])
        if found is None:
            continue
        app_id = secrets.token_hex(16)
        instance = AppInstance(
            app_id=app_id,
            owner=user_id,
            conversation_id=conversation_id,
            turn_id=turn_id,
            agent_id=agent.agent_id,
            registration_id=registration,
            profile_id=found[0],
            tool=split[1],
            tool_input=_input_object(call.input),
            tool_output=call.output,
            calls=0,
        )
        try:
            deps.store.put(instance)
        except (BotoCoreError, ClientError):
            logger.exception("an MCP App of a turn was not stored")
            continue
        apps.append({"app_id": app_id, "registration_id": registration, "tool": split[1]})
    return apps


def _input_object(raw: str) -> str:
    """The model's input as a JSON object, or ``{}``: an app only gets an object."""
    try:
        value = json.loads(raw) if raw else {}
    except ValueError:
        return "{}"
    return json.dumps(value if isinstance(value, dict) else {}, separators=(",", ":"))


def _app_of(deps: McpAppsDeps, instance: AppInstance) -> tuple[str, str, int, ToolUi]:
    found = _profile_app(deps, instance.registration_id, instance.tool)
    if found is None or found[0] != instance.profile_id:
        # The release or the registration no longer curates it: the turn keeps its step.
        raise ApiError(404, "app_unavailable", "this app is not available any more")
    return found


def app_detail(deps: McpAppsDeps, instance: AppInstance) -> McpAppOut:
    _, service, _, app = _app_of(deps, instance)
    remote = deps.release.get(instance.profile_id)
    if remote is None:
        raise ApiError(404, "app_unavailable", "this app is not available any more")
    try:
        tool_input = json.loads(instance.tool_input)
    except ValueError:
        tool_input = {}
    return McpAppOut(
        app_id=instance.app_id,
        registration_id=instance.registration_id,
        service=service,
        tool=instance.tool,
        html=remote.ui_resources[app.resource_uri],
        html_sha256=app.html_sha256,
        tool_input=tool_input if isinstance(tool_input, dict) else {},
        tool_result=AppToolResult(
            content=[AppTextBlock(text=instance.tool_output)], is_error=False
        ),
        calls_used=min(instance.calls, CALLS_PER_TURN),
        calls_limit=CALLS_PER_TURN,
    )


def _audit(
    deps: McpAppsDeps, caller: Caller, instance: AppInstance, tool: str, outcome: str
) -> None:
    try:
        deps.audit.emit(
            EVENT_CALL,
            caller.user.user_id,
            {
                "origin": "app",
                "app": instance.app_id,
                "conversation_id": instance.conversation_id,
                "agent": instance.agent_id,
                "registration": instance.registration_id,
                "tool": tool,
                "outcome": outcome,
            },
            caller.user,
        )
    except Exception as exc:
        # No answer of a tool leaves without its trail (fail closed).
        raise ApiError(503, "audit_unavailable", "please try again") from exc


def _budget_open(deps: McpAppsDeps, user: UserContext, agent_id: str) -> bool:
    """Fails closed: without a known budget, no call."""
    try:
        return deps.budget_open(user, agent_id)
    except ApiError:
        raise
    except Exception as exc:
        raise ApiError(503, "budget_unavailable", "please try again") from exc


def call_tool(
    deps: McpAppsDeps, caller: Caller, instance: AppInstance, body: McpAppCallIn
) -> McpAppCallOut:
    user = caller.user
    _, _, max_chars, app = _app_of(deps, instance)
    if body.name not in app.calls:
        # Not a tool of the app (TM-UI6): another server's, or one the model alone may call.
        _audit(deps, caller, instance, body.name, "not_allowed")
        raise ApiError(403, "app_tool_not_allowed", "this app cannot call that tool")
    if not deps.calls.allow(user.user_id):
        _audit(deps, caller, instance, body.name, "rate_limited")
        raise rate_limited(deps.calls.retry_after(user.user_id))
    agent = deps.agent(instance.agent_id, user)
    gateway_tool = remote_mcp.gateway_tool_name(instance.registration_id, body.name)
    if agent is None or not any(
        reg == instance.registration_id and gateway == gateway_tool
        for reg, _, gateway in agent.remote_tools
    ):
        # The agent no longer has it, the registration is not active or the person is not in
        # its groups (UseRemoteMcp): what the model could not call, the app cannot either.
        _audit(deps, caller, instance, body.name, "denied")
        raise ApiError(403, "app_call_denied", "your groups cannot use that tool")
    if not _budget_open(deps, user, instance.agent_id):
        _audit(deps, caller, instance, body.name, "budget_exceeded")
        raise ApiError(402, "budget_exceeded", "monthly AI budget exhausted")
    if deps.gateway is None:
        raise ApiError(503, "gateway_unavailable", "please try again in a few minutes")
    try:
        used = deps.store.take_call(instance, CALLS_PER_TURN)
    except McpAppStoreUnavailableError as exc:
        raise ApiError(503, "apps_unavailable", "please try again") from exc
    if used is None:
        _audit(deps, caller, instance, body.name, "call_limit")
        raise ApiError(429, "app_call_limit", "this app reached its calls of this turn")
    answer = deps.gateway.call(
        subject=user.user_id,
        access_token=caller.token,
        token_expires_at=caller.expires_at,
        agent_id=agent.agent_id,
        agent_version=agent.version,
        registration_id=instance.registration_id,
        tool=body.name,
        arguments=body.arguments,
        max_chars=max_chars,
    )
    _audit(deps, caller, instance, body.name, answer.outcome.value)
    if answer.outcome is AppCallOutcome.CONSENT_REQUIRED:
        raise ApiError(409, "consent_required", "connect your account to use this app")
    if answer.outcome is AppCallOutcome.FAILED:
        raise ApiError(502, "remote_unavailable", "the service does not answer now")
    return McpAppCallOut(
        result=AppToolResult(
            content=[AppTextBlock(text=text) for text in answer.texts],
            is_error=answer.outcome is AppCallOutcome.TOOL_ERROR,
        ),
        calls_used=used,
        calls_limit=CALLS_PER_TURN,
    )


# --- Router ---------------------------------------------------------------------------------

OwnConversation = Callable[[Caller, str, str, bool], Awaitable[None]]
"""``(caller, conversation_id, owner, read_only)``: L1 ``OwnConversation``, audited, 404 when
denied (``app.own_conversation``)."""


def mcp_apps_router(
    deps: McpAppsDeps,
    current_user: Callable[..., Awaitable[Caller]],
    own: OwnConversation,
) -> APIRouter:
    router = APIRouter(prefix="/api/conversations")
    ConversationId = Annotated[str, Path(pattern=ID_PATTERN)]  # noqa: N806
    AppId = Annotated[str, Path(pattern=ID_PATTERN)]  # noqa: N806
    SignedIn = Annotated[Caller, Depends(current_user)]  # noqa: N806

    async def instance_of(
        caller: Caller, conversation_id: str, app_id: str, *, read_only: bool
    ) -> AppInstance:
        """An app of the caller's partition, then ``OwnConversation`` with its record's owner:
        someone else's and one that does not exist answer the same 404."""
        try:
            found = await asyncio.to_thread(
                deps.store.get, caller.user.user_id, conversation_id, app_id
            )
        except McpAppStoreUnavailableError as exc:
            raise ApiError(503, "apps_unavailable", "please try again") from exc
        if found is None:
            raise ApiError(404, "not_found", "not found")
        await own(caller, conversation_id, found.owner, read_only)
        return found

    @router.get("/{conversation_id}/apps/{app_id}", response_model=McpAppOut)
    async def get_mcp_app(
        conversation_id: ConversationId, app_id: AppId, caller: SignedIn
    ) -> McpAppOut:
        instance = await instance_of(caller, conversation_id, app_id, read_only=True)
        return await asyncio.to_thread(app_detail, deps, instance)

    @router.post("/{conversation_id}/apps/{app_id}/calls", response_model=McpAppCallOut)
    async def call_mcp_app_tool(
        conversation_id: ConversationId, app_id: AppId, body: McpAppCallIn, caller: SignedIn
    ) -> McpAppCallOut:
        """A ``tools/call`` of the app (D125 (4)): read only, of its own MCP, through the
        Gateway with Cedar and the budget, counted per app and turn and per person."""
        instance = await instance_of(caller, conversation_id, app_id, read_only=False)
        return await asyncio.to_thread(call_tool, deps, caller, instance, body)

    return router
