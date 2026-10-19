"""Downloadable reports of task runs (D86, D87; threat model ``task-reports-threat-model.md``):
the internal tool, what a run keeps, the function it asks and who downloads the PDF."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

import pytest

from mango_api import app as app_module
from mango_api import harness
from mango_api.task_reports import TaskReports
from mango_api.tasks_store import Run
from mango_core import task_reports as tr

from .test_app import served
from .test_tasks import DAILY, Env, _code, _h, _scheduled, env  # noqa: F401 - the fixture

SUMMARY = {
    "period_start": "2026-09-01",
    "period_end": "2026-09-02",
    "total": 200,
    "previous_total": 150,
    "daily": [{"date": "2026-09-01", "cost": 99}, {"date": "2026-09-02", "cost": 101}],
    "services": [{"service": "Amazon EC2", "cost": 150, "previous": 100}],
    "notes": "Subió **EC2**.",
}
QUERY_ANSWER = {
    "metric": "UnblendedCost",
    "granularity": "DAILY",
    "group_by": [],
    "rows": [
        {"period_start": "2026-09-01", "keys": [], "amount": "90.00", "unit": "USD"},
        {"period_start": "2026-09-02", "keys": [], "amount": "110.00", "unit": "USD"},
    ],
}


@dataclass
class ReportAgentCore:
    """A harness that queries Cost Explorer and then hands the report over (inline call)."""

    data: Any = field(default_factory=lambda: SUMMARY)
    hand_over: bool = True
    requests: list[dict[str, Any]] = field(default_factory=list)

    def invoke_harness(self, **request: Any) -> dict[str, Any]:
        self.requests.append(request)
        query = json.dumps(
            {"start_date": "2026-09-01", "end_date": "2026-09-03", "granularity": "DAILY"}
        )
        answer = json.dumps(QUERY_ANSWER)
        stream: list[dict[str, Any]] = [
            {"contentBlockStart": {"contentBlockIndex": 0, "start": {}}},
            {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": "Consulto."}}},
            {
                "contentBlockStart": {
                    "contentBlockIndex": 1,
                    "start": {
                        "toolUse": {"toolUseId": "q1", "name": "finops___get_cost_and_usage"}
                    },
                }
            },
            {"contentBlockDelta": {"contentBlockIndex": 1, "delta": {"toolUse": {"input": query}}}},
            {"contentBlockStop": {"contentBlockIndex": 1}},
            {"messageStop": {"stopReason": "tool_use"}},
            {"metadata": {"usage": {"inputTokens": 100, "outputTokens": 10}}},
            {
                "contentBlockStart": {
                    "contentBlockIndex": 2,
                    "start": {"toolResult": {"toolUseId": "q1", "status": "success"}},
                }
            },
            {
                "contentBlockDelta": {
                    "contentBlockIndex": 2,
                    "delta": {"toolResult": [{"text": answer[:40]}, {"text": answer[40:]}]},
                }
            },
            {"contentBlockStop": {"contentBlockIndex": 2}},
            {"contentBlockStart": {"contentBlockIndex": 3, "start": {}}},
            {"contentBlockDelta": {"contentBlockIndex": 3, "delta": {"text": "El informe."}}},
        ]
        if self.hand_over:
            raw = self.data if isinstance(self.data, str) else json.dumps(self.data)
            stream += [
                {
                    "contentBlockStart": {
                        "contentBlockIndex": 4,
                        "start": {"toolUse": {"toolUseId": "r1", "name": tr.REPORT_TOOL}},
                    }
                },
                {
                    "contentBlockDelta": {
                        "contentBlockIndex": 4,
                        "delta": {"toolUse": {"input": raw}},
                    }
                },
                {"contentBlockStop": {"contentBlockIndex": 4}},
                {"messageStop": {"stopReason": "tool_use"}},
            ]
        else:
            stream.append({"messageStop": {"stopReason": "end_turn"}})
        stream.append({"metadata": {"usage": {"inputTokens": 100, "outputTokens": 10}}})
        return {"stream": stream}


@dataclass
class FakeRenderer:
    started: list[Run] = field(default_factory=list)
    fail: bool = False

    def start(self, run: Run) -> None:
        if self.fail:
            raise RuntimeError("the function did not take it")
        tr.valid_event({"task_id": run.automation_id, "run_id": run.run_id, "run_sk": run.sk})
        self.started.append(run)


@dataclass
class FakeLinks:
    issued: list[tuple[str, str]] = field(default_factory=list)

    def link(self, run: Run, *, owner_id: str) -> str:
        key = tr.object_key(owner_id, run.automation_id, run.run_id, run.report_meta["file"])
        self.issued.append((owner_id, key))
        return f"https://bucket.example/{key}?X-Amz-Signature=secret"


@dataclass
class Reports:
    renderer: FakeRenderer
    links: FakeLinks
    agentcore: ReportAgentCore


@pytest.fixture
def reports(env: Env) -> Reports:  # noqa: F811 - the fixture of test_tasks
    renderer, links, agentcore = FakeRenderer(), FakeLinks(), ReportAgentCore()
    tasks = env.services.tasks
    assert tasks is not None and env.services.task_runs is not None
    tasks.reports = TaskReports(renderer=renderer, links=links)
    tasks.downloads = app_module.Limits().limiter("tasks.report_downloads")
    env.services.task_runs.reports = tasks.reports
    env.services.agentcore = agentcore
    return Reports(renderer, links, agentcore)


def _run(env: Env, task: dict[str, Any], token: str = "creator") -> dict[str, Any]:  # noqa: F811
    detail = env.get(token, task["task_id"]).json()
    run: dict[str, Any] = detail["runs"][0]
    return run


def _download(env: Env, task: dict[str, Any], run: dict[str, Any], token: str = "creator") -> Any:  # noqa: F811
    return env.client.post(
        f"/api/tasks/{task['task_id']}/runs/{run['run_id']}/report/download",
        headers=_h(token),
        json={},
    )


def test_a_task_asks_for_a_report_only_with_an_agent_that_reads_costs(
    env: Env,  # noqa: F811
    reports: Reports,
) -> None:
    task = env.created(report=True)
    assert task["report"] == "cost_summary"
    anomaly = env.created(
        name="Anomalías", report=True, trigger={"kind": "event", "event_type": "cost_anomaly"}
    )
    assert anomaly["report"] == "anomaly"
    env.published.agents["logs"] = served(
        "logs", tools=("aws-cloudwatch.get_metric_data",), groups=["finops-central"]
    )
    refused = env.create(agent_id="logs", report=True)
    assert (refused.status_code, _code(refused)) == (422, "report_unavailable")
    assert env.created(agent_id="logs")["report"] is None


def test_without_the_reports_construct_the_option_is_refused(env: Env) -> None:  # noqa: F811
    refused = env.create(report=True)
    assert (refused.status_code, _code(refused)) == (422, "report_unavailable")


def test_a_completed_run_keeps_the_data_and_asks_for_its_pdf(env: Env, reports: Reports) -> None:  # noqa: F811
    task = env.created(report=True)
    env.deliver(_scheduled(task["task_id"]))
    (request,) = reports.agentcore.requests
    # The internal tool is only in this run, with the schema of its type, and allowed.
    inline = [t for t in request["tools"] if t["type"] == "inline_function"]
    assert [t["name"] for t in inline] == [tr.REPORT_TOOL]
    assert tr.REPORT_TOOL in request["allowedTools"]
    run = _run(env, task)
    assert run["status"] == "ok"
    assert run["report"]["status"] == "generating"
    assert run["report"]["type"] == "cost_summary"
    assert run["report"]["period"] == f"1{tr.EN_DASH}2 sep 2026"
    (started,) = reports.renderer.started
    assert started.run_id == run["run_id"]
    item = env.services.tasks.store.run(task["task_id"], run["run_id"])  # type: ignore[union-attr]
    assert item is not None
    # The series came from the query the agent made, not from what it copied (D87 (4)).
    stored = json.loads(
        env.services.tasks.store._db.get_item(  # type: ignore[union-attr]
            TableName="tasks", Key={"PK": {"S": f"AUTO#{task['task_id']}"}, "SK": {"S": item.sk}}
        )["Item"]["report_data"]["S"]
    )
    assert [d["cost"] for d in stored["data"]["daily"]] == ["90.00", "110.00"]
    assert stored["source"]["daily"] == "query"
    assert item.report_meta["file"].startswith("budget-check-diario-2026-")
    # The tool is not a step, and nothing of the data reaches the audit trail.
    detail = env.client.get(
        f"/api/tasks/{task['task_id']}/runs/{run['run_id']}", headers=_h("creator")
    ).json()
    assert [s["tool"] for s in detail["steps"]] == ["get_cost_and_usage"]
    assert "Amazon EC2" not in json.dumps(env.audit.events)


@pytest.mark.parametrize("data", ["not json", {**SUMMARY, "total": "NaN"}, {**SUMMARY, "x": 1}])
def test_invalid_data_fails_with_data_and_the_run_still_completes(
    env: Env,  # noqa: F811
    reports: Reports,
    data: Any,
) -> None:
    reports.agentcore.data = data
    task = env.created(report=True)
    env.deliver(_scheduled(task["task_id"]))
    run = _run(env, task)
    assert run["status"] == "ok"
    assert (run["report"]["status"], run["report"]["reason"]) == ("failed", "data")
    assert reports.renderer.started == []


def test_an_agent_that_hands_over_nothing_fails_with_data(env: Env, reports: Reports) -> None:  # noqa: F811
    reports.agentcore.hand_over = False
    task = env.created(report=True)
    env.deliver(_scheduled(task["task_id"]))
    assert _run(env, task)["report"]["reason"] == "data"


def test_a_run_without_report_has_no_tool_and_no_pdf(env: Env, reports: Reports) -> None:  # noqa: F811
    task = env.created()
    env.deliver(_scheduled(task["task_id"]))
    (request,) = reports.agentcore.requests
    assert all(t["type"] != "inline_function" for t in request["tools"])
    assert _run(env, task)["report"] is None


def test_a_function_that_does_not_take_it_fails_with_render(env: Env, reports: Reports) -> None:  # noqa: F811
    reports.renderer.fail = True
    task = env.created(report=True)
    env.deliver(_scheduled(task["task_id"]))
    run = _run(env, task)
    assert (run["report"]["status"], run["report"]["reason"]) == ("failed", "render")
    reports.renderer.fail = False
    path = f"/api/tasks/{task['task_id']}/runs/{run['run_id']}/report/retry"
    again = env.client.post(path, headers=_h("creator"), json={})
    assert again.status_code == 200, again.text
    assert again.json()["report"]["status"] == "generating"
    assert len(reports.renderer.started) == 1
    # Only after ``render``: generating again now is refused.
    refused = env.client.post(path, headers=_h("creator"), json={})
    assert (refused.status_code, _code(refused)) == (409, "report_not_retryable")
    assert env.events("schedule.report_retry")


def _ready(env: Env, task: dict[str, Any], run: dict[str, Any]) -> None:  # noqa: F811
    store = env.services.tasks.store  # type: ignore[union-attr]
    item = store.run(task["task_id"], run["run_id"])
    assert item is not None
    store._db.update_item(
        TableName="tasks",
        Key={"PK": {"S": f"AUTO#{task['task_id']}"}, "SK": {"S": item.sk}},
        UpdateExpression="SET report_status = :r, report_pages = :p, report_bytes = :b",
        ExpressionAttributeValues={":r": {"S": "ready"}, ":p": {"N": "2"}, ":b": {"N": "4096"}},
    )


def test_only_the_owner_downloads_with_a_new_audited_link(env: Env, reports: Reports) -> None:  # noqa: F811
    task = env.created(report=True)
    env.deliver(_scheduled(task["task_id"]))
    run = _run(env, task)
    early = _download(env, task, run)
    assert (early.status_code, _code(early)) == (409, "report_not_ready")
    _ready(env, task, run)
    ready = _run(env, task)["report"]
    assert (ready["status"], ready["pages"], ready["size_bytes"]) == ("ready", 2, 4096)
    first, second = _download(env, task, run), _download(env, task, run)
    assert first.status_code == 200, first.text
    assert first.json()["url"] != "" and first.json()["file"] == ready["file"]
    assert len(reports.links.issued) == 2
    owner, key = reports.links.issued[0]
    assert owner == "creator-1" and key.startswith(f"owner/creator-1/{task['task_id']}/")
    events = env.events("schedule.report_download")
    assert len(events) == 2
    assert events[0]["run"] == run["run_id"] and events[0]["file"] == ready["file"]
    # Never the link in the audit trail.
    assert "X-Amz-Signature" not in json.dumps(env.audit.events)
    assert second.status_code == 200
    # An administrator sees that it is ready, without its file, and may not download it.
    seen = _run(env, task, "admin")["report"]
    assert (seen["status"], seen["file"], seen["period"]) == ("ready", None, None)
    assert _download(env, task, run, "admin").status_code == 403
    # Anyone else does not even see the task.
    assert _download(env, task, run, "creator2").status_code == 404
    assert len(reports.links.issued) == 2


def test_downloads_are_limited_per_person(env: Env, reports: Reports) -> None:  # noqa: F811
    task = env.created(report=True)
    env.deliver(_scheduled(task["task_id"]))
    run = _run(env, task)
    _ready(env, task, run)
    codes = [_download(env, task, run).status_code for _ in range(61)]
    assert codes[:60] == [200] * 60 and codes[60] == 429


def test_a_generation_that_outlived_its_timeout_shows_as_render(env: Env, reports: Reports) -> None:  # noqa: F811
    task = env.created(report=True)
    env.deliver(_scheduled(task["task_id"]))
    run = _run(env, task)
    store = env.services.tasks.store  # type: ignore[union-attr]
    item = store.run(task["task_id"], run["run_id"])
    assert item is not None
    store._db.update_item(
        TableName="tasks",
        Key={"PK": {"S": f"AUTO#{task['task_id']}"}, "SK": {"S": item.sk}},
        UpdateExpression="SET report_at = :t",
        ExpressionAttributeValues={":t": {"N": "1"}},
    )
    report = _run(env, task)["report"]
    assert (report["status"], report["reason"]) == ("failed", "render")


def test_editing_turns_the_report_off_for_the_next_runs(env: Env, reports: Reports) -> None:  # noqa: F811
    task = env.created(report=True)
    body = {
        "name": task["name"],
        "agent_id": task["agent_id"],
        "task": "Otra instrucción",
        "trigger": DAILY,
        "report": False,
    }
    updated = env.client.put(f"/api/tasks/{task['task_id']}", headers=_h("creator"), json=body)
    assert updated.status_code == 200, updated.text
    assert updated.json()["report"] is None
    env.deliver(_scheduled(task["task_id"]))
    assert _run(env, task)["report"] is None


def test_recorded_calls_drop_a_cut_answer() -> None:
    recorded = harness._Recorded(frozenset({"get_cost_and_usage"}))
    recorded.call(1, "q1", "get_cost_and_usage")
    recorded.add(1, "{}")
    recorded.answer(2, "q1")
    recorded.add(2, "x" * (harness.MAX_RECORDED_CHARS + 1))
    assert recorded.done() == []
