"""The agents of the release as the stack seeds them (D34).

Mirrors ``infra/lib/constructs/release-agents.ts``: the definition is
``agents/<id>/agent.json`` plus the model of the installation, stored as canonical JSON, and
the first version is written already approved by the release. ``test_release_agent.py`` pins
the content hash both sides must produce.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from mango_core.agents import AgentDefinition, content_hash, dumps_definition
from mango_core.agents_table import meta_key, publish_items, version_key

REPO = Path(__file__).parents[3]
APPROVER = "release@0.1.0"
SEEDED_AT = "2026-10-01T00:00:00+00:00"
HARNESS = "arn:aws:bedrock-agentcore:us-east-1:111111111111:harness/Mango_test_a_{}-abcdefghij"


def release_definition(agent_id: str, model: str) -> AgentDefinition:
    file = json.loads((REPO / "agents" / agent_id / "agent.json").read_text(encoding="utf-8"))
    assert file["id"] == agent_id
    content = file["definition"]
    return AgentDefinition.model_validate(
        {
            **content,
            "system_prompt": "\n".join(content["system_prompt"]),
            "model": model,
            "allowed_models": [model],
        }
    )


def seed_release_agent(db: Any, table: str, agent_id: str, model: str) -> str:
    """Write the agent and its approved first version; returns the content hash."""
    canonical = dumps_definition(release_definition(agent_id, model))
    digest = content_hash(canonical)
    at, one = {"S": SEEDED_AT}, {"N": "1"}
    db.put_item(
        TableName=table,
        Item={
            **meta_key(agent_id),
            "agent_id": {"S": agent_id},
            "status": {"S": "draft"},
            "version": one,
            "latest_version": one,
            "open_version": one,
            "created_by": {"S": APPROVER},
            "created_at": at,
            "updated_at": at,
        },
    )
    db.put_item(
        TableName=table,
        Item={
            **version_key(agent_id, 1),
            "agent_id": {"S": agent_id},
            "n": one,
            "status": {"S": "approved"},
            "status_index": {"S": "VERSION#approved"},
            "status_at": at,
            "revision": one,
            "definition": {"S": canonical},
            "content_hash": {"S": digest},
            "created_by": {"S": APPROVER},
            "editors": {"SS": [APPROVER]},
            "created_at": at,
            "updated_at": at,
            "submitted_by": {"S": APPROVER},
            "submitted_at": at,
            "approved_by": {"S": APPROVER},
            "approved_at": at,
        },
    )
    return digest


def publish_version(
    db: Any, table: str, agent_id: str, version: int, digest: str, *, now: Any, previous: int | None
) -> None:
    """What the provisioner does once the harness is ready (it alone writes the pointer)."""
    db.transact_write_items(
        TransactItems=publish_items(
            table,
            agent_id=agent_id,
            version=version,
            content_hash=digest,
            previous_version=previous,
            harness_arn=HARNESS.format(agent_id),
            harness_version=str(version),
            now=now,
        )
    )
