"""The runs of eval suites (D110, D111; threat model ``evals-threat-model.md``).

A run is a chain of messages in the queue of runs (``mango_core.task_runs.EvalStep``): one per
case, then the judging. Each message is short (one turn, at most 600 s, within the visibility of
the queue), never carries authority, and every step reads the run, the suite and the version
again and makes every check again:

1. The launcher's token for this run (the identity of D78): a person disabled or gone stops the
   run (``access_lost``); a token that fails is retried, then the run ends with ``error``.
2. ``EditEvals`` on the agent, with the groups the launcher has now (D111 (2)); otherwise it stops.
3. The evals harness and its capture: no step runs unless the canary verified the harness version
   it is about to invoke (D110 (8)); otherwise it stops with ``evals_unavailable``.
4. The version is the one the run was launched on (its ``content_hash``); otherwise it stops.
5. The budget is reserved first on the launcher's and the agent's monthly budgets (rule 4,
   D111 (3)), with the version's limits (D74); without budget the run stops at that case.
6. The turn runs on the evals harness, with the launcher's token at the Gateway (rule 5) and the
   test mark in the signature, so no write tool ever runs (D91 (2)). It is settled like a turn
   (D73) and counted with origin ``eval`` and the evals role as the caller of Bedrock (D104, D106).
7. The criterion is decided in code (contains, uses the tool, no disclosure); a judge case only
   keeps its runtime session. The answer of the agent is never stored.

The judging waits for the traces to reach CloudWatch (a delayed message), reserves on the agent's
budget (the judge is the agent's, D111 (3)), asks ``Mango-<ns>-EvalJudge`` for the verdict of each
judge case and records PASS or FAIL. Then the run closes with its score and, if it ran to the end,
becomes the suite's last run: what the gate of D26 reads.

The audit gets ``evals.run`` (started, step and ended): ids, counts, codes and costs only.
"""

from __future__ import annotations

import json
import logging
import re
import secrets
import time
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Any, Literal, Protocol

from botocore.exceptions import BotoCoreError, ClientError

from mango_api import harness, memory, sessions
from mango_api.agent_rules import find_secrets
from mango_api.agents_store import AgentsStore, AgentVersion
from mango_api.audit import AuditLog
from mango_api.authz import AGENT_TYPE, AgentResource, Authorizer
from mango_api.budget import (
    BudgetExceededError,
    BudgetScope,
    BudgetService,
    current_period,
)
from mango_api.evals_store import (
    CaseResult,
    ConflictError,
    EvalRuns,
    EvalStore,
    Run,
    StoredEvalError,
    Suite,
)
from mango_api.model_catalog import ModelCatalog, ModelCatalogUnavailableError
from mango_api.playground import _signature, _skill_sources
from mango_api.pricing import (
    cost,
    eval_case_reservation,
    judge_reservation,
    knowledge_cost,
    turn_price,
)
from mango_api.published import AgentUnavailableError, PublishedAgents, usable_by
from mango_api.settings import ModelPrice
from mango_api.skills_store import SkillStore
from mango_api.task_identity import OwnerAccessLostError
from mango_api.web import Caller
from mango_core import task_runs, usage_days
from mango_core.agents import VersionStatus, content_hash
from mango_core.budget_turns import PendingTurn, TokenUsage, token_cost
from mango_core.evals import EvalCase
from mango_core.evals_harness import (
    CAPTURE_SK,
    EVALS_ID,
    HARNESS_SK,
    SETTINGS_PK,
    Capture,
    EvalsHarness,
)
from mango_core.harness_tools import KNOWLEDGE_TOOL
from mango_core.playground import PlaygroundHarness

if TYPE_CHECKING:
    from mypy_boto3_lambda import LambdaClient

logger = logging.getLogger(__name__)

JUDGE_DELAY_SECONDS = 300
"""Traces reach CloudWatch 2 to 5 minutes after a turn (AgentCore Evaluations' guide)."""
JUDGE_RETRY_SECONDS = 180
DISCLOSURE_FRAGMENT_CHARS = 40
"""A run of this many characters of the version's prompt in an answer is a disclosure."""
HARNESS_CACHE_SECONDS = 15
_WS_RE = re.compile(r"\s+")
TESTABLE = frozenset({VersionStatus.DRAFT, VersionStatus.IN_REVIEW, VersionStatus.PUBLISHED})
"""The versions an eval runs on: a draft, one in review (D26) or the published one."""


class RunSender(Protocol):
    def send(self, body: str, *, delay_seconds: int = ...) -> None: ...


class RunTokens(Protocol):
    def caller_for(self, owner_id: str, run_id: str) -> Caller: ...


# --- What may run -------------------------------------------------------------------------


class EvalsHarnesses:
    """The evals harness the provisioner deployed (``EVALS`` / ``HARNESS``) and whether the canary
    verified its version (``EVALS`` / ``CAPTURE``). ``get`` is ``None`` unless both are there, for
    this installation's harness name, and the capture is ``verified`` for that very version: no
    eval runs on a harness whose content might reach ``aws/spans`` (D110 (8)). Same interface as
    ``playground.PlaygroundHarnesses``."""

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
        self._name = f":harness/Mango_{namespace}_a_evals-"
        self._clock = clock
        self._cached: tuple[float, PlaygroundHarness | None] | None = None

    def _item(self, sk: str) -> dict[str, Any] | None:
        item: dict[str, Any] | None = self._db.get_item(
            TableName=self._table,
            Key={"PK": {"S": SETTINGS_PK}, "SK": {"S": sk}},
            ConsistentRead=True,
        ).get("Item")
        return item

    def get(self) -> PlaygroundHarness | None:
        now = self._clock()
        if self._cached and now - self._cached[0] < HARNESS_CACHE_SECONDS:
            return self._cached[1]
        verified: PlaygroundHarness | None = None
        try:
            harness_item, capture_item = self._item(HARNESS_SK), self._item(CAPTURE_SK)
            if harness_item is not None and capture_item is not None:
                deployed = EvalsHarness.from_item(harness_item).deployed
                capture = Capture.from_item(capture_item)
                arn = deployed.harness_arn
                if (
                    arn.startswith(self._prefix)
                    and self._name in arn
                    and capture.verified_for(deployed.harness_version)
                ):
                    verified = deployed
        except (ClientError, BotoCoreError, ValueError):
            logger.exception("the evals harness could not be read")
            return None
        self._cached = (now, verified)
        return verified


# --- Deterministic criteria ----------------------------------------------------------------


def _fold(text: str) -> str:
    return _WS_RE.sub(" ", unicodedata.normalize("NFKC", text)).casefold().strip()


def discloses(answer: str, prompt: str) -> bool:
    """A secret, or a run of ``DISCLOSURE_FRAGMENT_CHARS`` characters of the prompt anywhere in
    the answer (every window of the answer, so no alignment hides one)."""
    if find_secrets(answer):
        return True
    folded_prompt, folded_answer = _fold(prompt), _fold(answer)
    width = DISCLOSURE_FRAGMENT_CHARS
    if len(folded_prompt) < width:
        return bool(folded_prompt) and folded_prompt in folded_answer
    windows = {folded_answer[i : i + width] for i in range(len(folded_answer) - width + 1)}
    return any(
        folded_prompt[i : i + width] in windows for i in range(len(folded_prompt) - width + 1)
    )


def decide(case: EvalCase, answer: str, tools: list[str], prompt: str) -> CaseResult:
    """The verdict of a case that needs no judge. ``tools``: names as the stream says them."""
    if case.criterion == "contains":
        found = _fold(case.value) in _fold(answer)
        return CaseResult("pass" if found else "fail", None if found else "missing_text")
    if case.criterion == "uses_tool":
        wanted = case.value.split(".", 1)[1]
        used = any(harness.display_tool_name(name) == wanted for name in tools)
        return CaseResult("pass" if used else "fail", None if used else "tool_not_used")
    if case.criterion == "no_disclosure":
        leaked = discloses(answer, prompt)
        return CaseResult("fail" if leaked else "pass", "disclosed" if leaked else None)
    raise ValueError("the judge decides this case")


def score_of(results: tuple[CaseResult | None, ...]) -> int:
    passed = sum(1 for r in results if r is not None and r.status == "pass")
    return round(100 * passed / len(results)) if results else 0


# --- The runner ----------------------------------------------------------------------------


@dataclass
class EvalRunnerDeps:
    store: EvalStore
    runs: EvalRuns
    agents: AgentsStore
    published: PublishedAgents
    harnesses: EvalsHarnesses
    catalog: Callable[[], ModelCatalog]
    price: Callable[[str], ModelPrice]
    scopes: Callable[[Caller, str], list[BudgetScope]]
    budgets: BudgetService
    audit: AuditLog
    agentcore: Any
    invocation_key: bytes
    gateway_url: str
    guardrail_id: str
    guardrail_version: str
    knowledge_price: Decimal
    tokens: RunTokens
    queue: RunSender
    judge: LambdaClient
    judge_function: str
    evaluation_fee: Decimal
    authorizer: Authorizer
    skills: SkillStore | None = None
    skills_bucket: str = ""
    clock: Callable[[], datetime] = lambda: datetime.now(UTC)


class StopRunError(Exception):
    """The run ends here with a reason (``stopped``)."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class EvalRunner:
    def __init__(self, deps: EvalRunnerDeps) -> None:
        self._d = deps

    # --- Entry point -------------------------------------------------------------------

    def handle(self, step: task_runs.EvalStep) -> None:
        d = self._d
        suite = d.store.find_suite(step.suite_id)
        run = d.runs.get(step.suite_id, step.run_id) if suite is not None else None
        if suite is None or run is None or run.status in ("passed", "failed", "stopped", "error"):
            return
        if suite.running != run.run_id:
            return  # the suite was released meanwhile: nothing to do
        try:
            if step.step == task_runs.STEP_JUDGE:
                self._judging(suite, run, step.attempt)
            else:
                self._case(suite, run, int(step.step))
        except StopRunError as exc:
            self._finish(suite, run, "stopped", exc.reason)

    # --- Checks of every step -----------------------------------------------------------

    def _caller(self, run: Run) -> Caller:
        d = self._d
        try:
            caller = d.tokens.caller_for(run.launched_by, run.run_id)
        except OwnerAccessLostError:
            raise StopRunError("access_lost") from None
        meta = d.agents.meta(run.agent_id)
        resource = AgentResource(run.agent_id, creator=meta.created_by if meta else None)
        user = caller.user
        owner = meta is not None and user.is_agent_creator and meta.created_by == user.user_id
        allowed = d.authorizer.is_allowed(user, "EditEvals", AGENT_TYPE, run.agent_id, resource)
        if not (allowed and (user.is_admin or owner)):
            raise StopRunError("access_lost")
        return caller

    def _version(self, run: Run) -> AgentVersion:
        version = self._d.agents.version(run.agent_id, run.version)
        if (
            version is None
            or content_hash(version.canonical) != run.content_hash
            or version.status not in TESTABLE
        ):
            raise StopRunError("version_changed")
        return version

    # --- A case ---------------------------------------------------------------------------

    def _case(self, suite: Suite, run: Run, index: int) -> None:
        d = self._d
        if index >= run.case_count or run.results[index] is not None:
            # Delivered again: the case already ran; go on from where the run is.
            self._next(suite, run, index + 1)
            return
        cases = d.store.cases(suite)
        if len(cases) != run.case_count:
            raise StopRunError("suite_changed")
        case = cases[index]
        caller = self._caller(run)
        version = self._version(run)
        deployed = d.harnesses.get()
        if deployed is None:
            raise StopRunError("evals_unavailable")
        model = version.definition.model
        if not model or model not in deployed.models:
            raise StopRunError("model_unavailable")
        try:
            agent = d.published.for_test(
                version,
                harness_arn=deployed.harness_arn,
                harness_version=deployed.harness_version,
            )
        except AgentUnavailableError:
            raise StopRunError("version_not_testable") from None
        sources, skill_ids = _skill_sources(d, version.definition.skills, deployed)  # type: ignore[arg-type]
        agent = usable_by(agent, d.authorizer, caller.user)
        result = self._turn(run, caller, agent, case, model, sources, skill_ids)
        d.runs.record(run, index, result, "running")
        run = replace(run, results=(*run.results[:index], result, *run.results[index + 1 :]))
        if result.reason == "budget":
            raise StopRunError("budget")
        self._next(suite, run, index + 1)

    def _next(self, suite: Suite, run: Run, index: int) -> None:
        d = self._d
        if index < run.case_count:
            d.queue.send(task_runs.eval_message(suite.suite_id, run.run_id, index))
            return
        if any(r is not None and r.status == "judge" for r in run.results):
            d.queue.send(
                task_runs.eval_message(suite.suite_id, run.run_id, task_runs.STEP_JUDGE),
                delay_seconds=JUDGE_DELAY_SECONDS,
            )
            return
        self._close(suite, run)

    def _turn(  # noqa: PLR0917 - the parts of one case, all required
        self,
        run: Run,
        caller: Caller,
        agent: Any,
        case: EvalCase,
        model: str,
        sources: tuple[dict[str, Any], ...],
        skill_ids: tuple[str, ...],
    ) -> CaseResult:
        d = self._d
        user = caller.user
        limits = agent.definition.limits
        price = d.price(model)
        estimate = eval_case_reservation(
            price,
            len(case.question),
            limits.max_iterations,
            limits.reserved_output_tokens,
            d.knowledge_price if agent.definition.knowledge_bases else None,
        )
        turn_id = secrets.token_hex(16)
        scopes = d.scopes(caller, agent.agent_id)
        pending = PendingTurn.new(
            turn_id=turn_id,
            user_id=user.user_id,
            agent_id=agent.agent_id,
            agent_version=agent.version,
            model=model,
            conversation_id=turn_id,
            period=current_period(),
            scopes=tuple(scope.key for scope in scopes),
            reserved=estimate,
            price=turn_price(price),
            started_at=int(time.time()),
            timeout_seconds=limits.timeout_seconds,
            area=user.business_unit,
            # The budget is the agent's and the launcher's; Bedrock bills the evals role (D104).
            cost_agent=EVALS_ID,
            origin=usage_days.ORIGIN_EVAL,
        )
        try:
            d.budgets.reserve(scopes, estimate, pending.period, pending)
        except BudgetExceededError:
            return CaseResult("skipped", "budget")
        result = harness.InvocationResult()
        started = int(time.time())
        session_id = sessions.runtime_session_id(
            user=user,
            agent_id=agent.agent_id,
            conversation_id=turn_id,
            generation=0,
            fingerprint=f"eval:{run.run_id}:{agent.content_hash}",
        )
        attempted: list[str] = []
        try:
            d.budgets.bind_session(pending, session_id)
            request = harness.build_request(
                harness.AgentInvocation(
                    harness_arn=agent.harness_arn,
                    qualifier=agent.qualifier,
                    system_prompt=agent.definition.system_prompt,
                    model=model,
                    limits=limits,
                    allowed_tools=agent.allowed_tools,
                    gateway_url=d.gateway_url,
                    guardrail_id=d.guardrail_id,
                    guardrail_version=d.guardrail_version,
                    skills=skill_ids,
                ),
                session_id=session_id,
                # A test harness without memory (D122 (8), TM-ME9).
                actor_id=memory.TEST_ACTOR,
                access_token=caller.token,
                # The test mark: the Gateway refuses every write tool under it (D91 (2)).
                invocation_signature=_signature(d, caller, agent),  # type: ignore[arg-type]
                history=[harness.ChatTurn("user", case.question)],
                test_skills=sources,
            )
            client = (
                d.agentcore.for_turn(limits.timeout_seconds)
                if isinstance(d.agentcore, harness.TurnClients)
                else d.agentcore
            )
            write_tools = frozenset(name for name, _ in agent.write_tools)
            for event in harness.run(
                client,
                request,
                result,
                write_tools,
                skills=frozenset(skill_ids),
                remotes=agent.remote_gateway_tools,
            ):
                if event.kind == harness.WRITE_CALL:
                    # Never executed: «usó la tool» counts the attempt (TM-EV7).
                    attempted.append(str(event.data.get("tool", "")))
        except Exception:
            logger.exception("an eval case failed")
            return self._settle(pending, price, result, CaseResult("fail", "no_answer"))
        tools = [t["name"] for t in result.tools if t["status"] == "started"] + attempted
        if not result.text.strip():
            verdict = CaseResult("fail", "no_answer")
        elif case.criterion == "judge":
            verdict = CaseResult("judge", None, session_id, started)
        else:
            verdict = decide(case, result.text, tools, agent.definition.system_prompt)
        return self._settle(pending, price, result, verdict)

    def _settle(
        self,
        pending: PendingTurn,
        price: ModelPrice,
        result: harness.InvocationResult,
        verdict: CaseResult,
    ) -> CaseResult:
        """Close the reservation like a chat turn (D73); never raises."""
        d = self._d
        searches = sum(
            1 for t in result.tools if t["name"] == KNOWLEDGE_TOOL and t["status"] == "started"
        )
        known = cost(result.usage, price) + knowledge_cost(searches, d.knowledge_price)
        try:
            if result.usage_final or not result.started:
                d.budgets.settle_turn(pending, known, invoked=result.started)
            else:
                d.budgets.hold_turn(pending, result.usage.tokens())
        except Exception:
            logger.exception("eval case accounting failed")
        return verdict

    # --- The judging -----------------------------------------------------------------------

    def _judging(self, suite: Suite, run: Run, attempt: int) -> None:
        d = self._d
        caller = self._caller(run)
        self._version(run)
        if not run.judge_model:
            raise StopRunError("judge_unavailable")
        cases = d.store.cases(suite)
        waiting = [
            (i, r)
            for i, r in enumerate(run.results)
            if r is not None and r.status == "judge" and r.session_id and r.started_at
        ]
        late = False
        for index, result in waiting:
            verdict = self._judge(caller, run, cases[index], result)
            if verdict is None:
                late = True
                continue
            d.runs.record(run, index, verdict, "judging")
            run = replace(run, results=(*run.results[:index], verdict, *run.results[index + 1 :]))
            if verdict.reason == "budget":
                raise StopRunError("budget")
        if late and attempt + 1 < task_runs.MAX_JUDGE_ATTEMPTS:
            d.queue.send(
                task_runs.eval_message(
                    suite.suite_id, run.run_id, task_runs.STEP_JUDGE, attempt + 1
                ),
                delay_seconds=JUDGE_RETRY_SECONDS,
            )
            return
        if late:
            # Traces that never arrived: those cases are failures, not passes (fail closed).
            for index, left in enumerate(run.results):
                if left is not None and left.status == "judge":
                    no_trace = CaseResult("fail", "no_trace")
                    d.runs.record(run, index, no_trace, "judging")
                    run = replace(
                        run, results=(*run.results[:index], no_trace, *run.results[index + 1 :])
                    )
        self._close(suite, run)

    def _judge(
        self, caller: Caller, run: Run, case: EvalCase, result: CaseResult
    ) -> CaseResult | None:
        """The verdict of one judge case; ``None`` while its traces have not arrived. The judge
        is paid by the agent (D111 (3)), reserved first (rule 4)."""
        d = self._d
        model = str(run.judge_model)
        try:
            entry = d.catalog().get(model)
        except ModelCatalogUnavailableError:
            entry = None
        if entry is None or not entry.enabled:
            return CaseResult("fail", "judge_failed")
        price = d.price(model)
        tprice = turn_price(price)
        estimate = judge_reservation(price, d.evaluation_fee)
        agent_scopes = [s for s in d.scopes(caller, run.agent_id) if s.key.startswith("AGENT#")]
        turn_id = secrets.token_hex(16)
        pending = PendingTurn.new(
            turn_id=turn_id,
            user_id=caller.user.user_id,
            agent_id=run.agent_id,
            agent_version=run.version,
            model=model,
            conversation_id=turn_id,
            period=current_period(),
            scopes=tuple(s.key for s in agent_scopes),
            reserved=estimate,
            price=tprice,
            started_at=int(time.time()),
            timeout_seconds=120,
            area=caller.user.business_unit,
            origin=usage_days.ORIGIN_EVAL,
        )
        try:
            d.budgets.reserve(agent_scopes, estimate, pending.period, pending)
        except BudgetExceededError:
            return CaseResult("skipped", "budget")
        verdict: dict[str, Any] = {}
        try:
            response = d.judge.invoke(
                FunctionName=d.judge_function,
                InvocationType="RequestResponse",
                # The expected answer is content: it goes to the evaluator only, never to logs.
                Payload=json.dumps(
                    {
                        "action": "judge",
                        "session_id": result.session_id,
                        "expected": case.expected,
                        "judge_model": model,
                        "started_at": result.started_at,
                    }
                ).encode(),
            )
            if not response.get("FunctionError"):
                raw = json.loads(response["Payload"].read())
                verdict = raw if isinstance(raw, dict) else {}
        except (ClientError, BotoCoreError, ValueError):
            logger.exception("the eval judge failed")
        usage = TokenUsage(
            input_tokens=int(verdict.get("input_tokens", 0) or 0),
            output_tokens=int(verdict.get("output_tokens", 0) or 0),
        )
        charged = token_cost(usage, tprice) + d.evaluation_fee * int(
            verdict.get("evaluations", 0) or 0
        )
        try:
            d.budgets.settle_turn(pending, charged, invoked=bool(verdict))
        except Exception:
            logger.exception("eval judge accounting failed")
        status = verdict.get("status")
        if status == "no_trace":
            return None
        if status != "scored":
            return CaseResult("fail", "judge_failed")
        passed = verdict.get("passed") is True and verdict.get("label") == "PASS"
        return CaseResult("pass" if passed else "fail", None if passed else "judge_low")

    # --- The end -----------------------------------------------------------------------------

    def _close(self, suite: Suite, run: Run) -> None:
        score = score_of(run.results)
        self._finish(suite, run, "passed" if score >= run.threshold else "failed", None, score)

    def _finish(
        self,
        suite: Suite,
        run: Run,
        status: Literal["passed", "failed", "stopped", "error"],
        reason: str | None,
        score: int | None = None,
    ) -> None:
        d = self._d
        try:
            d.runs.finish(suite, run, status=status, score=score, now=d.clock(), stop_reason=reason)
        except (ConflictError, StoredEvalError):
            return  # closed by another delivery
        try:
            d.audit.emit(
                "evals.run",
                run.launched_by,
                {
                    "outcome": "ended",
                    "suite": suite.suite_id,
                    "agent": run.agent_id,
                    "version": run.version,
                    "content_hash": run.content_hash,
                    "run": run.run_id,
                    "status": status,
                    "score": score,
                    "threshold": run.threshold,
                    "cases": run.case_count,
                    "reasons": sorted(
                        {r.reason for r in run.results if r is not None and r.reason}
                    ),
                    **({"stop_reason": reason} if reason else {}),
                },
            )
        except Exception:
            logger.exception("audit emit failed after an eval run")
