"""Verified Permissions stand-in that evaluates the real platform policies (Cedar).

It reads ``policies/cedar/platform`` (the files IaC loads into the policy store) and answers
``IsAuthorized`` / ``BatchIsAuthorized`` with cedarpy, validating every request and entity
against the schema like the service does. Tests therefore exercise ``mango_api.authz`` and
the policies together, with no copy of the rules in Python.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import cedarpy

POLICY_DIR = Path(__file__).parents[3] / "policies" / "cedar" / "platform"


def policy_files() -> dict[str, str]:
    return {f.name: f.read_text(encoding="utf-8") for f in sorted(POLICY_DIR.glob("*.cedar"))}


def schema() -> dict[str, Any]:
    loaded: dict[str, Any] = json.loads(
        (POLICY_DIR / "schema.cedarschema.json").read_text(encoding="utf-8")
    )
    return loaded


def _uid(identifier: dict[str, str]) -> dict[str, str]:
    return {"type": identifier["entityType"], "id": identifier["entityId"]}


def _value(value: dict[str, Any]) -> Any:
    """Verified Permissions attribute value -> Cedar JSON."""
    (kind, inner), *rest = value.items()
    if rest:
        raise ValueError("an attribute value has exactly one type")
    if kind in ("string", "boolean", "long"):
        return inner
    if kind == "set":
        return [_value(v) for v in inner]
    if kind == "entityIdentifier":
        return {"__entity": _uid(inner)}
    raise ValueError(f"unsupported attribute type {kind}")


def _entity(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "uid": _uid(item["identifier"]),
        "attrs": {k: _value(v) for k, v in item.get("attributes", {}).items()},
        "parents": [_uid(p) for p in item.get("parents", [])],
    }


class CedarValidationError(Exception):
    """What the service answers when a request does not fit the schema."""


@dataclass
class CedarPolicyStore:
    """The subset of the ``verifiedpermissions`` client that ``Authorizer`` uses."""

    decisions: list[tuple[str, str, str, bool]] = field(default_factory=list)
    """``(principal id, action, resource id, allowed)`` in call order."""
    errors: list[str] = field(default_factory=list)
    fail: bool = False

    def __post_init__(self) -> None:
        self._policies = "\n".join(policy_files().values())
        self._schema = schema()

    def _decide(
        self, principal: Any, action: Any, resource: Any, entities: list[dict[str, Any]]
    ) -> str:
        if self.fail:
            raise RuntimeError("verified permissions unavailable")
        result = cedarpy.is_authorized(
            {
                "principal": _uid(principal),
                "action": {"type": action["actionType"], "id": action["actionId"]},
                "resource": _uid(resource),
                "context": {},
            },
            self._policies,
            [_entity(e) for e in entities],
            self._schema,
        )
        if result.decision is cedarpy.Decision.NoDecision:
            self.errors.extend(result.diagnostics.errors)
            raise CedarValidationError("; ".join(result.diagnostics.errors))
        allowed = bool(result.allowed)
        self.decisions.append(
            (principal["entityId"], action["actionId"], resource["entityId"], allowed)
        )
        return "ALLOW" if allowed else "DENY"

    def is_authorized(
        self,
        *,
        policyStoreId: str,  # noqa: N803 - boto3 parameter names
        principal: Any,
        action: Any,
        resource: Any,
        entities: Any,
    ) -> dict[str, Any]:
        return {"decision": self._decide(principal, action, resource, entities["entityList"])}

    def batch_is_authorized(
        self,
        *,
        policyStoreId: str,  # noqa: N803 - boto3 parameter names
        entities: Any,
        requests: list[Any],
    ) -> dict[str, Any]:
        if not 1 <= len(requests) <= 30:
            raise CedarValidationError("a batch holds 1 to 30 requests")
        return {
            "results": [
                {
                    "request": r,
                    "decision": self._decide(
                        r["principal"], r["action"], r["resource"], entities["entityList"]
                    ),
                }
                for r in requests
            ]
        }

    def allowed(self, action: str) -> list[tuple[str, str, bool]]:
        return [(p, r, ok) for p, a, r, ok in self.decisions if a == action]
