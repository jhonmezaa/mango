"""Harness log governor: the log groups of the harnesses already published (D16, 2026-11-08).

The runtime log of a harness (``otel-rt-logs``) is content: the owner decided on 2026-11-08 to
treat it as such, like the evals' (D110). The provisioner gives a harness its log groups with the
harness logs key and 7 days when it publishes it (:mod:`mango_provisioner.runtime_logs`). A
harness published before keeps what it had (the shared runtime logs key and 30 days) until it is
published again, and a release only publishes again the agents it ships with other content.

This function is a custom resource of a stack nested in Core. On Create, and on every Update (its
``Release`` property changes with each version), it lists the log groups of the installation's
harnesses (``/aws/bedrock-agentcore/runtimes/harness_Mango_<ns>_a_*``), leaves out the evals
harness's (its own key and 30 days, D110 (3)) and, for each one:

* associates the harness logs key if it has another one, or none;
* sets 7 days of retention if it has another retention, or none;
* gives it Mango's tags and the Core stack's (D76), as the provisioner does.

Nothing is deleted, and what already has the key or the retention is not written again
(2026-11-06, D110 (9)). Events written before keep the key they were written with: CloudWatch Logs
still reads them with the old key, which stays, until the 7 days take them.

It never acts while the stack rolls back. A log group that disappears while it works is skipped.
Any other failure answers FAILED with the operation and the error code, never a name or an AWS
message: CloudFormation rolls the stack back instead of leaving content in a log group that does
not expire. Delete does nothing.
"""

from __future__ import annotations

import logging
import os
import re
import time
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from mango_core.agents import is_agent_id
from mango_provisioner.config import (
    ENDPOINT_DEFAULT,
    ENDPOINT_LIVE,
    HARNESS_LOG_RETENTION_DAYS,
    ConfigError,
    stack_id,
)
from mango_provisioner.errors import StepError, error_code
from mango_provisioner.stack_tags import StackTags, merge
from mango_provisioner.uninstall import respond

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

PHYSICAL_ID = "mango-harness-logs"
EVALS_ID = "evals"
"""The evals harness (D110 (3)): its log groups are never touched here."""
LOG_GROUP_PREFIX = "/aws/bedrock-agentcore/runtimes/"
_NAMESPACE_RE = re.compile(r"^[a-z0-9]{3,8}$")
_ACCOUNT_RE = re.compile(r"^\d{12}$")
_REGION_RE = re.compile(r"^[a-z]{2}(-[a-z]+)+-\d$")
_ROLLING_BACK = re.compile(r"ROLLBACK")
_CLIENT_CONFIG = Config(retries={"mode": "standard", "max_attempts": 8})
_DENIED = frozenset({"AccessDenied", "AccessDeniedException"})
_GONE = "ResourceNotFoundException"
DENIAL_ATTEMPTS = 5
"""Its role and policy are created in the same stack operation, seconds before it runs: a denial
is tried again for about 80 s before it counts (as the stack tagger does, D77). Every write is
idempotent."""
DENIAL_WAIT_SECONDS = 20


@dataclass(frozen=True)
class GovernorSettings:
    namespace: str
    region: str
    account_id: str
    key_arn: str

    @staticmethod
    def from_env(env: Mapping[str, str] | None = None) -> GovernorSettings:
        env = os.environ if env is None else env
        namespace = env.get("MANGO_NAMESPACE", "")
        region = env.get("AWS_REGION", "")
        account_id = env.get("MANGO_ACCOUNT_ID", "")
        key_arn = env.get("HARNESS_LOGS_KEY_ARN", "")
        key_re = rf"^arn:aws:kms:{re.escape(region)}:{re.escape(account_id)}:key/[a-f0-9-]{{36}}$"
        if not (
            _NAMESPACE_RE.fullmatch(namespace)
            and _REGION_RE.fullmatch(region)
            and _ACCOUNT_RE.fullmatch(account_id)
            and re.fullmatch(key_re, key_arn)
        ):
            raise ConfigError("invalid harness log governor settings")
        return GovernorSettings(namespace, region, account_id, key_arn)

    @property
    def prefix(self) -> str:
        """The log groups of the installation's harnesses (``harness_Mango_<ns>_a_``)."""
        return f"{LOG_GROUP_PREFIX}harness_Mango_{self.namespace}_a_"

    def agent_of(self, name: str) -> str | None:
        """The agent of one of its log groups, or ``None`` if the name is not one of them.

        ``harness_Mango_<ns>_a_<agent>-<10 characters>-<endpoint>``, as AgentCore names it
        (``Settings.log_group_names``). The evals harness's are never one of them.
        """
        endpoints = "|".join(re.escape(e) for e in (ENDPOINT_DEFAULT, ENDPOINT_LIVE))
        match = re.fullmatch(
            rf"{re.escape(self.prefix)}([A-Za-z0-9_]+)-[A-Za-z0-9]{{10}}-(?:{endpoints})", name
        )
        if match is None:
            return None
        agent = match.group(1)
        if agent == EVALS_ID or not is_agent_id(agent):
            return None
        return agent

    def arn_of(self, name: str) -> str:
        return f"arn:aws:logs:{self.region}:{self.account_id}:log-group:{name}"


class Governor:
    def __init__(self, settings: GovernorSettings, logs: Any, cloudformation: Any) -> None:
        self._settings = settings
        self._logs = logs
        self._cloudformation = cloudformation

    def stack_status(self, stack: str) -> str:
        stacks = self._cloudformation.describe_stacks(StackName=stack)["Stacks"]
        return str(stacks[0]["StackStatus"]) if stacks else ""

    def _groups(self) -> Iterator[Mapping[str, Any]]:
        pages = self._logs.get_paginator("describe_log_groups").paginate(
            logGroupNamePrefix=self._settings.prefix
        )
        for page in pages:
            yield from page.get("logGroups", [])

    def run(self, core_stack: str) -> dict[str, int]:
        """Govern every log group of the installation's harnesses; counts of what changed."""
        stack_tags = StackTags(self._cloudformation, core_stack).get()
        counts = {"groups": 0, "keys": 0, "retention": 0, "skipped": 0}
        for group in self._groups():
            name = str(group.get("logGroupName", ""))
            agent = self._settings.agent_of(name)
            if agent is None:
                counts["skipped"] += 1
                continue
            try:
                counts["keys"] += self._govern_key(name, group)
                counts["retention"] += self._govern_retention(name, group)
                self._logs.tag_resource(
                    resourceArn=self._settings.arn_of(name),
                    tags=merge(
                        {
                            "mango:namespace": self._settings.namespace,
                            "mango:component": "agent",
                            "mango:agent": agent,
                        },
                        stack_tags,
                    ),
                )
            except ClientError as exc:
                if error_code(exc) != _GONE:
                    raise
                counts["skipped"] += 1
                continue
            counts["groups"] += 1
        return counts

    def _govern_key(self, name: str, group: Mapping[str, Any]) -> int:
        if group.get("kmsKeyId") == self._settings.key_arn:
            return 0
        self._logs.associate_kms_key(logGroupName=name, kmsKeyId=self._settings.key_arn)
        return 1

    def _govern_retention(self, name: str, group: Mapping[str, Any]) -> int:
        if group.get("retentionInDays") == HARNESS_LOG_RETENTION_DAYS:
            return 0
        self._logs.put_retention_policy(
            logGroupName=name, retentionInDays=HARNESS_LOG_RETENTION_DAYS
        )
        return 1


def _what_failed(exc: Exception) -> str:
    """What failed, as a code: never a log group name, an ARN or a message of AWS."""
    if isinstance(exc, StepError):
        return exc.code
    if isinstance(exc, ClientError):
        operation = str(getattr(exc, "operation_name", "") or "-")
        operation = operation if re.fullmatch(r"[A-Za-z]{1,64}", operation) else "-"
        return f"{operation}: {error_code(exc)}"
    return type(exc).__name__


def _run_with_patience(
    governor: Governor, core: str, sleep: Callable[[float], None]
) -> dict[str, int]:
    for attempt in range(1, DENIAL_ATTEMPTS):
        try:
            return governor.run(core)
        except ClientError as exc:
            if error_code(exc) not in _DENIED:
                raise
            logger.info("harness_logs denied (attempt %d): waiting for IAM", attempt)
            sleep(DENIAL_WAIT_SECONDS)
    return governor.run(core)


def handle(
    event: Mapping[str, Any],
    *,
    settings: GovernorSettings,
    governor: Governor,
    answer: Callable[..., None] = respond,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    def reply(status: str, reason: str = "") -> None:
        answer(event, status, reason, physical_id=PHYSICAL_ID)

    if event.get("RequestType") not in ("Create", "Update"):
        reply("SUCCESS")
        return
    try:
        # The custom resource lives in a stack nested in Core: the event's StackId is the nested
        # stack's, so Core's own id comes as a property.
        core = stack_id(
            str(event.get("ResourceProperties", {}).get("CoreStackId", "")),
            region=settings.region,
            account_id=settings.account_id,
            namespace=settings.namespace,
        )
        if _ROLLING_BACK.search(governor.stack_status(core)):
            logger.info("harness_logs skipped: the stack is rolling back")
            reply("SUCCESS")
            return
        counts = _run_with_patience(governor, core, sleep)
    except ConfigError:
        logger.error("harness_logs refused: the request is not for this installation's Core stack")  # noqa: TRY400
        reply(
            "FAILED",
            "The harness log governor only works for the Core stack of its own installation.",
        )
        return
    except Exception as exc:  # noqa: BLE001 - CloudFormation must always get an answer
        what = _what_failed(exc)
        logger.error("harness_logs failed: %s", what)  # noqa: TRY400
        reply("FAILED", _reason(what))
        return
    logger.info(
        "harness_logs governed groups=%d keys=%d retention=%d skipped=%d",
        counts["groups"],
        counts["keys"],
        counts["retention"],
        counts["skipped"],
    )
    reply("SUCCESS")


def _reason(what: str) -> str:
    return (
        f"The log groups of the harnesses could not get their key and retention ({what}), so the "
        "stack rolls back. Fix the cause, a permission or a tag of the stack, and update the "
        "stack again. See the installation runbook, known problems."
    )


def lambda_handler(event: dict[str, Any], _context: Any) -> None:
    settings = GovernorSettings.from_env()
    handle(
        event,
        settings=settings,
        governor=Governor(
            settings,
            boto3.client("logs", config=_CLIENT_CONFIG),
            boto3.client("cloudformation", config=_CLIENT_CONFIG),
        ),
    )
