"""The gate of the review (D26, TM-EV3): a required suite that has not passed on exactly the
content of a version blocks its approval, in the server; submitting runs its suites."""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from mango_api.evals import EvalGate
from mango_api.evals_store import Suite
from mango_core import task_runs
from mango_core.evals import EvalCase

from .test_agents_api import _create, _h, _submit, env  # noqa: F401
from .test_evals_runner import CASES, Lab, lab  # noqa: F401

# --- The gate of the review (D26) ---------------------------------------------------------


def _gate(lab: Lab) -> None:  # noqa: F811
    lab.env.deps.eval_gate = EvalGate(lab.deps)


def _approve(lab: Lab, review: dict[str, Any]) -> Any:  # noqa: F811
    url = f"/api/agents/{review['agent_id']}/versions/{review['version']}/approve"
    return lab.env.client.post(
        url, headers=_h("admin"), json={"content_hash": review["content_hash"]}
    )


def test_a_required_suite_that_never_ran_blocks_the_approval(lab: Lab) -> None:  # noqa: F811
    _gate(lab)
    draft = _create(lab.env)
    lab.suite(CASES[:1], draft["agent_id"])
    review = _submit(lab.env, draft)
    lab.queue.sent.clear()  # the run the submission started is not delivered
    response = _approve(lab, review)

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "evals_not_passing"
    assert response.json()["suites"] == [{"suite_id": "a" * 32, "state": "running"}]
    rejected = [d for e, _u, d in lab.env.audit.events if e == "agent.version.approved"]
    assert rejected[-1]["outcome"] == "rejected"


def test_submitting_runs_the_required_suites_and_a_pass_opens_the_approval(lab: Lab) -> None:  # noqa: F811
    _gate(lab)
    draft = _create(lab.env)
    suite = lab.suite(CASES[:1], draft["agent_id"])
    review = _submit(lab.env, draft)
    # The submission started the run, on exactly the frozen content.
    (body, _) = lab.queue.sent[0]
    step = task_runs.parse_message(body)
    assert isinstance(step, task_runs.EvalStep) and step.suite_id == suite.suite_id
    lab.drain()
    fresh = lab.store.find_suite(suite.suite_id)
    assert fresh is not None and fresh.last_run is not None
    assert fresh.last_run.passed and fresh.last_run.content_hash == review["content_hash"]

    assert _approve(lab, review).status_code == 200


def test_a_failed_run_or_a_pass_on_another_version_blocks_it(lab: Lab) -> None:  # noqa: F811
    _gate(lab)
    draft = _create(lab.env)
    cases = [EvalCase(question="q", criterion="contains", value="no está en la respuesta")]
    lab.suite(cases, draft["agent_id"])
    review = _submit(lab.env, draft)
    lab.drain()
    response = _approve(lab, review)
    assert response.json()["suites"] == [{"suite_id": "a" * 32, "state": "failed"}]


def test_the_gate_fails_closed_when_the_suites_cannot_be_read(lab: Lab) -> None:  # noqa: F811
    _gate(lab)
    review = _submit(lab.env, _create(lab.env))
    lab.env.db.delete_table(TableName="evals")
    response = _approve(lab, review)
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "evals_unavailable"


def test_an_agent_without_required_suites_is_approved_as_before(lab: Lab) -> None:  # noqa: F811
    _gate(lab)
    draft = _create(lab.env)
    optional = lab.suite(CASES[:1], draft["agent_id"])
    lab.store.update(optional, replace_suite(optional, required=False))
    review = _submit(lab.env, draft)
    assert _approve(lab, review).status_code == 200


def replace_suite(suite: Suite, **changes: Any) -> Suite:
    return replace(suite, **changes)
