"""Every version the agent writes to the Canvas goes through the base guardrail before it is
stored (D124 (8)): what it masks (a password) is stored masked, and what it blocks (an AWS key,
a card number, harmful content) is not stored at all.

Why: the harness sends a Canvas document again on every turn of its conversation, and a
password left in it cut every later turn ("No puedo procesar esta solicitud…"), on a customer
install. Masked when it is written, there is nothing to send again. The text is checked as
``OUTPUT`` (it is what the model wrote), with the pinned version mango-api uses for the turns.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from typing import Any

from botocore.exceptions import BotoCoreError, ClientError

from mango_core.textdocs import TextdocError

CHUNK_CHARS = 20_000
"""Text sent in one ``ApplyGuardrail`` call: 20 text units, under the default quota of the
account per second. A longer document is checked piece by piece, cut at line ends."""


class ScreenUnavailableError(Exception):
    """The guardrail could not be asked: nothing is written (fail closed)."""


def _pieces(text: str) -> Iterator[str]:
    start = 0
    while start < len(text):
        end = min(len(text), start + CHUNK_CHARS)
        if end < len(text):
            cut = text.rfind("\n", start, end)
            if cut > start:
                end = cut + 1
        yield text[start:end]
        start = end


def _blocked(answer: Any) -> bool:
    """Whether anything in the assessments was blocked (masking alone is not)."""
    if isinstance(answer, dict):
        if answer.get("action") == "BLOCKED":
            return True
        return any(_blocked(v) for v in answer.values())
    if isinstance(answer, list):
        return any(_blocked(v) for v in answer)
    return False


def make_screen(client: Any, guardrail_id: str, guardrail_version: str) -> Callable[[str], str]:
    """``screen(text)``: the text as it may be stored."""

    def screen(text: str) -> str:
        stored: list[str] = []
        for piece in _pieces(text):
            try:
                answer = client.apply_guardrail(
                    guardrailIdentifier=guardrail_id,
                    guardrailVersion=guardrail_version,
                    source="OUTPUT",
                    content=[{"text": {"text": piece}}],
                )
            except (ClientError, BotoCoreError):
                raise ScreenUnavailableError from None
            if answer.get("action") != "GUARDRAIL_INTERVENED":
                stored.append(piece)
                continue
            outputs = answer.get("outputs") or []
            if _blocked(answer.get("assessments")) or not outputs:
                raise TextdocError(
                    "blocked",
                    "the text has something the base guardrail does not let through (such as "
                    "an access key, a card number or harmful content); write it without that",
                )
            stored.append("".join(str(o.get("text", "")) for o in outputs))
        return "".join(stored)

    return screen
