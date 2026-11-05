"""The evals harness (D110 (3), (8)), as mango-api, the provisioner, the evaluator and the
reconcilers see it.

``Mango_<ns>_a_evals`` runs the cases of eval suites. It is the only harness of the installation
that captures content (prompts, answers, tool inputs and outputs) in its traces, so that
AgentCore Evaluations can score a case: the provisioner deploys it **without** the redaction of
D16 and with the unified trace destination, which sends its spans, content included, to the log
group of its own runtime (``/aws/bedrock-agentcore/runtimes/<runtime>-<endpoint>``). That log
group has a key of its own that only the evaluator (``Mango-<ns>-EvalJudge``) may decrypt.

Two items of the Settings table say what may run:

* ``EVALS`` / ``HARNESS``: what the provisioner deployed (the same layout as the Playground's,
  ``PlaygroundHarness``). Only the provisioner writes it.
* ``EVALS`` / ``CAPTURE``: whether the canary verified, for that harness version, that its
  content stays in its own log group and never reaches ``aws/spans`` (D110 (8)). The provisioner
  writes ``pending`` whenever it changes the harness; only the evaluator writes ``verified`` or
  ``failed``. mango-api runs no eval unless it reads ``verified`` for the harness version it is
  about to invoke: it fails closed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal

from mango_core.playground import RELEASE_LABEL_PATTERN, PlaygroundHarness

EVALS_ID = "evals"
"""Slug of the harness and its role. No agent ever has it: agents made in the app get random
16-character ids, and the release's slugs are a fixed list that does not include it."""

SETTINGS_PK = "EVALS"
HARNESS_SK = "HARNESS"
CAPTURE_SK = "CAPTURE"

ACTION_ENSURE = "ensure"
_INPUT_KEYS = frozenset({"evals", "release"})
_RELEASE_RE = re.compile(rf"{RELEASE_LABEL_PATTERN}|^models-[0-9]{{10,12}}$")
_HARNESS_VERSION_RE = re.compile(r"^[1-9][0-9]{0,4}$")
_REASON_RE = re.compile(r"^[a-z_]{1,40}$")

UNIFIED_TRACES = {"UNIFIED_TRACES_DESTINATION_ENABLED": "true"}
"""The spans of the evals harness, content included, go to its own runtime log group, never to
the shared ``aws/spans`` (D110 (8)). Whether AgentCore honours it is what the canary checks."""

CaptureStatus = Literal["pending", "verified", "failed"]


def provision_input(release: str) -> dict[str, str]:
    """Execution input of the provisioner that keeps the evals harness up to date."""
    if not _RELEASE_RE.fullmatch(release):
        raise ValueError("invalid release label")
    return {"evals": ACTION_ENSURE, "release": release}


def is_provision_input(raw: object) -> bool:
    return isinstance(raw, dict) and raw.get("evals") is not None


def parse_provision_input(raw: object) -> str:
    """The release label of a valid input; ``ValueError`` for anything else."""
    if (
        not isinstance(raw, dict)
        or set(raw) != _INPUT_KEYS
        or raw.get("evals") != ACTION_ENSURE
        or not isinstance(raw.get("release"), str)
        or not _RELEASE_RE.fullmatch(raw["release"])
    ):
        raise ValueError("invalid evals input")
    return str(raw["release"])


_RUNTIME_ID_RE = re.compile(r"^harness_Mango_[a-z0-9]{3,8}_a_evals-[A-Za-z0-9]{10}$")


@dataclass(frozen=True)
class EvalsHarness:
    """``EVALS`` / ``HARNESS``: the Playground's layout, plus the runtime whose log groups hold
    the content (the evaluator reads only those)."""

    deployed: PlaygroundHarness
    runtime_id: str

    def item(self) -> dict[str, Any]:
        return {
            **self.deployed.item(),
            "PK": {"S": SETTINGS_PK},
            "SK": {"S": HARNESS_SK},
            "runtime_id": {"S": self.runtime_id},
        }

    @staticmethod
    def from_item(item: dict[str, Any]) -> EvalsHarness:
        """``ValueError`` for an item that does not follow the layout (fail closed)."""
        deployed = PlaygroundHarness.from_item(item)
        runtime_id = item.get("runtime_id", {}).get("S")
        if not isinstance(runtime_id, str) or not _RUNTIME_ID_RE.fullmatch(runtime_id):
            raise ValueError("invalid evals harness item")
        if ":harness/Mango_" not in deployed.harness_arn or "_a_evals-" not in deployed.harness_arn:
            raise ValueError("invalid evals harness item")
        return EvalsHarness(deployed, runtime_id)


@dataclass(frozen=True)
class Capture:
    """What the canary found for one version of the evals harness."""

    status: CaptureStatus
    harness_version: str
    checked_at: str
    reason: str | None = None
    """A fixed code when ``failed`` (``spans_in_shared_log``, ``no_content``…); never content."""

    def verified_for(self, harness_version: str) -> bool:
        return self.status == "verified" and self.harness_version == harness_version

    def item(self) -> dict[str, Any]:
        item: dict[str, Any] = {
            "PK": {"S": SETTINGS_PK},
            "SK": {"S": CAPTURE_SK},
            "status": {"S": self.status},
            "harness_version": {"S": self.harness_version},
            "checked_at": {"S": self.checked_at},
        }
        if self.reason:
            item["reason"] = {"S": self.reason}
        return item

    @staticmethod
    def from_item(item: dict[str, Any]) -> Capture:
        """``ValueError`` for an item that does not follow the layout (fail closed)."""
        try:
            status = item["status"]["S"]
            version = item["harness_version"]["S"]
            checked_at = item["checked_at"]["S"]
            reason = item.get("reason", {}).get("S")
        except (KeyError, TypeError, AttributeError):
            raise ValueError("invalid capture item") from None
        if (
            status not in ("pending", "verified", "failed")
            or not isinstance(version, str)
            or not _HARNESS_VERSION_RE.fullmatch(version)
            or not isinstance(checked_at, str)
            or (
                reason is not None
                and not (isinstance(reason, str) and _REASON_RE.fullmatch(reason))
            )
        ):
            raise ValueError("invalid capture item")
        return Capture(status, version, checked_at, reason)
