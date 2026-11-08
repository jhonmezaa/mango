"""The process of mango-turn-worker: task protection (D121 (9)), the queue loop and SIGTERM."""

from __future__ import annotations

import io
import json
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

import pytest

from mango_api import turn_worker
from mango_api.app import wire_ticket_gate
from mango_api.tickets import TicketToolGate
from mango_api.turn_worker import Holds, TaskProtection, TurnWorker, worker_settings

AGENT = "http://169.254.170.2/api/task-1"


@dataclass
class Opened:
    calls: list[tuple[str, str, dict[str, Any]]] = field(default_factory=list)
    answer: dict[str, Any] = field(default_factory=lambda: {"protection": {}})
    status: int = 200

    def __call__(self, request: Any, timeout: float) -> Any:
        assert timeout <= 5
        self.calls.append((request.get_method(), request.full_url, json.loads(request.data)))
        body = io.BytesIO(json.dumps(self.answer).encode())
        body.status = self.status  # type: ignore[attr-defined]
        return body


def test_protection_is_set_through_the_ecs_agent_with_twelve_minutes() -> None:
    opened = Opened()
    protection = TaskProtection(AGENT, opener=opened)
    protection.set(True)
    protection.set(False)
    assert opened.calls == [
        (
            "PUT",
            f"{AGENT}/task-protection/v1/state",
            {"ProtectionEnabled": True, "ExpiresInMinutes": 12},
        ),
        ("PUT", f"{AGENT}/task-protection/v1/state", {"ProtectionEnabled": False}),
    ]


@pytest.mark.parametrize(
    "uri", ["http://example.com/api/x", "https://169.254.170.2/api/x", "file:///etc/passwd"]
)
def test_only_the_ecs_agent_of_the_task_is_called(uri: str) -> None:
    with pytest.raises(ValueError, match="ECS agent"):
        TaskProtection(uri)


def test_a_refused_protection_raises() -> None:
    with pytest.raises(turn_worker.ProtectionError):
        TaskProtection(AGENT, opener=Opened(answer={"failure": {"reason": "x"}})).set(True)


def test_outside_ecs_nothing_is_called() -> None:
    protection = TaskProtection(None)
    assert not protection.enabled
    protection.set(True)


@dataclass
class Recorded:
    """A TaskProtection that records what it was asked."""

    calls: list[bool] = field(default_factory=list)
    fail: bool = False
    attempts: int = 0

    def set(self, protected: bool) -> None:
        self.attempts += 1
        if self.fail:
            raise turn_worker.ProtectionError("x")
        self.calls.append(protected)


def test_the_first_hold_protects_and_the_last_one_unprotects() -> None:
    recorded = Recorded()
    holds = Holds(recorded)  # type: ignore[arg-type]
    holds.acquire()
    holds.acquire()
    holds.release()
    assert recorded.calls == [True]
    holds.release()
    assert recorded.calls == [True, False]


def test_a_long_turn_renews_its_protection_every_five_minutes() -> None:
    now = [0.0]
    recorded = Recorded()
    holds = Holds(recorded, clock=lambda: now[0])  # type: ignore[arg-type]
    holds.acquire()
    now[0] = 299
    holds.renew()
    now[0] = 300
    holds.renew()
    assert recorded.calls == [True, True]
    holds.release()
    now[0] = 900
    holds.renew()
    assert recorded.calls == [True, True, False]


@dataclass
class FakeSqs:
    messages: list[dict[str, Any]] = field(default_factory=list)
    log: list[str] = field(default_factory=list)
    deleted: list[str] = field(default_factory=list)
    on_empty: Callable[[], None] = lambda: None

    def receive_message(self, **kwargs: Any) -> dict[str, Any]:
        assert kwargs["MaxNumberOfMessages"] == 1
        assert kwargs["VisibilityTimeout"] == 960
        self.log.append("receive")
        if not self.messages:
            self.on_empty()
            return {}
        return {"Messages": [self.messages.pop(0)]}

    def delete_message(self, QueueUrl: str, ReceiptHandle: str) -> None:  # noqa: N803
        self.deleted.append(ReceiptHandle)


class Ordered:
    """A protection that writes into the same log as the queue, to check the order."""

    def __init__(self, log: list[str]) -> None:
        self.log = log

    def set(self, protected: bool) -> None:
        self.log.append("protect" if protected else "unprotect")


def test_the_task_is_protected_before_it_reads_and_released_when_idle() -> None:
    sqs = FakeSqs(messages=[{"Body": "b1", "ReceiptHandle": "r1"}])
    handled: list[str] = []
    worker: TurnWorker

    def handler(body: str, ack: Callable[[], None]) -> None:
        handled.append(body)
        ack()

    sqs.on_empty = lambda: worker.stop()  # noqa: PLW0108 - worker is built below
    worker = TurnWorker(
        sqs,
        "url",
        handler,
        Holds(Ordered(sqs.log)),  # type: ignore[arg-type]
        max_concurrent=1,
        wait_seconds=0,
    )
    worker.run()
    assert handled == ["b1"]
    assert sqs.deleted == ["r1"]
    # Never a receive without the protection; dropped once nothing is held.
    assert sqs.log[:2] == ["protect", "receive"]
    assert sqs.log[-1] == "unprotect"
    held = 0
    for entry in sqs.log:
        held += {"protect": 1, "unprotect": -1}.get(entry, 0)
        if entry == "receive":
            assert held == 1


def test_without_protection_the_queue_is_not_read(monkeypatch: pytest.MonkeyPatch) -> None:
    sqs = FakeSqs(messages=[{"Body": "b1", "ReceiptHandle": "r1"}])
    worker: TurnWorker
    waits: list[float] = []

    def stop_after_wait(seconds: float) -> bool:
        waits.append(seconds)
        worker.stop()
        return True

    refused = Recorded(fail=True)
    worker = TurnWorker(
        sqs,
        "url",
        lambda _b, _a: None,
        Holds(refused),  # type: ignore[arg-type]
        max_concurrent=1,
        wait_seconds=0,
    )
    monkeypatch.setattr(worker._stop, "wait", stop_after_wait)
    worker.run()
    assert "receive" not in sqs.log
    assert refused.attempts >= 1
    assert waits


def test_sigterm_stops_reading_and_the_turn_in_flight_finishes() -> None:
    sqs = FakeSqs(messages=[{"Body": "b1", "ReceiptHandle": "r1"}])
    started, release = threading.Event(), threading.Event()
    finished: list[str] = []

    def handler(body: str, ack: Callable[[], None]) -> None:
        ack()
        started.set()
        release.wait(5)
        finished.append(body)

    recorded = Recorded()
    worker = TurnWorker(
        sqs,
        "url",
        handler,
        Holds(recorded),  # type: ignore[arg-type]
        max_concurrent=2,
        wait_seconds=0,
    )
    runner = threading.Thread(target=worker.run)
    runner.start()
    assert started.wait(5)
    worker.stop()  # what the SIGTERM handler does
    reads = sqs.log.count("receive")
    release.set()
    runner.join(5)
    assert not runner.is_alive()
    assert finished == ["b1"]
    assert sqs.log.count("receive") <= reads + 1
    assert recorded.calls[0] is True
    assert recorded.calls[-1] is False


def test_the_worker_needs_only_the_settings_of_the_turn() -> None:
    env = {
        "MODEL_PRICES": "{}",
        "MANGO_NAMESPACE": "test",
        "COGNITO_ISSUER": "https://issuer.example.com",
        "COGNITO_CLIENT_ID": "client",
        "GATEWAY_URL": "https://gw.example.com/mcp",
        "AGENT_ID": "finops",
        "AGENT_MODEL": "m",
        "AUXILIARY_MODEL": "a",
        "POLICY_STORE_ID": "ps",
        "CONVERSATIONS_TABLE": "conv",
        "CONVERSATIONS_TABLE_ARN": "arn:aws:dynamodb:us-east-1:111122223333:table/conv",
        "DATA_KEY_ARN": "arn:aws:kms:us-east-1:111122223333:key/k",
        "DATA_ACCESS_ROLE_ARN": "arn:aws:iam::111122223333:role/data",
        "BUDGETS_TABLE": "budgets",
        "AUDIT_STREAM": "audit",
        "AUDIT_INDEX_TABLE": "audit-index",
        "USER_MONTHLY_BUDGET_USD": "5",
        "AGENT_MONTHLY_BUDGET_USD": "30",
        "INVOCATION_KEY_SECRET_ARN": "arn:aws:secretsmanager:us-east-1:111122223333:secret:k",
        "SETTINGS_TABLE": "settings",
        "AGENTS_TABLE": "agents",
        "GUARDRAIL_ID": "gr",
        "GUARDRAIL_VERSION": "1",
        "RATE_LIMITS_TABLE": "rate-limits",
        "MANGO_CHAT_TURNS_QUEUE_URL": "https://sqs.us-east-1.amazonaws.com/111122223333/q",
    }
    settings = worker_settings(env)
    assert settings.chat_turns_queue_url.endswith("/q")
    assert settings.allowed_hosts == frozenset()


def test_the_worker_decides_calls_of_the_tickets_tool_as_mango_api() -> None:
    """The gate of the tickets tool counts a request against the person's limits only when it is
    created (D112): without it in the worker, the limit would not apply to the chat."""
    services = SimpleNamespace(approvals=SimpleNamespace(gate=None), tickets=object())
    wire_ticket_gate(services)  # type: ignore[arg-type]
    assert isinstance(services.approvals.gate, TicketToolGate)
    untouched = SimpleNamespace(approvals=SimpleNamespace(gate=None), tickets=None)
    wire_ticket_gate(untouched)  # type: ignore[arg-type]
    assert untouched.approvals.gate is None
