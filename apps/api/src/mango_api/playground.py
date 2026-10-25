"""The Playground (D91): whoever edits an agent tests a version of it before sending it to
review.

A test runs one question, alone, on the installation's shared test harness
(``Mango_<ns>_a_playground``), with the prompt, the model, the tools, the knowledge bases and
the limits of a stored version: the open draft (at the revision the person sees) or the
published one, for «Con publicado». The person may change three things without saving:
the prompt, the model and the temperature. Everything else comes from the stored version.

What keeps it from being a way around the approval of D18:

* **Only whoever edits the agent** (``EditAgent``, by object, as saving a draft), and only as
  themselves: their token goes to the Gateway (rule 5) and the invocation signature names them.
* **No write ever runs:** the turn stops at the call, which is shown as a simulated write;
  no approval request is made, and the signature carries ``pg``, under which the Gateway
  interceptor refuses every write tool.
* **Nothing is kept or shared:** a new runtime session per test, no history, no conversation,
  the answer only goes to whoever asked.
* **It costs like a turn:** the reservation goes on the person's and the agent's monthly
  budgets before anything is invoked (rule 4) and is settled and reconciled the same way
  (D73), with the limits of the version (D74). Per person, at most ``CONCURRENT_RUNS`` at once
  and ``RUNS_PER_HOUR``, counted once across the tasks of mango-api (D70).
* **A prompt with a likely secret is never sent** to the model (AGENTS.md).

The audit gets ``playground.run``: agent, version, hash of what ran, model, tools, tokens,
cost and outcome. Never the prompt, the question or the answer.
"""

# No `from __future__ import annotations`: FastAPI resolves route annotations at runtime.

import asyncio
import json
import logging
import secrets
import threading
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, replace
from decimal import Decimal
from typing import Annotated, Any

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, StrictFloat

from mango_api import harness, sessions
from mango_api.agent_rules import find_secrets
from mango_api.agents_store import AgentsStore, AgentVersion
from mango_api.audit import AuditLog
from mango_api.authz import AGENT_TYPE, AgentResource
from mango_api.budget import (
    BudgetExceededError,
    BudgetScope,
    BudgetService,
    BudgetUnavailableError,
    current_period,
)
from mango_api.model_catalog import ModelCatalog, ModelCatalogUnavailableError
from mango_api.pricing import cost, estimate_max_cost, knowledge_cost, turn_price
from mango_api.published import AgentUnavailableError, PublishedAgent, PublishedAgents
from mango_api.rate_limits import Leases, Limiter
from mango_api.settings import ModelPrice
from mango_api.skills_store import SkillStore
from mango_api.web import ApiError, Caller, rate_limited
from mango_core import invocation
from mango_core.agents import (
    AGENT_ID_PATTERN,
    MODEL_ID_PATTERN,
    AgentDefinition,
    AgentStatus,
    VersionStatus,
    content_hash,
    dumps_definition,
)
from mango_core.budget_turns import PendingTurn
from mango_core.harness_tools import KNOWLEDGE_TOOL
from mango_core.playground import SETTINGS_PK, SETTINGS_SK, PlaygroundHarness
from mango_core.skills import parse_ref as parse_skill_ref
from mango_core.skills import s3_uri

logger = logging.getLogger(__name__)

RUNS_PER_HOUR = 60
CONCURRENT_RUNS = 2
LEASE_SECONDS = 600 + 120
"""A test lasts at most the longest turn (600 s, D70 (6)) plus the read margin: a lease of a
task that died ends by then."""
MAX_MESSAGE_CHARS = 4000
MAX_PROMPT_CHARS = 32_000
HARNESS_CACHE_SECONDS = 15
MIN_TOKEN_LIFETIME_MARGIN = 60
SIMULATED_WRITE = "simulated_write"


# --- Models -----------------------------------------------------------------------------


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class OverridesIn(_Strict):
    """What may change without saving (D91 (11)). Absent: the stored version's."""

    system_prompt: Annotated[str, Field(min_length=1, max_length=MAX_PROMPT_CHARS)] | None = None
    model: Annotated[str, Field(pattern=MODEL_ID_PATTERN)] | None = None
    temperature: Annotated[StrictFloat, Field(ge=0, le=1)] | None = None


class PlaygroundRunIn(_Strict):
    agent_id: Annotated[str, Field(pattern=AGENT_ID_PATTERN)]
    version: Annotated[int, Field(ge=1, le=1_000_000)]
    revision: Annotated[int, Field(ge=1, le=1_000_000)] | None = None
    """Revision of the draft the person sees; required for a draft, ignored otherwise."""
    message: Annotated[str, Field(min_length=1, max_length=MAX_MESSAGE_CHARS)]
    overrides: OverridesIn = OverridesIn()


# --- Access to data ---------------------------------------------------------------------


class PlaygroundHarnesses:
    """The harness the provisioner deployed for tests (``Settings`` ``PLAYGROUND/HARNESS``),
    read at most once every ``HARNESS_CACHE_SECONDS``. Only this installation's harness name
    is accepted; anything else, or no item, means the Playground is not available."""

    def __init__(
        self,
        dynamodb: Any,
        table: str,
        *,
        namespace: str,
        region: str,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._db = dynamodb
        self._table = table
        self._prefix = f"arn:aws:bedrock-agentcore:{region}:"
        self._name = f":harness/Mango_{namespace}_a_playground-"
        self._clock = clock
        self._cached: tuple[float, PlaygroundHarness] | None = None
        self._lock = threading.Lock()

    def get(self) -> PlaygroundHarness | None:
        now = self._clock()
        with self._lock:
            if self._cached and now - self._cached[0] < HARNESS_CACHE_SECONDS:
                return self._cached[1]
        try:
            item = self._db.get_item(
                TableName=self._table,
                Key={"PK": {"S": SETTINGS_PK}, "SK": {"S": SETTINGS_SK}},
                ConsistentRead=True,
            ).get("Item")
            deployed = PlaygroundHarness.from_item(item) if item else None
        except (ClientError, BotoCoreError, ValueError):
            logger.exception("the playground harness could not be read")
            return None
        if deployed is None:
            return None
        arn = deployed.harness_arn
        if not arn.startswith(self._prefix) or self._name not in arn:
            logger.error("the playground item names a harness that is not this installation's")
            return None
        with self._lock:
            self._cached = (now, deployed)
        return deployed


# --- Use cases --------------------------------------------------------------------------


@dataclass
class PlaygroundDeps:
    store: AgentsStore
    published: PublishedAgents
    harnesses: PlaygroundHarnesses
    catalog: Callable[[], ModelCatalog]
    """The model catalog as the chat reads it; raises ``ModelCatalogUnavailableError``."""
    price: Callable[[str], ModelPrice]
    """Price of an enabled model; raises ``ApiError`` otherwise (as the chat)."""
    scopes: Callable[[Caller, str], list[BudgetScope]]
    """The person's and the agent's monthly budgets (as the chat)."""
    budgets: BudgetService
    audit: AuditLog
    agentcore: Any
    """``harness.TurnClients`` in production; tests give a client."""
    invocation_key: bytes
    gateway_url: str
    guardrail_id: str
    guardrail_version: str
    knowledge_price: Decimal
    runs: Limiter
    concurrent: Leases
    skills: SkillStore | None = None
    """The approved skill versions (D92); without it a version with skills is not tested."""
    skills_bucket: str = ""


@dataclass(frozen=True)
class _Test:
    """What one test runs: the version with the changes, checked like a published one."""

    agent: PublishedAgent
    base: AgentVersion
    model: str
    price: ModelPrice
    skill_sources: tuple[dict[str, Any], ...] = ()
    """``s3`` sources of the version's approved skills, for the invocation (D91 (12))."""
    skill_ids: tuple[str, ...] = ()


def _tested_version(deps: PlaygroundDeps, agent_id: str, body: PlaygroundRunIn) -> AgentVersion:
    """The stored version the test starts from: the open draft at the revision the person
    sees, or the published version (the provisioner's pointer)."""
    version = deps.store.version(agent_id, body.version)
    meta = deps.store.meta(agent_id)
    if version is None or meta is None:
        raise ApiError(404, "not_found", "not found")
    if meta.status is AgentStatus.RETIRED:
        raise ApiError(409, "agent_retired", "this agent was retired")
    if version.status is VersionStatus.DRAFT:
        if body.revision != version.revision:
            raise ApiError(409, "version_conflict", "the draft changed; reload and try again")
        return version
    pointer = deps.store.published_pointer(agent_id)
    if (
        version.status is VersionStatus.PUBLISHED
        and pointer is not None
        and pointer.version == version.number
    ):
        return version
    raise ApiError(409, "version_not_testable", "only a draft or the published version")


def _with_overrides(
    deps: PlaygroundDeps, version: AgentVersion, overrides: OverridesIn
) -> tuple[AgentVersion, str]:
    """The version with the three changes allowed, validated as a definition, and its model."""
    definition = version.definition
    prompt = (
        overrides.system_prompt if overrides.system_prompt is not None else definition.system_prompt
    )
    if find_secrets(prompt):
        # Never into the context of the model (AGENTS.md); the kinds are not echoed either.
        raise ApiError(422, "secret_in_prompt", "the prompt looks like it contains a secret")
    model = overrides.model or definition.model
    if not model:
        raise ApiError(422, "model_required", "choose a model to test with")
    try:
        entry = deps.catalog().get(model)
    except ModelCatalogUnavailableError as exc:
        raise ApiError(503, "playground_unavailable", "please try again") from exc
    if entry is None or not entry.enabled:
        raise ApiError(409, "model_unavailable", "this model is not enabled")
    if definition.tools and not entry.supports_tools:
        raise ApiError(422, "model_without_tools", "this model cannot use the agent's tools")
    limits = definition.limits
    if overrides.temperature is not None:
        limits = limits.model_copy(update={"temperature": overrides.temperature})
    try:
        tested = AgentDefinition.model_validate(
            {
                **definition.model_dump(),
                "system_prompt": prompt,
                "model": model,
                "allowed_models": [model],
                "limits": limits.model_dump(),
            }
        )
    except ValueError as exc:
        raise ApiError(422, "version_not_testable", "this version cannot be tested") from exc
    canonical = dumps_definition(tested)
    return replace(
        version, definition=tested, canonical=canonical, content_hash=content_hash(canonical)
    ), model


def _skill_sources(
    deps: PlaygroundDeps, refs: tuple[str, ...], deployed: PlaygroundHarness
) -> tuple[tuple[dict[str, Any], ...], tuple[str, ...]]:
    """The tested version's skills as the test harness loads them (D91 (12)): only approved
    versions, from this installation's bucket, built here from the stored version; nothing
    from the request. The harness has none of its own, so these are exactly the version's."""
    if not refs:
        return (), ()
    if deps.skills is None or not deps.skills_bucket or not deployed.skills:
        raise ApiError(503, "skills_unavailable", "the playground cannot load skills")
    try:
        approved = deps.skills.approved({ref: parse_skill_ref(ref) for ref in refs})
    except (ClientError, BotoCoreError) as exc:
        raise ApiError(503, "skills_unavailable", "please try again") from exc
    if set(approved) != set(refs):
        raise ApiError(422, "skill_unavailable", "a skill of this version is not approved")
    pairs = sorted(parse_skill_ref(ref) for ref in refs)
    sources = tuple(
        {"s3": {"uri": s3_uri(deps.skills_bucket, skill_id, version)}}
        for skill_id, version in pairs
    )
    return sources, tuple(skill_id for skill_id, _ in pairs)


def _prepare(deps: PlaygroundDeps, agent_id: str, body: PlaygroundRunIn) -> _Test:
    base = _tested_version(deps, agent_id, body)
    tested, model = _with_overrides(deps, base, body.overrides)
    deployed = deps.harnesses.get()
    if deployed is None:
        raise ApiError(503, "playground_unavailable", "the playground is not available")
    if model not in deployed.models:
        # Enabled after the harness role was last written: the provisioner is catching up.
        raise ApiError(503, "playground_unavailable", "the playground is not available yet")
    try:
        agent = deps.published.for_test(
            tested, harness_arn=deployed.harness_arn, harness_version=deployed.harness_version
        )
    except AgentUnavailableError as exc:
        raise ApiError(422, "version_not_testable", "this version cannot be tested") from exc
    sources, skill_ids = _skill_sources(deps, tested.definition.skills, deployed)
    return _Test(
        agent=agent,
        base=base,
        model=model,
        price=deps.price(model),
        skill_sources=sources,
        skill_ids=skill_ids,
    )


def _signature(deps: PlaygroundDeps, caller: Caller, agent: PublishedAgent) -> str:
    """The invocation names the person, the version tested, its tools and knowledge bases,
    and ``pg``: the Gateway refuses every write tool under it (D91 (2))."""
    limits = agent.definition.limits
    expiry = min(caller.expires_at, int(time.time()) + limits.timeout_seconds + 60)
    try:
        return invocation.sign(
            deps.invocation_key,
            caller.user.user_id,
            expiry,
            agent_id=agent.agent_id,
            agent_version=agent.version,
            tools=agent.gateway_tools,
            knowledge_bases=agent.definition.knowledge_bases,
            playground=True,
        )
    except ValueError as exc:
        raise ApiError(422, "version_not_testable", "this version cannot be tested") from exc


def _sse(event: str, data: dict[str, Any]) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n".encode()


def _flags(result: harness.InvocationResult, elapsed: float, limits: Any) -> dict[str, bool]:
    """What the result card marks (design: «Guardrail», «Supera tokens», «Supera tiempo»,
    «Tope de iteraciones»), from the end of the stream and the version's limits."""
    started = sum(1 for t in result.tools if t["status"] == "started")
    return {
        "guardrail": result.stop_reason == "guardrail_intervened",
        "token_cap": result.stop_reason == harness.CAP_STOP,
        "time_limit": elapsed >= limits.timeout_seconds,
        "iteration_limit": (
            result.stop_reason == harness.TOOL_STOP
            and not result.interrupted
            and started >= limits.max_iterations
        ),
    }


def run_test(
    deps: PlaygroundDeps, caller: Caller, test: _Test, message: str, put: Callable[[bytes], None]
) -> None:
    """Reserve, invoke, stream and settle one test. Raises nothing once streaming."""
    user = caller.user
    agent = test.agent
    limits = agent.definition.limits
    run_id = secrets.token_hex(16)
    period = current_period()
    estimate = estimate_max_cost(
        test.price, len(message), limits.max_iterations, limits.reserved_output_tokens
    ) + (
        knowledge_cost(limits.max_iterations, deps.knowledge_price)
        if agent.definition.knowledge_bases
        else Decimal(0)
    )
    detail: dict[str, Any] = {
        "agent": agent.agent_id,
        "version": agent.version,
        "base_hash": test.base.content_hash,
        "content_hash": agent.content_hash,
        "model": test.model,
        "run": run_id,
        # The approved versions it loaded (D91 (12)): references, never their text.
        "skills": list(test.agent.definition.skills),
        "changed": sorted(
            name
            for name, changed in (
                (
                    "system_prompt",
                    agent.definition.system_prompt != test.base.definition.system_prompt,
                ),
                ("model", test.model != test.base.definition.model),
                (
                    "temperature",
                    agent.definition.limits.temperature != test.base.definition.limits.temperature,
                ),
            )
            if changed
        ),
    }
    try:
        scopes = deps.scopes(caller, agent.agent_id)
    except ApiError:
        put(_sse("error", {"code": "budget_unavailable", "message": "please try again"}))
        return
    pending = PendingTurn.new(
        turn_id=run_id,
        user_id=user.user_id,
        agent_id=agent.agent_id,
        agent_version=agent.version,
        model=test.model,
        conversation_id=run_id,
        period=period,
        scopes=tuple(scope.key for scope in scopes),
        reserved=estimate,
        price=turn_price(test.price),
        started_at=int(time.time()),
        timeout_seconds=limits.timeout_seconds,
    )
    try:
        deps.budgets.reserve(scopes, estimate, period, pending)
    except BudgetExceededError as exc:
        kind = None if exc.scope is None else "agent" if exc.scope.startswith("AGENT#") else "user"
        deps.audit.emit(
            "budget.exceeded",
            user.user_id,
            {**detail, "estimate": str(estimate), "scope": kind, "origin": "playground"},
            user,
        )
        put(_sse("error", {"code": "budget_exceeded", "scope": kind or "unknown"}))
        return
    except BudgetUnavailableError:
        put(_sse("error", {"code": "budget_unavailable", "message": "please try again"}))
        return

    result = harness.InvocationResult()
    simulated: list[str] = []
    started = time.monotonic()
    try:
        session_id = sessions.runtime_session_id(
            user=user,
            agent_id=agent.agent_id,
            conversation_id=run_id,
            generation=0,
            fingerprint=f"playground:{agent.content_hash}",
        )
        deps.budgets.bind_session(pending, session_id)
        request = harness.build_request(
            harness.AgentInvocation(
                harness_arn=agent.harness_arn,
                qualifier=agent.qualifier,
                system_prompt=agent.definition.system_prompt,
                model=test.model,
                limits=limits,
                allowed_tools=agent.allowed_tools,
                gateway_url=deps.gateway_url,
                guardrail_id=deps.guardrail_id,
                guardrail_version=deps.guardrail_version,
                skills=test.skill_ids,
            ),
            session_id=session_id,
            actor_id=user.user_id,
            access_token=caller.token,
            invocation_signature=_signature(deps, caller, agent),
            history=[harness.ChatTurn("user", message)],
            test_skills=test.skill_sources,
        )
        client = (
            deps.agentcore.for_turn(limits.timeout_seconds)
            if isinstance(deps.agentcore, harness.TurnClients)
            else deps.agentcore
        )
        write_tools = frozenset(name for name, _ in agent.write_tools)
        deps.audit.emit("playground.invoke", user.user_id, detail, user)
        # Loads of a skill are never shown (D92 (8)) nor counted as runs of it: a test is not
        # a use (D91 (12)).
        for event in harness.run(
            client, request, result, write_tools, skills=frozenset(test.skill_ids)
        ):
            if event.kind == harness.WRITE_CALL:
                # Never executed and never asked (D91 (2)): only shown as what it would ask.
                tool = harness.display_tool_name(str(event.data.get("tool", "")))
                simulated.append(tool)
                put(_sse(SIMULATED_WRITE, {"tool": tool}))
                continue
            put(_sse(event.kind, event.data))
        elapsed = time.monotonic() - started
        put(
            _sse(
                "done",
                {
                    "stop_reason": result.stop_reason,
                    "usage": {
                        "input_tokens": result.usage.input_tokens,
                        "output_tokens": result.usage.output_tokens,
                    },
                    "cost_usd": str(cost(result.usage, test.price).quantize(Decimal("0.0001"))),
                    "duration_ms": round(elapsed * 1000),
                    "flags": _flags(result, elapsed, limits),
                },
            )
        )
    except Exception:
        logger.exception(
            "playground test failed" if not result.harness_missing else "playground harness missing"
        )
        put(_sse("error", {"code": "upstream_error", "message": "the test failed"}))
    finally:
        _settle(deps, caller, pending, test.price, result, detail, simulated)


def _settle(  # noqa: PLR0917 - the parts of one test, all required
    deps: PlaygroundDeps,
    caller: Caller,
    turn: PendingTurn,
    price: ModelPrice,
    result: harness.InvocationResult,
    detail: dict[str, Any],
    simulated: list[str],
) -> None:
    """Close the reservation like a chat turn (D73) and audit the test; never raises."""
    searches = sum(
        1 for t in result.tools if t["name"] == KNOWLEDGE_TOOL and t["status"] == "started"
    )
    known = cost(result.usage, price) + knowledge_cost(searches, deps.knowledge_price)
    final = result.usage_final or not result.started
    try:
        if final:
            recorded = deps.budgets.settle_turn(turn, known)
        else:
            recorded = deps.budgets.hold_turn(turn, result.usage.tokens()) is not None
        deps.audit.emit(
            "playground.run",
            caller.user.user_id,
            {
                **detail,
                "stop_reason": result.stop_reason,
                "tools": [t["name"] for t in result.tools if t["status"] == "started"],
                "simulated_writes": simulated,
                "input_tokens": result.usage.input_tokens,
                "output_tokens": result.usage.output_tokens,
                "cost_usd": str(known),
                "settlement": "reconciler" if not recorded else "final" if final else "pending",
                **({"failure": "harness_missing"} if result.harness_missing else {}),
                "authz": {"action": "EditAgent", "allowed": True},
            },
            caller.user,
        )
    except Exception:
        logger.exception("post-test accounting failed")


# --- Router -----------------------------------------------------------------------------


Authorize = Callable[..., Awaitable[None]]
HEARTBEAT_SECONDS = 15


async def _streamed(producer: Callable[[Callable[[bytes], None]], None]) -> AsyncIterator[bytes]:
    """Run a blocking producer in a thread; yield its chunks and a comment now and then."""
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[bytes | None] = asyncio.Queue()

    def put(chunk: bytes) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, chunk)

    def target() -> None:
        try:
            producer(put)
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)

    threading.Thread(target=target, daemon=True).start()
    while True:
        try:
            chunk = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_SECONDS)
        except TimeoutError:
            yield b": ping\n\n"
            continue
        if chunk is None:
            return
        yield chunk


def playground_router(
    deps: PlaygroundDeps,
    current_user: Callable[..., Awaitable[Caller]],
    authorize: Authorize,
) -> APIRouter:
    router = APIRouter(prefix="/api/playground")

    async def editor(
        body: PlaygroundRunIn, caller: Annotated[Caller, Depends(current_user)]
    ) -> Caller:
        """``EditAgent`` on the agent of the test, as saving a draft (by object, deny by
        default). An agent that does not exist is denied like any other."""
        meta = await asyncio.to_thread(deps.store.meta, body.agent_id)
        resource = AgentResource(body.agent_id, creator=meta.created_by if meta else None)
        await authorize(caller, "EditAgent", AGENT_TYPE, body.agent_id, agent=resource)
        user = caller.user
        # Defense in depth: the Cedar policies already require these.
        owner = meta is not None and user.is_agent_creator and meta.created_by == user.user_id
        if not (user.is_admin or owner):
            raise ApiError(403, "forbidden", "not allowed")
        if meta is None:
            raise ApiError(404, "not_found", "not found")
        return caller

    Editor = Annotated[Caller, Depends(editor)]  # noqa: N806

    @router.post("/runs")
    async def run_playground_test(body: PlaygroundRunIn, caller: Editor) -> Response:
        user_id = caller.user.user_id
        test = await asyncio.to_thread(_prepare, deps, body.agent_id, body)
        limits = test.agent.definition.limits
        if (
            caller.expires_at - int(time.time())
            < limits.timeout_seconds + MIN_TOKEN_LIFETIME_MARGIN
        ):
            # The token must outlive the agent loop (TM-I5).
            raise ApiError(401, "token_expiring", "token about to expire; sign in again")
        lease = await asyncio.to_thread(deps.concurrent.acquire, user_id)
        if lease is None:
            raise ApiError(
                429,
                "playground_busy",
                "two tests are running; wait for one",
                headers={"Retry-After": "5"},
            )
        if not await asyncio.to_thread(deps.runs.allow, user_id):
            await asyncio.to_thread(deps.concurrent.release, user_id, lease)
            raise rate_limited(await asyncio.to_thread(deps.runs.retry_after, user_id))

        def produce(put: Callable[[bytes], None]) -> None:
            try:
                run_test(deps, caller, test, body.message, put)
            finally:
                deps.concurrent.release(user_id, lease)

        return StreamingResponse(
            _streamed(produce),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    return router
