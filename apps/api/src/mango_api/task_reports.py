"""Downloadable reports of task runs (D86, D87): what mango-api does with them.

A task may ask for a PDF of each run (``Automation.report``, fixed by its trigger). When such a
run completes, the worker keeps what the agent handed over with the internal tool
(``mango_core.task_reports``, validated there) and asks the function ``Mango-<ns>-TaskReport``
to draw it, asynchronously. The owner downloads it with a presigned URL of 5 minutes.

Security notes (security-best-practices, FastAPI; threat model ``task-reports-threat-model.md``):
* Only the owner downloads (L1 ``OwnTask``, checked by the route); an administrator sees the
  status, never the file name or a link (D82). The object key comes from the run, never from
  the request (TM-R2).
* Each link is new, lives 5 minutes, downloads as an attachment and is audited
  (``schedule.report_download``, fail-closed) before it is issued; it is never logged (TM-R3,
  TM-R6).
* The function's event only names the run: what it draws and where it writes were computed
  here and stored in the run (TM-R5).
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import TYPE_CHECKING, Any, Literal, Protocol

from botocore.config import Config
from pydantic import BaseModel, ConfigDict

from mango_api.tasks_store import Automation, Run, RunStatus
from mango_core import task_reports as tr

if TYPE_CHECKING:
    from mypy_boto3_lambda import LambdaClient
    from mypy_boto3_s3 import S3Client

logger = logging.getLogger(__name__)

LINK_SECONDS = 300
"""Life of a download link (D86 (4))."""
DOWNLOADS_PER_HOUR = 60
"""Links per person and hour (TM-R7): each click asks for one."""
GENERATING, READY, FAILED = "generating", "ready", "failed"


class ReportOut(BaseModel):
    """The PDF of a run, as its reader may see it. Only the owner learns its period and file."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["cost_summary", "anomaly"]
    status: Literal["generating", "ready", "failed"]
    reason: Literal["data", "size", "render"] | None = None
    period: str | None = None
    file: str | None = None
    pages: int | None = None
    size_bytes: int | None = None
    keep_until: date


class ReportLinkOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    url: str
    """Presigned, 5 minutes; the SPA opens it and never shows or copies it."""
    file: str


def status_of(run: Run, now: int) -> tuple[str, str | None] | None:
    """The status a reader sees: a generation that outlived its timeout failed (``render``)."""
    if run.report_status not in (GENERATING, READY, FAILED):
        return None
    if run.report_status == GENERATING and (run.report_at or 0) < now - (
        tr.GENERATION_TIMEOUT_SECONDS
    ):
        return FAILED, "render"
    reason = run.report_reason if run.report_status == FAILED else None
    return run.report_status, reason if reason in tr.FAILURE_REASONS else None


def report_out(run: Run, *, owner: bool, now: int) -> ReportOut | None:
    state = status_of(run, now)
    kind = run.report_meta.get("type")
    if state is None or kind not in tr.TYPE_NAMES:
        return None
    status, reason = state
    ready = status == READY
    return ReportOut(
        type=kind,
        status=status,  # type: ignore[arg-type]
        reason=reason,  # type: ignore[arg-type]
        period=str(run.report_meta.get("period") or "") or None if owner else None,
        file=str(run.report_meta.get("file") or "") or None if owner and ready else None,
        pages=run.report_pages if owner and ready else None,
        size_bytes=run.report_bytes if owner and ready else None,
        keep_until=tr.keep_until(run.queued_at),
    )


# --- What a run keeps for its PDF -------------------------------------------------------------


def period_of(kind: str, data: dict[str, Any], run: Run) -> str:
    """«{tipo} · {periodo}» of the design: the analyzed period, or the anomaly's days."""
    try:
        if kind == "cost_summary":
            return tr.period_label(
                date.fromisoformat(data["period_start"]), date.fromisoformat(data["period_end"])
            )
        if run.anomaly_start and run.anomaly_end:
            return tr.date_range(
                date.fromisoformat(run.anomaly_start), date.fromisoformat(run.anomaly_end)
            )
    except (KeyError, TypeError, ValueError):
        return ""
    return ""


def fields_for_run(
    automation: Automation,
    run: Run,
    *,
    status: RunStatus,
    document: str | None,
    agent_name: str | None,
    now: int,
) -> dict[str, Any]:
    """What ``update_run`` stores with the end of a run of a task with a report: only a
    completed run has one (design: «Una ejecución fallida u omitida no tiene reporte»)."""
    if automation.report not in tr.TYPE_NAMES or status is not RunStatus.OK:
        return {}
    at = datetime.fromtimestamp(run.started_at or run.queued_at, UTC)
    name = tr.file_name(
        automation.name,
        at=at,
        timezone=automation.timezone,
        anomaly_id=run.anomaly_id if automation.report == "anomaly" else None,
    )
    meta: dict[str, Any] = {
        "type": automation.report,
        "file": name,
        "owner_id": automation.owner_id,
        "task": automation.name,
        "agent": agent_name or automation.agent_id,
        "owner": automation.owner_email or automation.owner_name or automation.owner_id,
        "generated_at": datetime.fromtimestamp(now, UTC).isoformat(),
        "timezone": automation.timezone,
        "keep_until": tr.keep_until(run.queued_at).isoformat(),
    }
    if document is None:
        return {
            "report_status": FAILED,
            "report_reason": "data",
            "report_meta": meta,
            "report_at": now,
        }
    stored = json.loads(document)
    meta["period"] = period_of(automation.report, stored.get("data", {}), run)
    return {
        "report_status": GENERATING,
        "report_meta": meta,
        "report_data": document,
        "report_at": now,
    }


# --- The function and the bucket ------------------------------------------------------------


class ReportRenderer(Protocol):
    def start(self, run: Run) -> None:
        """Ask for the PDF of ``run``; raises if the function did not take it."""


class ReportLinks(Protocol):
    def link(self, run: Run, *, owner_id: str) -> str: ...


@dataclass
class LambdaRenderer:
    """``InvokeFunction`` asynchronously (``Event``): retries and the dead-letter queue are the
    function's. The event names the run and nothing else (TM-R5)."""

    client: LambdaClient
    function: str

    def start(self, run: Run) -> None:
        tr.valid_event(
            event := {"task_id": run.automation_id, "run_id": run.run_id, "run_sk": run.sk}
        )
        self.client.invoke(
            FunctionName=self.function,
            InvocationType="Event",
            Payload=json.dumps(event).encode(),
        )


@dataclass
class S3Links:
    client: S3Client
    bucket: str

    def link(self, run: Run, *, owner_id: str) -> str:
        """A link to the run's object, under its owner's prefix (D86 (3)): computed again
        from the run, so a stored key never points elsewhere."""
        name = str(run.report_meta.get("file", ""))
        key = tr.object_key(owner_id, run.automation_id, run.run_id, name)
        return self.client.generate_presigned_url(
            "get_object",
            Params={
                "Bucket": self.bucket,
                "Key": key,
                "ResponseContentType": "application/pdf",
                "ResponseContentDisposition": f'attachment; filename="{name}"',
            },
            ExpiresIn=LINK_SECONDS,
        )


S3_CONFIG = Config(signature_version="s3v4", s3={"addressing_style": "virtual"})
"""SigV4 (the objects are encrypted with KMS) and the bucket's own host name."""


@dataclass
class TaskReports:
    renderer: ReportRenderer
    links: ReportLinks

    def start(self, run: Run, fail: Any) -> None:
        """Ask for the PDF; if the function does not take it, the report fails with
        ``render`` (``fail``), so its owner may generate it again. Never raises."""
        try:
            self.renderer.start(run)
        except Exception:
            logger.exception("the report of a task run could not be asked for")
            fail(run, "render")
