"""Lambda entry point of the agent deprovisioner: one invocation per state machine step.

Same contract as the agent provisioner (``mango_provisioner.handler``): the event is
``{"step": <name>, "state": <execution state>, "execution": <name>}``, the execution name
comes from the Step Functions context object, and results and errors carry identifiers and
codes only. It runs with its own role, which can delete the harness and the role of an agent
and nothing else: it cannot create, update, pass or invoke anything.
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
from mango_provisioner.deprovision.config import DeprovisionSettings
from mango_provisioner.deprovision.resources import RetiredHarnesses, RetiredRoles
from mango_provisioner.deprovision.steps import Deprovisioner
from mango_provisioner.deprovision.store import DeprovisionStore
from mango_provisioner.errors import StepError, aws_error
from mango_provisioner.handler import ProvisionerStepError, RetryableStepError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

_CLIENT_CONFIG = Config(
    retries={"mode": "standard", "max_attempts": 3}, connect_timeout=5, read_timeout=20
)


@cache
def _deprovisioner() -> Deprovisioner:
    settings = DeprovisionSettings.from_env()
    dynamodb = boto3.client("dynamodb", config=_CLIENT_CONFIG)
    return Deprovisioner(
        settings,
        store=DeprovisionStore(dynamodb, settings.agents_table),
        harnesses=RetiredHarnesses(
            boto3.client("bedrock-agentcore-control", config=_CLIENT_CONFIG), settings
        ),
        roles=RetiredRoles(boto3.client("iam", config=_CLIENT_CONFIG), settings),
        audit=AuditWriter(
            boto3.client("firehose", config=_CLIENT_CONFIG),
            settings.audit_stream,
            dynamodb,
            settings.audit_index_table,
        ),
    )


def _steps(d: Deprovisioner, event: dict[str, Any]) -> dict[str, Callable[[], dict[str, Any]]]:
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
        "load": lambda: d.load(raw, event.get("execution")),
        "delete_endpoints": forward(d.delete_endpoints),
        "delete_harness": forward(d.delete_harness),
        "delete_role": forward(d.delete_role),
        "finish": forward(d.finish),
        "mark_failed": lambda: d.mark_failed(state),
    }


def handle(event: object, deprovisioner: Deprovisioner) -> dict[str, Any]:
    step = event.get("step") if isinstance(event, dict) else None
    steps = _steps(deprovisioner, event) if isinstance(event, dict) else {}
    if not isinstance(step, str) or step not in steps:
        raise ProvisionerStepError(json.dumps({"step": "dispatch", "code": "invalid_step"}))
    try:
        result = steps[step]()
    except (StepError, ClientError, BotoCoreError) as exc:
        error = exc if isinstance(exc, StepError) else aws_error(step, exc)
        logger.warning(
            json.dumps({"event": "deprovisioner.step_failed", "step": step, "code": error.code})
        )
        message = json.dumps({"step": step, "code": error.code})
        if type(error).__name__ == "RetryableError":
            raise RetryableStepError(message) from None
        raise ProvisionerStepError(message) from None
    logger.info(
        json.dumps(
            {
                "event": "deprovisioner.step",
                "step": step,
                "agent": result.get("agent_id"),
                "execution": result.get("execution"),
            }
        )
    )
    return {**result, "last_step": step}


def lambda_handler(event: object, _context: Any) -> dict[str, Any]:
    return handle(event, _deprovisioner())
