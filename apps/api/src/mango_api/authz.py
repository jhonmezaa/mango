"""L1 platform authorization with Amazon Verified Permissions (Cedar). Deny by default."""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from mango_core.identity import UserContext

if TYPE_CHECKING:
    from mypy_boto3_verifiedpermissions import VerifiedPermissionsClient

logger = logging.getLogger(__name__)

USER_TYPE = "Mango::User"
AGENT_TYPE = "Mango::Agent"
TASK_TYPE = "Mango::Task"
KNOWLEDGE_BASE_TYPE = "Mango::KnowledgeBase"
REMOTE_MCP_TYPE = "Mango::RemoteMcp"
PLATFORM = ("Mango::Platform", "mango")
# Limit of requests per BatchIsAuthorized call.
_BATCH_SIZE = 30


@dataclass(frozen=True)
class AgentResource:
    """What Cedar may know about an agent (D33).

    Built by mango-api from the Agents table, never from the request: ``creator`` is who
    created the agent, ``groups`` and ``users`` are the ones of the version being used (the
    published one for ``UseAgent``). Left empty, only administrators match.
    """

    agent_id: str
    creator: str | None = None
    groups: frozenset[str] = frozenset()
    users: frozenset[str] = frozenset()


@dataclass(frozen=True)
class TaskResource:
    """What Cedar knows about a task (D78): its owner, read from the Tasks table."""

    task_id: str
    owner: str


@dataclass(frozen=True)
class KnowledgeBaseResource:
    """What Cedar knows about a knowledge base (D88 (13)): its owner and its groups, read from
    the Knowledge table when asked, never from the request."""

    kb_id: str
    owner: str
    groups: frozenset[str] = frozenset()


@dataclass(frozen=True)
class RemoteMcpResource:
    """What Cedar knows about a remote MCP registration (D98 (18)): its groups, read from
    ``REMOTE#<reg>`` when asked, never from the request."""

    registration_id: str
    groups: frozenset[str] = frozenset()


def _user_ref(user_id: str) -> dict[str, Any]:
    return {"entityIdentifier": {"entityType": USER_TYPE, "entityId": user_id}}


def _agent_entity(agent: AgentResource) -> dict[str, Any]:
    attributes: dict[str, Any] = {
        "groups": {"set": [{"string": g} for g in sorted(agent.groups)]},
        "users": {"set": [_user_ref(u) for u in sorted(agent.users)]},
    }
    if agent.creator:
        attributes["creator"] = _user_ref(agent.creator)
    return {
        "identifier": {"entityType": AGENT_TYPE, "entityId": agent.agent_id},
        "attributes": attributes,
    }


def _task_entity(task: TaskResource) -> dict[str, Any]:
    return {
        "identifier": {"entityType": TASK_TYPE, "entityId": task.task_id},
        "attributes": {"owner": _user_ref(task.owner)},
    }


def _knowledge_entity(kb: KnowledgeBaseResource) -> dict[str, Any]:
    return {
        "identifier": {"entityType": KNOWLEDGE_BASE_TYPE, "entityId": kb.kb_id},
        "attributes": {
            "owner": _user_ref(kb.owner),
            "groups": {"set": [{"string": g} for g in sorted(kb.groups)]},
        },
    }


def _remote_entity(remote: RemoteMcpResource) -> dict[str, Any]:
    return {
        "identifier": {"entityType": REMOTE_MCP_TYPE, "entityId": remote.registration_id},
        "attributes": {"groups": {"set": [{"string": g} for g in sorted(remote.groups)]}},
    }


class Authorizer:
    def __init__(self, client: VerifiedPermissionsClient, policy_store_id: str) -> None:
        self._client = client
        self._store = policy_store_id

    def _user_entity(self, user: UserContext) -> Any:
        attributes: dict[str, Any] = {
            "isAdmin": {"boolean": user.is_admin},
            # From the verified token only (``cognito:groups``), never from the request.
            "groups": {"set": [{"string": g} for g in sorted(user.groups)]},
        }
        if user.role:
            attributes["role"] = {"string": user.role}
        if user.business_unit:
            attributes["businessUnit"] = {"string": user.business_unit}
        return {
            "identifier": {"entityType": USER_TYPE, "entityId": user.user_id},
            "attributes": attributes,
        }

    def is_allowed(
        self,
        user: UserContext,
        action: str,
        resource_type: str,
        resource_id: str,
        agent: AgentResource | None = None,
        *,
        task: TaskResource | None = None,
        knowledge: KnowledgeBaseResource | None = None,
        remote: RemoteMcpResource | None = None,
    ) -> bool:
        """One decision. ``agent`` carries the attributes of an ``Mango::Agent`` resource,
        ``task`` those of a ``Mango::Task``, ``knowledge`` those of a ``Mango::KnowledgeBase``
        and ``remote`` those of a ``Mango::RemoteMcp``."""
        resource: Any = {"identifier": {"entityType": resource_type, "entityId": resource_id}}
        if agent is not None:
            if resource_type != AGENT_TYPE or agent.agent_id != resource_id:
                logger.error("agent attributes do not match the resource; denying")
                return False
            resource = _agent_entity(agent)
        if task is not None:
            if resource_type != TASK_TYPE or task.task_id != resource_id or agent is not None:
                logger.error("task attributes do not match the resource; denying")
                return False
            resource = _task_entity(task)
        if knowledge is not None:
            if (
                resource_type != KNOWLEDGE_BASE_TYPE
                or knowledge.kb_id != resource_id
                or agent is not None
                or task is not None
            ):
                logger.error("knowledge base attributes do not match the resource; denying")
                return False
            resource = _knowledge_entity(knowledge)
        if remote is not None:
            if (
                resource_type != REMOTE_MCP_TYPE
                or remote.registration_id != resource_id
                or agent is not None
                or task is not None
                or knowledge is not None
            ):
                logger.error("remote MCP attributes do not match the resource; denying")
                return False
            resource = _remote_entity(remote)
        try:
            resp = self._client.is_authorized(
                policyStoreId=self._store,
                principal={"entityType": USER_TYPE, "entityId": user.user_id},
                action={"actionType": "Mango::Action", "actionId": action},
                resource={"entityType": resource_type, "entityId": resource_id},
                entities={"entityList": [self._user_entity(user), resource]},
            )
        except Exception:
            logger.exception("authorization check failed; denying")
            return False
        return resp.get("decision") == "ALLOW"

    def allowed_agents(
        self, user: UserContext, action: str, agents: Sequence[AgentResource]
    ) -> frozenset[str]:
        """Ids of the agents ``user`` may ``action`` on; used to filter lists (fail closed)."""
        allowed: set[str] = set()
        principal: Any = {"entityType": USER_TYPE, "entityId": user.user_id}
        cedar_action: Any = {"actionType": "Mango::Action", "actionId": action}
        unique = list({a.agent_id: a for a in agents}.values())
        for start in range(0, len(unique), _BATCH_SIZE):
            batch = unique[start : start + _BATCH_SIZE]
            entities: Any = [self._user_entity(user), *(_agent_entity(a) for a in batch)]
            try:
                resp = self._client.batch_is_authorized(
                    policyStoreId=self._store,
                    entities={"entityList": entities},
                    requests=[
                        {
                            "principal": principal,
                            "action": cedar_action,
                            "resource": {"entityType": AGENT_TYPE, "entityId": a.agent_id},
                        }
                        for a in batch
                    ],
                )
            except Exception:
                logger.exception("batch authorization check failed; denying")
                continue
            for result in resp.get("results", []):
                resource = result.get("request", {}).get("resource", {})
                if result.get("decision") == "ALLOW" and resource.get("entityType") == AGENT_TYPE:
                    allowed.add(str(resource.get("entityId")))
        # Only ids that were asked for count, whatever the response says.
        return frozenset(allowed & {a.agent_id for a in unique})

    def allowed_knowledge_bases(
        self, user: UserContext, action: str, bases: Sequence[KnowledgeBaseResource]
    ) -> frozenset[str]:
        """Ids of the knowledge bases ``user`` may ``action`` on (fail closed), for lists."""
        allowed: set[str] = set()
        principal: Any = {"entityType": USER_TYPE, "entityId": user.user_id}
        cedar_action: Any = {"actionType": "Mango::Action", "actionId": action}
        unique = list({kb.kb_id: kb for kb in bases}.values())
        for start in range(0, len(unique), _BATCH_SIZE):
            batch = unique[start : start + _BATCH_SIZE]
            entities: Any = [self._user_entity(user), *(_knowledge_entity(kb) for kb in batch)]
            try:
                resp = self._client.batch_is_authorized(
                    policyStoreId=self._store,
                    entities={"entityList": entities},
                    requests=[
                        {
                            "principal": principal,
                            "action": cedar_action,
                            "resource": {"entityType": KNOWLEDGE_BASE_TYPE, "entityId": kb.kb_id},
                        }
                        for kb in batch
                    ],
                )
            except Exception:
                logger.exception("batch authorization check failed; denying")
                continue
            for result in resp.get("results", []):
                resource = result.get("request", {}).get("resource", {})
                if (
                    result.get("decision") == "ALLOW"
                    and resource.get("entityType") == KNOWLEDGE_BASE_TYPE
                ):
                    allowed.add(str(resource.get("entityId")))
        # Only ids that were asked for count, whatever the response says.
        return frozenset(allowed & {kb.kb_id for kb in unique})
