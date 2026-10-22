"""Steps of the state machine ``Mango-<ns>-KnowledgeSync`` (D88 (11), (16), (24)).

A synchronization of one knowledge base:

1. ``acquire``: the lock of the Bedrock knowledge base (one synchronization at a time); the
   machine waits and asks again while another holds it.
1b. ``copy``: the documents of the sources on existing buckets, copied into Mango's bucket
   as the source is now (``sources``, D88 (19)); again while something is left to copy.
2. ``plan``: what to ingest (documents ``uploaded``), what to delete (``deleting``, or every
   document of a knowledge base being deleted) and what is still being indexed; then the
   budget reservation of whoever asked, for the documents to ingest (rule 4).
3. ``ingest`` and ``poll``: batches of 25, with the metadata of the registry, and the status
   of each document until Bedrock says.
4. ``delete`` and ``verify``: batches of 25, and a search filtered by ``kb_id`` and the
   documents until nothing comes back; then the object and the record go.
5. ``finish``: the charge and the release of the rest of the reservation, the status of the
   knowledge base, the lock, the audit event, and the synchronization someone asked for
   meanwhile. It also runs after any failure of the steps above.

``sweep`` runs every hour on its own: it counts the deletions not verified in 6 hours (the
metric of the alarm), starts the synchronization of deletions nobody finished, and settles
the reservation of a synchronization that died.

The state carries ids, counters and amounts only (never a name nor content). Inputs are
checked by pattern; everything about a knowledge base is read from the registry (TM-K10).
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from functools import cache
from typing import Any

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from mango_core import knowledge
from mango_core.knowledge import DocumentStatus, Status
from mango_knowledge_sync import budget
from mango_knowledge_sync.audit import AuditWriter
from mango_knowledge_sync.bedrock import (
    BATCH,
    BedrockDeniedError,
    BedrockUnavailableError,
    Ingestable,
    KnowledgeBedrock,
    ThrottledError,
)
from mango_knowledge_sync.budget import Budgets, Reservation
from mango_knowledge_sync.config import Settings
from mango_knowledge_sync.sources import SourceCopier, role_requester, session_for
from mango_knowledge_sync.store import Requester, StoreUnavailableError, SyncStore

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

LOCK_SECONDS = 2 * 3600
"""As long as the state machine may run: a lock never outlives its execution."""
MAX_LOCK_ATTEMPTS = 120
"""Asked every 30 seconds: an hour behind other synchronizations, then it gives up."""
MAX_POLLS = 90
"""Every 10 seconds: 15 minutes of indexing per run. What is left is polled by the next."""
MAX_COPY_STEPS = 20
"""Of 3 minutes each: an hour of copying per run. What is left is copied by the next."""
MAX_VERIFIES = 30
"""Every 20 seconds: 10 minutes. What still answers is retried by the hourly sweep."""
OVERDUE = timedelta(hours=6)
"""A deletion not verified by then is an alarm (D88 (16))."""
STALE = timedelta(hours=3)
"""A synchronization still holding its knowledge base after that is dead: the machine ends at 2."""
METRICS_NAMESPACE = "Mango/Knowledge"
"""``infra/lib/constructs/knowledge.ts``, ``KNOWLEDGE_SIGNALS``."""
SYSTEM = Requester("system:knowledge-sync", None, Decimal(0))
"""Who asks for the synchronizations the sweep starts: deletions only, which cost nothing."""
_USER_RE = re.compile(r"^[A-Za-z0-9:._-]{1,128}$")


class RetryableStepError(Exception):
    """A dependency was busy or unavailable: the state machine retries the step."""


class StepDeniedError(Exception):
    """AWS refused the step for permissions: the state machine does not retry it."""


class InvalidInputError(Exception):
    """The state is not one this machine writes."""


@dataclass
class Deps:
    settings: Settings
    store: SyncStore
    bedrock: KnowledgeBedrock
    budgets: Budgets
    audit: AuditWriter
    s3: Any
    sfn: Any
    clock: Callable[[], datetime] = lambda: datetime.now(UTC)
    metrics: Callable[[str, float], None] | None = None
    sources: SourceCopier | None = None
    """The copy of the sources (D88 (19)); ``None`` until the stack gives what it needs."""


@cache
def _deps() -> Deps:
    settings = Settings.from_env()
    dynamodb = boto3.client("dynamodb")
    store = SyncStore(dynamodb, settings.knowledge_table)
    s3 = boto3.client("s3")
    sources = SourceCopier(
        store=store,
        documents_s3=s3,
        documents_bucket=settings.documents_bucket,
        session_for=session_for(boto3.client("sts"), boto3.Session),
        request_role=(
            role_requester(boto3.client("lambda"), settings.sources_function)
            if settings.sources_function
            else None
        ),
        now_iso=lambda: _iso(datetime.now(UTC)),
    )
    return Deps(
        settings=settings,
        store=store,
        bedrock=KnowledgeBedrock(
            boto3.client("bedrock-agent"),
            boto3.client("bedrock-agent-runtime"),
            knowledge_base_id=settings.knowledge_base_id,
            data_source_id=settings.data_source_id,
            bucket=settings.documents_bucket,
            account_id=settings.account_id,
        ),
        budgets=Budgets(dynamodb, settings.budgets_table),
        audit=AuditWriter(
            boto3.client("firehose"), settings.audit_stream, dynamodb, settings.audit_index_table
        ),
        s3=s3,
        sfn=boto3.client("stepfunctions"),
        sources=sources,
    )


def lambda_handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    return handle(_deps(), event)


def handle(deps: Deps, event: dict[str, Any]) -> dict[str, Any]:
    step = event.get("step")
    state = dict(event.get("state") or {})
    steps: dict[str, Callable[[Deps, dict[str, Any]], dict[str, Any]]] = {
        "acquire": acquire,
        "copy": copy,
        "plan": plan,
        "ingest": ingest,
        "poll": poll,
        "delete": delete,
        "verify": verify,
        "finish": finish,
        "sweep": sweep,
    }
    if step not in steps:
        raise InvalidInputError("unknown step")
    if step != "sweep":
        _check(state)
    try:
        return steps[step](deps, state)
    except BedrockDeniedError as exc:
        # Not retried: the step ends in `finish` (reservation and lock released, status «Error»)
        # and the execution fails, which alarms. The code of AWS says which refusal it was.
        logger.error("knowledge sync step %s denied by AWS: %s", step, aws_code(exc))  # noqa: TRY400
        raise StepDeniedError(aws_code(exc)) from exc
    except (
        ThrottledError,
        BedrockUnavailableError,
        StoreUnavailableError,
        budget.BudgetUnavailableError,
        BotoCoreError,
        ClientError,
    ) as exc:
        logger.warning(
            "knowledge sync step %s will be retried: %s (%s)",
            step,
            type(exc).__name__,
            aws_code(exc),
        )
        raise RetryableStepError(type(exc).__name__) from exc


def aws_code(exc: Exception) -> str:
    """The error code of AWS behind ``exc``, never its message (it may quote a request)."""
    if isinstance(exc, ClientError):
        return str(exc.response.get("Error", {}).get("Code", "unknown"))
    if isinstance(exc, BotoCoreError):
        return type(exc).__name__
    code = exc.args[0] if exc.args else ""
    return (
        code if isinstance(code, str) and re.fullmatch(r"[A-Za-z0-9.]{1,64}", code) else "unknown"
    )


def _check(state: dict[str, Any]) -> None:
    if not knowledge.is_id(str(state.get("kb_id", ""))) or not knowledge.is_id(
        str(state.get("sync_id", ""))
    ):
        raise InvalidInputError("invalid ids")
    requester = state.get("requested_by")
    if not isinstance(requester, dict) or not _USER_RE.fullmatch(str(requester.get("user_id", ""))):
        raise InvalidInputError("invalid requester")
    for name in ("ingest", "indexing", "delete", "verifying", "indexed"):
        if not all(knowledge.is_id(str(d)) for d in state.get(name, [])):
            raise InvalidInputError("invalid document ids")


def _iso(now: datetime) -> str:
    return now.astimezone(UTC).isoformat(timespec="seconds")


def _document_key(kb_id: str, doc_id: str) -> str:
    """``mango_api.knowledge_uploads.document_key``: ids only."""
    return f"kb/{kb_id}/docs/{doc_id}"


def _counts(state: dict[str, Any]) -> dict[str, int]:
    counts: dict[str, int] = state.setdefault("counts", {})
    for name in ("ingested", "indexed", "failed", "deleted", "copied", "copy_failed"):
        counts.setdefault(name, 0)
    return counts


# --- Steps ---------------------------------------------------------------------------------


def acquire(deps: Deps, state: dict[str, Any]) -> dict[str, Any]:
    now = int(deps.clock().timestamp())
    state["attempts"] = int(state.get("attempts", 0)) + 1
    state["locked"] = deps.store.acquire(
        deps.settings.knowledge_base_id, state["sync_id"], now=now, ttl=LOCK_SECONDS
    )
    state["gave_up"] = not state["locked"] and state["attempts"] >= MAX_LOCK_ATTEMPTS
    if state["gave_up"]:
        state["outcome"] = "busy"
    return state


def copy(deps: Deps, state: dict[str, Any]) -> dict[str, Any]:
    """The sources of the knowledge base, as they are now (D88 (19)). A synchronization of
    deletions only copies nothing: it only clears what removed sources left."""
    kb_id = state["kb_id"]
    state["copy_more"] = False
    record = deps.store.knowledge_base(kb_id)
    if deps.sources is None or record is None or record.status is Status.DELETING:
        return state
    requester = Requester.from_json(state["requested_by"])
    result = deps.sources.step(kb_id, requester.user_id, copy=state.get("mode") != "deletions")
    counts = _counts(state)
    counts["copied"] += result.copied
    counts["copy_failed"] += result.failed
    state["copy_steps"] = int(state.get("copy_steps", 0)) + 1
    state["copy_more"] = result.more and state["copy_steps"] < MAX_COPY_STEPS
    if result.full:
        state["full"] = True
    if result.unavailable:
        state["sources_unavailable"] = result.unavailable
    return state


def plan(deps: Deps, state: dict[str, Any]) -> dict[str, Any]:
    kb_id = state["kb_id"]
    record = deps.store.knowledge_base(kb_id)
    state.update(ingest=[], indexing=[], delete=[], verifying=[], indexed=[], polls=0, verifies=0)
    _counts(state)
    if record is None:
        state["outcome"] = "gone"
        return state
    requester = Requester.from_json(state["requested_by"])
    deps.store.start_sync(kb_id, state["sync_id"], requester, _iso(deps.clock()))
    documents = deps.store.documents(kb_id)
    deleting_kb = record.status is Status.DELETING
    state["kb_deleting"] = deleting_kb
    state["delete"] = sorted(
        d.doc_id for d in documents if deleting_kb or d.status is DocumentStatus.DELETING
    )
    state["indexing"] = sorted(
        d.doc_id for d in documents if not deleting_kb and d.status is DocumentStatus.INDEXING
    )
    # Deletions only: the sweep starts them, and asks for nothing that costs.
    if not deleting_kb and state.get("mode") != "deletions":
        state["ingest"] = sorted(d.doc_id for d in documents if d.status is DocumentStatus.UPLOADED)
    size = sum(d.size for d in documents if d.doc_id in set(state["ingest"]))
    amount = budget.estimate(size, deps.settings.embedding_price)
    reservation = Reservation(
        budget.scope_of(requester.user_id), deps.clock().strftime("%Y-%m"), amount
    )
    if amount > 0:
        try:
            deps.budgets.reserve(reservation, requester.limit, requester.email)
        except budget.BudgetExceededError:
            # «No empezó por presupuesto»: nothing is ingested; deletions still go ahead.
            state["outcome"] = "budget"
            state["ingest"] = []
            reservation = Reservation(reservation.scope, reservation.period, Decimal(0))
    state["reservation"] = {
        "scope": reservation.scope,
        "period": reservation.period,
        "amount": str(reservation.amount),
    }
    deps.store.record_sync(
        kb_id,
        state["sync_id"],
        {
            "reserved_usd": reservation.amount,
            "to_ingest": len(state["ingest"]),
            "to_delete": len(state["delete"]),
        },
    )
    if not deleting_kb and (state["ingest"] or state["indexing"]):
        deps.store.set_status(kb_id, Status.SYNCING)
    return state


def ingest(deps: Deps, state: dict[str, Any]) -> dict[str, Any]:
    kb_id = state["kb_id"]
    record = deps.store.knowledge_base(kb_id)
    batch, rest = state["ingest"][:BATCH], state["ingest"][BATCH:]
    if record is None or record.status is Status.DELETING or not batch:
        state["ingest"] = []
        return state
    documents = [
        Ingestable(
            doc_id=doc_id,
            key=_document_key(kb_id, doc_id),
            kb_id=kb_id,
            business_unit=record.business_unit,
            groups=record.groups,
            classification=record.classification,
        )
        for doc_id in batch
    ]
    index = int(state.get("batches", 0))
    deps.bedrock.ingest(documents, token=f"{state['sync_id']}-ingest-{index:04d}")
    for doc_id in batch:
        deps.store.mark(kb_id, doc_id, DocumentStatus.INDEXING)
    state["batches"] = index + 1
    state["ingest"] = rest
    state["indexing"] = sorted({*state["indexing"], *batch})
    _counts(state)["ingested"] += len(batch)
    return state


def poll(deps: Deps, state: dict[str, Any]) -> dict[str, Any]:
    kb_id = state["kb_id"]
    pending: list[str] = []
    counts = _counts(state)
    for outcome in deps.bedrock.outcomes(state["indexing"]):
        if outcome.state == "indexed":
            deps.store.mark(kb_id, outcome.doc_id, DocumentStatus.INDEXED)
            state["indexed"] = sorted({*state.get("indexed", []), outcome.doc_id})
            counts["indexed"] += 1
        elif outcome.state == "failed":
            deps.store.mark(kb_id, outcome.doc_id, DocumentStatus.FAILED, outcome.reason)
            counts["failed"] += 1
        else:
            pending.append(outcome.doc_id)
    state["indexing"] = sorted(pending)
    state["polls"] = int(state.get("polls", 0)) + 1
    state["polled"] = not pending or state["polls"] >= MAX_POLLS
    return state


def delete(deps: Deps, state: dict[str, Any]) -> dict[str, Any]:
    batch, rest = state["delete"][:BATCH], state["delete"][BATCH:]
    if batch:
        index = int(state.get("delete_batches", 0))
        deps.bedrock.delete(batch, token=f"{state['sync_id']}-delete-{index:04d}")
        for doc_id in batch:
            deps.store.mark(state["kb_id"], doc_id, DocumentStatus.DELETING, unless=None)
        state["delete_batches"] = index + 1
    state["delete"] = rest
    state["verifying"] = sorted({*state["verifying"], *batch})
    return state


def verify(deps: Deps, state: dict[str, Any]) -> dict[str, Any]:
    kb_id = state["kb_id"]
    answering = deps.bedrock.still_answering(kb_id, state["verifying"])
    sizes = {d.doc_id: d.size for d in deps.store.documents(kb_id)}
    for doc_id in state["verifying"]:
        if doc_id in answering:
            continue
        # Versioned bucket: the old version goes after a day (TM-K5).
        deps.s3.delete_object(
            Bucket=deps.settings.documents_bucket, Key=_document_key(kb_id, doc_id)
        )
        if doc_id in sizes:
            deps.store.remove_document(kb_id, doc_id, sizes[doc_id])
            _counts(state)["deleted"] += 1
    state["verifying"] = sorted(d for d in state["verifying"] if d in answering)
    state["verifies"] = int(state.get("verifies", 0)) + 1
    state["verified"] = not state["verifying"] or state["verifies"] >= MAX_VERIFIES
    return state


def finish(deps: Deps, state: dict[str, Any]) -> dict[str, Any]:
    """Also after a failure (``state["error"]``): it must never leave a reservation held or the
    lock taken. Idempotent: a retry finds the synchronization already settled."""
    kb_id, sync_id = state["kb_id"], state["sync_id"]
    failed = "error" in state
    outcome = "error" if failed else state.get("outcome", "done")
    requester = Requester.from_json(state["requested_by"])
    record = deps.store.knowledge_base(kb_id)
    documents = deps.store.documents(kb_id) if record else []
    charged = _settle(deps, state, documents)
    removed = False
    again: Requester | None = None
    if record is not None:
        deleting_kb = record.status is Status.DELETING
        if deleting_kb:
            # Gone only when no record is left and a search by its kb_id returns nothing.
            removed = not documents and not deps.bedrock.still_answering(kb_id, None)
        elif state.get("locked"):
            deps.store.set_status(kb_id, _status_after(outcome, documents))
        deletions_left = (deleting_kb and not removed) or any(
            d.status is DocumentStatus.DELETING for d in documents
        )
        again = deps.store.finish(kb_id, sync_id, deletions_left=deletions_left)
    if state.get("locked"):
        deps.store.release(deps.settings.knowledge_base_id, sync_id)
    counts = _counts(state)
    deps.audit.emit(
        "kb.sync",
        {
            "kb_id": kb_id,
            "sync_id": sync_id,
            "requested_by": requester.user_id,
            "outcome": outcome,
            **counts,
            "reserved_usd": state.get("reservation", {}).get("amount", "0"),
            "charged_usd": str(charged),
        },
    )
    if removed:
        deps.store.remove_knowledge_base(kb_id)
        deps.audit.emit("kb.deleted", {"kb_id": kb_id, "sync_id": sync_id, "verified": True})
    elif record is not None:
        deps.store.record_sync(kb_id, sync_id, {"state": outcome, **counts, "charged_usd": charged})
    if again is not None and not removed:
        _start(deps, kb_id, again, "sync")
    state["outcome"] = outcome
    return state


def _status_after(outcome: str, documents: list[Any]) -> Status:
    if outcome in {"error", "budget", "busy"}:
        return Status.ERROR
    if any(d.status in (DocumentStatus.INDEXING, DocumentStatus.UPLOADED) for d in documents):
        return Status.SYNCING
    if any(d.status is DocumentStatus.FAILED for d in documents):
        return Status.WARN
    return Status.OK


def _settle(deps: Deps, state: dict[str, Any], documents: list[Any]) -> Decimal:
    """Charge what was indexed, and what Bedrock may still be indexing; release the rest.
    Once: the synchronization record says it is settled."""
    raw = state.get("reservation")
    if not raw or state.get("settled"):
        return Decimal(str(state.get("charged", "0")))
    reservation = Reservation(raw["scope"], raw["period"], Decimal(raw["amount"]))
    billable = {*state.get("indexed", []), *state.get("indexing", [])}
    size = sum(d.size for d in documents if d.doc_id in billable)
    charged = min(budget.estimate(size, deps.settings.embedding_price), reservation.amount)
    deps.budgets.settle(reservation, charged)
    state["settled"] = True
    state["charged"] = str(charged)
    return charged


def _start(deps: Deps, kb_id: str, requester: Requester, mode: str) -> bool:
    """Start one more synchronization of ``kb_id``, if nobody holds it."""
    sync_id = knowledge.new_id()
    if not deps.store.claim(kb_id, sync_id, _iso(deps.clock())):
        return False
    try:
        deps.sfn.start_execution(
            stateMachineArn=deps.settings.state_machine_arn,
            name=sync_id,
            input=json.dumps(
                {
                    "mode": mode,
                    "kb_id": kb_id,
                    "sync_id": sync_id,
                    "requested_by": requester.as_json(),
                }
            ),
        )
    except (BotoCoreError, ClientError):
        logger.exception("knowledge sync could not start the next synchronization")
        deps.store.drop_claim(kb_id, sync_id)
        return False
    return True


def sweep(deps: Deps, state: dict[str, Any]) -> dict[str, Any]:
    now = deps.clock()
    overdue = started = abandoned = 0
    for record in deps.store.everything():
        if record.deleting_since and datetime.fromisoformat(record.deleting_since) < now - OVERDUE:
            overdue += 1
        if record.sync_id and record.sync_requested_at:
            if datetime.fromisoformat(record.sync_requested_at) < now - STALE:
                _abandon(deps, record.kb_id, record.sync_id)
                abandoned += 1
            continue
        if record.status is Status.DELETING or record.deleting_since:
            started += int(_start(deps, record.kb_id, SYSTEM, "deletions"))
    _metric(deps, "DeletionsOverdue", overdue)
    logger.info(
        "knowledge sweep: %d overdue, %d started, %d abandoned", overdue, started, abandoned
    )
    return {"mode": "sweep", "overdue": overdue, "started": started, "abandoned": abandoned}


def _abandon(deps: Deps, kb_id: str, sync_id: str) -> None:
    """A synchronization that died holding its knowledge base: whatever it reserved is charged
    (what it spent is not known any more), and the knowledge base is free again."""
    record = deps.store.sync_record(kb_id, sync_id)
    reserved = (
        Decimal(record["reserved_usd"]["N"]) if record and "reserved_usd" in record else Decimal(0)
    )
    state = record.get("state", {}).get("S") if record else None
    if record and state == "running" and reserved > 0:
        scope = budget.scope_of(record["requested_by"]["S"])
        period = record["started_at"]["S"][:7]
        deps.budgets.settle(Reservation(scope, period, reserved), reserved)
    if record:
        deps.store.record_sync(kb_id, sync_id, {"state": "abandoned", "charged_usd": reserved})
    deps.store.drop_claim(kb_id, sync_id)
    deps.store.release(deps.settings.knowledge_base_id, sync_id)
    deps.audit.emit(
        "kb.sync",
        {"kb_id": kb_id, "sync_id": sync_id, "outcome": "abandoned", "charged_usd": str(reserved)},
    )


def _metric(deps: Deps, name: str, value: float) -> None:
    """Embedded metric format: the log line is the metric, no permission needed."""
    if deps.metrics is not None:
        deps.metrics(name, value)
        return
    print(
        json.dumps(
            {
                "_aws": {
                    "Timestamp": int(deps.clock().timestamp() * 1000),
                    "CloudWatchMetrics": [
                        {
                            "Namespace": f"{METRICS_NAMESPACE}/{deps.settings.namespace}",
                            "Dimensions": [[]],
                            "Metrics": [{"Name": name, "Unit": "Count"}],
                        }
                    ],
                },
                name: value,
            }
        )
    )
