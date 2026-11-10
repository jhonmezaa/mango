"""Decision 44 (D34): the chat's harness carries the turn version of the base guardrail, and
the person's new message is checked with the base version first."""

from types import SimpleNamespace
from typing import Any

from mango_api import turns


def _settings(turn: str) -> Any:
    return SimpleNamespace(guardrail_id="gid", guardrail_version="3", turn_guardrail_version=turn)


def test_the_chat_carries_the_turn_version_when_there_is_one() -> None:
    assert turns.turn_guardrail_version(_settings("4")) == "4"
    # An installation without it keeps the base version (and no check of the message).
    assert turns.turn_guardrail_version(_settings("")) == "3"


class _Guardrail:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def apply_guardrail(self, **request: Any) -> dict[str, Any]:
        self.calls.append(request)
        return {"action": "NONE"}


def test_the_new_message_is_checked_with_the_base_version() -> None:
    bedrock = _Guardrail()
    services: Any = SimpleNamespace(settings=_settings("4"), bedrock=bedrock)
    screen = turns.message_screen(services, "¿Capital de Colombia?")
    assert screen is not None and screen() is None
    assert bedrock.calls[0]["guardrailVersion"] == "3"
    assert bedrock.calls[0]["source"] == "INPUT"


def test_no_check_when_the_harness_carries_the_base_version() -> None:
    services: Any = SimpleNamespace(settings=_settings(""), bedrock=_Guardrail())
    assert turns.message_screen(services, "hola") is None
