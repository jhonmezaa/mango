"""The turn of a task run in the turn worker (D121 (5)): mango-api keeps every check before the
turn, the token and the hold; the worker claims the run, runs its turn and records its end."""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from typing import Any

import pytest

from mango_api import app as app_module
from mango_api.task_worker import (
    TASK_RUN_KIND,
    DispatchedRuns,
    TaskRunMessage,
)
from mango_api.tasks_store import PauseReason, RunStatus, Status
from mango_api.turn_worker import route
from mango_core.identity import IdentityError

from .test_tasks import CLAIMS, EXP, Env, _scheduled, env  # noqa: F401 - the fixture


@dataclass
class TaskVerifier:
    """The tasks client of the worker: the token ``FakeTaskTokens`` issued, with the groups the
    owner had when mango-api asked for it."""

    env: Env
    refuse: bool = False
    subject: str | None = None
    """A token of somebody else than the task's owner."""
    verified: list[str] = field(default_factory=list)

    def verify(self, token: str) -> dict[str, Any]:
        self.verified.append(token)
        if self.refuse or not token.startswith("task-token-"):
            raise IdentityError("invalid")
        sub = self.subject or token.removeprefix("task-token-")
        claims = next(c for c in CLAIMS.values() if c["sub"] == sub)
        groups = self.env.tokens.groups.get(sub, claims["cognito:groups"])
        return {**claims, "cognito:groups": groups, "exp": EXP, "client_id": "tasks"}


@dataclass
class Worker:
    runs: DispatchedRuns
    verifier: TaskVerifier
    acks: list[str] = field(default_factory=list)

    def take(self, body: str) -> None:
        self.runs.handle(body, lambda: self.acks.append("ack"))


@dataclass
class Dispatch:
    """``Mango-<ns>-ChatTurns`` between mango-api and the worker: the worker takes each run as
    soon as it is sent, unless ``hold`` keeps it in the queue. ``before`` runs in between."""

    worker: Worker | None
    sent: list[str] = field(default_factory=list)
    before: Callable[[], None] | None = None
    fail: bool = False

    def send(self, body: str) -> None:
        if self.fail:
            raise RuntimeError("queue unavailable")
        self.sent.append(body)
        if self.before is not None:
            self.before()
        if self.worker is not None:
            self.worker.take(body)


def _worker(env: Env, verifier: TaskVerifier | None = None) -> Worker:  # noqa: F811 - the fixture
    services = env.services
    assert services.tasks is not None
    verifier = verifier or TaskVerifier(env)
    runs = DispatchedRuns(
        store=services.tasks.store,
        verifier=verifier,
        turn=lambda caller, automation, run, message: app_module._task_turn(
            services, caller, automation, run, message, reports_on=False
        ),
        audit=services.audit,
    )
    return Worker(runs, verifier)


def _dispatch(env: Env, worker: Worker | None, **kwargs: Any) -> Dispatch:  # noqa: F811 - the fixture
    runs = env.services.task_runs
    assert runs is not None
    dispatch = Dispatch(worker, **kwargs)
    runs.dispatch = dispatch
    runs.poll_seconds = 0
    return dispatch


def _run(env: Env, task_id: str) -> dict[str, Any]:  # noqa: F811 - the fixture
    runs: list[dict[str, Any]] = env.get("creator", task_id).json()["runs"]
    return runs[0]


def _held(env: Env, task_id: str) -> str | None:  # noqa: F811 - the fixture
    assert env.services.tasks is not None
    automation = env.services.tasks.store.get(task_id)
    assert automation is not None
    return automation.running_run


def test_the_turn_of_a_run_runs_in_the_worker_with_its_token(
    env: Env,  # noqa: F811 - the fixture
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)
    task = env.created()
    worker = _worker(env)
    dispatch = _dispatch(env, worker)
    env.deliver(_scheduled(task["task_id"]))
    (body,) = dispatch.sent
    message = TaskRunMessage.model_validate_json(body)
    assert (message.kind, message.automation_id, message.owner_sub) == (
        TASK_RUN_KIND,
        task["task_id"],
        "creator-1",
    )
    # The token mango-api issued for the run, verified again by the worker.
    assert worker.verifier.verified == ["task-token-creator-1"]
    assert len(env.agentcore.requests) == 1
    assert len(env.budgets.reserved) == 1
    run = _run(env, task["task_id"])
    assert run["status"] == "ok"
    assert worker.acks == ["ack"]
    # The worker released the hold: the next run may take the task.
    assert _held(env, task["task_id"]) is None
    assert [e for e, *_ in env.audit.events if e.startswith("task.run.")] == [
        "task.run.started",
        "task.run.finished",
    ]
    # The token never reaches a log nor the audit.
    assert "task-token-creator-1" not in caplog.text
    assert "task-token-creator-1" not in json.dumps([d for _e, _u, d in env.audit.events])


def test_a_second_delivery_never_runs_it_again(env: Env) -> None:  # noqa: F811 - the fixture
    task = env.created()
    worker = _worker(env)
    dispatch = _dispatch(env, worker)
    env.deliver(_scheduled(task["task_id"]))
    worker.take(dispatch.sent[0])
    assert len(env.agentcore.requests) == 1
    assert worker.acks == ["ack", "ack"]
    assert len(env.budgets.reserved) == 1


def test_a_run_nobody_takes_fails_and_never_runs_later(env: Env) -> None:  # noqa: F811 - the fixture
    task = env.created()
    dispatch = _dispatch(env, None)
    runs = env.services.task_runs
    assert runs is not None
    runs.pickup_seconds = -1
    env.deliver(_scheduled(task["task_id"]))
    run = _run(env, task["task_id"])
    assert (run["status"], run["reason"]) == ("failed", "upstream_error")
    assert _held(env, task["task_id"]) is None
    # Delivered to a worker after all: not queued any more, so it never runs.
    late = _worker(env)
    late.take(dispatch.sent[0])
    assert env.agentcore.requests == []
    assert late.acks == ["ack"]


def test_a_run_that_cannot_be_sent_fails_and_frees_its_task(env: Env) -> None:  # noqa: F811 - the fixture
    task = env.created()
    _dispatch(env, None, fail=True)
    env.deliver(_scheduled(task["task_id"]))
    run = _run(env, task["task_id"])
    assert (run["status"], run["reason"]) == ("failed", "upstream_error")
    assert _held(env, task["task_id"]) is None


def test_a_token_the_worker_does_not_verify_fails_the_run(env: Env) -> None:  # noqa: F811 - the fixture
    task = env.created()
    worker = _worker(env, TaskVerifier(env, refuse=True))
    _dispatch(env, worker)
    env.deliver(_scheduled(task["task_id"]))
    assert env.agentcore.requests == []
    run = _run(env, task["task_id"])
    assert (run["status"], run["reason"]) == ("failed", "identity_unavailable")
    assert _held(env, task["task_id"]) is None
    assert worker.acks == ["ack"]


def test_a_token_of_somebody_else_never_runs_the_task(env: Env) -> None:  # noqa: F811 - the fixture
    task = env.created()
    worker = _worker(env, TaskVerifier(env, subject="creator-2"))
    _dispatch(env, worker)
    env.deliver(_scheduled(task["task_id"]))
    assert env.agentcore.requests == []
    run = _run(env, task["task_id"])
    assert (run["status"], run["reason"]) == ("failed", "identity_unavailable")


def test_a_message_that_names_another_owner_is_not_run(env: Env) -> None:  # noqa: F811 - the fixture
    task = env.created()
    worker = _worker(env)
    dispatch = _dispatch(env, None)
    runs = env.services.task_runs
    assert runs is not None
    runs.pickup_seconds = 10**6
    runs.stopping.set()  # mango-api does not wait: this test delivers by hand
    env.deliver(_scheduled(task["task_id"]))
    forged = json.loads(dispatch.sent[0])
    forged["owner_sub"] = "creator-2"
    worker.take(json.dumps(forged))
    assert env.agentcore.requests == []
    assert _run(env, task["task_id"])["status"] == "queued"
    assert worker.acks == ["ack"]


def test_a_task_paused_by_an_administrator_on_the_way_skips_the_run(env: Env) -> None:  # noqa: F811 - the fixture
    task = env.created()
    store = env.services.tasks.store if env.services.tasks else None
    assert store is not None

    def pause() -> None:
        automation = store.get(task["task_id"])
        assert automation is not None
        store.update(
            automation,
            {"status": Status.PAUSED, "paused_reason": PauseReason.ADMIN.value},
            expect_status=frozenset({Status.ACTIVE}),
        )

    worker = _worker(env)
    _dispatch(env, worker, before=pause)
    env.deliver(_scheduled(task["task_id"]))
    assert env.agentcore.requests == []
    run = _run(env, task["task_id"])
    assert (run["status"], run["reason"]) == ("skipped", "paused_by_admin")
    assert _held(env, task["task_id"]) is None


def test_an_owner_denied_in_the_worker_pauses_the_task_from_mango_api(env: Env) -> None:  # noqa: F811 - the fixture
    """``UseAgent`` is decided again in the worker with the groups of the token; the worker has
    no Scheduler, so the mango-api task that sent the run pauses the task (D26)."""
    task = env.created()
    env.tokens.groups["creator-1"] = ["mango-agent-creator"]
    _dispatch(env, _worker(env))
    env.deliver(_scheduled(task["task_id"]))
    assert env.agentcore.requests == []
    detail = env.get("creator", task["task_id"]).json()
    assert (detail["status"], detail["paused_reason"]) == ("paused", "access_lost")
    assert (detail["runs"][0]["status"], detail["runs"][0]["reason"]) == ("skipped", "access_lost")
    assert env.scheduler.updated[-1]["State"] == "DISABLED"
    assert env.events("task.paused")[0]["reason"] == "access_lost"


def test_a_task_mango_api_stopped_waiting_for_is_paused_by_its_next_run(env: Env) -> None:  # noqa: F811 - the fixture
    """The mango-api task stopped (a deployment) before the worker skipped the run: the task
    is still active, and the next run, denied again, pauses it."""
    task = env.created()
    env.tokens.groups["creator-1"] = ["mango-agent-creator"]
    runs = env.services.task_runs
    assert runs is not None
    _dispatch(env, _worker(env))
    runs.stopping.set()
    env.deliver(_scheduled(task["task_id"]))
    detail = env.get("creator", task["task_id"]).json()
    assert (detail["status"], detail["runs"][0]["reason"]) == ("active", "access_lost")
    runs.stopping.clear()
    env.deliver(_scheduled(task["task_id"], "2026-10-16T14:30:00Z"))
    detail = env.get("creator", task["task_id"]).json()
    assert (detail["status"], detail["paused_reason"]) == ("paused", "access_lost")
    assert env.scheduler.updated[-1]["State"] == "DISABLED"
    assert env.agentcore.requests == []


def test_an_invalid_message_is_deleted_and_never_logged(
    env: Env,  # noqa: F811 - the fixture
    caplog: pytest.LogCaptureFixture,
) -> None:
    worker = _worker(env)
    body = json.dumps({"v": 1, "kind": TASK_RUN_KIND, "access_token": "secret-token-value"})
    worker.take(body)
    assert worker.acks == ["ack"]
    assert "secret-token-value" not in caplog.text


def test_the_worker_routes_each_message_to_its_handler() -> None:
    chats: list[str] = []
    tasks: list[str] = []
    handle = route(lambda b, _a: chats.append(b), lambda b, _a: tasks.append(b))
    handle('{"v":1,"turn_id":"t"}', lambda: None)
    handle('{"v":1,"kind":"task_run"}', lambda: None)
    handle("not json", lambda: None)
    assert chats == ['{"v":1,"turn_id":"t"}', "not json"]
    assert tasks == ['{"v":1,"kind":"task_run"}']
    # A worker without the tasks deletes a run and never runs it as a chat turn.
    acks: list[str] = []
    route(lambda b, _a: chats.append(b), None)('{"kind":"task_run"}', lambda: acks.append("a"))
    assert acks == ["a"]
    assert len(chats) == 2


def test_the_body_of_a_run_is_the_contract_of_the_queue(env: Env) -> None:  # noqa: F811 - the fixture
    task = env.created()
    dispatch = _dispatch(env, _worker(env))
    env.deliver(_scheduled(task["task_id"]))
    body = json.loads(dispatch.sent[0])
    assert sorted(body) == sorted(TaskRunMessage.model_fields)
    assert (body["v"], body["kind"], body["agent_id"]) == (1, TASK_RUN_KIND, "finops")
    assert _run(env, task["task_id"])["status"] == RunStatus.OK.value


def test_one_run_at_a_time_while_a_run_is_on_its_way_to_the_worker(env: Env) -> None:  # noqa: F811 - the fixture
    """The hold is taken in mango-api and released by the worker (TM-T5)."""
    task = env.created()
    dispatch = _dispatch(env, None)
    runs = env.services.task_runs
    assert runs is not None
    runs.stopping.set()  # mango-api does not wait: this test delivers by hand
    env.deliver(_scheduled(task["task_id"]))
    assert _held(env, task["task_id"]) is not None
    assert env.post("creator", task["task_id"], "run").status_code == 202
    env.deliver()
    statuses = sorted(
        (r["status"], r.get("reason")) for r in env.get("creator", task["task_id"]).json()["runs"]
    )
    assert statuses == [("queued", None), ("skipped", "overlap")]
    worker = _worker(env)
    worker.take(dispatch.sent[0])
    assert len(env.agentcore.requests) == 1
    assert _held(env, task["task_id"]) is None


def test_the_worker_builds_its_runs_with_the_tasks_client_only(env: Env) -> None:  # noqa: F811 - the fixture
    """Only the table, the tasks client to verify with and the PDF function: never the client's
    secret, the identity key or Scheduler (TM-T1). Without the table or the client, none."""
    services = env.services
    services.settings = replace(
        services.settings,
        cognito_issuer="https://cognito-idp.us-east-1.amazonaws.com/us-east-1_example",
        tasks_table="tasks",
        tasks_client_id="tasksclient",
        task_report_function="Mango-test-TaskReport",
    )
    runs = app_module.dispatched_runs(services)
    assert isinstance(runs, DispatchedRuns)
    assert runs.verifier._client_ids == frozenset({"tasksclient"})  # type: ignore[attr-defined]
    assert runs.reports is not None
    assert not hasattr(runs, "tokens") and not hasattr(runs, "scheduler")
    services.settings = replace(services.settings, tasks_client_id="")
    assert app_module.dispatched_runs(services) is None
