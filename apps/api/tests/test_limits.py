"""Which rate limits every mango-api task shares (D70).

The exceptions of AGENTS.md to «do not reveal whether a user exists» rest on limits per
caller. They are only true while those limits are counted once for all the tasks: these tests
fail if one of them goes back to the memory of each task, or if the application is wired
without the table.
"""

from __future__ import annotations

import ast
import dataclasses
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import boto3
import pytest
from moto import mock_aws

from mango_api import app as app_module
from mango_api.directory import EMAILS_PER_DAY, LookupQuota
from mango_api.limits import HOUR, LIMITS, MINUTE, Limits
from mango_api.probe import RateLimiter
from mango_api.rate_limits import RateLimitStore, SharedRateLimiter
from mango_api.settings import Settings

from .test_admin import _table
from .test_app import _settings

ROOT = Path(__file__).resolve().parents[3]
SOURCES = ROOT / "apps/api/src/mango_api"

SECURITY_EXCEPTION_LIMITS = {
    # AGENTS.md, «Excepciones documentadas»: the number each row promises, per caller.
    "people.reads": (120, MINUTE, "120 lecturas por minuto"),
    "people.invitations": (20, HOUR, "20 invitaciones por hora"),
    "directory.emails": (30, MINUTE, "30 correos por minuto"),
    # The row of the MFA reset names no number: the one of the code is kept.
    "mfa_reset.proposals": (5, HOUR, None),
}
PER_TASK = {"models.refreshes", "session.starts", "session.renewals", "agents.lists"}
"""Limits accepted as one per task. Adding a name here is a decision: record it (D70)."""


def test_the_limits_that_hold_a_security_exception_are_shared() -> None:
    agents_md = (ROOT / "AGENTS.md").read_text()
    for name, (limit, window, promise) in SECURITY_EXCEPTION_LIMITS.items():
        spec = LIMITS[name]
        assert spec.shared, f"{name} holds a security exception: it cannot be per task"
        assert (spec.limit, spec.window_seconds) == (limit, window), name
        if promise:
            assert promise in agents_md, f"AGENTS.md no longer promises «{promise}»"
    # The daily quota of the same exception was already a counter in DynamoDB.
    assert EMAILS_PER_DAY == 200
    assert "200 por día" in agents_md
    assert "update_item" in LookupQuota.consume.__code__.co_names


def test_only_the_accepted_limits_are_per_task() -> None:
    assert {name for name, spec in LIMITS.items() if not spec.shared} == PER_TASK
    assert all(spec.why for spec in LIMITS.values())


def test_with_a_store_the_shared_limits_count_in_it_and_the_rest_in_memory() -> None:
    limits = Limits(RateLimitStore(object(), "table"))  # type: ignore[arg-type]
    for name, spec in LIMITS.items():
        assert isinstance(limits.limiter(name), SharedRateLimiter) is spec.shared, name
    assert limits.shared
    # Without a store (tests) nothing is shared, and nothing says it is.
    local = Limits()
    assert not local.shared
    assert all(isinstance(local.limiter(name), RateLimiter) for name in LIMITS)
    with pytest.raises(KeyError):
        limits.limiter("made.up")


# --- The application as it is built in production ----------------------------------------


@pytest.fixture
def production(monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[Settings, list[Any]]]:
    """``build_services`` with every optional part configured, against moto."""
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    with mock_aws():
        secrets = boto3.client("secretsmanager", region_name="us-east-1")
        secret = secrets.create_secret(Name="invocation", SecretString="k" * 32)
        account = "111111111111"
        settings = dataclasses.replace(
            _settings(),
            invocation_key_secret_arn=secret["ARN"],
            settings_table="settings",
            agents_table="agents",
            admin_probe_function="probe",
            cognito_user_pool_id="us-east-1_Example",
            approvals_table="approvals",
            approval_key_arn=f"arn:aws:kms:us-east-1:{account}:key/approval",
            provisioner_state_machine_arn=f"arn:aws:states:us-east-1:{account}:stateMachine:Mango-test-provisioner",
            deprovisioner_state_machine_arn=f"arn:aws:states:us-east-1:{account}:stateMachine:Mango-test-deprovisioner",
            pack_provisioner_state_machine_arn=f"arn:aws:states:us-east-1:{account}:stateMachine:Mango-test-pack-provisioner",
            app_origin="https://mango.example.com",
            web_sessions_table="web-sessions",
            session_hours=8,
            rate_limits_table="rate-limits",
        )
        built: list[Any] = []

        def factory(s: Settings) -> app_module.Services:
            built.append(app_module.build_services(s))
            return built[0]  # type: ignore[no-any-return]

        _table(boto3.client("dynamodb", region_name="us-east-1"), "rate-limits")
        app_module.create_app(settings, services_factory=factory)
        yield settings, built


def test_production_takes_every_limiter_from_the_registry(
    production: tuple[Settings, list[Any]],
) -> None:
    services: app_module.Services = production[1][0]
    issued = services.limits.issued
    assert services.limits.shared
    # Every limit is in use, and each one is of the kind the registry says.
    assert set(issued) == set(LIMITS)
    for name, spec in LIMITS.items():
        assert isinstance(issued[name], SharedRateLimiter) is spec.shared, name
    for name in SECURITY_EXCEPTION_LIMITS:
        assert isinstance(issued[name], SharedRateLimiter), name


def test_production_routes_hold_the_limiters_of_the_registry(
    production: tuple[Settings, list[Any]],
) -> None:
    services: app_module.Services = production[1][0]
    issued = services.limits.issued
    assert services.people is not None
    assert services.approvals is not None
    assert services.mcp is not None
    assert services.tool_policies is not None
    assert services.group_admin is not None
    assert services.models is not None
    assert services.web_sessions is not None
    assert services.agents is not None
    held = {
        "people.reads": services.people.reads,
        "people.changes": services.people.changes,
        "people.proposals": services.people.proposals,
        "people.invitations": services.people.invitations,
        "approvals.runs": services.approvals.run_limiter,
        "mcp.writes": services.mcp.rate_limiter,
        "tool_policies.proposals": services.tool_policies.rate_limiter,
        "group_admin.proposals": services.group_admin.rate_limiter,
        "models.refreshes": services.models.rate_limiter,
        "session.starts": services.web_sessions.starts,
        "session.renewals": services.web_sessions.renewals,
        "agents.lists": services.agents.list_limiter,
    }
    for name, limiter in held.items():
        assert limiter is issued[name], f"{name} is not the limiter of the registry"


def test_production_does_not_start_without_the_table(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    with mock_aws(), pytest.raises(ValueError, match="rate limits table"):
        app_module.build_services(_settings())


def test_the_environment_must_name_the_table(monkeypatch: pytest.MonkeyPatch) -> None:
    source = (SOURCES / "settings.py").read_text()
    assert 'rate_limits_table=env["RATE_LIMITS_TABLE"]' in source


# --- Nothing else builds a limiter --------------------------------------------------------


def _builds_a_limiter(node: ast.AST) -> bool:
    return (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id in {"RateLimiter", "SharedRateLimiter"}
    )


def test_routes_do_not_build_limiters_outside_the_registry() -> None:
    """A limiter built by hand in ``app.py`` would be per task without the registry knowing.
    The defaults of the dependency containers are in memory on purpose (tests); production
    replaces every one of them (the tests above)."""
    defaults = {"people.py", "web_session.py", "mcp.py", "approvals.py", "admin.py"}
    builders = {
        path.name
        for path in SOURCES.glob("*.py")
        if any(_builds_a_limiter(node) for node in ast.walk(ast.parse(path.read_text())))
    }
    assert builders == defaults | {"limits.py"}
