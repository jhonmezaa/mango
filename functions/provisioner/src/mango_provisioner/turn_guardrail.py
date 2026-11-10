"""Custom resource that pins the turn version of the base guardrail (D34, decision 44).

The chat invokes the harness with the whole conversation, and the base guardrail's input
filter against prompt attacks (``PROMPT_ATTACK``, strength ``HIGH``) evaluates all of it: from
the second question on, harmless conversations were blocked (confidence ``LOW``). The person's
new message is still checked with the base version (``ApplyGuardrail`` in ``mango-api``); the
harness gets this **turn version**, the base policy without the input ``PROMPT_ATTACK`` filter.

It is a version of the same guardrail, not another guardrail: the agent roles already published
may apply the base guardrail's ARN, which covers all its versions, so nothing is published again.
A version is a snapshot of the guardrail's ``DRAFT``, so this resource:

1. puts the turn policy in the ``DRAFT``;
2. creates the version;
3. **always** puts the base policy back in the ``DRAFT`` (``finally``), and fails unless the
   ``DRAFT`` then equals the base policy and the new version equals the turn policy.

Every call ends with the ``DRAFT`` back on the base policy, also the call CloudFormation makes
when it rolls an update back (an ``Update`` with the previous properties). ``Delete`` changes
nothing: a version goes with its guardrail, and the previous one stays like the base versions
(published harnesses may keep it).

CloudFormation invokes it synchronously with::

    {"RequestType": "Create" | "Update" | "Delete",
     "ResourceProperties": {"GuardrailId": "<id>", "BaseVersion": "3",
                            "Base": "<policy JSON>", "Turn": "<policy JSON>",
                            "Description": "Turn guardrail (policy …)"}, …}

and it answers at the pre-signed ``ResponseURL``. The turn policy may only be the base policy
without its ``PROMPT_ATTACK`` filter: anything else is refused, so the role can do nothing more.
"""

from __future__ import annotations

import json
import logging
import re
import time
import urllib.request
from collections.abc import Callable, Mapping
from typing import Any, Final

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

PROMPT_ATTACK: Final = "PROMPT_ATTACK"
_GUARDRAIL_ID = re.compile(r"[a-z0-9]{1,64}")
_VERSION = re.compile(r"[1-9][0-9]{0,7}")
_POLICY_KEYS: Final = frozenset(
    {
        "name",
        "description",
        "blockedInputMessaging",
        "blockedOutputsMessaging",
        "contentPolicyConfig",
        "sensitiveInformationPolicyConfig",
    }
)
_WAIT_SECONDS: Final = 120
_OTHER_POLICIES: Final = (
    "topicPolicy",
    "wordPolicy",
    "contextualGroundingPolicy",
    "automatedReasoningPolicy",
)


class InvalidRequestError(ValueError):
    """The properties of the resource are not what this function does."""


def _filters(policy: Mapping[str, Any]) -> list[dict[str, Any]]:
    return list(policy.get("contentPolicyConfig", {}).get("filtersConfig", []))


def validate(properties: Mapping[str, Any]) -> tuple[str, dict[str, Any], dict[str, Any], str]:
    """The guardrail, the base and turn policies and the version description."""
    guardrail = str(properties.get("GuardrailId", ""))
    if not _GUARDRAIL_ID.fullmatch(guardrail):
        raise InvalidRequestError("GuardrailId")
    if not _VERSION.fullmatch(str(properties.get("BaseVersion", ""))):
        raise InvalidRequestError("BaseVersion")
    try:
        base = json.loads(str(properties.get("Base", "")))
        turn = json.loads(str(properties.get("Turn", "")))
    except json.JSONDecodeError:
        raise InvalidRequestError("Base and Turn are JSON policies") from None
    if not isinstance(base, dict) or not isinstance(turn, dict) or set(base) != _POLICY_KEYS:
        raise InvalidRequestError("Base and Turn are guardrail policies")
    expected = {
        **base,
        "contentPolicyConfig": {
            "filtersConfig": [f for f in _filters(base) if f.get("type") != PROMPT_ATTACK]
        },
    }
    if turn != expected or len(_filters(turn)) == len(_filters(base)):
        raise InvalidRequestError("Turn is the base policy without its PROMPT_ATTACK filter")
    description = str(properties.get("Description", ""))[:200]
    return guardrail, base, turn, description


def normalized(policy: Mapping[str, Any]) -> dict[str, Any]:
    """A policy, from its configuration (``Base``/``Turn``) or from ``GetGuardrail``, in one shape:
    the defaults the API fills in (each direction takes ``action``; evaluation enabled) made
    explicit, and the order of filters and entities ignored."""
    content = policy.get("contentPolicyConfig") or policy.get("contentPolicy") or {}
    sensitive = (
        policy.get("sensitiveInformationPolicyConfig")
        or policy.get("sensitiveInformationPolicy")
        or {}
    )
    filters = sorted(
        (str(f["type"]), str(f.get("inputStrength")), str(f.get("outputStrength")))
        for f in content.get("filtersConfig", content.get("filters", []))
    )
    entities = sorted(
        (
            str(e["type"]),
            str(e["action"]),
            str(e.get("inputAction") or e["action"]),
            str(e.get("outputAction") or e["action"]),
            bool(e.get("inputEnabled", True)),
            bool(e.get("outputEnabled", True)),
        )
        for e in sensitive.get("piiEntitiesConfig", sensitive.get("piiEntities", []))
    )
    regexes = sensitive.get("regexesConfig", sensitive.get("regexes", []))
    others = sorted(
        key
        for key in (
            "topicPolicy",
            "wordPolicy",
            "contextualGroundingPolicy",
            "automatedReasoningPolicy",
        )
        if policy.get(key) or policy.get(f"{key}Config")
    )
    return {
        "name": policy.get("name"),
        "description": policy.get("description"),
        "blockedInputMessaging": policy.get("blockedInputMessaging"),
        "blockedOutputsMessaging": policy.get("blockedOutputsMessaging"),
        "filters": filters,
        "entities": entities,
        "regexes": len(regexes),
        "others": others,
    }


class TurnVersion:
    """The three steps on one guardrail, waiting for it to be ready between them."""

    def __init__(
        self, client: Any, guardrail: str, sleep: Callable[[float], None] = time.sleep
    ) -> None:
        self._client = client
        self._guardrail = guardrail
        self._sleep = sleep

    def _ready(self, version: str | None = None) -> dict[str, Any]:
        args: dict[str, Any] = {"guardrailIdentifier": self._guardrail}
        if version is not None:
            args["guardrailVersion"] = version
        for _ in range(_WAIT_SECONDS):
            current: dict[str, Any] = self._client.get_guardrail(**args)
            if current.get("status") == "READY":
                return current
            if current.get("status") == "FAILED":
                raise RuntimeError("the guardrail failed")
            self._sleep(1)
        raise RuntimeError("the guardrail is not ready")

    def put(self, policy: Mapping[str, Any]) -> None:
        """Put ``policy`` in the ``DRAFT``, retried once: this one must not be left half done."""
        for attempt in range(2):
            try:
                self._client.update_guardrail(guardrailIdentifier=self._guardrail, **policy)
                self._ready()
            except Exception:
                if attempt:
                    raise
                self._sleep(2)
            else:
                return

    def create(self, base: Mapping[str, Any], turn: Mapping[str, Any], description: str) -> str:
        """The new turn version; the ``DRAFT`` is the base policy again on every way out."""
        try:
            self.put(turn)
            version = str(
                self._client.create_guardrail_version(
                    guardrailIdentifier=self._guardrail, description=description
                )["version"]
            )
            made = self._ready(version)
        finally:
            self.put(base)
        if normalized(self._ready()) != normalized(base):
            raise RuntimeError("the DRAFT is not the base policy")
        # A version answers with its own description, not the guardrail's.
        if {**normalized(made), "description": None} != {**normalized(turn), "description": None}:
            raise RuntimeError("the turn version is not the turn policy")
        return version


def handle(
    event: Mapping[str, Any], client_factory: Callable[[], Any] | None = None
) -> tuple[str, str, dict[str, str], str]:
    """Status, reason, data and physical id of the answer to CloudFormation."""
    physical = str(event.get("PhysicalResourceId") or "mango-turn-guardrail")
    if event.get("RequestType") == "Delete":
        return "SUCCESS", "nothing to delete", {}, physical
    try:
        guardrail, base, turn, description = validate(event.get("ResourceProperties") or {})
    except InvalidRequestError as exc:
        return "FAILED", str(exc), {}, physical
    client = (client_factory or (lambda: boto3.client("bedrock")))()
    try:
        version = TurnVersion(client, guardrail).create(base, turn, description)
    except Exception as exc:  # noqa: BLE001 - every failure is answered to CloudFormation
        logger.warning("turn guardrail version failed", extra={"error": type(exc).__name__})
        return "FAILED", f"could not make the turn version ({type(exc).__name__})", {}, physical
    logger.info("turn guardrail version created", extra={"version": version})
    return "SUCCESS", "", {"Version": version}, f"{guardrail}:{version}"


def respond(
    event: Mapping[str, Any], status: str, reason: str, data: Mapping[str, str], physical: str
) -> None:
    """Answer CloudFormation at the pre-signed URL of the request."""
    body = json.dumps(
        {
            "Status": status,
            "Reason": reason[:400] or "See the function's log group",
            "PhysicalResourceId": physical,
            "StackId": event["StackId"],
            "RequestId": event["RequestId"],
            "LogicalResourceId": event["LogicalResourceId"],
            "Data": dict(data),
        }
    ).encode()
    url = str(event["ResponseURL"])
    if not url.startswith("https://"):
        raise ValueError("ResponseURL")
    request = urllib.request.Request(  # noqa: S310 - https only, checked above
        url, data=body, method="PUT", headers={"Content-Type": "", "Content-Length": str(len(body))}
    )
    with urllib.request.urlopen(request, timeout=30):  # noqa: S310
        pass


def lambda_handler(event: dict[str, Any], _context: Any) -> None:
    try:
        status, reason, data, physical = handle(event)
    except Exception as exc:  # noqa: BLE001 - CloudFormation must get an answer, never wait
        status, reason, data = "FAILED", f"unexpected error ({type(exc).__name__})", {}
        physical = str(event.get("PhysicalResourceId") or "mango-turn-guardrail")
    respond(event, status, reason, data, physical)
