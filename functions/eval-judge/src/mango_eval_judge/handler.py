"""Lambda entry point of ``Mango-<ns>-EvalJudge`` (D110).

Two actions, each from one caller (IAM decides who may invoke it; the event is validated here):

* ``{"action": "canary", "harness_version": "<n>"}``: asynchronous, from the provisioner, after
  it deploys a version of the evals harness (``mango_eval_judge.canary``).
* ``{"action": "judge", "session_id", "expected", "judge_model", "started_at"}``:
  synchronous, from mango-api, for one case whose criterion is the judge. It answers the
  verdict only (``mango_eval_judge.judge``).

The event of ``judge`` carries the expected answer of a case (content): it is never logged, and
neither is anything this function reads from the evals log group.
"""

from __future__ import annotations

import logging
import re
import time
from functools import cache
from typing import Any

import boto3
from botocore.config import Config

from mango_core.evals_harness import HARNESS_SK, SETTINGS_PK, Capture, EvalsHarness
from mango_eval_judge import judge
from mango_eval_judge.canary import INVOKE_HARNESS_EVENT, Canary, own_trace_on_invoke
from mango_eval_judge.config import Settings

logger = logging.getLogger()
logger.setLevel(logging.INFO)

_CLIENT_CONFIG = Config(retries={"mode": "standard", "max_attempts": 4}, read_timeout=120)
_VERSION_RE = re.compile(r"^[1-9][0-9]{0,4}$")
LOOKBACK_SECONDS = 60
"""The trace of a case starts after the case does; a minute before, for clocks."""
MAX_CASE_AGE_SECONDS = 2 * 24 * 3600
"""A case is scored within its run; older sessions are not read."""


class InvalidEventError(ValueError):
    pass


@cache
def _settings() -> Settings:
    return Settings.from_env()


def agentcore_client(**kwargs: Any) -> Any:
    """The AgentCore client: its ``InvokeHarness`` carries a sampled trace of its own, never the
    invocation's (``canary.TRACE_HEADER``)."""
    client = boto3.client("bedrock-agentcore", config=_CLIENT_CONFIG, **kwargs)
    client.meta.events.register(INVOKE_HARNESS_EVENT, own_trace_on_invoke)
    return client


@cache
def _clients() -> tuple[Any, Any, Any]:
    return (
        boto3.client("dynamodb", config=_CLIENT_CONFIG),
        boto3.client("logs", config=_CLIENT_CONFIG),
        agentcore_client(),
    )


def _evals_harness(dynamodb: Any, settings: Settings) -> EvalsHarness:
    item = dynamodb.get_item(
        TableName=settings.settings_table,
        Key={"PK": {"S": SETTINGS_PK}, "SK": {"S": HARNESS_SK}},
        ConsistentRead=True,
    ).get("Item")
    if item is None:
        raise InvalidEventError("no evals harness")
    return EvalsHarness.from_item(item)


def handle_judge(
    event: dict[str, Any], settings: Settings, clients: tuple[Any, Any, Any]
) -> dict[str, Any]:
    dynamodb, logs, agentcore = clients
    session_id, expected = event.get("session_id"), event.get("expected")
    model, started = event.get("judge_model"), event.get("started_at")
    if (
        set(event) != {"action", "session_id", "expected", "judge_model", "started_at"}
        or not isinstance(session_id, str)
        or not isinstance(expected, str)
        or not isinstance(model, str)
        or not isinstance(started, int)
        or isinstance(started, bool)
    ):
        raise InvalidEventError("invalid judge event")
    now = int(time.time())
    if not now - MAX_CASE_AGE_SECONDS <= started <= now + LOOKBACK_SECONDS:
        raise InvalidEventError("invalid judge event")
    harness = _evals_harness(dynamodb, settings)
    verdict = judge.score(
        settings,
        logs,
        agentcore,
        groups=settings.runtime_log_groups(harness.runtime_id),
        session_id=session_id,
        expected=expected,
        judge_model=model,
        start_ms=(started - LOOKBACK_SECONDS) * 1000,
        end_ms=(now + LOOKBACK_SECONDS) * 1000,
    )
    return verdict.to_dict()


def handle(event: object, settings: Settings, clients: tuple[Any, Any, Any]) -> dict[str, Any]:
    if not isinstance(event, dict):
        raise InvalidEventError("invalid event")
    action = event.get("action")
    if action == "judge":
        try:
            return handle_judge(event, settings, clients)
        except ValueError as exc:
            # The message is ours (never the event's content).
            raise InvalidEventError(str(exc)) from None
    if action == "canary":
        version = event.get("harness_version")
        if set(event) != {"action", "harness_version"} or not (
            isinstance(version, str) and _VERSION_RE.fullmatch(version)
        ):
            raise InvalidEventError("invalid canary event")
        dynamodb, logs, agentcore = clients
        capture: Capture = Canary(settings, dynamodb=dynamodb, logs=logs, agentcore=agentcore).run(
            version
        )
        return {"status": capture.status, "reason": capture.reason}
    raise InvalidEventError("invalid action")


def lambda_handler(event: object, _context: Any) -> dict[str, Any]:
    return handle(event, _settings(), _clients())
