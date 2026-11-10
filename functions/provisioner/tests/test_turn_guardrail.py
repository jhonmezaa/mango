import copy
import json
from typing import Any

import pytest

from mango_provisioner import turn_guardrail as tg

FILTERS = [
    {"type": "PROMPT_ATTACK", "inputStrength": "HIGH", "outputStrength": "NONE"},
    {"type": "HATE", "inputStrength": "MEDIUM", "outputStrength": "MEDIUM"},
]
BASE: dict[str, Any] = {
    "name": "Mango-poc-base",
    "description": "Mango base guardrail",
    "blockedInputMessaging": "No puedo procesar esta solicitud.",
    "blockedOutputsMessaging": "No puedo mostrar esta respuesta.",
    "contentPolicyConfig": {"filtersConfig": FILTERS},
    "sensitiveInformationPolicyConfig": {
        "piiEntitiesConfig": [
            {"type": "AWS_ACCESS_KEY", "action": "BLOCK"},
            {
                "type": "PASSWORD",
                "action": "ANONYMIZE",
                "inputAction": "NONE",
                "inputEnabled": False,
                "outputAction": "ANONYMIZE",
                "outputEnabled": True,
            },
        ]
    },
}
TURN: dict[str, Any] = {**BASE, "contentPolicyConfig": {"filtersConfig": FILTERS[1:]}}


def _as_api(policy: dict[str, Any], status: str = "READY") -> dict[str, Any]:
    """What GetGuardrail answers for ``policy``: other key names and the defaults filled in."""
    return {
        "name": policy["name"],
        "description": policy["description"],
        "blockedInputMessaging": policy["blockedInputMessaging"],
        "blockedOutputsMessaging": policy["blockedOutputsMessaging"],
        "contentPolicy": {
            "filters": list(reversed(policy["contentPolicyConfig"]["filtersConfig"]))
        },
        "sensitiveInformationPolicy": {
            "piiEntities": policy["sensitiveInformationPolicyConfig"]["piiEntitiesConfig"]
        },
        "status": status,
    }


class FakeBedrock:
    def __init__(self, fail_version: bool = False) -> None:
        self.draft: dict[str, Any] = copy.deepcopy(BASE)
        self.versions: dict[str, dict[str, Any]] = {}
        self.calls: list[str] = []
        self.fail_version = fail_version

    def update_guardrail(self, guardrailIdentifier: str, **policy: Any) -> None:  # noqa: N803
        assert guardrailIdentifier == "abc123"
        self.calls.append("update")
        self.draft = copy.deepcopy(policy)

    def create_guardrail_version(
        self,
        guardrailIdentifier: str,  # noqa: N803
        description: str,
    ) -> dict[str, str]:
        self.calls.append("version")
        if self.fail_version:
            raise RuntimeError("boom")
        number = str(len(self.versions) + 4)
        self.versions[number] = {**copy.deepcopy(self.draft), "description": description}
        return {"version": number}

    def get_guardrail(
        self,
        guardrailIdentifier: str,  # noqa: N803
        guardrailVersion: str = "DRAFT",  # noqa: N803
    ) -> dict[str, Any]:
        policy = self.draft if guardrailVersion == "DRAFT" else self.versions[guardrailVersion]
        return _as_api(policy)


def _event(request: str = "Create", **overrides: Any) -> dict[str, Any]:
    properties = {
        "GuardrailId": "abc123",
        "BaseVersion": "3",
        "Base": json.dumps(BASE),
        "Turn": json.dumps(TURN),
        "Description": "Turn guardrail (policy 0123456789ab, base v3)",
        **overrides,
    }
    return {"RequestType": request, "ResourceProperties": properties}


def test_makes_the_turn_version_and_leaves_the_draft_exactly_on_the_base_policy() -> None:
    fake = FakeBedrock()
    status, _, data, physical = tg.handle(_event(), lambda: fake)
    assert (status, data, physical) == ("SUCCESS", {"Version": "4"}, "abc123:4")
    assert fake.calls == ["update", "version", "update"]
    # The DRAFT is the base policy again, exactly what the template says.
    assert fake.draft == BASE
    # The version is the turn policy: no PROMPT_ATTACK, everything else as the base.
    version = fake.versions["4"]
    assert [f["type"] for f in version["contentPolicyConfig"]["filtersConfig"]] == ["HATE"]
    assert version["sensitiveInformationPolicyConfig"] == BASE["sensitiveInformationPolicyConfig"]


def test_an_update_is_a_new_version_too_also_the_one_of_a_rollback() -> None:
    # CloudFormation rolls an update back with an Update of the previous properties: it ends,
    # like any call, with the DRAFT on the (previous) base policy.
    fake = FakeBedrock()
    tg.handle(_event("Update"), lambda: fake)
    status, _, data, _ = tg.handle(_event("Update"), lambda: fake)
    assert status == "SUCCESS" and data == {"Version": "5"}
    assert fake.draft == BASE


def test_a_failure_still_puts_the_base_policy_back_in_the_draft() -> None:
    fake = FakeBedrock(fail_version=True)
    status, reason, data, _ = tg.handle(_event(), lambda: fake)
    assert status == "FAILED" and data == {} and "RuntimeError" in reason
    assert fake.calls == ["update", "version", "update"]
    assert fake.draft == BASE


def test_fails_when_the_draft_does_not_end_on_the_base_policy() -> None:
    class Drifting(FakeBedrock):
        def update_guardrail(self, guardrailIdentifier: str, **policy: Any) -> None:  # noqa: N803
            super().update_guardrail(guardrailIdentifier, **policy)
            self.draft = copy.deepcopy(TURN)  # never goes back to the base policy

    status, _, _, _ = tg.handle(_event(), Drifting)
    assert status == "FAILED"


def test_delete_changes_nothing() -> None:
    fake = FakeBedrock()
    event = {**_event("Delete"), "PhysicalResourceId": "abc123:4"}
    assert tg.handle(event, lambda: fake) == ("SUCCESS", "nothing to delete", {}, "abc123:4")
    assert fake.calls == []


@pytest.mark.parametrize(
    "overrides",
    [
        # The turn policy may only drop the PROMPT_ATTACK filter.
        {"Turn": json.dumps({**TURN, "blockedInputMessaging": "otro"})},
        {"Turn": json.dumps(BASE)},
        {
            "Turn": json.dumps(
                {**TURN, "sensitiveInformationPolicyConfig": {"piiEntitiesConfig": []}}
            )
        },
        {"Turn": json.dumps({**TURN, "contentPolicyConfig": {"filtersConfig": []}})},
        {"Base": json.dumps({**BASE, "topicPolicyConfig": {}})},
        {"GuardrailId": "arn:aws:bedrock:x"},
        {"BaseVersion": "DRAFT"},
        {"Base": "not json"},
    ],
)
def test_refuses_all_but_the_base_policy_without_prompt_attack(
    overrides: dict[str, str],
) -> None:
    fake = FakeBedrock()
    status, _, _, _ = tg.handle(_event(**overrides), lambda: fake)
    assert status == "FAILED"
    assert fake.calls == []


def test_normalized_reads_the_configuration_and_the_api_alike() -> None:
    assert tg.normalized(_as_api(BASE)) == tg.normalized(BASE)
    assert tg.normalized(_as_api(TURN)) != tg.normalized(BASE)
    # A default the API fills in is not a difference.
    explicit = copy.deepcopy(BASE)
    explicit["sensitiveInformationPolicyConfig"]["piiEntitiesConfig"][0].update(
        {"inputAction": "BLOCK", "outputAction": "BLOCK", "inputEnabled": True}
    )
    assert tg.normalized(explicit) == tg.normalized(BASE)
