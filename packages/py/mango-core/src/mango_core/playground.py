"""The Playground's shared test harness (D91), as mango-api, the provisioner and the
reconciler see it.

Whoever edits an agent tests its draft in one harness of the installation that is not an
agent's: ``Mango_<ns>_a_playground``, run by the role ``Mango-<ns>-agent-playground`` under the
agent permissions boundary. Every invocation brings its own prompt, model, tools and limits;
the harness only fixes the role, whose policy names the models enabled in the catalog and
reads every approved skill version (D91 (12)): mango-api names the tested version's skills in
the invocation, which adds them to the harness's, and this harness has none of its own.

The provisioner keeps it, and writes what it deployed in the ``Settings`` table
(``PLAYGROUND`` / ``HARNESS``): mango-api reads the harness to invoke from there. The
provisioner starts on ``{"playground": "ensure", "release": <label>}``: the stack sends it on
every deployment of a release, and mango-api when the enabled models change.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

from mango_core.agents import MODEL_ID_PATTERN

PLAYGROUND_ID = "playground"
"""Slug of the harness and its role. No agent ever has it: agents made in the app get random
16-character ids, and the release's slugs are a fixed list that does not include it."""

SETTINGS_PK = "PLAYGROUND"
SETTINGS_SK = "HARNESS"

ACTION_ENSURE = "ensure"
_INPUT_KEYS = frozenset({"playground", "release"})
RELEASE_LABEL_PATTERN = r"^v?[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(?:-[A-Za-z0-9.-]{1,40})?$"
"""What starts an execution: the release label of the stack (``v0.1.0-g1a2b3c4``), or the
catalog change that mango-api asks for (``models-<epoch>``)."""
_RELEASE_RE = re.compile(rf"{RELEASE_LABEL_PATTERN}|^models-[0-9]{{10,12}}$")
_MODEL_RE = re.compile(MODEL_ID_PATTERN)
_HARNESS_ARN_RE = re.compile(
    r"^arn:aws:bedrock-agentcore:[a-z0-9-]+:[0-9]{12}:harness/[A-Za-z][A-Za-z0-9_]{0,39}-[A-Za-z0-9]{10}$"
)
_HARNESS_VERSION_RE = re.compile(r"^[1-9][0-9]{0,4}$")
MAX_MODELS = 100


def provision_input(release: str) -> dict[str, str]:
    """Execution input of the provisioner that keeps the harness up to date."""
    if not _RELEASE_RE.fullmatch(release):
        raise ValueError("invalid release label")
    return {"playground": ACTION_ENSURE, "release": release}


def is_provision_input(raw: object) -> bool:
    return isinstance(raw, dict) and raw.get("playground") is not None


def parse_provision_input(raw: object) -> str:
    """The release label of a valid input; ``ValueError`` for anything else."""
    if (
        not isinstance(raw, dict)
        or set(raw) != _INPUT_KEYS
        or raw.get("playground") != ACTION_ENSURE
        or not isinstance(raw.get("release"), str)
        or not _RELEASE_RE.fullmatch(raw["release"])
    ):
        raise ValueError("invalid playground input")
    return str(raw["release"])


@dataclass(frozen=True)
class PlaygroundHarness:
    """What the provisioner deployed last: the harness, its version, the models its role may
    invoke and whether it reads the approved skill versions."""

    harness_arn: str
    harness_version: str
    models: tuple[str, ...]
    updated_at: str
    skills: bool = False
    """The role reads ``skills/`` of the skills bucket (D91 (12)). False on an installation
    without the bucket: a version with skills is then not tested."""

    def item(self) -> dict[str, Any]:
        return {
            "PK": {"S": SETTINGS_PK},
            "SK": {"S": SETTINGS_SK},
            "harness_arn": {"S": self.harness_arn},
            "harness_version": {"S": self.harness_version},
            "models": {"S": json.dumps(sorted(self.models), separators=(",", ":"))},
            "updated_at": {"S": self.updated_at},
            "skills": {"BOOL": self.skills},
        }

    @staticmethod
    def from_item(item: dict[str, Any]) -> PlaygroundHarness:
        """``ValueError`` for an item that does not follow the layout (fail closed)."""
        try:
            arn = item["harness_arn"]["S"]
            version = item["harness_version"]["S"]
            models = json.loads(item["models"]["S"])
            updated_at = item["updated_at"]["S"]
            skills = item.get("skills", {"BOOL": False})["BOOL"]
        except (KeyError, TypeError, ValueError):
            raise ValueError("invalid playground harness item") from None
        if (
            not isinstance(arn, str)
            or not _HARNESS_ARN_RE.fullmatch(arn)
            or not isinstance(version, str)
            or not _HARNESS_VERSION_RE.fullmatch(version)
            or not isinstance(models, list)
            or len(models) > MAX_MODELS
            or not all(isinstance(m, str) and _MODEL_RE.fullmatch(m) for m in models)
            or not isinstance(updated_at, str)
            or not isinstance(skills, bool)
        ):
            raise ValueError("invalid playground harness item")
        return PlaygroundHarness(arn, version, tuple(sorted(set(models))), updated_at, skills)
