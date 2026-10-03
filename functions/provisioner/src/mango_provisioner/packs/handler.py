"""Lambda entry point of the pack provisioner: one invocation per state machine step.

Same contract as the agent provisioner (``mango_provisioner.handler``): the event is
``{"step": <name>, "state": <execution state>, "execution": <name>}``, the execution name
comes from the Step Functions context object, and results and errors carry identifiers and
codes only. It runs with its own role: the agent provisioner cannot touch the Gateway, and
this one cannot touch agent harnesses.
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
from mango_provisioner.errors import StepError, aws_error
from mango_provisioner.handler import ProvisionerStepError, RetryableStepError
from mango_provisioner.packs.config import PackSettings
from mango_provisioner.packs.gateway import PackGateway
from mango_provisioner.packs.identity import IdentityKey
from mango_provisioner.packs.release import PackRelease
from mango_provisioner.packs.role import PackRoles
from mango_provisioner.packs.runtime import PackRuntimes
from mango_provisioner.packs.steps import PackProvisioner
from mango_provisioner.packs.store import PackStore

logger = logging.getLogger()
logger.setLevel(logging.INFO)

_CLIENT_CONFIG = Config(
    retries={"mode": "standard", "max_attempts": 3}, connect_timeout=5, read_timeout=20
)
# The first `tools/list` of a runtime version waits for its microVM to start.
_INVOKE_CONFIG = Config(
    retries={"mode": "standard", "max_attempts": 1}, connect_timeout=5, read_timeout=60
)


@cache
def _provisioner() -> PackProvisioner:
    settings = PackSettings.from_env()
    dynamodb = boto3.client("dynamodb", config=_CLIENT_CONFIG)
    control = boto3.client("bedrock-agentcore-control", config=_CLIENT_CONFIG)
    return PackProvisioner(
        settings,
        store=PackStore(dynamodb, settings.settings_table),
        release=PackRelease(boto3.client("s3", config=_CLIENT_CONFIG), settings),
        roles=PackRoles(boto3.client("iam", config=_CLIENT_CONFIG), settings),
        runtimes=PackRuntimes(
            control, boto3.client("bedrock-agentcore", config=_INVOKE_CONFIG), settings
        ),
        gateway=PackGateway(control, settings),
        identity=IdentityKey(boto3.client("kms", config=_CLIENT_CONFIG), settings),
        logs=boto3.client("logs", config=_CLIENT_CONFIG),
        audit=AuditWriter(
            boto3.client("firehose", config=_CLIENT_CONFIG),
            settings.audit_stream,
            dynamodb,
            settings.audit_index_table,
        ),
    )


def _steps(p: PackProvisioner, event: dict[str, Any]) -> dict[str, Callable[[], dict[str, Any]]]:
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
        "ensure_runtime": forward(p.ensure_runtime),
        "check_runtime": forward(p.check_runtime),
        "verify_tools": forward(p.verify_tools),
        "point_live": forward(p.point_live),
        "check_live": forward(p.check_live),
        "govern_logs": forward(p.govern_logs),
        "ensure_target": forward(p.ensure_target),
        "check_target": forward(p.check_target),
        "ensure_policies": forward(p.ensure_policies),
        "check_policies": forward(p.check_policies),
        "finish": forward(p.finish),
        "remove": forward(p.remove),
        "compensate": lambda: p.compensate(state),
        "mark_failed": lambda: p.mark_failed(state),
    }


def handle(event: object, provisioner: PackProvisioner) -> dict[str, Any]:
    step = event.get("step") if isinstance(event, dict) else None
    steps = _steps(provisioner, event) if isinstance(event, dict) else {}
    if not isinstance(step, str) or step not in steps:
        raise ProvisionerStepError(json.dumps({"step": "dispatch", "code": "invalid_step"}))
    try:
        result = steps[step]()
    except (StepError, ClientError, BotoCoreError) as exc:
        error = exc if isinstance(exc, StepError) else aws_error(step, exc)
        logger.warning(
            json.dumps({"event": "pack_provisioner.step_failed", "step": step, "code": error.code})
        )
        message = json.dumps({"step": step, "code": error.code})
        if type(error).__name__ == "RetryableError":
            raise RetryableStepError(message) from None
        raise ProvisionerStepError(message) from None
    logger.info(
        json.dumps(
            {
                "event": "pack_provisioner.step",
                "step": step,
                "pack": result.get("pack_id"),
                "version": result.get("pack_version"),
                "execution": result.get("execution"),
            }
        )
    )
    return {**result, "last_step": step}


def lambda_handler(event: object, _context: Any) -> dict[str, Any]:
    return handle(event, _provisioner())
