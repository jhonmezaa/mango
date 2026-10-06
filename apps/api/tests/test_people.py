"""Settings > People (D60, ``people-management-threat-model.md``) against moto DynamoDB and a
fake directory."""

from __future__ import annotations

import dataclasses
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError
from botocore.stub import Stubber
from fastapi.testclient import TestClient
from moto import mock_aws

from mango_api import app as app_module
from mango_api import people as people_module
from mango_api.budget import BudgetService
from mango_api.groups import GroupRegistry
from mango_api.people import (
    CognitoPeople,
    DirectoryCache,
    DirectoryUnavailableError,
    MemberChangeStore,
    PeopleDeps,
    PoolUser,
    UserExistsError,
    invitation_domain,
    parse_domains,
)
from mango_api.probe import RateLimiter
from mango_api.settings_store import BudgetLimits, SettingsStore

from .test_admin import (
    TOKENS,
    CedarLikeAuthorizer,
    FakeProbe,
    FakeVerifier,
    RecordingAudit,
    _code,
    _h,
    _table,
)
from .test_app import (
    HOST,
    FakeAgentCore,
    FakeBedrock,
    FakeConversations,
    FakeModelCatalog,
    FakePublished,
    _settings,
)

BASE = "/api/admin/people"
NOW = datetime(2026, 10, 3, 12, tzinfo=UTC)
TOKENS.setdefault(
    "people-admin3", {"sub": "admin-3b", "mango_role": "finops-central", "mango_admin": "true"}
)


def _user(sub: str, status: str = "CONFIRMED", enabled: bool = True, days: int = 10) -> PoolUser:
    return PoolUser(
        username=f"name-{sub}",
        sub=sub,
        email=f"{sub}@example.com",
        status=status,
        enabled=enabled,
        created_at=NOW - timedelta(days=days),
    )


@dataclass
class FakePeople:
    """The directory in memory, with the interface of ``CognitoPeople``."""

    by_sub: dict[str, PoolUser] = field(default_factory=dict)
    memberships: dict[str, set[str]] = field(default_factory=dict)
    signed_out: list[str] = field(default_factory=list)
    invited: list[str] = field(default_factory=list)
    fail_writes: bool = False
    deleted: set[str] = field(default_factory=set)
    """Usernames deleted from the pool that a list read before still carries."""
    listed: int | None = None
    """How many users one read of the pool returns; ``None`` is all of them."""
    fail_reads: bool = False
    lookups: list[str] = field(default_factory=list)

    def put(self, user: PoolUser, *groups: str) -> None:
        self.by_sub[user.sub] = user
        self.memberships[user.username] = set(groups)

    def _named(self, username: str) -> PoolUser:
        return next(u for u in self.by_sub.values() if u.username == username)

    def users(self, limit: int = 2000) -> tuple[list[PoolUser], bool]:
        if self.fail_reads:
            raise DirectoryUnavailableError
        everyone = list(self.by_sub.values())
        if self.listed is not None:
            return everyone[: self.listed], len(everyone) > self.listed
        return everyone[:limit], False

    def members(self, group: str) -> list[PoolUser]:
        return [u for u in self.by_sub.values() if group in self.memberships[u.username]]

    def by_id(self, user_id: str) -> PoolUser | None:
        self.lookups.append(user_id)
        return self.by_sub.get(user_id)

    def exists(self, email: str) -> bool:
        return any(u.email == email for u in self.by_sub.values())

    def mfa_registered(self, username: str) -> bool | None:
        if username in self.deleted:
            return None
        return self._named(username).status == "CONFIRMED"

    def groups_of(self, username: str) -> frozenset[str]:
        return frozenset(self.memberships[username])

    def _write(self) -> None:
        if self.fail_writes:
            raise DirectoryUnavailableError

    def add_to_group(self, username: str, group: str) -> None:
        self._write()
        self.memberships[username].add(group)

    def remove_from_group(self, username: str, group: str) -> None:
        self._write()
        self.memberships[username].discard(group)

    def _set_enabled(self, username: str, enabled: bool) -> None:
        self._write()
        user = self._named(username)
        self.by_sub[user.sub] = dataclasses.replace(user, enabled=enabled)

    def disable(self, username: str) -> None:
        self._set_enabled(username, False)

    def enable(self, username: str) -> None:
        self._set_enabled(username, True)

    def sign_out(self, username: str) -> None:
        self.signed_out.append(username)

    def invite(self, email: str) -> PoolUser:
        self._write()
        if self.exists(email):
            raise UserExistsError
        user = PoolUser(
            username=f"name-{email}",
            sub=f"sub-{len(self.by_sub)}",
            email=email,
            status="FORCE_CHANGE_PASSWORD",
            enabled=True,
            created_at=NOW,
        )
        self.put(user)
        self.invited.append(email)
        return user


@dataclass
class Env:
    client: TestClient
    audit: RecordingAudit
    authorizer: CedarLikeAuthorizer
    people: FakePeople
    clock: list[datetime]
    deps: PeopleDeps


def _directory() -> FakePeople:
    people = FakePeople()
    people.put(_user("admin-1", days=200), "mango-admin", "finops-central")
    people.put(_user("admin-2", days=190), "mango-admin")
    people.put(_user("admin-3b", days=180), "mango-admin")
    people.put(_user("lead", days=100), "bu-lead", "bu-finanzas")
    people.put(_user("new", days=0))
    people.put(_user("invited", status="FORCE_CHANGE_PASSWORD", days=1), "devops")
    people.put(_user("gone", enabled=False, days=300), "devops")
    people.put(_user("unverified", status="UNCONFIRMED", days=0))
    return people


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.setenv(key, "testing")
    clock = [NOW]
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        _table(db, "settings")
        for group, kind, area in (("devops", "general", None), ("bu-finanzas", "area", "finanzas")):
            item: dict[str, Any] = {"PK": {"S": "GROUPS"}, "SK": {"S": group}, "type": {"S": kind}}
            if area:
                item["area"] = {"S": area}
            db.put_item(TableName="settings", Item=item)
        store = SettingsStore(db, "settings", Decimal(5), Decimal(30))
        audit, authorizer, people = RecordingAudit(), CedarLikeAuthorizer(), _directory()
        deps = PeopleDeps(
            people=people,  # type: ignore[arg-type]
            store=MemberChangeStore(db, "settings"),
            registry=GroupRegistry(db, "settings"),
            audit=audit,  # type: ignore[arg-type]
            clock=lambda: clock[0],
            sign_up_domains=frozenset({"example.com"}),
            cache=DirectoryCache(ttl_seconds=0),
        )

        def factory(s: Any) -> app_module.Services:
            return app_module.Services(
                settings=s,
                verifier=FakeVerifier(),  # type: ignore[arg-type]
                authorizer=authorizer,  # type: ignore[arg-type]
                budgets=BudgetService(db, "settings"),
                conversations=FakeConversations(),  # type: ignore[arg-type]
                audit=audit,  # type: ignore[arg-type]
                agentcore=FakeAgentCore(),
                bedrock=FakeBedrock(),
                settings_store=store,
                budget_limits=BudgetLimits(store),
                probe=FakeProbe(),  # type: ignore[arg-type]
                published=FakePublished(),  # type: ignore[arg-type]
                model_catalog=FakeModelCatalog(),  # type: ignore[arg-type]
                invocation_key=b"k" * 32,
                people=deps,
            )

        settings = dataclasses.replace(
            _settings(),
            version="0.1.0",
            release="v0.1.0-g1a2b3c4",
            organization_id="o-exampleorg1",
            management_account_id="111111111111",
            alerts_email="alerts@example.com",
            sign_up_domains="example.com",
            first_admin_emails="admin-1@example.com,",
        )
        asgi = app_module.create_app(settings, services_factory=factory)
        client = TestClient(asgi, base_url=f"http://{HOST}")  # type: ignore[arg-type]
        yield Env(client, audit, authorizer, people, clock, deps)


def _post(env: Env, path: str, body: dict[str, Any], token: str = "admin") -> Any:
    return env.client.post(f"{BASE}{path}", headers=_h(token), json=body)


def _search(env: Env, token: str = "admin", **body: Any) -> dict[str, Any]:
    response = _post(env, "/search", body, token)
    assert response.status_code == 200, response.json()
    return dict(response.json())


def _changes(env: Env, token: str = "admin") -> list[dict[str, Any]]:
    return list(env.client.get(f"{BASE}/changes", headers=_h(token)).json()["items"])


# --- Authorization ----------------------------------------------------------------------

ENDPOINTS: list[tuple[str, str, dict[str, Any] | None, str]] = [
    ("POST", f"{BASE}/search", {}, "ViewPeople"),
    ("GET", f"{BASE}/changes", None, "ViewPeople"),
    ("POST", f"{BASE}/invitations", {"email": "x@example.com"}, "ManagePeople"),
    ("POST", f"{BASE}/new/groups", {"group": "devops"}, "ManagePeople"),
    ("POST", f"{BASE}/lead/groups/remove", {"group": "bu-lead"}, "ManagePeople"),
    ("POST", f"{BASE}/new/disable", {"reason": "left"}, "ManagePeople"),
    ("POST", f"{BASE}/gone/enable", {}, "ManagePeople"),
    ("POST", f"{BASE}/changes/{'a' * 32}/approve", {}, "ApprovePeopleChange"),
    ("POST", f"{BASE}/changes/{'a' * 32}/reject", {"reason": "no"}, "ApprovePeopleChange"),
    ("POST", f"{BASE}/changes/{'a' * 32}/withdraw", {}, "ManagePeople"),
    ("GET", "/api/admin/installation", None, "ViewAdmin"),
]


@pytest.mark.parametrize(("method", "path", "body", "action"), ENDPOINTS)
def test_every_endpoint_requires_its_admin_action(
    env: Env, method: str, path: str, body: dict[str, Any] | None, action: str
) -> None:
    before = {u: set(g) for u, g in env.people.memberships.items()}
    assert env.client.request(method, path, json=body).status_code == 401
    response = env.client.request(method, path, json=body, headers=_h("user"))
    assert response.status_code == 403
    assert env.authorizer.decisions == [("user-1", action, False)]
    assert [e for e, _, _ in env.audit.events] == ["policy.decision"]
    assert env.people.memberships == before
    assert env.people.invited == []


def test_the_test_list_covers_every_route_of_the_router(env: Env) -> None:
    routes = {
        (method, route.path)
        for route in people_module.people_router(env.deps, lambda: None, lambda: None).routes  # type: ignore[arg-type]
        for method in route.methods  # type: ignore[attr-defined]
    }
    covered = {
        (m, p.replace("/new/", "/{user_id}/").replace("/lead/", "/{user_id}/"))
        for m, p, _, _ in ENDPOINTS
    }
    covered = {
        (m, p.replace("/gone/", "/{user_id}/").replace("a" * 32, "{change_id}")) for m, p in covered
    }
    assert routes <= covered


# --- Directory --------------------------------------------------------------------------


def test_search_lists_people_waiting_first_and_hides_unverified_accounts(env: Env) -> None:
    out = _search(env)
    assert [p["user_id"] for p in out["items"]] == [
        "new",
        "invited",
        "lead",
        "admin-3b",
        "admin-2",
        "admin-1",
        "gone",
    ]
    assert (out["pending"], out["admins"], out["with_access"]) == (1, 3, 2)
    by_id = {p["user_id"]: p for p in out["items"]}
    assert by_id["new"] == {
        "user_id": "new",
        "email": "new@example.com",
        "status": "active",
        "mfa": True,
        "groups": [],
        "created_at": "2026-10-03T12:00:00+00:00",
    }
    assert (by_id["invited"]["status"], by_id["invited"]["mfa"]) == ("invited", False)
    assert by_id["gone"]["status"] == "disabled"
    assert by_id["admin-1"]["groups"] == ["finops-central", "mango-admin"]


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ({"filter": "pending"}, ["new"]),
        ({"filter": "invited"}, ["invited"]),
        ({"filter": "disabled"}, ["gone"]),
        ({"prefix": "ADMIN-"}, ["admin-3b", "admin-2", "admin-1"]),
        ({"prefix": "nobody"}, []),
    ],
)
def test_search_filters(env: Env, body: dict[str, Any], expected: list[str]) -> None:
    assert [p["user_id"] for p in _search(env, **body)["items"]] == expected


def test_search_pages_with_a_cursor(env: Env) -> None:
    for n in range(30):
        env.people.put(_user(f"extra-{n:02d}", days=20 + n), "devops")
    first = _search(env)
    assert len(first["items"]) == 20
    second = _search(env, cursor=first["next_cursor"])
    assert second["next_cursor"] is None
    ids = [p["user_id"] for p in first["items"] + second["items"]]
    assert len(ids) == len(set(ids)) == 37


def test_someone_deleted_from_the_pool_after_the_list_was_read_is_left_out(env: Env) -> None:
    before = [p["user_id"] for p in _post(env, "/search", {}).json()["items"]]
    assert "new" in before
    # Deleted with the AWS console: the snapshot of this task still lists them.
    env.people.deleted.add("name-new")
    response = _post(env, "/search", {})
    assert response.status_code == 200
    assert [p["user_id"] for p in response.json()["items"]] == [u for u in before if u != "new"]
    # The next read starts from the pool again.
    del env.people.by_sub["new"]
    env.people.deleted.clear()
    again = _post(env, "/search", {}).json()
    assert [p["user_id"] for p in again["items"]] == [u for u in before if u != "new"]
    assert again["pending"] == 0


@pytest.mark.parametrize(
    "body",
    [
        {"prefix": 'a" or email ^= "'},
        {"prefix": "a b"},
        {"prefix": "a\\"},
        {"prefix": "x" * 65},
        {"cursor": "abc"},
        {"cursor": "-1"},
        {"filter": "everyone"},
        {"extra": 1},
    ],
)
def test_search_rejects_anything_that_is_not_a_plain_prefix(env: Env, body: dict[str, Any]) -> None:
    assert _post(env, "/search", body).status_code == 422


def test_a_read_is_audited_without_emails_or_the_prefix(env: Env) -> None:
    _search(env, prefix="admin-")
    ((actor, detail),) = env.audit.named("directory.list")
    assert actor == "admin-1"
    assert detail == {
        "scope": "people",
        "filter": "all",
        "searched": True,
        "returned": 3,
        "outcome": "applied",
    }


def test_a_read_that_cannot_be_audited_returns_nothing(env: Env) -> None:
    env.audit.fail_outcomes = {"applied"}
    response = _post(env, "/search", {})
    assert (response.status_code, _code(response)) == (503, "audit_unavailable")


def test_reads_are_rate_limited_per_administrator(env: Env) -> None:
    env.deps.reads = RateLimiter(2, 60)
    assert _post(env, "/search", {}).status_code == 200
    assert _post(env, "/search", {}).status_code == 200
    limited = _post(env, "/search", {})
    assert (limited.status_code, _code(limited)) == (429, "rate_limited")
    assert _post(env, "/search", {}, "admin2").status_code == 200


# --- Groups applied at once --------------------------------------------------------------


def test_an_access_group_is_given_at_once_and_audited(env: Env) -> None:
    response = _post(env, "/new/groups", {"group": "devops"})
    assert response.json() == {"result": "applied", "change_id": None}
    assert env.people.memberships["name-new"] == {"devops"}
    assert [d["outcome"] for _, d in env.audit.named("directory.group_add", None)] == [
        "requested",
        "applied",
    ]
    assert env.audit.named("directory.group_add")[0][1] == {
        "target_user": "new",
        "target_email": "new@example.com",
        "kind": "add",
        "group": "devops",
        "outcome": "applied",
    }
    assert _changes(env) == []


def test_an_access_group_is_taken_at_once_without_closing_sessions(env: Env) -> None:
    response = _post(env, "/lead/groups/remove", {"group": "bu-finanzas"})
    assert response.json()["result"] == "applied"
    assert env.people.memberships["name-lead"] == {"bu-lead"}
    assert env.people.signed_out == []


def test_an_administrator_may_give_themselves_an_access_group(env: Env) -> None:
    assert _post(env, "/admin-1/groups", {"group": "devops"}).json()["result"] == "applied"


@pytest.mark.parametrize(
    ("path", "body", "status", "code"),
    [
        ("/new/groups", {"group": "us-east-1-okta"}, 422, "unknown_group"),
        ("/new/groups", {"group": "mango-other"}, 422, "unknown_group"),
        ("/lead/groups", {"group": "bu-lead"}, 409, "already_member"),
        ("/new/groups/remove", {"group": "devops"}, 409, "not_member"),
        ("/gone/groups", {"group": "bu-lead"}, 409, "user_disabled"),
        ("/nobody/groups", {"group": "devops"}, 404, "user_not_found"),
        ("/unverified/groups", {"group": "devops"}, 404, "user_not_found"),
        ("/gone/disable", {"reason": "x"}, 409, "already_disabled"),
        ("/new/enable", {}, 409, "already_enabled"),
    ],
)
def test_changes_that_do_not_fit_the_state_are_refused(
    env: Env, path: str, body: dict[str, Any], status: int, code: str
) -> None:
    before = {u: set(g) for u, g in env.people.memberships.items()}
    response = _post(env, path, body)
    assert (response.status_code, _code(response)) == (status, code)
    assert env.people.memberships == before


def test_a_change_that_cannot_be_audited_is_not_applied(env: Env) -> None:
    env.audit.fail_outcomes = {"requested"}
    response = _post(env, "/new/groups", {"group": "devops"})
    assert (response.status_code, _code(response)) == (503, "audit_unavailable")
    assert env.people.memberships["name-new"] == set()


def test_a_directory_failure_is_reported_and_audited(env: Env) -> None:
    env.people.fail_writes = True
    response = _post(env, "/new/groups", {"group": "devops"})
    assert (response.status_code, _code(response)) == (502, "upstream_error")
    assert [d["outcome"] for _, d in env.audit.named("directory.group_add", None)] == [
        "requested",
        "rejected",
    ]


# --- Dual approval ----------------------------------------------------------------------


def _propose_admin(env: Env, target: str = "lead", token: str = "admin") -> str:
    response = _post(env, f"/{target}/groups", {"group": "mango-admin", "reason": "on call"}, token)
    assert response.status_code == 200, response.json()
    assert response.json()["result"] == "proposed"
    return str(response.json()["change_id"])


@pytest.mark.parametrize("group", ["mango-admin", "finops-central"])
def test_a_sensitive_group_is_proposed_never_applied_by_one_administrator(
    env: Env, group: str
) -> None:
    response = _post(env, "/lead/groups", {"group": group, "reason": "needs it"})
    assert response.json()["result"] == "proposed"
    assert group not in env.people.memberships["name-lead"]
    (change,) = _changes(env)
    assert (change["kind"], change["group"], change["status"]) == ("add", group, "pending")
    assert (change["target_user"], change["proposed_by"]) == ("lead", "admin-1")
    assert env.audit.named("directory.group_add", None) == []
    assert len(env.audit.named("directory.member_propose")) == 1


def test_a_sensitive_change_needs_a_reason(env: Env) -> None:
    response = _post(env, "/lead/groups", {"group": "mango-admin"})
    assert (response.status_code, _code(response)) == (422, "reason_required")


def test_another_administrator_approves_and_the_group_is_given(env: Env) -> None:
    change_id = _propose_admin(env)
    response = _post(env, f"/changes/{change_id}/approve", {}, "admin2")
    assert response.status_code == 200
    item = response.json()["items"][0]
    assert (item["status"], item["decided_by"]) == ("approved", "admin-2")
    assert "mango-admin" in env.people.memberships["name-lead"]
    ((actor, detail),) = env.audit.named("directory.group_add")
    assert actor == "admin-2"
    assert detail == {
        "change_id": change_id,
        "target_user": "lead",
        "target_email": "lead@example.com",
        "kind": "add",
        "proposed_by": "admin-1",
        "group": "mango-admin",
        "approved_by": "admin-2",
        "outcome": "applied",
    }


def test_the_proposer_cannot_approve_their_own_change(env: Env) -> None:
    change_id = _propose_admin(env)
    response = _post(env, f"/changes/{change_id}/approve", {})
    assert (response.status_code, _code(response)) == (403, "same_approver")
    assert "mango-admin" not in env.people.memberships["name-lead"]
    assert len(env.audit.named("directory.member_approve", "rejected")) == 1


def test_nobody_decides_a_change_about_their_own_account(env: Env) -> None:
    response = _post(env, "/admin-2/groups/remove", {"group": "mango-admin", "reason": "rotation"})
    change_id = response.json()["change_id"]
    for decision, body in (("approve", {}), ("reject", {"reason": "no"})):
        refused = _post(env, f"/changes/{change_id}/{decision}", body, "admin2")
        assert (refused.status_code, _code(refused)) == (403, "self_change")
    assert "mango-admin" in env.people.memberships["name-admin-2"]


@pytest.mark.parametrize(
    ("path", "body"),
    [
        ("/admin-2/groups/remove", {"group": "mango-admin", "reason": "me"}),
        ("/admin-2/disable", {"reason": "me"}),
    ],
)
def test_nobody_gives_up_a_sensitive_group_or_disables_themselves_alone(
    env: Env, path: str, body: dict[str, Any]
) -> None:
    response = _post(env, path, body, "admin2")
    assert (response.status_code, _code(response)) == (403, "self_change")
    assert _changes(env) == []
    # Reading the changes is audited as a read of the directory; it is not what is checked.
    reads = {"policy.decision", "directory.list"}
    outcomes = [d["outcome"] for e, _, d in env.audit.events if e not in reads]
    assert outcomes == ["rejected"]


def test_asking_for_a_sensitive_group_for_oneself_needs_another_administrator(env: Env) -> None:
    response = _post(env, "/admin-2/groups", {"group": "finops-central", "reason": "me"}, "admin2")
    change_id = response.json()["change_id"]
    assert response.json()["result"] == "proposed"
    for decision, body in (("approve", {}), ("reject", {"reason": "no"})):
        own = _post(env, f"/changes/{change_id}/{decision}", body, "admin2")
        assert own.status_code == 403
    assert _post(env, f"/changes/{change_id}/approve", {}).status_code == 200
    assert "finops-central" in env.people.memberships["name-admin-2"]


def test_one_open_change_per_person_and_group(env: Env) -> None:
    _propose_admin(env)
    again = _post(env, "/lead/groups", {"group": "mango-admin", "reason": "again"}, "admin2")
    assert (again.status_code, _code(again)) == (409, "already_pending")


def test_an_expired_change_cannot_be_approved(env: Env) -> None:
    change_id = _propose_admin(env)
    env.clock[0] = NOW + timedelta(hours=73)
    response = _post(env, f"/changes/{change_id}/approve", {}, "admin2")
    assert (response.status_code, _code(response)) == (410, "expired")
    assert _changes(env)[0]["status"] == "expired"
    assert "mango-admin" not in env.people.memberships["name-lead"]


def test_the_rules_are_checked_again_when_the_change_is_approved(env: Env) -> None:
    change_id = _propose_admin(env)
    env.people.disable("name-lead")
    response = _post(env, f"/changes/{change_id}/approve", {}, "admin2")
    assert (response.status_code, _code(response)) == (409, "user_disabled")
    assert _changes(env)[0]["status"] == "pending"


def test_a_directory_failure_leaves_the_change_pending(env: Env) -> None:
    change_id = _propose_admin(env)
    env.people.fail_writes = True
    response = _post(env, f"/changes/{change_id}/approve", {}, "admin2")
    assert (response.status_code, _code(response)) == (502, "upstream_error")
    env.people.fail_writes = False
    assert _post(env, f"/changes/{change_id}/approve", {}, "admin2").status_code == 200


def _delete_from_pool(env: Env, sub: str) -> None:
    """What the AWS console or the CLI does: the person is gone, their changes stay."""
    user = env.people.by_sub.pop(sub)
    del env.people.memberships[user.username]


def test_the_changes_say_who_is_no_longer_in_the_directory(env: Env) -> None:
    _propose_admin(env)
    assert _changes(env)[0]["target_in_directory"] is True
    _delete_from_pool(env, "lead")
    env.audit.events.clear()
    (change,) = _changes(env)
    # History: the card keeps the email of who it was about.
    assert (change["target_in_directory"], change["target_email"]) == (False, "lead@example.com")
    # No lookup per change: the answer comes from the shared copy of the directory.
    assert env.people.lookups.count("lead") == 1  # the proposal itself
    ((actor, detail),) = env.audit.named("directory.list")
    assert actor == "admin-1"
    assert detail == {"scope": "changes", "returned": 1, "missing": 1, "outcome": "applied"}


def test_reading_the_changes_has_the_limit_and_the_audit_of_a_directory_read(env: Env) -> None:
    change_id = _propose_admin(env)
    env.audit.fail_outcomes = {"applied"}
    unaudited = env.client.get(f"{BASE}/changes", headers=_h("admin"))
    assert (unaudited.status_code, _code(unaudited)) == (503, "audit_unavailable")
    env.audit.fail_outcomes = set()
    env.deps.reads = RateLimiter(1, 60)
    assert env.client.get(f"{BASE}/changes", headers=_h("admin")).status_code == 200
    limited = env.client.get(f"{BASE}/changes", headers=_h("admin"))
    assert (limited.status_code, _code(limited)) == (429, "rate_limited")
    # A decision answers with the list without spending a read: it is audited as itself.
    decided = _post(env, f"/changes/{change_id}/reject", {"reason": "not now"}, "admin2")
    assert decided.json()["items"][0]["status"] == "rejected"
    assert len(env.audit.named("directory.list")) == 1


def test_the_changes_are_listed_when_the_directory_cannot_be_read(env: Env) -> None:
    _propose_admin(env)
    env.people.fail_reads = True
    (change,) = _changes(env)
    assert (change["status"], change["target_in_directory"]) == ("pending", None)


def test_a_directory_larger_than_one_read_is_asked_a_bounded_number_of_times(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    _propose_admin(env)
    env.clock[0] = NOW + timedelta(minutes=1)
    _post(env, "/admin-3b/groups/remove", {"group": "mango-admin", "reason": "moved"})
    _delete_from_pool(env, "lead")
    # One read returns the first two people only: nobody else is known from it.
    env.people.listed = 2
    env.people.lookups.clear()
    monkeypatch.setattr(people_module, "MAX_PRESENCE_LOOKUPS", 1)
    newest, oldest = _changes(env)
    assert len(env.people.lookups) == 1
    assert (newest["target_user"], newest["target_in_directory"]) == ("admin-3b", True)
    assert (oldest["target_user"], oldest["target_in_directory"]) == ("lead", None)
    env.people.lookups.clear()
    monkeypatch.setattr(people_module, "MAX_PRESENCE_LOOKUPS", 20)
    assert [c["target_in_directory"] for c in _changes(env)] == [True, False]
    assert sorted(env.people.lookups) == ["admin-3b", "lead"]
    # While the copy of the directory is fresh, reading again does not ask the pool again.
    env.deps.cache = DirectoryCache(ttl_seconds=30)
    assert [c["target_in_directory"] for c in _changes(env)] == [True, False]
    env.people.lookups.clear()
    assert [c["target_in_directory"] for c in _changes(env)] == [True, False]
    assert env.people.lookups == []


# --- Two tasks (D70) ---------------------------------------------------------------------


def _other_task(env: Env) -> PeopleDeps:
    """Another mango-api task: its own copy of the directory, the same table and pool."""
    return dataclasses.replace(env.deps, cache=DirectoryCache(ttl_seconds=30))


def test_a_change_applied_by_one_task_is_seen_by_the_others_at_once(env: Env) -> None:
    other = _other_task(env)
    before = people_module._snapshot(other)
    assert "devops" not in before.groups.get("new", frozenset())
    # Nothing changed: the other task keeps serving its copy.
    assert people_module._snapshot(other) is before
    # This task gives a group. The screen reads the list again, and that read may land on
    # the other task: it must not answer with the copy from before the change.
    assert _post(env, "/new/groups", {"group": "devops"}).json()["result"] == "applied"
    after = people_module._snapshot(other)
    assert "devops" in after.groups["new"]
    assert people_module._snapshot(other) is after


def test_a_change_that_was_refused_does_not_spend_the_copies(env: Env) -> None:
    other = _other_task(env)
    before = people_module._snapshot(other)
    assert _post(env, "/lead/groups", {"group": "bu-lead"}).status_code == 409
    assert people_module._snapshot(other) is before


def test_without_the_generation_the_directory_is_read_afresh(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    other = _other_task(env)
    before = people_module._snapshot(other)

    def unreadable() -> int:
        raise ClientError({"Error": {"Code": "InternalServerError"}}, "GetItem")

    monkeypatch.setattr(other.store, "generation", unreadable)
    # Nothing says the copy is still good: it is not served.
    assert people_module._snapshot(other) is not before


def test_a_change_stands_when_the_other_tasks_cannot_be_told(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    def unwritable() -> None:
        raise ClientError({"Error": {"Code": "InternalServerError"}}, "UpdateItem")

    monkeypatch.setattr(env.deps.store, "bump_generation", unwritable)
    assert _post(env, "/new/groups", {"group": "devops"}).json()["result"] == "applied"
    assert "devops" in env.people.memberships["name-new"]


def test_reject_and_withdraw_close_the_change(env: Env) -> None:
    first = _propose_admin(env)
    rejected = _post(env, f"/changes/{first}/reject", {"reason": "not now"}, "admin2")
    assert rejected.json()["items"][0]["status"] == "rejected"
    env.clock[0] = NOW + timedelta(minutes=1)
    second = _propose_admin(env)
    not_mine = _post(env, f"/changes/{second}/withdraw", {}, "admin2")
    assert (not_mine.status_code, _code(not_mine)) == (403, "forbidden")
    withdrawn = _post(env, f"/changes/{second}/withdraw", {})
    assert withdrawn.json()["items"][0]["status"] == "withdrawn"
    assert "mango-admin" not in env.people.memberships["name-lead"]
    closed = _post(env, f"/changes/{second}/approve", {}, "admin2")
    assert (closed.status_code, _code(closed)) == (409, "version_conflict")


def test_approving_tells_another_change_in_progress_from_one_already_decided(env: Env) -> None:
    change_id = _propose_admin(env)
    # Another change of administrators holds the claim: this one is still pending.
    env.deps.store.claim_admins("someone", NOW)
    busy = _post(env, f"/changes/{change_id}/approve", {}, "admin2")
    assert (busy.status_code, _code(busy)) == (409, "busy")
    assert "mango-admin" not in env.people.memberships["name-lead"]
    assert _changes(env)[0]["status"] == "pending"
    assert env.audit.named("directory.member_approve", "rejected")[-1][1]["error"] == "busy"
    env.clock[0] = NOW + timedelta(minutes=3)
    assert _post(env, f"/changes/{change_id}/approve", {}, "admin2").status_code == 200
    # Decided already: approving again is a different refusal.
    again = _post(env, f"/changes/{change_id}/approve", {}, "admin2")
    assert (again.status_code, _code(again)) == (409, "version_conflict")


def test_taking_a_sensitive_group_closes_the_sessions(env: Env) -> None:
    response = _post(
        env, "/admin-1/groups/remove", {"group": "finops-central", "reason": "moved"}, "admin2"
    )
    change_id = response.json()["change_id"]
    assert _post(env, f"/changes/{change_id}/approve", {}, "people-admin3").status_code == 200
    assert env.people.memberships["name-admin-1"] == {"mango-admin"}
    assert env.people.signed_out == ["name-admin-1"]


def test_taking_a_sensitive_group_names_the_cause_for_the_web_sessions(env: Env) -> None:
    ended: list[tuple[str, str]] = []
    env.deps.end_sessions = lambda sub, cause: ended.append((sub, cause))
    response = _post(
        env, "/admin-1/groups/remove", {"group": "finops-central", "reason": "moved"}, "admin2"
    )
    change_id = response.json()["change_id"]
    assert _post(env, f"/changes/{change_id}/approve", {}, "people-admin3").status_code == 200
    assert ended == [("admin-1", "group_removed")]


# --- Two administrators, always ----------------------------------------------------------


def test_the_application_never_leaves_fewer_than_two_administrators(env: Env) -> None:
    env.people.memberships["name-admin-3b"] = set()
    for path, body in (
        ("/admin-2/groups/remove", {"group": "mango-admin", "reason": "x"}),
        ("/admin-2/disable", {"reason": "x"}),
    ):
        response = _post(env, path, body)
        assert (response.status_code, _code(response)) == (409, "last_admins")
    assert _changes(env) == []


def test_the_minimum_is_checked_again_at_approval(env: Env) -> None:
    response = _post(env, "/admin-2/groups/remove", {"group": "mango-admin", "reason": "x"})
    change_id = response.json()["change_id"]
    env.people.memberships["name-admin-1"].discard("mango-admin")
    # admin-3b approves: with admin-1 gone there are only two administrators left.
    approved = _post(env, f"/changes/{change_id}/approve", {}, "people-admin3")
    assert (approved.status_code, _code(approved)) == (409, "last_admins")
    assert "mango-admin" in env.people.memberships["name-admin-2"]


def test_a_disabled_administrator_does_not_count(env: Env) -> None:
    env.people.disable("name-admin-3b")
    response = _post(env, "/admin-2/disable", {"reason": "x"})
    assert (response.status_code, _code(response)) == (409, "last_admins")


# --- Bootstrap --------------------------------------------------------------------------


def _alone(env: Env) -> None:
    env.people.memberships["name-admin-2"] = set()
    env.people.memberships["name-admin-3b"] = set()


def test_the_only_administrator_names_the_second_without_an_approver(env: Env) -> None:
    _alone(env)
    response = _post(env, "/lead/groups", {"group": "mango-admin"})
    assert response.json() == {"result": "bootstrap", "change_id": None}
    assert "mango-admin" in env.people.memberships["name-lead"]
    assert env.audit.named("directory.group_add")[0][1]["bootstrap"] is True
    # From then on there are two: the next one needs an approver.
    third = _post(env, "/new/groups", {"group": "mango-admin", "reason": "third"})
    assert third.json()["result"] == "proposed"


def test_bootstrap_only_covers_mango_admin(env: Env) -> None:
    _alone(env)
    response = _post(env, "/lead/groups", {"group": "finops-central", "reason": "x"})
    assert response.json()["result"] == "proposed"


def test_bootstrap_needs_the_caller_to_be_that_administrator(env: Env) -> None:
    # admin-2's token still says administrator, but the directory no longer does.
    _alone(env)
    response = _post(env, "/lead/groups", {"group": "mango-admin", "reason": "x"}, "admin2")
    assert (response.status_code, _code(response)) == (403, "forbidden")
    assert "mango-admin" not in env.people.memberships["name-lead"]
    assert _changes(env) == []


@pytest.mark.parametrize(
    ("path", "body"),
    [
        ("/new/groups", {"group": "devops"}),
        ("/new/disable", {"reason": "x"}),
        ("/invitations", {"email": "ana@example.com"}),
    ],
)
def test_a_token_that_outlived_its_administrator_changes_nothing(
    env: Env, path: str, body: dict[str, Any]
) -> None:
    env.people.memberships["name-admin-2"] = set()
    response = _post(env, path, body, "admin2")
    assert (response.status_code, _code(response)) == (403, "forbidden")
    assert env.people.memberships["name-new"] == set()
    assert env.people.invited == []
    env.people.memberships["name-admin-2"] = {"mango-admin"}
    env.people.disable("name-admin-2")
    assert _post(env, path, body, "admin2").status_code == 403


def test_a_removed_administrator_cannot_approve(env: Env) -> None:
    change_id = _propose_admin(env)
    env.people.memberships["name-admin-2"] = set()
    response = _post(env, f"/changes/{change_id}/approve", {}, "admin2")
    assert (response.status_code, _code(response)) == (403, "forbidden")
    assert "mango-admin" not in env.people.memberships["name-lead"]


def test_two_bootstraps_at_once_do_not_both_apply(env: Env) -> None:
    _alone(env)
    env.deps.store.claim_admins("someone", NOW)
    response = _post(env, "/lead/groups", {"group": "mango-admin"})
    assert (response.status_code, _code(response)) == (409, "busy")
    assert "mango-admin" not in env.people.memberships["name-lead"]
    # The claim expires on its own, and a finished change releases its own.
    env.clock[0] = NOW + timedelta(minutes=3)
    assert _post(env, "/lead/groups", {"group": "mango-admin"}).json()["result"] == "bootstrap"
    env.clock[0] = NOW + timedelta(minutes=4)
    third = _post(env, "/new/groups", {"group": "mango-admin", "reason": "x"})
    approved = _post(env, f"/changes/{third.json()['change_id']}/approve", {}, "people-admin3")
    assert approved.status_code == 403  # admin-3b is no longer an administrator here
    assert env.deps.store.get(third.json()["change_id"]).status == "pending"  # type: ignore[union-attr]


# --- Disable and enable -----------------------------------------------------------------


def test_signing_a_person_out_ends_their_web_sessions_too(env: Env) -> None:
    ended: list[tuple[str, str]] = []
    env.deps.end_sessions = lambda sub, cause: ended.append((sub, cause))
    assert _post(env, "/lead/disable", {"reason": "left the company"}).json()["result"] == "applied"
    # By user id (the sessions table), next to the Cognito sign-out by username (D63), with
    # the cause their ``session.ended`` will name.
    assert ended == [("lead", "disabled")]
    assert env.people.signed_out == ["name-lead"]


def test_a_sessions_outage_fails_the_change_before_the_cognito_sign_out(env: Env) -> None:
    def down(_sub: str, _cause: str) -> None:
        raise RuntimeError("table unavailable")

    env.deps.end_sessions = down
    response = _post(env, "/lead/disable", {"reason": "left the company"})
    assert response.status_code == 502
    assert env.people.signed_out == []


def test_disabling_a_person_closes_their_sessions(env: Env) -> None:
    assert _post(env, "/lead/disable", {"reason": "left the company"}).json()["result"] == "applied"
    assert env.people.by_sub["lead"].enabled is False
    assert env.people.signed_out == ["name-lead"]
    assert env.audit.named("directory.disable")[0][1]["reason"] == "left the company"


def test_disabling_an_administrator_needs_another_one(env: Env) -> None:
    response = _post(env, "/admin-2/disable", {"reason": "left"})
    assert response.json()["result"] == "proposed"
    assert env.people.by_sub["admin-2"].enabled is True
    approved = _post(env, f"/changes/{response.json()['change_id']}/approve", {}, "people-admin3")
    assert approved.status_code == 200
    assert env.people.by_sub["admin-2"].enabled is False


def test_enabling_is_applied_unless_the_person_holds_a_sensitive_group(env: Env) -> None:
    assert _post(env, "/gone/enable", {}).json()["result"] == "applied"
    assert env.people.by_sub["gone"].enabled is True
    env.people.put(_user("exadmin", enabled=False), "mango-admin")
    no_reason = _post(env, "/exadmin/enable", {})
    assert (no_reason.status_code, _code(no_reason)) == (422, "reason_required")
    proposed = _post(env, "/exadmin/enable", {"reason": "back from leave"})
    assert proposed.json()["result"] == "proposed"
    assert env.people.by_sub["exadmin"].enabled is False
    assert _changes(env)[0]["kind"] == "enable"


# --- Invitations ------------------------------------------------------------------------


def test_an_invitation_creates_the_person_with_access_groups(env: Env) -> None:
    response = _post(
        env, "/invitations", {"email": " Ana@Example.com ", "groups": ["devops", "bu-lead"]}
    )
    assert response.status_code == 201
    assert response.json()["result"] == "applied"
    assert env.people.invited == ["ana@example.com"]
    assert env.people.memberships["name-ana@example.com"] == {"devops", "bu-lead"}
    assert env.audit.named("directory.invite")[0][1] == {
        "target_email": "ana@example.com",
        "groups": ["devops", "bu-lead"],
        "outcome": "applied",
    }


@pytest.mark.parametrize(
    ("body", "status", "code"),
    [
        ({"email": "ana@gmail.com"}, 422, "public_domain"),
        ({"email": "ana@GoogleMail.com"}, 422, "public_domain"),
        ({"email": "ana@outlook.es"}, 422, "public_domain"),
        ({"email": "ana@hotmail.com.mx"}, 422, "public_domain"),
        ({"email": "ana@yahoo.co.uk"}, 422, "public_domain"),
        ({"email": "ana@mail.yahoo.es"}, 422, "public_domain"),
        ({"email": "ana@mailinator.com"}, 422, "public_domain"),
        ({"email": "ana@localhost"}, 422, "invalid_email"),
        ({"email": "\u0430na@example.com"}, 422, "invalid_email"),
        ({"email": '"a b"@example.com'}, 422, "invalid_email"),
        ({"email": "lead@example.com"}, 409, "already_exists"),
        ({"email": "ana@example.com", "groups": ["mango-admin"]}, 422, "sensitive_group"),
        ({"email": "ana@example.com", "groups": ["finops-central"]}, 422, "sensitive_group"),
        ({"email": "ana@example.com", "groups": ["pool-okta"]}, 422, "unknown_group"),
    ],
)
def test_invitations_that_are_refused(
    env: Env, body: dict[str, Any], status: int, code: str
) -> None:
    response = _post(env, "/invitations", body)
    assert (response.status_code, _code(response)) == (status, code)
    assert env.people.invited == []
    # The refusal is in the trail, and nothing else of that invitation is.
    assert [detail["error"] for _, detail in env.audit.named("directory.invite", None)] == [code]


def test_a_refused_address_is_audited_by_its_domain_never_as_typed(env: Env) -> None:
    _post(env, "/invitations", {"email": "Ana.Perez@gmail.com", "groups": ["devops"]})
    _post(env, "/invitations", {"email": '"hunter2 pasted"@example.com'})
    _post(env, "/invitations", {"email": "ana@not a domain"})
    refused = {"outcome": "rejected", "error": "invalid_email"}
    assert [detail for _, detail in env.audit.named("directory.invite", "rejected")] == [
        {
            "groups": 1,
            "target_domain": "gmail.com",
            "outcome": "rejected",
            "error": "public_domain",
        },
        {"groups": 0, "target_domain": "example.com", **refused},
        {"groups": 0, **refused},
    ]


def test_a_refusal_stands_when_it_cannot_be_audited(env: Env) -> None:
    env.audit.fail_outcomes = {"rejected"}
    response = _post(env, "/invitations", {"email": "ana@gmail.com"})
    assert (response.status_code, _code(response)) == (422, "public_domain")


@pytest.mark.parametrize("email", ["ana@other.com", "ana@sub.example.com", "ana@partner.io"])
def test_someone_of_another_company_may_be_invited_and_the_event_says_so(
    env: Env, email: str
) -> None:
    response = _post(env, "/invitations", {"email": email, "groups": ["devops"]})
    assert (response.status_code, response.json()["result"]) == (201, "applied")
    assert env.people.invited == [email]
    assert [detail for _, detail in env.audit.named("directory.invite", None)] == [
        {"target_email": email, "groups": ["devops"], "external_domain": True, "outcome": o}
        for o in ("requested", "applied")
    ]


def test_an_outsider_never_gets_a_sensitive_group_with_the_invitation(env: Env) -> None:
    for group in ("mango-admin", "finops-central"):
        response = _post(env, "/invitations", {"email": "ana@other.com", "groups": [group]})
        assert (response.status_code, _code(response)) == (422, "sensitive_group")
    assert env.people.invited == []
    refusals = env.audit.named("directory.invite", "rejected")
    assert [detail["external_domain"] for _, detail in refusals] == [True, True]


def test_the_only_administrator_may_invite_the_second_one(env: Env) -> None:
    _alone(env)
    response = _post(env, "/invitations", {"email": "ana@example.com", "groups": ["mango-admin"]})
    assert response.json()["result"] == "bootstrap"
    assert env.people.memberships["name-ana@example.com"] == {"mango-admin"}
    assert env.audit.named("directory.invite")[0][1]["bootstrap"] is True


def test_invitations_are_rate_limited(env: Env) -> None:
    env.deps.invitations = RateLimiter(1, 3600)
    assert _post(env, "/invitations", {"email": "a@example.com"}).status_code == 201
    limited = _post(env, "/invitations", {"email": "b@example.com"})
    assert (limited.status_code, _code(limited)) == (429, "rate_limited")


def test_the_invitation_rule_matches_the_sign_up_trigger() -> None:
    trigger = pytest.importorskip("mango_pre_sign_up.handler")
    # One list (``mango_core.mail_domains``): neither module keeps a copy of its own.
    assert not hasattr(people_module, "PUBLIC_MAIL_DOMAINS")
    assert not hasattr(trigger, "PUBLIC_MAIL_DOMAINS")
    assert trigger.is_public_mail_domain is people_module.is_public_mail_domain
    domains = "example.com,gmail.com,outlook.es"
    assert parse_domains(domains) == trigger.allowed_domains(domains)
    for email in (
        "ana@example.com",
        "ana+x@example.com",
        "ana@EXAMPLE.com",
        "ana@evilexample.com",
        "a..b@example.com",
        "ana@gmail.com",
        "ana@outlook.es",
        "ana@yahoo.com.mx",
        "a@b@example.com",
        "\u0430na@example.com",
    ):
        allowed, _, _ = trigger.check_email(email, trigger.allowed_domains(domains))
        refused, domain = invitation_domain(email.strip().lower())
        # The shape of an address and the public providers are the trigger's; an invitation
        # only differs in accepting a company domain the installation did not list.
        ours = refused is None and domain in parse_domains(domains)
        assert ours == allowed, email
    assert invitation_domain("ana@evilexample.com") == (None, "evilexample.com")


def test_an_unusable_domain_list_marks_every_invitation_as_external() -> None:
    assert parse_domains("") == frozenset()
    assert parse_domains("example.com,not a domain") == frozenset()
    assert invitation_domain("ana@example.com") == (None, "example.com")


# --- Installation -----------------------------------------------------------------------


def test_installation_is_read_only_data_for_administrators(env: Env) -> None:
    response = env.client.get("/api/admin/installation", headers=_h("admin"))
    assert response.json() == {
        "name": "test",
        "version": "0.1.0",
        "release": "v0.1.0-g1a2b3c4",
        "organization_id": "o-exampleorg1",
        "management_account_id": "111111111111",
        "alerts_emails": ["alerts@example.com"],
        "sign_up_domains": ["example.com"],
        "first_admins": ["admin-1@example.com"],
    }


# --- Cognito adapter --------------------------------------------------------------------

POOL = "us-east-1_Example"


def _cognito() -> tuple[CognitoPeople, Stubber]:
    client = boto3.client("cognito-idp", region_name="us-east-1")
    return CognitoPeople(client, POOL), Stubber(client)


def _raw(sub: str, **extra: Any) -> dict[str, Any]:
    return {
        "Username": f"name-{sub}",
        "Attributes": [
            {"Name": "sub", "Value": sub},
            {"Name": "email", "Value": f"{sub}@Example.com"},
        ],
        "UserStatus": "CONFIRMED",
        "Enabled": True,
        "UserCreateDate": NOW,
        **extra,
    }


def test_by_id_only_sends_a_validated_identifier_to_the_filter() -> None:
    people, stub = _cognito()
    with stub:
        # Nothing is stubbed: an identifier that could break out of the filter never calls.
        assert people.by_id('x" or sub ^= "') is None
        stub.add_response(
            "list_users",
            {"Users": [_raw("abc-1")]},
            {"UserPoolId": POOL, "Filter": 'sub = "abc-1"', "Limit": 1},
        )
        found = people.by_id("abc-1")
    assert found is not None
    assert (found.username, found.email) == ("name-abc-1", "abc-1@example.com")


def test_users_follows_pagination_and_reports_when_it_stops() -> None:
    people, stub = _cognito()
    with stub:
        stub.add_response(
            "list_users",
            {"Users": [_raw("a"), _raw("b")], "PaginationToken": "t1"},
            {"UserPoolId": POOL, "Limit": 60},
        )
        stub.add_response(
            "list_users",
            {"Users": [_raw("c")], "PaginationToken": "t2"},
            {"UserPoolId": POOL, "Limit": 60, "PaginationToken": "t1"},
        )
        users, incomplete = people.users(limit=3)
    assert ([u.sub for u in users], incomplete) == (["a", "b", "c"], True)


def test_members_of_a_group_the_directory_does_not_have_is_empty() -> None:
    people, stub = _cognito()
    with stub:
        stub.add_client_error("list_users_in_group", "ResourceNotFoundException")
        assert people.members("devops") == []
        stub.add_client_error("list_users_in_group", "TooManyRequestsException")
        with pytest.raises(DirectoryUnavailableError):
            people.members("devops")


def test_a_totp_enrolled_at_sign_in_counts_as_mfa_and_is_listed_from_then_on() -> None:
    people, stub = _cognito()
    prefer = {
        "UserPoolId": POOL,
        "Username": "name-a",
        "SoftwareTokenMfaSettings": {"Enabled": True, "PreferredMfa": True},
    }
    lookup = {"UserPoolId": POOL, "Username": "name-a"}
    with stub:
        # Enrolled through MFA_SETUP: Cognito lists nothing until a preference is set.
        stub.add_response("admin_get_user", {"Username": "name-a"}, lookup)
        stub.add_response("admin_set_user_mfa_preference", {}, prefer)
        assert people.mfa_registered("name-a") is True
        # Listed: one read, no write.
        stub.add_response(
            "admin_get_user",
            {"Username": "name-a", "UserMFASettingList": ["SOFTWARE_TOKEN_MFA"]},
            lookup,
        )
        assert people.mfa_registered("name-a") is True
        # No verified TOTP: Cognito refuses the preference.
        stub.add_response("admin_get_user", {"Username": "name-a"}, lookup)
        stub.add_client_error(
            "admin_set_user_mfa_preference", "InvalidParameterException", expected_params=prefer
        )
        assert people.mfa_registered("name-a") is False
        stub.add_response("admin_get_user", {"Username": "name-a"}, lookup)
        stub.add_client_error("admin_set_user_mfa_preference", "TooManyRequestsException")
        with pytest.raises(DirectoryUnavailableError):
            people.mfa_registered("name-a")
        # Deleted from the pool after it was listed: not there, and not an outage.
        stub.add_client_error("admin_get_user", "UserNotFoundException", expected_params=lookup)
        assert people.mfa_registered("name-a") is None
        stub.assert_no_pending_responses()


def test_invite_sends_the_email_and_maps_an_existing_user() -> None:
    people, stub = _cognito()
    with stub:
        stub.add_response(
            "admin_create_user",
            {"User": _raw("new-1")},
            {
                "UserPoolId": POOL,
                "Username": "ana@example.com",
                "DesiredDeliveryMediums": ["EMAIL"],
                "UserAttributes": [
                    {"Name": "email", "Value": "ana@example.com"},
                    {"Name": "email_verified", "Value": "true"},
                ],
            },
        )
        assert people.invite("ana@example.com").sub == "new-1"
        stub.add_client_error("admin_create_user", "UsernameExistsException")
        with pytest.raises(UserExistsError):
            people.invite("ana@example.com")
