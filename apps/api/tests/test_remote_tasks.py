"""A task whose remote MCP tool needs its owner's consent (D98 (20)): the run fails with
``remote_consent_required`` and the owner's Bandeja gets ``remote_connect``, never a URL."""

from __future__ import annotations

import dataclasses
import json

from mango_api.task_worker import REMOTE_CONSENT_REQUIRED

from .test_remote_tools import CONSENT, GATEWAY_PROJECTS, REG, _stream
from .test_tasks import (
    AGENT,
    Env,
    RecordingInbox,
    _scheduled,
    env,  # noqa: F401 - fixture
    served,
)

ALLOWED = f"@mango/{GATEWAY_PROJECTS}"


def _with_remote(env: Env, groups: tuple[str, ...]) -> None:  # noqa: F811
    base = served(AGENT, groups=["finops-central"])
    env.published.agents[AGENT] = dataclasses.replace(
        base,
        allowed_tools=(*base.allowed_tools, ALLOWED),
        gateway_tools=(*base.gateway_tools, GATEWAY_PROJECTS),
        remote_tools=((REG, ALLOWED, GATEWAY_PROJECTS),),
        remote_groups=((REG, groups),),
    )


def test_a_run_that_needs_consent_fails_and_asks_its_owner_to_connect(env: Env) -> None:  # noqa: F811
    inbox = RecordingInbox()
    assert env.services.task_runs is not None
    env.services.task_runs.inbox = inbox
    _with_remote(env, ("finops-central",))
    env.agentcore.stream = _stream(CONSENT, "error")
    task = env.created()
    env.deliver(_scheduled(task["task_id"]))
    (notice,) = inbox.notices
    assert (notice["ok"], notice["reason"], notice["remote_connect"]) == (
        False,
        REMOTE_CONSENT_REQUIRED,
        REG,
    )
    assert "bedrock-agentcore" not in json.dumps(notice)
    run = env.get("creator", task["task_id"]).json()["runs"][0]
    assert (run["status"], run["reason"]) == ("failed", REMOTE_CONSENT_REQUIRED)
    assert ALLOWED in env.agentcore.requests[-1]["allowedTools"]


def test_a_run_of_an_owner_outside_the_registration_has_no_remote_tools(env: Env) -> None:  # noqa: F811
    inbox = RecordingInbox()
    assert env.services.task_runs is not None
    env.services.task_runs.inbox = inbox
    _with_remote(env, ("hr",))
    task = env.created()
    env.deliver(_scheduled(task["task_id"]))
    assert ALLOWED not in env.agentcore.requests[-1]["allowedTools"]
    (notice,) = inbox.notices
    assert (notice["ok"], notice.get("remote_connect")) == (True, None)
