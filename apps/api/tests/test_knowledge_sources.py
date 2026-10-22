"""Sources on existing buckets (D88 (10), (20); TM-K2): who proposes, who decides, which
buckets. Real Cedar policies and moto DynamoDB; S3 answers like it does for each case."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError

from mango_api.knowledge_sources import BucketChecker, split_location

from .test_knowledge import Env, _code, _h, env  # noqa: F401 - fixture

ACCOUNT = "111122223333"
OTHER_ACCOUNT = "444455556666"


@dataclass
class FakeS3:
    """``GetBucketEncryption`` as S3 answers it: by bucket, honoring ``ExpectedBucketOwner``."""

    owners: dict[str, str] = field(
        default_factory=lambda: {
            "docs-rrhh": ACCOUNT,
            "docs-legal": ACCOUNT,
            "otra-cuenta": OTHER_ACCOUNT,
            "con-llave": ACCOUNT,
            "sin-config": ACCOUNT,
        }
    )
    encryption: dict[str, dict[str, Any]] = field(
        default_factory=lambda: {
            "docs-rrhh": {"SSEAlgorithm": "AES256"},
            "docs-legal": {"SSEAlgorithm": "aws:kms"},
            "otra-cuenta": {"SSEAlgorithm": "AES256"},
            "con-llave": {
                "SSEAlgorithm": "aws:kms",
                "KMSMasterKeyID": f"arn:aws:kms:us-east-1:{ACCOUNT}:key/1234abcd-12ab-34cd-56ef",
            },
        }
    )
    down: bool = False
    calls: list[str] = field(default_factory=list)

    def get_bucket_encryption(self, Bucket: str, ExpectedBucketOwner: str) -> dict[str, Any]:  # noqa: N803
        self.calls.append(Bucket)
        if self.down:
            raise EndpointConnectionError(endpoint_url="https://s3.example")
        owner = self.owners.get(Bucket)
        if owner is None:
            raise ClientError({"Error": {"Code": "NoSuchBucket"}}, "GetBucketEncryption")
        if owner != ExpectedBucketOwner:
            raise ClientError({"Error": {"Code": "AccessDenied"}}, "GetBucketEncryption")
        if Bucket not in self.encryption:
            raise ClientError(
                {"Error": {"Code": "ServerSideEncryptionConfigurationNotFoundError"}},
                "GetBucketEncryption",
            )
        return {
            "ServerSideEncryptionConfiguration": {
                "Rules": [{"ApplyServerSideEncryptionByDefault": self.encryption[Bucket]}]
            }
        }


@pytest.fixture
def s3(env: Env) -> FakeS3:  # noqa: F811
    fake = FakeS3()
    assert env.deps is not None
    env.deps.buckets = BucketChecker(fake, ACCOUNT)
    return fake


def _sources(kb: dict[str, Any]) -> str:
    return f"/api/knowledge-bases/{kb['kb_id']}/sources"


def _propose(env: Env, kb: dict[str, Any], location: str, token: str = "creator") -> Any:  # noqa: F811
    return env.client.post(_sources(kb), headers=_h(token), json={"location": location})


def _proposed(env: Env, kb: dict[str, Any], location: str = "s3://docs-rrhh/politicas/") -> Any:  # noqa: F811
    response = _propose(env, kb, location)
    assert response.status_code == 201, response.text
    return response.json()


def _decide(env: Env, source: dict[str, Any], verb: str, token: str = "admin") -> Any:  # noqa: F811
    return env.client.post(
        f"/api/knowledge-bases/{source['kb_id']}/sources/{source['src_id']}/{verb}",
        headers=_h(token),
        json={"version": source["version"]},
    )


def _events(env: Env, name: str) -> list[dict[str, Any]]:  # noqa: F811
    return [d for _u, d in env.audit.named(name, None)]


# --- The location -------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("location", "expected"),
    [
        ("s3://docs-rrhh/politicas/", ("docs-rrhh", "politicas/")),
        ("s3://docs-rrhh/", ("docs-rrhh", "")),
        ("s3://docs.rrhh/a/b c/", ("docs.rrhh", "a/b c/")),
    ],
)
def test_a_location_is_a_bucket_and_a_prefix(location: str, expected: tuple[str, str]) -> None:
    assert split_location(location) == expected


@pytest.mark.parametrize(
    "location",
    [
        "https://docs-rrhh.s3.amazonaws.com/x/",
        "s3://Docs/",
        "s3://ab/",
        "s3://192.168.0.1/",
        "s3://docs-rrhh/politicas",
        "s3://docs-rrhh//x/",
        "s3://docs-rrhh/x\ny/",
    ],
)
def test_what_is_not_a_location(location: str) -> None:
    with pytest.raises(ValueError, match=r"location|bucket|prefix"):
        split_location(location)


# --- Who proposes -------------------------------------------------------------------------


def test_the_owner_proposes_a_bucket_of_the_account_and_it_waits(env: Env, s3: FakeS3) -> None:  # noqa: F811
    kb = env.created()
    source = _proposed(env, kb)
    assert (source["bucket"], source["prefix"], source["status"]) == (
        "docs-rrhh",
        "politicas/",
        "pending",
    )
    assert source["proposed_by"]["user_id"] == "creator-1"
    # Nobody decides their own proposal.
    assert source["can_decide"] is False
    [requested, applied] = _events(env, "kb.source_propose")
    assert requested["outcome"] == "requested"
    assert applied["arn"] == "arn:aws:s3:::docs-rrhh/politicas/"
    assert s3.calls == ["docs-rrhh"]


def test_who_may_propose(env: Env, s3: FakeS3) -> None:  # noqa: F811
    kb = env.created()
    # The owner while a creator, or an administrator; not another creator of its groups.
    for token, status in (("creator2", 403), ("member", 403), ("former", 403), ("admin", 201)):
        assert _propose(env, kb, "s3://docs-legal/", token).status_code == status, token


@pytest.mark.parametrize(
    ("location", "code"),
    [
        ("s3://mango-poc-core-accesslogs1234/", "mango_bucket"),
        ("s3://mango-otra-knowledge-0a1b2c3d/", "mango_bucket"),
        ("s3://otra-cuenta/", "bucket_not_in_account"),
        ("s3://no-existe/", "bucket_not_found"),
        ("s3://con-llave/", "bucket_key_unsupported"),
    ],
)
def test_which_buckets_are_refused(env: Env, s3: FakeS3, location: str, code: str) -> None:  # noqa: F811
    response = _propose(env, env.created(), location)
    assert (response.status_code, _code(response)) == (422, code)
    assert _events(env, "kb.source_propose") == []


def test_a_bucket_without_configuration_or_with_the_managed_key_is_accepted(
    env: Env,  # noqa: F811
    s3: FakeS3,
) -> None:
    kb = env.created()
    assert _propose(env, kb, "s3://sin-config/").status_code == 201
    s3.encryption["docs-legal"]["KMSMasterKeyID"] = f"arn:aws:kms:us-east-1:{ACCOUNT}:alias/aws/s3"
    assert _propose(env, kb, "s3://docs-legal/").status_code == 201


def test_without_s3_nothing_is_proposed(env: Env, s3: FakeS3) -> None:  # noqa: F811
    s3.down = True
    response = _propose(env, env.created(), "s3://docs-rrhh/")
    assert (response.status_code, _code(response)) == (503, "source_check_unavailable")
    assert env.deps is not None
    env.deps.buckets = None
    assert _code(_propose(env, env.created(), "s3://docs-rrhh/")) == "source_check_unavailable"


def test_the_same_location_once_and_at_most_five(env: Env, s3: FakeS3) -> None:  # noqa: F811
    kb = env.created()
    _proposed(env, kb, "s3://docs-rrhh/a/")
    assert _code(_propose(env, kb, "s3://docs-rrhh/a/")) == "source_exists"
    for prefix in ("b/", "c/", "d/", "e/"):
        _proposed(env, kb, f"s3://docs-rrhh/{prefix}")
    assert _code(_propose(env, kb, "s3://docs-rrhh/f/")) == "too_many_sources"


def test_a_knowledge_base_being_deleted_takes_no_source(env: Env, s3: FakeS3) -> None:  # noqa: F811
    kb = env.created()
    assert env.delete("creator", kb).status_code == 202
    assert _code(_propose(env, kb, "s3://docs-rrhh/")) == "knowledge_base_deleting"


# --- Who decides --------------------------------------------------------------------------


def test_an_administrator_approves_what_someone_else_proposed(env: Env, s3: FakeS3) -> None:  # noqa: F811
    source = _proposed(env, env.created())
    for token in ("creator", "creator2", "member"):
        assert _decide(env, source, "approve", token).status_code == 403, token
    response = _decide(env, source, "approve")
    assert response.status_code == 200, response.text
    approved = response.json()
    assert (approved["status"], approved["version"]) == ("approved", 2)
    assert approved["decided_at"] is not None
    # The bucket was checked again when it was approved.
    assert s3.calls == ["docs-rrhh", "docs-rrhh"]
    [applied] = [e for e in _events(env, "kb.source_approve") if e["outcome"] == "applied"]
    assert applied["arn"] == "arn:aws:s3:::docs-rrhh/politicas/"
    # Decided once.
    assert _code(_decide(env, approved, "reject")) == "source_decided"


def test_an_administrator_never_decides_their_own_proposal(env: Env, s3: FakeS3) -> None:  # noqa: F811
    # D88 (20): also when the proposer is an administrator.
    source = _propose(env, env.created(), "s3://docs-rrhh/", "admin").json()
    for verb in ("approve", "reject"):
        response = _decide(env, source, verb)
        assert (response.status_code, _code(response)) == (403, "own_proposal")


def test_the_table_refuses_a_decision_by_the_proposer_too(env: Env, s3: FakeS3) -> None:  # noqa: F811
    from mango_api.knowledge_store import KnowledgeConflictError  # noqa: PLC0415
    from mango_core.knowledge import SourceStatus  # noqa: PLC0415

    source = _proposed(env, env.created())
    assert env.deps is not None
    stored = env.deps.store.source(source["kb_id"], source["src_id"])
    assert stored is not None
    with pytest.raises(KnowledgeConflictError):
        env.deps.store.set_source_status(
            stored, SourceStatus.APPROVED, by="creator-1", now="x", not_proposed_by="creator-1"
        )


def test_a_bucket_that_changed_is_not_approved(env: Env, s3: FakeS3) -> None:  # noqa: F811
    source = _proposed(env, env.created())
    s3.owners["docs-rrhh"] = OTHER_ACCOUNT
    response = _decide(env, source, "approve")
    assert (response.status_code, _code(response)) == (422, "bucket_not_in_account")
    assert _events(env, "kb.source_approve") == []


def test_a_rejection_is_audited_and_a_stale_decision_refused(env: Env, s3: FakeS3) -> None:  # noqa: F811
    source = _proposed(env, env.created())
    stale = {**source, "version": 7}
    assert _code(_decide(env, stale, "reject")) == "version_conflict"
    rejected = _decide(env, source, "reject").json()
    assert rejected["status"] == "rejected"
    assert [e["outcome"] for e in _events(env, "kb.source_reject")] == ["requested", "applied"]


# --- The administrators' list and removing ------------------------------------------------


def test_administrators_see_what_they_may_sign_and_never_their_own(env: Env, s3: FakeS3) -> None:  # noqa: F811
    kb = env.created()
    theirs = _proposed(env, kb, "s3://docs-rrhh/a/")
    own = _propose(env, kb, "s3://docs-rrhh/b/", "admin").json()
    pending = env.client.get("/api/knowledge-sources/pending", headers=_h("admin")).json()
    assert [s["src_id"] for s in pending["items"]] == [theirs["src_id"]]
    assert pending["items"][0]["knowledge_base"] == kb["name"]
    assert pending["items"][0]["can_decide"] is True
    # A creator signs nothing.
    assert env.client.get("/api/knowledge-sources/pending", headers=_h("creator")).json() == {
        "items": []
    }
    # Once decided, it is no longer pending.
    _decide(env, theirs, "approve")
    pending = env.client.get("/api/knowledge-sources/pending", headers=_h("admin")).json()
    assert pending["items"] == []
    assert own["status"] == "pending"


def test_the_sources_are_listed_to_who_sees_the_documents(env: Env, s3: FakeS3) -> None:  # noqa: F811
    kb = env.created()
    _proposed(env, kb)
    for token, status in (("creator2", 200), ("admin", 200), ("outsider", 403)):
        response = env.client.get(_sources(kb), headers=_h(token))
        assert response.status_code == status, token
    [listed] = env.client.get(_sources(kb), headers=_h("creator2")).json()["items"]
    # The proposer's email only for administrators, the owner and the proposer.
    assert listed["proposed_by"]["email"] is None
    [listed] = env.client.get(_sources(kb), headers=_h("admin")).json()["items"]
    assert listed["proposed_by"]["email"] == "creator1@example.com"


def test_removing_withdraws_a_pending_source_and_removes_an_approved_one(
    env: Env,  # noqa: F811
    s3: FakeS3,
) -> None:
    kb = env.created()
    pending = _proposed(env, kb, "s3://docs-rrhh/a/")
    approved = _decide(env, _proposed(env, kb, "s3://docs-rrhh/b/"), "approve").json()
    path = f"{_sources(kb)}/{{}}/delete"
    withdrawn = env.client.post(
        path.format(pending["src_id"]), headers=_h("creator"), json={"version": 1}
    ).json()
    assert withdrawn["status"] == "withdrawn"
    removing = env.client.post(
        path.format(approved["src_id"]), headers=_h("creator"), json={"version": 2}
    ).json()
    assert removing["status"] == "removing"
    again = env.client.post(
        path.format(approved["src_id"]), headers=_h("creator"), json={"version": 3}
    )
    assert _code(again) == "source_inactive"
    # Withdrawn and removing free their place: the same location may be proposed again later.
    assert _propose(env, kb, "s3://docs-rrhh/a/").status_code == 201
    assert [e["outcome"] for e in _events(env, "kb.source_remove")].count("applied") == 2


def test_nothing_is_written_without_its_audit(env: Env, s3: FakeS3) -> None:  # noqa: F811
    kb = env.created()
    env.audit.fail_outcomes = {"requested"}
    assert _code(_propose(env, kb, "s3://docs-rrhh/")) == "audit_unavailable"
    env.audit.fail_outcomes = set()
    assert env.client.get(_sources(kb), headers=_h("creator")).json() == {"items": []}
    assert "docs-rrhh" not in json.dumps(env.audit.events)


# --- The role of a source (D88 (10), PR 7b) -----------------------------------------------


@dataclass
class FakeRoles:
    """``Mango-<ns>-KnowledgeSources``: records what it is asked and sets the ARN like it."""

    env: Env
    fail: str | None = None
    calls: list[tuple[str, str]] = field(default_factory=list)

    def _set(self, kb_id: str, src_id: str, arn: str | None) -> None:
        key = {"PK": {"S": f"KB#{kb_id}"}, "SK": {"S": f"SRC#{src_id}"}}
        self.env.db.update_item(
            TableName="knowledge",
            Key=key,
            UpdateExpression="SET role_arn = :a" if arn else "REMOVE role_arn",
            **({"ExpressionAttributeValues": {":a": {"S": arn}}} if arn else {}),
        )

    def ensure(self, kb_id: str, src_id: str) -> None:
        from mango_api.knowledge_sources import SourceRoleError  # noqa: PLC0415

        self.calls.append(("ensure", src_id))
        if self.fail:
            raise SourceRoleError(self.fail)
        self._set(kb_id, src_id, f"arn:aws:iam::{ACCOUNT}:role/Mango-test-kbsrc-{src_id}")

    def delete(self, kb_id: str, src_id: str) -> None:
        self.calls.append(("delete", src_id))
        self._set(kb_id, src_id, None)


@pytest.fixture
def roles(env: Env) -> FakeRoles:  # noqa: F811
    fake = FakeRoles(env)
    assert env.deps is not None
    env.deps.source_roles = fake
    return fake


def test_an_approval_creates_the_role_of_the_source_by_its_ids(
    env: Env,  # noqa: F811
    s3: FakeS3,
    roles: FakeRoles,
) -> None:
    source = _proposed(env, env.created())
    assert source["role_ready"] is False
    # Proposing creates nothing: nothing is read before an approval (D88 (20)).
    assert roles.calls == []
    approved = _decide(env, source, "approve").json()
    assert roles.calls == [("ensure", source["src_id"])]
    assert approved["role_ready"] is True
    assert [e["outcome"] for e in _events(env, "kb.source_role")] == ["requested", "applied"]
    # A rejection creates nothing.
    _decide(env, _proposed(env, env.created(), "s3://docs-legal/"), "reject")
    assert len(roles.calls) == 1


def test_an_approval_stands_when_the_role_fails_and_says_so(
    env: Env,  # noqa: F811
    s3: FakeS3,
    roles: FakeRoles,
) -> None:
    roles.fail = "iam_AccessDenied"
    response = _decide(env, _proposed(env, env.created()), "approve")
    assert response.status_code == 200
    assert (response.json()["status"], response.json()["role_ready"]) == ("approved", False)
    [_requested, failed] = _events(env, "kb.source_role")
    assert (failed["outcome"], failed["reason"]) == ("failed", "iam_AccessDenied")


def test_removing_an_approved_source_deletes_its_role(
    env: Env,  # noqa: F811
    s3: FakeS3,
    roles: FakeRoles,
) -> None:
    kb = env.created()
    approved = _decide(env, _proposed(env, kb), "approve").json()
    pending = _proposed(env, kb, "s3://docs-legal/")
    path = f"{_sources(kb)}/{{}}/delete"
    removed = env.client.post(
        path.format(approved["src_id"]), headers=_h("creator"), json={"version": 2}
    ).json()
    assert (removed["status"], removed["role_ready"]) == ("removing", False)
    env.client.post(path.format(pending["src_id"]), headers=_h("creator"), json={"version": 1})
    # A withdrawn proposal never had a role.
    assert roles.calls == [("ensure", approved["src_id"]), ("delete", approved["src_id"])]


def test_the_function_is_invoked_with_ids_only() -> None:
    from mango_api.knowledge_sources import SourceRoleError, SourceRoleFunction  # noqa: PLC0415

    class Payload:
        def __init__(self, body: bytes) -> None:
            self.body = body

        def read(self) -> bytes:
            return self.body

    sent: list[dict[str, Any]] = []

    class Lambda:
        answer: bytes = b'{"outcome": "created"}'
        error: str | None = None

        def invoke(self, **kwargs: Any) -> dict[str, Any]:
            sent.append(kwargs)
            response: dict[str, Any] = {"Payload": Payload(self.answer)}
            if self.error:
                response["FunctionError"] = self.error
            return response

    client = Lambda()
    function = SourceRoleFunction(client, "Mango-test-KnowledgeSources")
    function.ensure("KB1", "SRC1")
    assert json.loads(sent[0]["Payload"]) == {"op": "ensure", "kb_id": "KB1", "src_id": "SRC1"}
    assert sent[0]["InvocationType"] == "RequestResponse"
    client.answer = b'{"error": "role_without_boundary"}'
    with pytest.raises(SourceRoleError, match="role_without_boundary"):
        function.delete("KB1", "SRC1")
    client.answer, client.error = b"{}", "Unhandled"
    with pytest.raises(SourceRoleError, match="function_error"):
        function.ensure("KB1", "SRC1")


def test_an_approval_starts_the_first_copy_and_a_removal_its_cleanup(
    env: Env,  # noqa: F811
    s3: FakeS3,
    roles: FakeRoles,
) -> None:
    kb = env.created()
    approved = _decide(env, _proposed(env, kb), "approve").json()
    [started] = env.sfn.started
    assert started["input"]["requested_by"]["user_id"] == "admin-1"
    env.client.post(
        f"{_sources(kb)}/{approved['src_id']}/delete", headers=_h("creator"), json={"version": 2}
    )
    # Queued behind the one running, as whoever removed it.
    meta = env.db.get_item(
        TableName="knowledge", Key={"PK": {"S": f"KB#{kb['kb_id']}"}, "SK": {"S": "META"}}
    )["Item"]
    assert "sync_again" in meta


def test_an_approval_without_a_role_starts_nothing(env: Env, s3: FakeS3, roles: FakeRoles) -> None:  # noqa: F811
    roles.fail = "iam_AccessDenied"
    _decide(env, _proposed(env, env.created()), "approve")
    assert env.sfn.started == []
