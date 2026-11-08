"""mango-api: chat BFF (SSE) and control plane of Mango.

Security notes (security-best-practices, FastAPI):
* No interactive docs or OpenAPI endpoint at runtime (FASTAPI-OPENAPI-001).
* Every route except /api/health depends on ``current_user`` (FASTAPI-AUTH-001) and access
  tokens are verified strictly (FASTAPI-AUTH-004).
* Request models forbid extra fields; responses use explicit models (VALID-001, RESP-001).
* Host header validation and request size limits via ASGI middleware (HOST-001, LIMITS-001).
* No CORS: the SPA and API share the CloudFront origin.
"""

# No `from __future__ import annotations`: FastAPI resolves route annotations at runtime,
# including the closure-local `CallerDependency`.
import asyncio
import json
import logging
import re
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Collection
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from functools import cache, partial
from pathlib import Path as FilePath
from typing import Annotated, Any, Literal, cast

import boto3
from botocore.config import Config
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from mango_api import harness, sessions, turns
from mango_api.activity import (
    ActivityDeps,
    AgentView,
    activity_router,
)
from mango_api.activity_store import ActivityStore
from mango_api.admin import AdminDeps, admin_router, now_utc
from mango_api.agents import (
    AgentsDeps,
    agents_router,
    agents_serving_knowledge,
    agents_using_knowledge_base,
    usable_versions,
)
from mango_api.agents_store import AgentsStore, AgentVersion, ListedVersions
from mango_api.approval_executor import GatewayExecutor
from mango_api.approvals import (
    ApprovalDeps,
    ApprovalOut,
    approvals_router,
    conversation_view,
)
from mango_api.approvals_store import ApprovalStore
from mango_api.audit import (
    INDEX_TTL,
    MAX_PAGE,
    READ_ACTIONS,
    AgentLookup,
    AuditAgentOut,
    AuditEventOut,
    AuditLog,
    AuditQuery,
    InvalidCursorError,
    audit_events_out,
)
from mango_api.authz import (
    PLATFORM,
    REMOTE_MCP_TYPE,
    AgentResource,
    Authorizer,
    KnowledgeBaseResource,
    RemoteMcpResource,
    TaskResource,
    TicketResource,
)
from mango_api.budget import (
    BudgetExceededError,
    BudgetService,
    BudgetUnavailableError,
    current_period,
)
from mango_api.connections import (
    ConnectionRecords,
    ConnectionsDeps,
    ConsentCompleter,
    PendingConsents,
    connections_router,
)
from mango_api.conversation_search import (
    MAX_BYTES,
    MAX_CONVERSATIONS,
    MAX_LIST_PAGES,
    MAX_MESSAGES,
    SearchDeps,
    conversation_search_router,
)
from mango_api.conversations import (
    CONVERSATION_ID_RE,
    ConversationRecord,
    ConversationRepository,
    RlsClientFactory,
    new_id,
)
from mango_api.costs import AgentInfo as CostAgent
from mango_api.costs import CostsDeps, costs_router
from mango_api.directory import (
    CognitoDirectory,
    DirectoryDeps,
    LookupQuota,
    directory_router,
)
from mango_api.evals import EvalGate, EvalsDeps, evals_router
from mango_api.evals_runner import EvalRunner, EvalRunnerDeps, EvalsHarnesses
from mango_api.evals_store import EvalRuns, EvalStore
from mango_api.gateway_mcp import GatewayConnections
from mango_api.governance import GovernanceDeps, governance_router
from mango_api.group_admin import (
    CognitoGroups,
    GroupAdminDeps,
    GroupStore,
    group_admin_router,
)
from mango_api.groups import GroupRegistry, groups_router
from mango_api.home import HomeData, HomeDeps, home_router
from mango_api.inbox import InboxDeps, RunInbox, inbox_router
from mango_api.inbox_store import InboxStore
from mango_api.knowledge import (
    KnowledgeDeps,
    KnowledgeSchedules,
    SyncStarter,
    knowledge_router,
)
from mango_api.knowledge_sources import (
    BucketChecker,
    QueuedSourceOut,
    SourceRoleFunction,
    knowledge_sources_router,
    queued_sources,
)
from mango_api.knowledge_store import KnowledgeStore
from mango_api.knowledge_uploads import S3_CONFIG as KNOWLEDGE_S3_CONFIG
from mango_api.knowledge_uploads import DocumentStorage
from mango_api.limits import Limits
from mango_api.mcp import McpDeps, mcp_router
from mango_api.mcp_catalog import CatalogSource, McpCatalog, RemoteStates
from mango_api.mcp_store import PackStore
from mango_api.mfa_reset import CognitoUsers, MfaResetDeps, ResetStore, mfa_reset_router
from mango_api.model_capabilities import load_capabilities
from mango_api.model_catalog import (
    ModelCatalogCache,
    ModelCatalogStore,
)
from mango_api.models import BedrockCatalog, ModelsDeps, models_router
from mango_api.observability import (
    TRACE_READER_TIMEOUT_SECONDS,
    Emails,
    LambdaTraceSource,
    ObservabilityDeps,
    observability_router,
)
from mango_api.observability_store import TraceRefs
from mango_api.pack_release import ReleasePacks, parse_catalog
from mango_api.people import (
    CognitoPeople,
    Installation,
    MemberChangeStore,
    PeopleDeps,
    installation_router,
    only_area_of,
    parse_domains,
    people_router,
)
from mango_api.playground import PlaygroundDeps, PlaygroundHarnesses, playground_router
from mango_api.presign import PresignSessions
from mango_api.pricing import cost, estimate_max_cost, turn_price
from mango_api.probe import AdminProbe, OrganizationCache
from mango_api.provisioner import (
    DeprovisionerClient,
    PackProvisionerClient,
    ProvisionerClient,
    RemoteProvisionerClient,
)
from mango_api.published import PublishedAgents, usable_by
from mango_api.rate_limits import RateLimitStore
from mango_api.remote_mcp import RemoteMcpDeps, remote_mcp_router
from mango_api.remote_mcp_store import (
    ApprovedRemotes,
    IdentityProviders,
    Registration,
    RemoteStore,
    StackTags,
    gateway_id_of,
)
from mango_api.remote_release import ReleaseRemotes, parse_remote_catalog
from mango_api.settings import Settings
from mango_api.settings_store import BudgetLimits, SettingsStore
from mango_api.skills import SkillsDeps, skills_router
from mango_api.skills_store import SkillStore
from mango_api.task_identity import TaskTokens
from mango_api.task_reports import LambdaRenderer, S3Links, TaskReports
from mango_api.task_worker import (
    REMOTE_CONSENT_REQUIRED,
    AgentAccessDeniedError,
    QueueWorker,
    TaskRuns,
    TaskSteps,
    TurnOutcome,
)
from mango_api.tasks import (
    MAX_PER_INSTALLATION,
    MAX_PER_OWNER,
    RunQueue,
    TaskScheduler,
    TasksDeps,
    tasks_router,
)
from mango_api.tasks_store import Automation, Run, RunStatus, TaskStore
from mango_api.tickets import RunTicketWriter, TicketsDeps, TicketToolGate, tickets_router
from mango_api.tool_policies import PolicyStore, ToolPolicyDeps, tool_policy_router
from mango_api.turns_store import DynamoTurnLog, MemoryTurnLog
from mango_api.web import ApiError, Caller, error_response
from mango_api.web_session import (
    CognitoTokens,
    SessionStore,
    TokenCipher,
    WebSessionDeps,
    web_session_router,
)
from mango_core import task_reports as reports
from mango_core import usage_days
from mango_core.agents import AGENT_ID_PATTERN, MODEL_ID_PATTERN, VersionStatus
from mango_core.budget_turns import PendingTurn
from mango_core.identity import (
    AccessTokenVerifier,
    IdentityError,
    NoAreaError,
    NoGroupError,
    UserContext,
    user_from_claims,
)
from mango_core.skills import parse_ref as parse_skill_ref
from mango_core.tickets import TicketStore

logger = logging.getLogger("mango_api")

MAX_BODY_BYTES = 32 * 1024
HEALTH_PATH = "/api/health"
LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"
"""Time (two words), level, logger and message: the metric filter of the alarm
``Api-rate-limit-store-unavailable`` reads the third and fourth words (D71)."""


# --- Models -----------------------------------------------------------------------------


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ChatRequest(_Strict):
    """A turn. Besides the message the client only picks the agent of a new conversation and
    one of that agent's allowed models; everything else comes from the published version."""

    conversation_id: Annotated[str, Field(pattern=r"^[0-9a-f]{32}$")] | None = None
    message: Annotated[str, Field(min_length=1, max_length=4000)]
    agent_id: Annotated[str, Field(pattern=AGENT_ID_PATTERN)] | None = None
    """Agent of a new conversation (default: the release agent). An existing conversation
    keeps the agent it started with."""
    model: Annotated[str, Field(pattern=MODEL_ID_PATTERN)] | None = None
    """One of the agent's allowed models (D22); default: the agent's default model."""


class MeCan(_Strict):
    """Hints for the SPA only; the API authorizes every request on its own."""

    create_agent: bool


class MeResponse(_Strict):
    user_id: str
    email: str | None
    name: str | None
    role: str | None
    business_unit: str | None
    is_admin: bool
    groups: list[str]
    can: MeCan


class ConversationSummary(_Strict):
    conversation_id: str
    title: str
    updated_at: str
    agent_id: str


class ConversationList(_Strict):
    items: list[ConversationSummary]


class ToolStatus(_Strict):
    name: str
    status: str


class CitationOut(_Strict):
    """A source of an answer: plain text, never the text of the fragment (D88 (44))."""

    knowledge_base: str
    document: str
    page: int | None = None


class MessageOut(_Strict):
    message_id: str
    role: str
    content: str
    created_at: str
    tools: list[ToolStatus]
    approvals: list[str] = []
    """Ids of the approval requests this message created (D27); see ``ConversationDetail``."""
    citations: list[CitationOut] = []
    """The sources of the knowledge searches of this answer (D88 (44))."""
    connection_required: list[str] = []
    """Remote MCP registrations whose tools asked this person to connect their account during
    this answer (D98 (20)): the chat shows its card, also after a reload. Never a URL."""
    remote_sources: list[str] = []
    """Remote MCP registrations whose tools answered (design «Leyó {servicio}»)."""


class ConversationDetail(_Strict):
    conversation_id: str
    title: str
    agent_id: str
    messages: list[MessageOut]
    approvals: list[ApprovalOut] = []
    """The caller's requests to confirm write tool calls of this conversation."""


class AuditParams(_Strict):
    """Query of GET /api/admin/audit; unknown parameters are rejected."""

    limit: Annotated[int, Field(ge=1, le=MAX_PAGE)] = 50
    cursor: Annotated[str, Field(max_length=128)] | None = None
    since: datetime | None = None
    until: datetime | None = None
    exclude: Annotated[list[Literal["reads"]], Field(max_length=1)] = []
    event: Annotated[str, Field(max_length=64, pattern=r"^[a-z][a-z_]*(\.[a-z_]+)*\.?$")] | None = (
        None
    )


class AuditList(_Strict):
    items: list[AuditEventOut]
    next_cursor: str | None


_FIELD_PART_RE = re.compile(r"^[a-z][a-z0-9_]{0,39}$")


def _field_path(error: Any) -> str:
    """Location of a validation error using only names the API itself defines."""
    parts = list(error["loc"][1:])
    if error.get("type") == "extra_forbidden" and parts:
        parts[-1] = "?"
    return ".".join(
        str(p) if isinstance(p, int) or _FIELD_PART_RE.fullmatch(str(p)) else "?" for p in parts
    )


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


# --- Dependencies -----------------------------------------------------------------------


@dataclass
class Services:
    settings: Settings
    verifier: AccessTokenVerifier
    authorizer: Authorizer
    budgets: BudgetService
    conversations: ConversationRepository
    audit: AuditLog
    agentcore: Any
    """``harness.TurnClients`` in production: one client per turn limit. Tests give a client."""
    bedrock: Any
    settings_store: SettingsStore
    budget_limits: BudgetLimits
    probe: AdminProbe
    published: PublishedAgents
    """What each agent serves now: the version the provisioner published (D40)."""
    model_catalog: ModelCatalogCache
    """Enabled models and their prices for the chat (rule 7), cached briefly."""
    invocation_key: bytes = b""
    # D20 MFA reset; both are set in production (build_services).
    cognito_users: CognitoUsers | None = None
    mfa_reset_store: ResetStore | None = None
    # Access group registry (D26); set in production (build_services).
    group_registry: GroupRegistry | None = None
    # Settings > Groups: registry changes with dual approval (D26); set in production.
    group_admin: GroupAdminDeps | None = None
    # Agents as data (D18); set in production (build_services).
    agents: AgentsDeps | None = None
    # Brains: the model catalog administrators edit (D38); set in production (build_services).
    models: ModelsDeps | None = None
    # MCP catalog and pack enablements (D19); set in production (build_services).
    mcp: McpDeps | None = None
    # Remote MCP registrations (D93, D98); set in production (build_services).
    remote_mcp: RemoteMcpDeps | None = None
    # «Mis conexiones» of remote MCPs (D97, D98); set in production (build_services).
    connections: ConnectionsDeps | None = None
    # Emails of the people an agent is shared with (D33); set in production (build_services).
    directory: CognitoDirectory | None = None
    directory_quota: LookupQuota | None = None
    # Settings > People (D60); set in production (build_services).
    people: PeopleDeps | None = None
    # Write tools with approval (D27); set in production once the approvals table exists.
    approvals: ApprovalDeps | None = None
    tool_policies: ToolPolicyDeps | None = None
    # Web session cookie (D63); set in production once its table and origin are configured.
    web_sessions: WebSessionDeps | None = None
    # Tasks without chat (D78); set in production once the tasks construct is deployed.
    tasks: TasksDeps | None = None
    task_tokens: TaskTokens | None = None
    task_runs: TaskRuns | None = None
    """Built by ``create_app``: its turn needs these services."""
    task_queue: Any = None
    chat_turns: turns.ChatTurns | None = None
    """The chat turn (D121). ``None``: create_app runs it in this task, recorded in memory
    (tests); production builds it with the queue and the Conversations table."""
    """SQS client the worker reads the runs with; ``None`` keeps the worker off (tests)."""
    home: HomeData | None = None
    """The day counters of Inicio and the person's own budget (D102); set in production."""
    # La Bandeja (D83): notices of each person, in their conversations partition.
    inbox: InboxDeps | None = None
    # La Actividad (D90): what the agents did, metadata only.
    activity: ActivityDeps | None = None
    # Observabilidad (D108): the traces of the agents, read by the trace reader function.
    observability: ObservabilityDeps | None = None
    # Tickets of Mango (D112); set in production once the Tickets table exists.
    tickets: TicketsDeps | None = None
    # Knowledge bases (D88); set in production once mango-api may use the Knowledge table.
    knowledge: KnowledgeDeps | None = None
    # Skills of instructions (D92); set in production once the Skills table exists.
    skills: SkillsDeps | None = None
    # The Playground's test harness (D91); set in production.
    playground_harnesses: PlaygroundHarnesses | None = None
    # Evals (D110, D111); set in production once the Evals table exists.
    evals: EvalsDeps | None = None
    # The evaluator's function (D110): only invoked for the verdict of a judge case.
    eval_judge: Any = None
    limits: Limits = field(default_factory=Limits)
    """Where every rate limit comes from (D70). In production the shared ones count in
    DynamoDB (build_services); the default, for tests, keeps all of them in memory."""


def _error(status: int, code: str, message: str) -> JSONResponse:
    return error_response(status, code, message)


_LOG_SUB_RE = re.compile(r"^[A-Za-z0-9-]{1,64}$")


def _log_sub(claims: dict[str, Any]) -> str:
    """The subject of verified claims, for a log line: a Cognito id or ``-``, never free text."""
    sub = claims.get("sub")
    return sub if isinstance(sub, str) and _LOG_SUB_RE.fullmatch(sub) else "-"


def _areas(store: SettingsStore) -> list[str]:
    """The areas of the installation, read on each call: they change with dual approval."""
    return list(store.mapping().units)


@cache
def _presign_for(role_arn: str, region: str) -> PresignSessions:
    return PresignSessions(boto3.client("sts", region_name=region), role_arn, region)


def _ticket_decider(
    services: Services,
) -> Callable[[UserContext, str, str, str, TicketResource | None], bool]:
    """A decision about a ticket made outside a route (the tickets tool, a task run), decided
    like its route and audited (D112 (9))."""

    def decide(
        user: UserContext,
        action: str,
        resource_type: str,
        resource_id: str,
        ticket: TicketResource | None,
    ) -> bool:
        allowed = services.authorizer.is_allowed(
            user, action, resource_type, resource_id, ticket=ticket
        )
        services.audit.emit(
            "policy.decision",
            user.user_id,
            {
                "action": action,
                "resource": f"{resource_type}::{resource_id}",
                "allowed": allowed,
                "read_only": False,
            },
            user,
        )
        return allowed

    return decide


def _presign_sessions(settings: Settings) -> PresignSessions | None:
    """The signer of every URL a browser uses: one per process, shared by reports and uploads.
    Without its role nothing is signed (never with the task's credentials)."""
    if not settings.presign_role_arn:
        return None
    return _presign_for(settings.presign_role_arn, settings.region)


def _task_services(
    settings: Settings,
    *,
    dynamodb: Any,
    cognito: Any,
    audit: AuditLog,
    published: PublishedAgents,
    limits: Limits,
) -> tuple[TasksDeps | None, TaskTokens | None, Any]:
    """Tasks (D78), once the tasks construct is deployed: all of its settings, or nothing."""
    needed = (
        settings.tasks_table,
        settings.task_runs_queue_url,
        settings.task_runs_queue_arn,
        settings.task_schedule_group,
        settings.task_scheduler_role_arn,
        settings.tasks_client_id,
        settings.task_identity_key_arn,
        settings.tasks_client_secret_arn,
    )
    if not all(needed):
        return None, None, None
    region = settings.region
    sqs = boto3.client("sqs", region_name=region)
    presign = _presign_sessions(settings)
    tasks = TasksDeps(
        store=TaskStore(
            dynamodb,
            settings.tasks_table,
            per_owner=MAX_PER_OWNER,
            per_installation=MAX_PER_INSTALLATION,
        ),
        scheduler=TaskScheduler(
            boto3.client("scheduler", region_name=region),
            group=settings.task_schedule_group,
            queue_arn=settings.task_runs_queue_arn,
            role_arn=settings.task_scheduler_role_arn,
        ),
        queue=RunQueue(sqs, settings.task_runs_queue_url),
        published=published,
        audit=audit,
        runs=limits.limiter("tasks.runs"),
        changes=limits.limiter("tasks.changes"),
        reports=(
            TaskReports(
                renderer=LambdaRenderer(
                    boto3.client("lambda", region_name=region), settings.task_report_function
                ),
                links=S3Links(presign, settings.task_reports_bucket),
            )
            if settings.task_report_function and settings.task_reports_bucket
            else None
        ),
        downloads=limits.limiter("tasks.report_downloads"),
    )
    tokens = TaskTokens(
        cognito=cognito,
        kms=boto3.client("kms", region_name=region),
        user_pool_id=settings.cognito_user_pool_id,
        client_id=settings.tasks_client_id,
        key_arn=settings.task_identity_key_arn,
        # The token of a run is checked like any other, against its own client.
        verifier=AccessTokenVerifier(settings.cognito_issuer, settings.tasks_client_id),
        client_secret=str(
            boto3.client("secretsmanager", region_name=region).get_secret_value(
                SecretId=settings.tasks_client_secret_arn
            )["SecretString"]
        ),
    )
    return tasks, tokens, sqs


def _remote_mcp_deps(
    settings: Settings,
    *,
    dynamodb: Any,
    group_registry: GroupRegistry,
    authorizer: Authorizer,
    audit: AuditLog,
    limits: Limits,
) -> RemoteMcpDeps:
    """Remote MCP registrations (D98 (17)): the profiles of the release, the Identity providers
    mango-api creates and the remote provisioner it starts."""
    region = settings.region
    identity = IdentityProviders(
        boto3.client("bedrock-agentcore-control", region_name=region),
        StackTags(boto3.client("cloudformation", region_name=region), settings.stack_id),
        settings.namespace,
    )
    return RemoteMcpDeps(
        release=ReleaseRemotes(
            boto3.client("s3", region_name=region),
            bucket=settings.packs_bucket,
            bucket_owner=settings.packs_bucket_owner,
            catalog=parse_remote_catalog(settings.remote_catalog),
            public_key_pem=settings.pack_signing_public_key,
        ),
        store=RemoteStore(dynamodb, settings.settings_table),
        groups=group_registry,
        authorizer=authorizer,
        audit=audit,
        clock=now_utc,
        namespace=settings.namespace,
        enabled=settings.remote_mcp_enabled,
        identity=identity,
        approved=ApprovedRemotes(
            dynamodb,
            settings.settings_table,
            boto3.client("kms", region_name=region),
            key_id=settings.remote_mcp_key_id,
            gateway_id=gateway_id_of(settings.gateway_url),
        ),
        provisioner=RemoteProvisionerClient(
            boto3.client("stepfunctions", region_name=region),
            settings.remote_provisioner_state_machine_arn,
        )
        if settings.remote_provisioner_state_machine_arn
        else None,
        rate_limiter=limits.limiter("remote_mcp.writes"),
    )


def _connections_deps(
    settings: Settings,
    *,
    dynamodb: Any,
    rls: RlsClientFactory,
    remote: RemoteMcpDeps,
    audit: AuditLog,
    invocation_key: bytes,
    limits: Limits,
) -> ConnectionsDeps:
    """«Mis conexiones» (D98 (17)): the registrations and the approved catalog of the remote
    MCP domain, the person's connection records (RLS) and the Gateway they are probed through."""
    region = settings.region
    return ConnectionsDeps(
        registrations=remote.store,
        release=remote.release,
        records=ConnectionRecords(rls.for_user, settings.conversations_table),
        consents=PendingConsents(dynamodb, settings.settings_table, region=region),
        audit=audit,
        clock=now_utc,
        region=region,
        app_origin=settings.app_origin,
        connects=limits.limiter("connections.connects"),
        disconnects=limits.limiter("connections.disconnects"),
        callbacks=limits.limiter("connections.callbacks"),
        enabled=settings.remote_mcp_enabled,
        approved=remote.approved,
        gateway=GatewayConnections(gateway_url=settings.gateway_url, invocation_key=invocation_key),
        completer=ConsentCompleter(boto3.client("bedrock-agentcore", region_name=region)),
    )


def _sibling_table_arn(table_arn: str, name: str) -> str:
    """The ARN of another table of the same account and region."""
    return f"{table_arn.rsplit('/', 1)[0]}/{name}"


def build_services(settings: Settings) -> Services:
    region = settings.region
    dynamodb = boto3.client("dynamodb", region_name=region)
    # Without the table the shared limits would fall back to one per task: do not start.
    limits = Limits(RateLimitStore(dynamodb, settings.rate_limits_table))
    rls = RlsClientFactory(
        boto3.client("sts", region_name=region),
        role_arn=settings.data_access_role_arn,
        table_arn=settings.conversations_table_arn,
        key_arn=settings.data_key_arn,
        region=region,
        budgets_table_arn=_sibling_table_arn(
            settings.conversations_table_arn, settings.budgets_table
        ),
    )
    settings_store = SettingsStore(
        dynamodb,
        settings.settings_table,
        fallback_user_usd=settings.user_monthly_budget,
        fallback_agent_usd=settings.agent_monthly_budget,
    )
    authorizer = Authorizer(
        boto3.client("verifiedpermissions", region_name=region), settings.policy_store_id
    )
    audit = AuditLog(
        boto3.client("firehose", region_name=region),
        settings.audit_stream,
        dynamodb,
        settings.audit_index_table,
    )
    group_registry = GroupRegistry(dynamodb, settings.settings_table)
    budget_limits = BudgetLimits(settings_store)
    agents_store = AgentsStore(dynamodb, settings.agents_table)
    knowledge_store = (
        KnowledgeStore(dynamodb, settings.knowledge_table) if settings.knowledge_table else None
    )
    skill_store = (
        SkillStore(
            dynamodb,
            settings.skills_table,
            boto3.client("s3", region_name=region),
            settings.skills_bucket,
        )
        if settings.skills_table and settings.skills_bucket
        else None
    )
    model_catalog = ModelCatalogStore(dynamodb, settings.settings_table)
    model_cache = ModelCatalogCache(model_catalog)
    # Release data inside the image: read once, and fail closed if it is not there. Packs
    # join it from the signed statements of the release and their installation state (D36).
    pack_store = PackStore(dynamodb, settings.settings_table)
    remote_mcp = _remote_mcp_deps(
        settings,
        dynamodb=dynamodb,
        group_registry=group_registry,
        authorizer=authorizer,
        audit=audit,
        limits=limits,
    )
    mcp_catalog = CatalogSource(
        cache(lambda: McpCatalog.load(FilePath(settings.mcp_catalog_dir))),
        ReleasePacks(
            boto3.client("s3", region_name=region),
            bucket=settings.packs_bucket,
            bucket_owner=settings.packs_bucket_owner,
            catalog=parse_catalog(settings.pack_catalog),
            public_key_pem=settings.pack_signing_public_key,
        ),
        pack_store,
        # Remote MCP registrations with their signed catalogs (D98): tools agents may use.
        remotes=RemoteStates(remote_mcp.store, remote_mcp.approved, remote_mcp.release),
    )
    published = PublishedAgents(
        agents_store,
        mcp_catalog,
        namespace=settings.namespace,
        region=region,
    )
    cognito = boto3.client("cognito-idp", region_name=region)
    invocation_key = str(
        boto3.client("secretsmanager", region_name=region).get_secret_value(
            SecretId=settings.invocation_key_secret_arn
        )["SecretString"]
    ).encode()
    policy_store = PolicyStore(dynamodb, settings.settings_table)
    approvals = (
        ApprovalDeps(
            store=ApprovalStore(dynamodb, settings.approvals_table),
            policies=policy_store,
            catalog=mcp_catalog,
            published=published,
            audit=audit,
            clock=now_utc,
            # Without the signing key nothing can be run: requests can still be decided.
            executor=GatewayExecutor(
                boto3.client("kms", region_name=region),
                key_arn=settings.approval_key_arn,
                gateway_url=settings.gateway_url,
                invocation_key=invocation_key,
            )
            if settings.approval_key_arn
            else None,
            run_limiter=limits.limiter("approvals.runs"),
        )
        if settings.approvals_table
        else None
    )
    verifier = AccessTokenVerifier(settings.cognito_issuer, settings.cognito_client_id)
    web_sessions = None
    if settings.web_sessions_table and settings.app_origin and settings.session_hours > 0:
        web_sessions = WebSessionDeps(
            store=SessionStore(dynamodb, settings.web_sessions_table),
            cipher=TokenCipher(boto3.client("kms", region_name=region), settings.data_key_arn),
            tokens=CognitoTokens(
                cognito, settings.cognito_user_pool_id, settings.cognito_client_id
            ),
            verifier=verifier,
            audit=audit,
            clock=now_utc,
            app_origin=settings.app_origin,
            session_seconds=settings.session_hours * 3600,
            starts=limits.limiter("session.starts"),
            renewals=limits.limiter("session.renewals"),
        )
    tasks, task_tokens, task_queue = _task_services(
        settings,
        dynamodb=dynamodb,
        cognito=cognito,
        audit=audit,
        published=published,
        limits=limits,
    )
    people_deps = PeopleDeps(
        people=CognitoPeople(cognito, settings.cognito_user_pool_id),
        store=MemberChangeStore(dynamodb, settings.settings_table),
        registry=group_registry,
        audit=audit,
        clock=now_utc,
        sign_up_domains=parse_domains(settings.sign_up_domains),
        reads=limits.limiter("people.reads"),
        changes=limits.limiter("people.changes"),
        proposals=limits.limiter("people.proposals"),
        invitations=limits.limiter("people.invitations"),
    )
    remote_mcp = _remote_mcp_deps(
        settings,
        dynamodb=dynamodb,
        group_registry=group_registry,
        authorizer=authorizer,
        audit=audit,
        limits=limits,
    )
    trace_refs = TraceRefs(dynamodb, settings.audit_index_table)
    services = Services(
        settings=settings,
        verifier=verifier,
        authorizer=authorizer,
        # Each turn that binds its session leaves its reference for the traces (D108).
        budgets=BudgetService(dynamodb, settings.budgets_table, on_bind=trace_refs.record),
        observability=(
            ObservabilityDeps(
                traces=LambdaTraceSource(
                    boto3.client(
                        "lambda",
                        region_name=region,
                        # One attempt: in the legacy mode `max_attempts` counts retries, and
                        # a repeated 20 s reading only doubles the wait (obs-perf).
                        config=Config(
                            connect_timeout=3,
                            read_timeout=TRACE_READER_TIMEOUT_SECONDS,
                            retries={"total_max_attempts": 1},
                        ),
                    ),
                    settings.trace_reader_function,
                ),
                refs=trace_refs,
                emails=Emails(CognitoDirectory(cognito, settings.cognito_user_pool_id).email_of),
                # Set by create_app, which has the agents.
                agent_names=dict,
                limiter=limits.limiter("observability.reads"),
            )
            if settings.trace_reader_function
            else None
        ),
        home=HomeData(table=settings.budgets_table, dynamodb=dynamodb, own=rls.for_user),
        conversations=ConversationRepository(rls.for_user, settings.conversations_table),
        audit=audit,
        agentcore=harness.TurnClients(region),
        bedrock=boto3.client("bedrock-runtime", region_name=region),
        settings_store=settings_store,
        budget_limits=budget_limits,
        probe=AdminProbe(boto3.client("lambda", region_name=region), settings.admin_probe_function),
        published=published,
        model_catalog=model_cache,
        playground_harnesses=PlaygroundHarnesses(
            dynamodb, settings.settings_table, namespace=settings.namespace, region=region
        ),
        evals=EvalsDeps(
            store=EvalStore(dynamodb, settings.evals_table),
            agents=agents_store,
            authorizer=authorizer,
            catalog=model_cache.catalog,
            audit=audit,
            writes=limits.limiter("evals.writes"),
            reads=limits.limiter("evals.reads"),
            clock=now_utc,
        )
        if settings.evals_table
        else None,
        eval_judge=boto3.client("lambda", region_name=region)
        if settings.eval_judge_function
        else None,
        cognito_users=CognitoUsers(cognito, settings.cognito_user_pool_id),
        mfa_reset_store=ResetStore(dynamodb, settings.settings_table),
        directory=CognitoDirectory(cognito, settings.cognito_user_pool_id),
        directory_quota=LookupQuota(dynamodb, settings.settings_table),
        people=people_deps,
        approvals=approvals,
        inbox=InboxDeps(
            store=InboxStore(rls.for_user, settings.conversations_table),
            published=published,
            approvals=approvals,
            clock=now_utc,
        ),
        activity=ActivityDeps(
            store=ActivityStore(
                rls.for_user, settings.conversations_table, dynamodb, settings.audit_index_table
            ),
            # Set by create_app, which has the agents and the authorizer.
            agents=lambda _caller, _everyone: [],
            approvals=approvals.store if approvals is not None else None,
            clock=now_utc,
            reads=limits.limiter("activity.reads"),
        ),
        tickets=TicketsDeps(
            store=TicketStore(dynamodb, settings.tickets_table),
            published=published,
            audit=audit,
            creates=limits.limiter("tickets.creates"),
            changes=limits.limiter("tickets.changes"),
            comments=limits.limiter("tickets.comments"),
            approvals=approvals.store if approvals is not None else None,
        )
        if settings.tickets_table
        else None,
        tool_policies=ToolPolicyDeps(
            store=policy_store,
            catalog=mcp_catalog,
            audit=audit,
            rate_limiter=limits.limiter("tool_policies.proposals"),
            clock=now_utc,
        ),
        group_registry=group_registry,
        group_admin=GroupAdminDeps(
            store=GroupStore(dynamodb, settings.settings_table),
            settings=settings_store,
            directory=CognitoGroups(cognito, settings.cognito_user_pool_id),
            agents=agents_store,
            catalog=mcp_catalog,
            audit=audit,
            rate_limiter=limits.limiter("group_admin.proposals"),
            clock=now_utc,
            stranded=lambda group: len(only_area_of(people_deps, group)[0]),
        ),
        agents=AgentsDeps(
            store=agents_store,
            audit=audit,
            authorizer=authorizer,
            groups=group_registry,
            models=model_catalog,
            catalog=mcp_catalog,
            published=published,
            listed=ListedVersions(agents_store),
            list_limiter=limits.limiter("agents.lists"),
            # Until the provisioner is deployed nothing can be approved (503).
            provisioner=ProvisionerClient(
                boto3.client("stepfunctions", region_name=region),
                settings.provisioner_state_machine_arn,
            )
            if settings.provisioner_state_machine_arn
            else None,
            deprovisioner=DeprovisionerClient(
                boto3.client("stepfunctions", region_name=region),
                settings.deprovisioner_state_machine_arn,
            )
            if settings.deprovisioner_state_machine_arn
            else None,
            knowledge=knowledge_store,
            skills=skill_store,
            clock=now_utc,
        ),
        skills=SkillsDeps(
            store=skill_store,
            agents=agents_store,
            catalog=mcp_catalog,
            audit=audit,
            rate_limiter=limits.limiter("skills.proposals"),
            clock=now_utc,
            reads=limits.limiter("skills.reads"),
        )
        if skill_store is not None
        else None,
        mcp=McpDeps(
            catalog=mcp_catalog,
            agents=agents_store,
            audit=audit,
            clock=now_utc,
            store=pack_store,
            # Until the pack provisioner is deployed nothing can be approved (503).
            provisioner=PackProvisionerClient(
                boto3.client("stepfunctions", region_name=region),
                settings.pack_provisioner_state_machine_arn,
            )
            if settings.pack_provisioner_state_machine_arn
            else None,
            rate_limiter=limits.limiter("mcp.writes"),
            authorizer=authorizer,
        ),
        remote_mcp=remote_mcp,
        connections=_connections_deps(
            settings,
            dynamodb=dynamodb,
            rls=rls,
            remote=remote_mcp,
            audit=audit,
            invocation_key=invocation_key,
            limits=limits,
        ),
        models=ModelsDeps(
            store=model_catalog,
            # Control plane client: it only lists models, nothing is invoked with it.
            bedrock=BedrockCatalog(boto3.client("bedrock", region_name=region)),
            agents=agents_store,
            audit=audit,
            rate_limiter=limits.limiter("models.refreshes"),
            region=region,
            default_model=settings.agent_model,
            list_prices=settings.model_prices,
            # Release data inside the image, read on each refresh (a few per day at most).
            capabilities=lambda: load_capabilities(FilePath(settings.model_capabilities_file)),
            clock=now_utc,
            playground=(
                ProvisionerClient(
                    boto3.client("stepfunctions", region_name=region),
                    settings.provisioner_state_machine_arn,
                ).refresh_playground
                if settings.provisioner_state_machine_arn
                else None
            ),
        ),
        invocation_key=invocation_key,
        web_sessions=web_sessions,
        tasks=tasks,
        task_tokens=task_tokens,
        task_queue=task_queue,
        knowledge=(
            KnowledgeDeps(
                store=knowledge_store,
                groups=group_registry,
                areas=partial(_areas, settings_store),
                audit=audit,
                changes=limits.limiter("knowledge.changes"),
                storage=(
                    DocumentStorage(
                        boto3.client("s3", region_name=region, config=KNOWLEDGE_S3_CONFIG),
                        settings.knowledge_bucket,
                        region,
                        _presign_sessions(settings),
                    )
                    if settings.knowledge_bucket
                    else None
                ),
                uploads=limits.limiter("knowledge.uploads"),
                sync=(
                    SyncStarter(
                        boto3.client("stepfunctions", region_name=region),
                        settings.knowledge_sync_state_machine_arn,
                    )
                    if settings.knowledge_sync_state_machine_arn
                    else None
                ),
                user_limit=lambda user_id: budget_limits.for_user(user_id)[0],
                agents_using=partial(agents_using_knowledge_base, agents_store),
                agents_serving=partial(agents_serving_knowledge, agents_store),
                retrieve=(
                    boto3.client("bedrock-agent-runtime", region_name=region).retrieve
                    if settings.knowledge_base_id
                    else None
                ),
                knowledge_base_id=settings.knowledge_base_id,
                searches=limits.limiter("knowledge.searches"),
                buckets=(
                    BucketChecker(boto3.client("s3", region_name=region), settings.account_id)
                    if settings.account_id
                    else None
                ),
                schedules=(
                    KnowledgeSchedules(
                        boto3.client("scheduler", region_name=region),
                        group=settings.knowledge_schedule_group,
                        state_machine_arn=settings.knowledge_sync_state_machine_arn,
                        role_arn=settings.knowledge_scheduler_role_arn,
                    )
                    if settings.knowledge_schedule_group
                    and settings.knowledge_scheduler_role_arn
                    and settings.knowledge_sync_state_machine_arn
                    else None
                ),
                source_roles=(
                    SourceRoleFunction(
                        boto3.client("lambda", region_name=region),
                        settings.knowledge_sources_function,
                    )
                    if settings.knowledge_sources_function
                    else None
                ),
            )
            if knowledge_store is not None
            else None
        ),
        limits=limits,
    )
    services.chat_turns = _chat_turns(services, rls.for_user)
    return services


def _chat_turns(services: Services, clients: Callable[[str], Any]) -> turns.ChatTurns:
    """The chat turn (D121): sent to ``Mango-<ns>-ChatTurns`` for the turn worker. Without the
    queue (an installation whose stack does not have it yet) this task runs the same handler
    itself; the events go to the Conversations table either way."""
    settings = services.settings
    log = DynamoTurnLog(clients, settings.conversations_table)
    if settings.chat_turns_queue_url:
        sender = turns.SqsTurnSender(
            boto3.client("sqs", region_name=settings.region), settings.chat_turns_queue_url
        )
        return turns.ChatTurns(services, log, sender)
    local = turns.LocalTurnSender()
    chat_turns = turns.ChatTurns(services, log, local)
    local.bind(chat_turns.handle)
    return chat_turns


# --- ASGI middleware --------------------------------------------------------------------


class HostAndSizeGuard:
    """Rejects unexpected Host headers and oversized bodies before routing."""

    def __init__(self, app: ASGIApp, allowed_hosts: frozenset[str]) -> None:
        self.app = app
        self.allowed_hosts = allowed_hosts

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = dict(scope.get("headers") or [])
        host = headers.get(b"host", b"").decode("latin-1").split(":", 1)[0].lower()
        if scope.get("path") != HEALTH_PATH and host not in self.allowed_hosts:
            await _error(400, "bad_request", "invalid host")(scope, receive, send)
            return
        length = headers.get(b"content-length")
        if length is not None and (not length.isdigit() or int(length) > MAX_BODY_BYTES):
            await _error(413, "payload_too_large", "request too large")(scope, receive, send)
            return

        received = 0

        async def limited_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > MAX_BODY_BYTES:
                    raise HTTPException(status_code=413, detail="request too large")
            return message

        await self.app(scope, limited_receive, send)


# --- SSE helpers ------------------------------------------------------------------------


# --- Evals (D110) -----------------------------------------------------------------------


def _eval_runner(services: Services, settings: Settings) -> EvalRunner | None:
    """Runs of evals share the queue and the identity of the tasks (D78) and need the evaluator.
    Without any of them, suites still exist and nothing runs (503 ``evals_unavailable``)."""
    deps = services.evals
    if (
        deps is None
        or services.tasks is None
        or services.task_tokens is None
        or not settings.eval_judge_function
        or services.eval_judge is None
    ):
        return None
    region = settings.region
    harnesses = EvalsHarnesses(
        deps.store.client, settings.settings_table, namespace=settings.namespace, region=region
    )
    deps.runs = EvalRuns(deps.store.client, deps.store.table)
    deps.harnesses = harnesses
    deps.queue = services.tasks.queue
    deps.run_limiter = services.limits.limiter("evals.runs")
    deps.judge_models = settings.eval_judge_models
    deps.price = lambda model_id: turns.model_price(services, model_id)
    deps.knowledge_price = settings.knowledge_embedding_price
    deps.evaluation_fee = settings.evaluation_fee
    return EvalRunner(
        EvalRunnerDeps(
            store=deps.store,
            runs=deps.runs,
            agents=deps.agents,
            published=services.published,
            harnesses=harnesses,
            catalog=services.model_catalog.catalog,
            price=lambda model_id: turns.model_price(services, model_id),
            scopes=lambda caller, agent_id: turns.budget_scopes(services, caller.user, agent_id),
            budgets=services.budgets,
            audit=services.audit,
            agentcore=services.agentcore,
            invocation_key=services.invocation_key,
            gateway_url=settings.gateway_url,
            guardrail_id=settings.guardrail_id,
            guardrail_version=settings.guardrail_version,
            knowledge_price=settings.knowledge_embedding_price,
            tokens=services.task_tokens,
            queue=services.tasks.queue,
            judge=services.eval_judge,
            judge_function=settings.eval_judge_function,
            evaluation_fee=settings.evaluation_fee,
            authorizer=services.authorizer,
            skills=services.skills.store if services.skills is not None else None,
            skills_bucket=settings.skills_bucket,
        )
    )


# --- App --------------------------------------------------------------------------------


def create_app(  # noqa: PLR0912, PLR0915 - app factory registering route closures
    settings: Settings | None = None,
    services_factory: Callable[[Settings], Services] = build_services,
) -> ASGIApp:
    settings = settings or Settings.from_env()
    services = services_factory(settings)
    eval_runner = _eval_runner(services, settings)
    if services.chat_turns is None:
        # Tests: the turn runs in this process, recorded in memory.
        local = turns.LocalTurnSender()
        services.chat_turns = turns.ChatTurns(services, MemoryTurnLog(), local)
        local.bind(services.chat_turns.handle)
    if services.agents is not None and services.evals is not None:
        # D26: a required suite that has not passed on a version blocks its approval.
        services.agents.eval_gate = EvalGate(services.evals)
    if services.tasks is not None and services.task_tokens is not None:
        services.task_runs = TaskRuns(
            store=services.tasks.store,
            tokens=services.task_tokens,
            turn=lambda caller, automation, run, message: _task_turn(
                services, caller, automation, run, message
            ),
            scheduler=services.tasks.scheduler,
            audit=services.audit,
            queue=services.tasks.queue,
            inbox=RunInbox(services.inbox.store) if services.inbox is not None else None,
            reports=services.tasks.reports,
            evals=eval_runner,
            tickets=RunTicketWriter(services.tickets, _ticket_decider(services))
            if services.tickets is not None
            else None,
        )
        services.tasks.tickets = services.tickets is not None

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        # Runs of tasks are read in the background of every task of mango-api (D78).
        worker = (
            QueueWorker(services.task_queue, settings.task_runs_queue_url, services.task_runs)
            if services.task_runs is not None and services.task_queue is not None
            else None
        )
        if worker is not None:
            worker.start()
        try:
            yield
        finally:
            if worker is not None:
                await asyncio.to_thread(worker.stop)

    app = FastAPI(
        title="mango-api",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )

    @app.exception_handler(HTTPException)
    async def http_error(_request: Request, exc: HTTPException) -> JSONResponse:
        detail = exc.detail if isinstance(exc.detail, str) else "error"
        code = {
            401: "unauthenticated",
            403: "forbidden",
            404: "not_found",
            413: "payload_too_large",
        }
        return _error(exc.status_code, code.get(exc.status_code, "error"), detail)

    @app.exception_handler(ApiError)
    async def api_error(_request: Request, exc: ApiError) -> JSONResponse:
        return error_response(exc.status, exc.code, exc.message, exc.headers, exc.extra)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
        # Field names only, never values. A name the client made up (an unknown field, a key
        # of a map) is content too: it is not repeated (TM-M7).
        fields = sorted({_field_path(e) for e in exc.errors()})
        return _error(422, "invalid_request", f"invalid fields: {', '.join(fields)}")

    async def current_user(request: Request) -> Caller:
        header = request.headers.get("authorization", "")
        scheme, _, token = header.partition(" ")
        if scheme.lower() != "bearer" or not token:
            raise HTTPException(status_code=401, detail="missing bearer token")
        try:
            claims = await asyncio.to_thread(services.verifier.verify, token)
        except IdentityError as exc:
            # Nothing of an unverified token is trusted, not even its subject.
            logger.info("identity refused: %s", exc.code)
            raise HTTPException(status_code=401, detail="invalid token") from exc
        try:
            user = user_from_claims(claims)
        except IdentityError as exc:
            # The code and the subject of a verified token: never the token or the claims.
            # Someone waiting for a group is an expected state, not a warning.
            log = logger.info if isinstance(exc, NoGroupError) else logger.warning
            log("identity refused: %s sub=%s", exc.code, _log_sub(claims))
            if isinstance(exc, NoGroupError):
                # Valid session without a group (D20): the SPA shows "no access yet" (TM-L5).
                raise ApiError(403, "no_group", "no group assigned yet") from exc
            if isinstance(exc, NoAreaError):
                # A bu-lead without exactly one area (D60): an administrator has to fix the
                # groups; signing in again does not, so it is not a 401.
                raise ApiError(403, "area_required", "no area assigned yet") from exc
            raise HTTPException(status_code=401, detail="invalid token") from exc
        return Caller(user=user, token=token, expires_at=int(claims["exp"]))

    CallerDependency = Annotated[Caller, Depends(current_user)]  # noqa: N806

    def require(
        caller: Caller,
        action: str,
        resource_type: str,
        resource_id: str,
        *,
        read_only: bool = False,
        context: dict[str, str] | None = None,
        agent: AgentResource | None = None,
        task: TaskResource | None = None,
        knowledge: KnowledgeBaseResource | None = None,
        remote: RemoteMcpResource | None = None,
        ticket: TicketResource | None = None,
    ) -> Awaitable[None]:
        # Every decision is audited; ``read_only`` only lets the log hide allowed reads.
        # ``context`` (validated or server-generated ids only) links the decision to its turn.
        # ``agent`` carries the attributes of an Agent resource, read from the Agents table;
        # ``task`` those of a Task, read from the Tasks table (D78); ``knowledge`` those of a
        # KnowledgeBase, read from the Knowledge table (D88).
        async def check() -> None:
            subject = (caller.user, action, resource_type, resource_id)
            decide: Callable[..., bool] = services.authorizer.is_allowed
            if task is not None:
                decide = partial(services.authorizer.is_allowed, task=task)
            elif knowledge is not None:
                decide = partial(services.authorizer.is_allowed, knowledge=knowledge)
            elif remote is not None:
                # D98 (18): the groups of the registration, read from REMOTE#<reg>.
                decide = partial(services.authorizer.is_allowed, remote=remote)
            elif ticket is not None:
                # D112: creator and assignee from the Tickets table, the agent as published.
                decide = partial(services.authorizer.is_allowed, ticket=ticket)
            allowed = await asyncio.to_thread(decide, *subject, *([agent] if agent else []))
            await asyncio.to_thread(
                services.audit.emit,
                "policy.decision",
                caller.user.user_id,
                {
                    "action": action,
                    "resource": f"{resource_type}::{resource_id}",
                    "allowed": allowed,
                    "read_only": read_only or action in READ_ACTIONS,
                    **(context or {}),
                },
                caller.user,
            )
            if not allowed:
                raise HTTPException(status_code=403, detail="not allowed")

        return check()

    @app.get(HEALTH_PATH)
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/me", response_model=MeResponse)
    async def me(caller: CallerDependency) -> MeResponse:
        u = caller.user
        # A hint for the SPA from the same Cedar decision the API enforces (not audited:
        # nothing is accessed here).
        can_create = await asyncio.to_thread(
            services.authorizer.is_allowed, u, "CreateAgent", *PLATFORM
        )
        return MeResponse(
            user_id=u.user_id,
            email=u.email,
            name=u.name,
            role=u.role,
            business_unit=u.business_unit,
            is_admin=u.is_admin,
            groups=sorted(u.groups),
            can=MeCan(create_agent=can_create),
        )

    @app.get("/api/conversations", response_model=ConversationList)
    async def list_conversations(caller: CallerDependency) -> ConversationList:
        items = await asyncio.to_thread(
            services.conversations.list_conversations, caller.user.user_id
        )
        return ConversationList(
            items=[
                ConversationSummary(
                    conversation_id=str(i["conversation_id"]),
                    title=str(i["title"]),
                    updated_at=str(i["updated_at"]),
                    # Conversations stored before agents were data belong to the release agent.
                    agent_id=i.get("agent_id") or settings.agent_id,
                )
                for i in items
            ]
        )

    @app.get("/api/conversations/{conversation_id}", response_model=ConversationDetail)
    async def get_conversation(
        conversation_id: str, caller: CallerDependency
    ) -> ConversationDetail:
        if not CONVERSATION_ID_RE.fullmatch(conversation_id):
            raise HTTPException(status_code=404, detail="not found")
        user_id = caller.user.user_id
        summary = await asyncio.to_thread(services.conversations.summary, user_id, conversation_id)
        if summary is None:
            raise HTTPException(status_code=404, detail="not found")
        title, agent_id = summary
        messages = await asyncio.to_thread(
            services.conversations.messages, user_id, conversation_id
        )
        # Only when some message asked to confirm a write tool call (D27).
        approvals = (
            await asyncio.to_thread(conversation_view, services.approvals, user_id, conversation_id)
            if services.approvals is not None and any(m.approvals for m in messages)
            else []
        )
        return ConversationDetail(
            conversation_id=conversation_id,
            title=title,
            agent_id=agent_id or settings.agent_id,
            messages=[
                MessageOut(
                    message_id=m.message_id,
                    role=m.role,
                    content=m.content,
                    created_at=m.created_at,
                    tools=[ToolStatus(**t) for t in m.tools],
                    approvals=m.approvals,
                    citations=[CitationOut(**c) for c in m.citations],
                    connection_required=m.connection_required,
                    remote_sources=m.remote_sources,
                )
                for m in messages
            ],
            approvals=approvals,
        )

    @app.get("/api/admin/audit", response_model=AuditList)
    async def admin_audit(
        caller: CallerDependency, params: Annotated[AuditParams, Query()]
    ) -> AuditList:
        await require(caller, "ViewAudit", "Mango::Platform", "mango")
        now = datetime.now(UTC)
        query = AuditQuery(
            since=_utc(params.since) if params.since else now - INDEX_TTL,
            until=_utc(params.until) if params.until else now,
            limit=params.limit,
            cursor=params.cursor,
            exclude_reads="reads" in params.exclude,
            event=params.event,
        )
        try:
            page = await asyncio.to_thread(services.audit.page, query)
        except InvalidCursorError as exc:
            raise ApiError(422, "invalid_request", "invalid fields: cursor") from exc
        return AuditList(
            items=audit_events_out(page.items, _audit_agents(services)),
            next_cursor=page.next_cursor,
        )

    admin_deps = AdminDeps(
        store=services.settings_store,
        limits=services.budget_limits,
        budgets=services.budgets,
        audit=services.audit,
        probe=services.probe,
        agent_id=settings.agent_id,
        rate_limiter=services.limits.limiter("admin.probe"),
        organization_cache=OrganizationCache(ttl_seconds=60),
        clock=now_utc,
        agent_names=lambda: _agent_names(services),
        latest_names=lambda agent_ids: _latest_names(services, agent_ids),
        member_rate_limiter=services.limits.limiter("admin.member_access"),
    )
    app.include_router(admin_router(admin_deps, current_user, require))

    def platform_allows(caller: Caller, action: str) -> bool:
        # One section of the Gobernanza summary: the request itself was decided and audited.
        return services.authorizer.is_allowed(caller.user, action, *PLATFORM)

    governance_sources: Callable[[Caller], list[QueuedSourceOut]] | None = None
    if services.knowledge is not None:
        governance_knowledge = services.knowledge

        def governance_sources(caller: Caller) -> list[QueuedSourceOut]:
            # The pending bucket proposals of Aprobaciones, as the Bandeja (D88 (48), D89).
            return queued_sources(
                governance_knowledge,
                caller,
                lambda c, action, bases: services.authorizer.allowed_knowledge_bases(
                    c.user, action, bases
                ),
                decided=False,
            )

    app.include_router(
        governance_router(
            GovernanceDeps(
                approvals=services.approvals,
                admin=admin_deps,
                audit=services.audit,
                clock=now_utc,
                limiter=services.limits.limiter("governance.reads"),
                sources=governance_sources,
                agents=_audit_agents(services),
            ),
            current_user,
            require,
            platform_allows,
        )
    )

    if services.observability is not None:
        services.observability.agent_names = lambda: _agent_names(services)
        app.include_router(observability_router(services.observability, current_user, require))

    # Buscar conversaciones (D103): the caller's own, read with their row-level security client.
    app.include_router(
        conversation_search_router(
            SearchDeps(
                read=lambda user_id: services.conversations.search_corpus(
                    user_id,
                    max_conversations=MAX_CONVERSATIONS,
                    max_messages=MAX_MESSAGES,
                    max_bytes=MAX_BYTES,
                    max_list_pages=MAX_LIST_PAGES,
                ),
                audit=services.audit,
                limiter=services.limits.limiter("conversations.searches"),
                default_agent=settings.agent_id,
            ),
            current_user,
            require,
        )
    )

    if services.home is not None:
        app.include_router(
            home_router(
                HomeDeps(
                    data=services.home,
                    user_limit=lambda user_id: services.budget_limits.for_user(user_id)[0],
                    admin=admin_deps,
                    approvals=services.approvals,
                    clock=now_utc,
                    limiter=services.limits.limiter("home.reads"),
                    sources=governance_sources,
                ),
                current_user,
                require,
                platform_allows,
            )
        )

    if services.home is not None:
        # Costos (D105, D106): the organization's counters, read with mango-api's own client.
        app.include_router(
            costs_router(
                CostsDeps(
                    table=services.home.table,
                    dynamodb=services.home.dynamodb,
                    agents=lambda: _cost_agents(services),
                    models=lambda: _cost_models(services),
                    agent_limit=lambda: services.settings_store.budget_defaults().agent_monthly_usd,
                    default_agent=settings.agent_id,
                    clock=now_utc,
                    limiter=services.limits.limiter("costs.reads"),
                ),
                current_user,
                require,
            )
        )

    if services.web_sessions is not None:
        app.include_router(web_session_router(services.web_sessions))
        if services.people is not None:
            services.people.end_sessions = services.web_sessions.revoke_user

    if services.cognito_users is not None and services.mfa_reset_store is not None:
        app.include_router(
            mfa_reset_router(
                MfaResetDeps(
                    store=services.mfa_reset_store,
                    users=services.cognito_users,
                    audit=services.audit,
                    rate_limiter=services.limits.limiter("mfa_reset.proposals"),
                    clock=now_utc,
                    end_sessions=(
                        services.web_sessions.revoke_user if services.web_sessions else None
                    ),
                ),
                current_user,
                require,
            )
        )

    if services.people is not None:
        app.include_router(people_router(services.people, current_user, require))
    app.include_router(
        installation_router(
            Installation(
                name=settings.namespace,
                version=settings.version,
                release=settings.release,
                organization_id=settings.organization_id,
                management_account_id=settings.management_account_id,
                alerts_email=settings.alerts_email,
                sign_up_domains=settings.sign_up_domains,
                first_admin_emails=settings.first_admin_emails,
            ),
            current_user,
            require,
        )
    )

    if services.group_registry is not None:
        app.include_router(groups_router(services.group_registry, current_user, require))

    if services.group_admin is not None:
        app.include_router(group_admin_router(services.group_admin, current_user, require))
    if services.skills is not None:
        app.include_router(skills_router(services.skills, current_user, require))
    if services.evals is not None:
        # D110, D111: suites of cases that score a version of an agent.
        app.include_router(evals_router(services.evals, current_user, require))

    if services.agents is not None:
        app.include_router(agents_router(services.agents, current_user, require))
        if services.playground_harnesses is not None:
            # D91: whoever edits an agent tests a version of it on the shared test harness.
            app.include_router(
                playground_router(
                    PlaygroundDeps(
                        store=services.agents.store,
                        published=services.published,
                        harnesses=services.playground_harnesses,
                        catalog=services.model_catalog.catalog,
                        price=lambda model_id: turns.model_price(services, model_id),
                        scopes=lambda caller, agent_id: turns.budget_scopes(
                            services, caller.user, agent_id
                        ),
                        budgets=services.budgets,
                        audit=services.audit,
                        agentcore=services.agentcore,
                        invocation_key=services.invocation_key,
                        gateway_url=settings.gateway_url,
                        guardrail_id=settings.guardrail_id,
                        guardrail_version=settings.guardrail_version,
                        knowledge_price=settings.knowledge_embedding_price,
                        runs=services.limits.limiter("playground.runs"),
                        concurrent=services.limits.leases("playground.concurrent"),
                        skills=services.skills.store if services.skills is not None else None,
                        skills_bucket=settings.skills_bucket,
                        authorizer=services.authorizer,
                    ),
                    current_user,
                    require,
                )
            )
        if services.remote_mcp is not None:
            # Before the packs router: `/api/mcp/remotes` is never a pack (D98 (17)).
            app.include_router(remote_mcp_router(services.remote_mcp, current_user, require))
        app.include_router(
            mcp_router(services.mcp or McpDeps.catalog_only(services.agents), current_user, require)
        )

    if services.models is not None:
        app.include_router(models_router(services.models, current_user, require))

    if services.connections is not None:
        # «Mis conexiones» (D98 (17)): UseRemoteMcp on the groups of each registration.
        def may_use(caller: Caller, registration: Registration) -> bool:
            return services.authorizer.is_allowed(
                caller.user,
                "UseRemoteMcp",
                REMOTE_MCP_TYPE,
                registration.registration_id,
                remote=RemoteMcpResource(
                    registration.registration_id, frozenset(registration.groups)
                ),
            )

        app.include_router(connections_router(services.connections, current_user, require, may_use))

    if services.directory is not None and services.directory_quota is not None:
        app.include_router(
            directory_router(
                DirectoryDeps(
                    directory=services.directory,
                    quota=services.directory_quota,
                    audit=services.audit,
                    emails_per_minute=services.limits.limiter("directory.emails"),
                    ids_per_minute=services.limits.limiter("directory.ids"),
                    clock=now_utc,
                ),
                current_user,
                require,
            )
        )

    # Write tools with approval (D27). The policies router goes first: its path is under the
    # approvals prefix and must not be read as an approval id.
    if services.tool_policies is not None:
        app.include_router(tool_policy_router(services.tool_policies, current_user, require))
    if services.approvals is not None:

        async def authorize_use(caller: Caller, agent_id: str, approval_id: str) -> None:
            agent = await asyncio.to_thread(turns.served_agent, services, agent_id)
            await require(
                caller,
                "UseAgent",
                "Mango::Agent",
                agent_id,
                context={"approval_id": approval_id},
                agent=turns.use_resource(agent_id, agent),
            )

        def can_decide(caller: Caller) -> bool:
            # A hint for lists: signing and rejecting are authorized (and audited) per request.
            return services.authorizer.is_allowed(caller.user, "ApproveToolCall", *PLATFORM)

        app.include_router(
            approvals_router(services.approvals, current_user, require, authorize_use, can_decide)
        )

    if services.inbox is not None:

        def inbox_can_decide(caller: Caller) -> bool:
            # A hint that shapes the list: signing is authorized (and audited) per request.
            return services.authorizer.is_allowed(caller.user, "ApproveToolCall", *PLATFORM)

        if services.knowledge is not None:
            knowledge = services.knowledge

            def inbox_sources(caller: Caller) -> list[QueuedSourceOut]:
                # The bucket proposals of Aprobaciones, pending only (D88 (49)).
                return queued_sources(
                    knowledge,
                    caller,
                    lambda c, action, bases: services.authorizer.allowed_knowledge_bases(
                        c.user, action, bases
                    ),
                    decided=False,
                )

            services.inbox.sources = inbox_sources

        app.include_router(inbox_router(services.inbox, current_user, require, inbox_can_decide))

    if services.activity is not None:
        if services.agents is not None:
            agents_deps = services.agents

            def activity_agents(caller: Caller, everyone: bool) -> list[AgentView]:
                return [
                    AgentView(
                        agent_id=v.agent_id,
                        name=v.definition.name,
                        icon=v.definition.icon,
                        color=v.definition.color,
                        published=v.status is VersionStatus.PUBLISHED,
                    )
                    for v in usable_versions(agents_deps, caller.user, everyone=everyone)
                ]

            services.activity.agents = activity_agents

        def activity_views_all(caller: Caller) -> bool:
            """Whose activity is read (D90 (1)): everyone's for who may read the audit trail.
            A decision that shapes the answer, audited as a read."""
            allowed = services.authorizer.is_allowed(caller.user, "ViewAudit", *PLATFORM)
            services.audit.emit(
                "policy.decision",
                caller.user.user_id,
                {
                    "action": "ViewAudit",
                    "resource": "Mango::Platform::mango",
                    "allowed": allowed,
                    "read_only": True,
                    "purpose": "activity",
                },
                caller.user,
            )
            return allowed

        app.include_router(
            activity_router(services.activity, current_user, require, activity_views_all)
        )

    if services.tasks is not None:

        def task_allowed(
            caller: Caller,
            action: str,
            resource_type: str,
            resource_id: str,
            task: TaskResource | None,
        ) -> bool:
            """A decision that only shapes the answer (404 or a hint), audited as a read."""
            allowed = services.authorizer.is_allowed(
                caller.user, action, resource_type, resource_id, None, task=task
            )
            services.audit.emit(
                "policy.decision",
                caller.user.user_id,
                {
                    "action": action,
                    "resource": f"{resource_type}::{resource_id}",
                    "allowed": allowed,
                    "read_only": True,
                },
                caller.user,
            )
            return allowed

        app.include_router(tasks_router(services.tasks, current_user, require, task_allowed))

    if services.tickets is not None:

        def tickets_allowed(
            caller: Caller, action: str, tickets: list[TicketResource]
        ) -> frozenset[str]:
            """Decisions that only shape a list, not audited one by one: the list itself was
            authorized and audited (ListTickets)."""
            return services.authorizer.allowed_tickets(caller.user, action, tickets)

        def ticket_allowed(
            caller: Caller,
            action: str,
            resource_type: str,
            resource_id: str,
            ticket: TicketResource,
        ) -> bool:
            """A decision that only shapes the answer (404), audited as a read."""
            allowed = services.authorizer.is_allowed(
                caller.user, action, resource_type, resource_id, ticket=ticket
            )
            services.audit.emit(
                "policy.decision",
                caller.user.user_id,
                {
                    "action": action,
                    "resource": f"{resource_type}::{resource_id}",
                    "allowed": allowed,
                    "read_only": True,
                },
                caller.user,
            )
            return allowed

        app.include_router(
            tickets_router(services.tickets, current_user, require, tickets_allowed, ticket_allowed)
        )

        if services.approvals is not None:
            services.approvals.gate = TicketToolGate(services.tickets, _ticket_decider(services))

    if services.knowledge is not None:

        def knowledge_allowed(
            caller: Caller, action: str, bases: list[KnowledgeBaseResource]
        ) -> frozenset[str]:
            """Decisions that only shape the answer (hints of a list), not audited one by one:
            the list itself was authorized and audited."""
            return services.authorizer.allowed_knowledge_bases(caller.user, action, bases)

        def knowledge_platform(caller: Caller, action: str) -> bool:
            return services.authorizer.is_allowed(caller.user, action, *PLATFORM)

        app.include_router(
            knowledge_router(
                services.knowledge, current_user, require, knowledge_allowed, knowledge_platform
            )
        )
        app.include_router(
            knowledge_sources_router(services.knowledge, current_user, require, knowledge_allowed)
        )

    @app.post("/api/chat")
    async def chat(body: ChatRequest, caller: CallerDependency) -> Response:
        user = caller.user
        repo = services.conversations
        is_new = body.conversation_id is None
        conversation_id = body.conversation_id or new_id()
        turn_id = new_id()
        record = (
            ConversationRecord(sessions.SessionState(), None)
            if is_new
            else await asyncio.to_thread(repo.conversation, user.user_id, conversation_id)
        )
        existing = None if is_new or record is None else record
        agent_id = turns.turn_agent(services, existing, body.agent_id)

        agent = await asyncio.to_thread(turns.served_agent, services, agent_id)
        # The decision is always audited on its own (fail closed, rule 4); the turn ids let
        # the log show it inside the turn's ``agent.completed`` when the turn finishes. The
        # Agent entity carries the groups and users of the version being served (D33): an
        # agent that was never published has none, so nobody matches.
        await require(
            caller,
            "UseAgent",
            "Mango::Agent",
            agent_id,
            context={"conversation_id": conversation_id, "turn": turn_id},
            agent=turns.use_resource(agent_id, agent),
        )
        agent = turns.admit(agent_id, agent, record, body.agent_id)
        checked = await asyncio.to_thread(turns.check_turn, services, caller, agent, body.model)
        # The turn runs in the turn worker (D121): it reserves, invokes and writes its events;
        # this request answers with them, as when the turn ran here.
        chat_turns = services.chat_turns
        if chat_turns is None:  # set by create_app
            raise ApiError(503, "agent_unavailable", "please try again")
        await asyncio.to_thread(
            partial(
                chat_turns.enqueue,
                caller,
                turn_id=turn_id,
                conversation_id=conversation_id,
                checked=checked,
                message=body.message,
            )
        )
        first = await chat_turns.opening(user.user_id, turn_id)
        return StreamingResponse(
            chat_turns.stream(user.user_id, turn_id, first),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    return _wrap(app, settings)


# --- The agent a turn runs on -----------------------------------------------------------


def _agent_names(services: Services) -> dict[str, str]:
    """Names of the published and retired agents, for the administrators' budget list."""
    if services.agents is None:
        return {}
    return {
        version.agent_id: version.definition.name
        for status in (VersionStatus.RETIRED, VersionStatus.PUBLISHED)
        for version in services.agents.store.by_status(status)
    }


def _cost_agents(services: Services) -> dict[str, CostAgent]:
    """The published and retired agents for Costos: the published version wins."""
    if services.agents is None:
        return {}
    return {
        version.agent_id: CostAgent(
            name=version.definition.name,
            category=version.definition.category,
            model=version.definition.model,
        )
        for status in (VersionStatus.RETIRED, VersionStatus.PUBLISHED)
        for version in services.agents.store.by_status(status)
    }


def _cost_models(services: Services) -> list[str]:
    """Every model of the catalog, enabled or not, and the auxiliary one (the titles)."""
    return [
        *(m.id for m in services.model_catalog.catalog().models),
        services.settings.auxiliary_model,
    ]


def _latest_names(services: Services, agent_ids: Collection[str]) -> dict[str, str] | None:
    """Names of the agents that exist, from their latest version; ``None`` without a catalog."""
    if services.agents is None:
        return None
    store = services.agents.store
    names: dict[str, str] = {}
    for agent_id, meta in store.metas(list(agent_ids)).items():
        latest = meta.open_version or meta.published_version or meta.latest_version
        version = store.version(agent_id, latest)
        if version is not None:
            names[agent_id] = version.definition.name
    return names


def _audit_agents(services: Services) -> AgentLookup | None:
    """The agent of an audit event and the email of its creator, from the catalog: the name of
    that version, and the email stored with the version the creator wrote (the one of the event,
    or the first one, which the creator of the agent wrote). Never another person's email."""
    if services.agents is None:
        return None
    store = services.agents.store

    def lookup(agent_id: str, number: int, created_by: str | None) -> AuditAgentOut | None:
        version = store.version(agent_id, number)
        if version is None:
            return None
        wrote: AgentVersion | None = version
        if created_by is not None and version.created_by != created_by and number != 1:
            wrote = store.version(agent_id, 1)
        email = (
            wrote.created_by_email
            if created_by is not None and wrote is not None and wrote.created_by == created_by
            else None
        )
        return AuditAgentOut(name=version.definition.name, created_by_email=email)

    return lookup


# --- The turn of a task (D78) -------------------------------------------------------------


def _task_turn(  # noqa: PLR0911, PLR0912, PLR0915 - the steps of a turn, as in the chat
    services: Services,
    caller: Caller,
    automation: Automation,
    run: Run,
    message: str,
) -> TurnOutcome:
    """One turn without chat, as the owner of the task: the path of ``POST /api/chat``.

    The run has no conversation: its id stands for one in the turn's pending record and its
    runtime session, which is always new (a run never continues another). The answer goes to
    the run, never to logs. A write the agent asks for becomes a request its owner decides from
    their own session (A3, D56): this token has no way to run it.
    """
    user = caller.user
    agent_id = automation.agent_id
    turn_id = new_id()
    try:
        agent = turns.served_agent(services, agent_id)
    except ApiError:
        return TurnOutcome(status=RunStatus.FAILED, reason="agent_unavailable")
    resource = turns.use_resource(agent_id, agent)
    allowed = services.authorizer.is_allowed(user, "UseAgent", "Mango::Agent", agent_id, resource)
    services.audit.emit(
        "policy.decision",
        user.user_id,
        {
            "action": "UseAgent",
            "resource": f"Mango::Agent::{agent_id}",
            "allowed": allowed,
            "read_only": False,
            "task": automation.automation_id,
            "turn": turn_id,
        },
        user,
    )
    if not allowed:
        raise AgentAccessDeniedError
    if agent is None or agent.retired:
        return TurnOutcome(status=RunStatus.SKIPPED, reason="agent_unavailable")
    # Remote tools only of the registrations the owner may use (D98 (2)).
    agent = usable_by(agent, services.authorizer, user)
    definition = agent.definition
    limits = definition.limits
    model_id = definition.model or ""
    if model_id not in definition.allowed_models:
        return TurnOutcome(status=RunStatus.FAILED, reason="model_unavailable")
    try:
        price = turns.model_price(services, model_id)
    except ApiError:
        return TurnOutcome(status=RunStatus.FAILED, reason="model_unavailable")
    if (
        caller.expires_at - int(time.time())
        < limits.timeout_seconds + turns.MIN_TOKEN_LIFETIME_MARGIN
    ):
        # The token of a run must outlive the agent loop, like a chat turn's (TM-I5).
        return TurnOutcome(status=RunStatus.FAILED, reason="identity_unavailable")
    try:
        invocation_request = turns.agent_invocation(services, agent, model_id)
        signature = turns.sign_invocation(services, caller, agent)
    except ApiError:
        return TurnOutcome(status=RunStatus.FAILED, reason="agent_unavailable")
    history = [harness.ChatTurn("user", message)]
    estimate = estimate_max_cost(
        price, len(message), limits.max_iterations, limits.reserved_output_tokens
    ) + turns.knowledge_reserve(services, agent)
    period = current_period()
    try:
        scopes = turns.budget_scopes(services, user, agent_id)
    except ApiError:
        return TurnOutcome(status=RunStatus.FAILED, reason="budget_unavailable")
    turn = {"agent": agent_id, "version": agent.version, "model": model_id}
    pending = PendingTurn.new(
        turn_id=turn_id,
        user_id=user.user_id,
        agent_id=agent_id,
        agent_version=agent.version,
        model=model_id,
        conversation_id=run.run_id,
        period=period,
        scopes=tuple(scope.key for scope in scopes),
        reserved=estimate,
        price=turn_price(price),
        started_at=int(time.time()),
        timeout_seconds=limits.timeout_seconds,
        # A run of a task (D78): Costos tells it from a conversation (D106).
        origin=usage_days.ORIGIN_TASK,
        area=user.business_unit,
    )
    try:
        services.budgets.reserve(scopes, estimate, period, pending)
    except BudgetExceededError as exc:
        services.audit.emit(
            "budget.exceeded",
            user.user_id,
            {
                **turn,
                "estimate": str(estimate),
                "task_id": automation.automation_id,
                "scope": turns.budget_kind(exc),
            },
            user,
        )
        blocked = turns.turn_activity(
            services, turns.task_origin(user, agent_id, agent.version, automation, run)
        )
        if blocked is not None and turns.budget_kind(exc) == "agent":
            blocked.budget_blocked()
        return TurnOutcome(status=RunStatus.SKIPPED, reason="budget_exceeded")
    except BudgetUnavailableError:
        return TurnOutcome(status=RunStatus.FAILED, reason="budget_unavailable")
    fingerprint = sessions.agent_fingerprint(
        harness_arn=agent.harness_arn,
        harness_version=agent.harness_version,
        content_hash=agent.content_hash,
        model=model_id,
        guardrail_id=services.settings.guardrail_id,
        guardrail_version=services.settings.guardrail_version,
    )
    session_id = sessions.runtime_session_id(
        user=user,
        agent_id=agent_id,
        conversation_id=run.run_id,
        generation=0,
        fingerprint=fingerprint,
    )
    try:
        services.budgets.bind_session(pending, session_id)
    except Exception:
        logger.exception("a task turn could not bind its session")
        turns.release_turn(services, pending)
        return TurnOutcome(status=RunStatus.FAILED, reason="budget_unavailable")
    # A task with a report hands its data over with the internal tool (D86 (6), D87 (3)).
    report_type = (
        cast(reports.ReportType, automation.report)
        if automation.report in reports.TYPE_NAMES
        and services.tasks is not None
        and services.tasks.reports is not None
        else None
    )
    request = harness.build_request(
        invocation_request,
        session_id=session_id,
        actor_id=user.user_id,
        access_token=caller.token,
        invocation_signature=signature,
        history=history,
        inline_tools=(reports.tool_spec(report_type),) if report_type else (),
    )
    detail = {
        **turn,
        "task_id": automation.automation_id,
        "run": run.run_id,
        "trigger": run.trigger,
        "via": "task",
        "turn": turn_id,
    }
    agentcore = (
        services.agentcore.for_turn(limits.timeout_seconds)
        if isinstance(services.agentcore, harness.TurnClients)
        else services.agentcore
    )
    result = harness.InvocationResult()
    write_tools = frozenset(name for name, _ in agent.write_tools)
    steps = TaskSteps(
        frozenset(harness.display_tool_name(t) for t in request.get("allowedTools", []))
    )
    requested: set[str] = set()
    approval_ids: list[str] = []
    handed: str | None = None
    answered = False
    activity = turns.turn_activity(
        services, turns.task_origin(user, agent_id, agent.version, automation, run)
    )
    try:
        services.audit.emit("agent.invoke", user.user_id, {**detail, "session": "new"}, user)
        for event in harness.run(
            agentcore,
            request,
            result,
            write_tools,
            inline=frozenset({reports.REPORT_TOOL}) if report_type else frozenset(),
            record=(
                frozenset({reports.COST_QUERY_TOOL, reports.ANOMALY_QUERY_TOOL})
                if report_type
                else frozenset()
            ),
            on_call=activity.call if activity is not None else None,
            skills=frozenset(parse_skill_ref(r)[0] for r in agent.definition.skills),
            on_skill=turns.skill_counter(services),
            remotes=agent.remote_gateway_tools,
        ):
            # The internal tool hands data over: it is not a query, so not a step (D86 (6)).
            if (
                event.kind == "tool"
                and event.data.get("status") == "started"
                and event.data.get("name") != reports.REPORT_TOOL
            ):
                steps.tool(result.text, event.data.get("name", ""))
            if event.kind == harness.INLINE_CALL:
                handed = event.data.get("arguments", "")
                continue
            if event.kind != harness.WRITE_CALL:
                continue
            approval = turns.request_approval(
                services, user, agent, run.run_id, call=event.data, requested=requested
            )
            if approval is not None:
                approval_ids.append(approval.approval_id)
        answered = True
    except Exception:
        if result.harness_missing:
            logger.exception("agent %s is published but its harness does not exist", agent_id)
        else:
            logger.exception("task turn failed")
    finally:
        turns.settle_turn(
            services, user=user, turn=pending, price=price, detail=detail, result=result
        )
        if activity is not None:
            activity.end()
    spent = str(cost(result.usage, price).quantize(Decimal("0.0001")))
    if result.connection_required:
        # The owner has to connect their account from their own session (D98 (20)): the run
        # did not read what it needed, whatever the agent wrote without it. Never a URL.
        return TurnOutcome(
            status=RunStatus.FAILED,
            reason=REMOTE_CONSENT_REQUIRED,
            cost_usd=spent,
            turn_id=turn_id,
            approvals=approval_ids,
            remote_connect=result.connection_required[0],
        )
    if not answered:
        return TurnOutcome(
            status=RunStatus.FAILED,
            reason="harness_missing" if result.harness_missing else "upstream_error",
            cost_usd=spent,
            turn_id=turn_id,
        )
    return TurnOutcome(
        status=RunStatus.APPROVAL if approval_ids else RunStatus.OK,
        result=steps.report(result.text),
        steps=steps.steps,
        cost_usd=spent,
        turn_id=turn_id,
        approvals=approval_ids,
        report=_report_document(report_type, handed, result.calls),
        agent_name=definition.name,
    )


def _report_document(
    report_type: reports.ReportType | None, handed: str | None, calls: list[dict[str, str]]
) -> str | None:
    """The data of the run's PDF, validated, with the series of its query when one matches;
    ``None`` when the agent handed over nothing valid (the report fails with ``data``). Nothing
    of what the model wrote is logged (TM-R6)."""
    if report_type is None or handed is None:
        return None
    try:
        data = reports.parse(report_type, handed)
        document = reports.build(
            report_type,
            data,
            [
                reports.ToolCall(c["id"], c["name"], c["input"], c["output"], c.get("at") or None)
                for c in calls
            ],
        )
    except reports.InvalidReportError as error:
        # The rule and the field that failed, never what the model wrote (TM-R6).
        logger.info("the data of a task report did not validate: %s", error)
        return None
    return json.dumps(document, ensure_ascii=False, separators=(",", ":"))


def _wrap(app: FastAPI, settings: Settings) -> ASGIApp:
    return HostAndSizeGuard(app, settings.allowed_hosts)


def main() -> ASGIApp:
    logging.basicConfig(level=logging.INFO, format=LOG_FORMAT)
    return create_app()
