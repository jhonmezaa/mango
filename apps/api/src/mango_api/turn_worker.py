"""mango-turn-worker: runs the chat turns of ``Mango-<ns>-ChatTurns`` (D121).

``python -m mango_api.turn_worker``: the same image as mango-api, another entry point, no
port. Each message is one turn, handled by ``turns.ChatTurns.handle``: claimed with a
conditional write, deleted at once, and never run twice (TM-TW5, D121 (7)).

While the task may hold a turn it is protected (ECS task scale-in protection, D121 (9)): the
protection is set **before** a message is read and dropped once no receive and no turn is in
flight, so a deployment waits for the turns that run and stops an idle task at once. On
SIGTERM the worker stops reading and finishes what it has; ECS gives it ``stopTimeout``
(120 s) after the protection is gone.

Security notes (security-best-practices): the ECS agent endpoint comes from ECS itself
(``ECS_AGENT_URI``) and must be the task metadata address (no outbound call to a variable
host, SSRF); no message body is ever logged (it carries the person's token, TM-TW1).
"""

from __future__ import annotations

import json
import logging
import os
import signal
import threading
import time
import urllib.request
from collections.abc import Callable, Mapping
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from urllib.parse import urlparse

import boto3

from mango_api.settings import Settings
from mango_api.turns import Handler

logger = logging.getLogger("mango_api.turn_worker")

LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"
PROTECTION_MINUTES = 12
"""The longest turn (600 s) plus a margin: a protection a task forgot ends by itself."""
RENEW_SECONDS = 300
WAIT_SECONDS = 20
VISIBILITY_SECONDS = 960
"""The queue's own visibility: the message is deleted as soon as its turn is claimed."""
MAX_CONCURRENT = 8
"""Turns at once per task (TM-TW10); the rest wait in the queue."""
ECS_AGENT_HOST = "169.254.170.2"
HTTP_TIMEOUT_SECONDS = 5
HTTP_OK = 200
WORKER_DEFAULTS = {
    # What only the HTTP routes of mango-api need: the worker serves none. Its environment
    # (TURN_WORKER_ENVIRONMENT in infra) brings them anyway; these only keep it starting.
    "ALLOWED_HOSTS": "",
    "ADMIN_PROBE_FUNCTION": "",
    "COGNITO_USER_POOL_ID": "",
}


class ProtectionError(Exception):
    """ECS did not take the task protection."""


class TaskProtection:
    """ECS task scale-in protection, through the ECS agent of the task. Without
    ``ECS_AGENT_URI`` (outside ECS: tests, a laptop) it does nothing."""

    def __init__(
        self,
        agent_uri: str | None,
        *,
        opener: Callable[..., Any] = urllib.request.urlopen,
    ) -> None:
        if agent_uri:
            parsed = urlparse(agent_uri)
            if parsed.scheme != "http" or parsed.hostname != ECS_AGENT_HOST:
                raise ValueError("ECS_AGENT_URI is not the ECS agent of this task")
        self._url = f"{agent_uri.rstrip('/')}/task-protection/v1/state" if agent_uri else None
        self._open = opener

    @property
    def enabled(self) -> bool:
        return self._url is not None

    def set(self, protected: bool) -> None:
        if self._url is None:
            return
        body: dict[str, Any] = {"ProtectionEnabled": protected}
        if protected:
            body["ExpiresInMinutes"] = PROTECTION_MINUTES
        request = urllib.request.Request(  # noqa: S310 - fixed host, checked above
            self._url,
            data=json.dumps(body).encode(),
            method="PUT",
            headers={"Content-Type": "application/json"},
        )
        with self._open(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
            status = getattr(response, "status", HTTP_OK)
            answer = json.loads(response.read() or b"{}")
        if status != HTTP_OK or "failure" in answer or "error" in answer:
            raise ProtectionError(f"task protection not set (HTTP {status})")


class Holds:
    """What the task must not be stopped in the middle of: a receive or a turn. The first
    one protects the task, the last one to end drops the protection (D121 (9))."""

    def __init__(
        self, protection: TaskProtection, *, clock: Callable[[], float] = time.monotonic
    ) -> None:
        self._protection = protection
        self._clock = clock
        self._count = 0
        self._renewed_at = 0.0
        self._lock = threading.Lock()

    @property
    def count(self) -> int:
        with self._lock:
            return self._count

    def acquire(self) -> None:
        """Raises when the task cannot be protected: then nothing is read."""
        with self._lock:
            if self._count == 0:
                self._protection.set(True)
                self._renewed_at = self._clock()
            self._count += 1

    def release(self) -> None:
        with self._lock:
            self._count -= 1
            if self._count > 0:
                return
            try:
                self._protection.set(False)
            except Exception:
                # It ends by itself after PROTECTION_MINUTES.
                logger.exception("the task protection could not be dropped")

    def renew(self) -> None:
        """Every ``RENEW_SECONDS`` while something is held: a turn may outlast one period."""
        with self._lock:
            if self._count == 0 or self._clock() - self._renewed_at < RENEW_SECONDS:
                return
            try:
                self._protection.set(True)
                self._renewed_at = self._clock()
            except Exception:
                logger.exception("the task protection could not be renewed")


class TurnWorker:
    """Long-polls the queue and hands each message to ``handler`` in a thread pool."""

    def __init__(
        self,
        client: Any,
        queue_url: str,
        handler: Handler,
        holds: Holds,
        *,
        max_concurrent: int = MAX_CONCURRENT,
        wait_seconds: int = WAIT_SECONDS,
    ) -> None:
        self._client = client
        self._url = queue_url
        self._handler = handler
        self._holds = holds
        self._wait = wait_seconds
        self._slots = threading.BoundedSemaphore(max_concurrent)
        self._pool = ThreadPoolExecutor(max_workers=max_concurrent, thread_name_prefix="turn")
        self._stop = threading.Event()
        self._done = threading.Event()
        """Set once the last turn finished: the protection is renewed until then."""

    def stop(self) -> None:
        """Stop reading (SIGTERM); the turns in flight finish."""
        self._stop.set()

    def run(self) -> None:
        renewer = threading.Thread(target=self._renew, name="turn-protection", daemon=True)
        renewer.start()
        try:
            while not self._stop.is_set():
                self._receive()
        finally:
            self._pool.shutdown(wait=True, cancel_futures=False)
            self._stop.set()
            self._done.set()
            logger.info("turn worker stopped")

    def _receive(self) -> None:
        if not self._slots.acquire(timeout=1):
            return
        try:
            # Protected before reading (D121 (9)): a message is never taken by a task that a
            # deployment may stop in the middle of its turn.
            self._holds.acquire()
        except Exception:
            self._slots.release()
            logger.exception("the task could not be protected: the queue is not read")
            self._stop.wait(5)
            return
        try:
            resp = self._client.receive_message(
                QueueUrl=self._url,
                MaxNumberOfMessages=1,
                WaitTimeSeconds=self._wait,
                VisibilityTimeout=VISIBILITY_SECONDS,
            )
            messages = resp.get("Messages", [])
        except Exception:
            logger.exception("the chat turns queue could not be read")
            messages = []
            self._stop.wait(5)
        if not messages:
            self._holds.release()
            self._slots.release()
            return
        # The receive's hold is now the turn's.
        self._pool.submit(self._one, messages[0])

    def _one(self, message: Mapping[str, Any]) -> None:
        receipt = str(message.get("ReceiptHandle", ""))

        def ack() -> None:
            self._client.delete_message(QueueUrl=self._url, ReceiptHandle=receipt)

        try:
            self._handler(str(message.get("Body", "")), ack)
        except Exception:
            logger.exception("a chat turn ended with an error")
        finally:
            self._holds.release()
            self._slots.release()

    def _renew(self) -> None:
        # Also after SIGTERM, while the last turns finish.
        while not self._done.wait(30):
            self._holds.renew()


def worker_settings(env: Mapping[str, str] | None = None) -> Settings:
    """The settings of mango-api, without what only its HTTP routes need."""
    return Settings.from_env({**WORKER_DEFAULTS, **(os.environ if env is None else env)})


def main() -> None:
    logging.basicConfig(level=logging.INFO, format=LOG_FORMAT)
    # Imported here: building the services of mango-api pulls its whole app.
    from mango_api.app import build_services, wire_ticket_gate  # noqa: PLC0415

    settings = worker_settings()
    if not settings.chat_turns_queue_url:
        raise SystemExit("MANGO_CHAT_TURNS_QUEUE_URL is not set")
    services = build_services(settings)
    # What create_app adds to the services the turn uses: the gate of the tickets tool.
    wire_ticket_gate(services)
    chat_turns = services.chat_turns
    if chat_turns is None:
        raise SystemExit("the chat turns are not configured")
    worker = TurnWorker(
        boto3.client("sqs", region_name=settings.region),
        settings.chat_turns_queue_url,
        chat_turns.handle,
        Holds(TaskProtection(os.environ.get("ECS_AGENT_URI"))),
    )

    def stop(_signum: int, _frame: object) -> None:
        logger.info("stop requested: no more turns are read")
        worker.stop()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    logger.info("turn worker started")
    worker.run()


if __name__ == "__main__":
    main()
