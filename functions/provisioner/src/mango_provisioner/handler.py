"""Lambda entry point of the agent provisioner: one invocation per state machine step.

The event is ``{"step": <name>, "state": <execution state>, "execution": <name>}``.
The execution name always comes from the Step Functions context object, never from the state:
it is the owner of the agent's lock. Results and errors carry identifiers and codes only:
definitions, prompts and AWS error messages never reach the execution history or the logs.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from functools import cache
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from mango_provisioner.audit import AuditWriter
from mango_provisioner.config import Settings
from mango_provisioner.errors import StepError, aws_error
from mango_provisioner.harness import Harnesses
from mango_provisioner.role import AgentRoles
from mango_provisioner.runtime_logs import RuntimeLogs
from mango_provisioner.steps import Provisioner
from mango_provisioner.store import ProvisionerStore

logger = logging.getLogger()
logger.setLevel(logging.INFO)

_CLIENT_CONFIG = Config(
    retries={"mode": "standard", "max_attempts": 3}, connect_timeout=5, read_timeout=20
)


class ProvisionerStepError(Exception):
    """A step failed for good. The message is ``{"step", "code"}``."""


class RetryableStepError(Exception):
    """A step hit a transient condition; the state machine retries it."""


@cache
def _provisioner() -> Provisioner:
    settings = Settings.from_env()
    dynamodb = boto3.client("dynamodb", config=_CLIENT_CONFIG)
    return Provisioner(
        settings,
        store=ProvisionerStore(dynamodb, settings.agents_table, settings.settings_table),
        roles=AgentRoles(boto3.client("iam", config=_CLIENT_CONFIG), settings),
        harnesses=Harnesses(
            boto3.client("bedrock-agentcore-control", config=_CLIENT_CONFIG), settings
        ),
        logs=RuntimeLogs(boto3.client("logs", config=_CLIENT_CONFIG), settings),
        audit=AuditWriter(
            boto3.client("firehose", config=_CLIENT_CONFIG),
            settings.audit_stream,
            dynamodb,
            settings.audit_index_table,
        ),
    )


def _steps(p: Provisioner, event: dict[str, Any]) -> dict[str, Callable[[], dict[str, Any]]]:
    raw = event.get("state")
    # `load` receives the execution input as it came; every other step, the state `load` built.
    state = {**raw, "execution": event.get("execution")} if isinstance(raw, dict) else raw

    def forward(step: Callable[[dict[str, Any]], dict[str, Any]]) -> Callable[[], dict[str, Any]]:
        def run() -> dict[str, Any]:
            if not isinstance(state, dict):
                raise StepError("invalid_state")
            return step(state)

        return run

    return {
        "load": lambda: p.load(raw, event.get("execution")),
        "ensure_role": forward(p.ensure_role),
        "ensure_harness": forward(p.ensure_harness),
        "check_harness": forward(p.check_harness),
        "point_live": forward(p.point_live),
        "check_live": forward(p.check_live),
        "govern_logs": forward(p.govern_logs),
        "publish": forward(p.publish),
        "compensate": lambda: p.compensate(state),
        "mark_failed": lambda: p.mark_failed(state),
    }


def handle(event: object, provisioner: Provisioner) -> dict[str, Any]:
    step = event.get("step") if isinstance(event, dict) else None
    steps = _steps(provisioner, event) if isinstance(event, dict) else {}
    if not isinstance(step, str) or step not in steps:
        raise ProvisionerStepError(json.dumps({"step": "dispatch", "code": "invalid_step"}))
    try:
        result = steps[step]()
    except (StepError, ClientError, BotoCoreError) as exc:
        error = exc if isinstance(exc, StepError) else aws_error(step, exc)
        logger.warning(
            json.dumps({"event": "provisioner.step_failed", "step": step, "code": error.code})
        )
        message = json.dumps({"step": step, "code": error.code})
        if type(error).__name__ == "RetryableError":
            raise RetryableStepError(message) from None
        raise ProvisionerStepError(message) from None
    logger.info(
        json.dumps(
            {
                "event": "provisioner.step",
                "step": step,
                "agent": result.get("agent_id"),
                "version": result.get("version"),
                "execution": result.get("execution"),
            }
        )
    )
    return {**result, "last_step": step}


def lambda_handler(event: object, _context: Any) -> dict[str, Any]:
    return handle(event, _provisioner())
