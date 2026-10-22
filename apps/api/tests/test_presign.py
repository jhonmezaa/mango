"""The credentials that sign URLs a browser uses (D86 (4), D88 (9); GuardDuty finding of
2026-10-21): the presign role, one session per person, never the task's credentials."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import parse_qs, urlparse

import boto3
import pytest
from botocore.exceptions import ClientError

from mango_api import presign
from mango_api.presign import (
    LONGEST_URL_SECONDS,
    SESSION_SECONDS,
    PresignSessions,
    SigningUnavailableError,
)
from mango_api.task_reports import S3Links
from mango_api.tasks_store import Run, RunStatus

ROLE = "arn:aws:iam::111122223333:role/Mango-test-Presign"
NOW = 1_800_000_000.0


@dataclass
class FakeSts:
    calls: list[dict[str, Any]] = field(default_factory=list)
    fail: bool = False

    def assume_role(self, **request: Any) -> dict[str, Any]:
        if self.fail:
            raise ClientError({"Error": {"Code": "AccessDenied"}}, "AssumeRole")
        self.calls.append(request)
        n = len(self.calls)
        return {
            "Credentials": {
                "AccessKeyId": f"ASIAPRESIGN{n:09d}",
                "SecretAccessKey": f"secret-{n}",
                "SessionToken": f"presign-token-{n}",
                "Expiration": datetime.fromtimestamp(NOW, UTC)
                + timedelta(seconds=request["DurationSeconds"]),
            }
        }


@dataclass
class Clock:
    now: float = NOW

    def __call__(self) -> float:
        return self.now


def _sessions(sts: FakeSts, clock: Clock) -> PresignSessions:
    return PresignSessions(
        sts,
        ROLE,
        "us-east-1",
        clock=clock,
        client_factory=lambda c: boto3.client(
            "s3",
            region_name="us-east-1",
            config=presign.S3_CONFIG,
            aws_access_key_id=c["AccessKeyId"],
            aws_secret_access_key=c["SecretAccessKey"],
            aws_session_token=c["SessionToken"],
        ),
    )


def test_each_person_signs_with_a_session_of_the_presign_role_named_after_them() -> None:
    sts, clock = FakeSts(), Clock()
    sessions = _sessions(sts, clock)
    sessions.s3_for("user-1")
    [call] = sts.calls
    assert call == {
        "RoleArn": ROLE,
        "RoleSessionName": "mango-presign",
        "SourceIdentity": "user-1",
        "DurationSeconds": SESSION_SECONDS,
    }
    # The same person reuses it; another person gets their own.
    sessions.s3_for("user-1")
    sessions.s3_for("user-2")
    assert [c["SourceIdentity"] for c in sts.calls] == ["user-1", "user-2"]


def test_a_session_is_renewed_before_it_has_less_life_than_the_longest_url() -> None:
    sts, clock = FakeSts(), Clock()
    sessions = _sessions(sts, clock)
    sessions.s3_for("user-1")
    clock.now = NOW + SESSION_SECONDS - LONGEST_URL_SECONDS - 120
    sessions.s3_for("user-1")
    assert len(sts.calls) == 1
    clock.now = NOW + SESSION_SECONDS - LONGEST_URL_SECONDS
    sessions.s3_for("user-1")
    assert len(sts.calls) == 2


def test_the_cache_keeps_at_most_its_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(presign, "MAX_SESSIONS", 2)
    sts = FakeSts()
    sessions = _sessions(sts, Clock())
    for user in ("a1", "b1", "c1", "a1"):
        sessions.s3_for(user)
    assert [c["SourceIdentity"] for c in sts.calls] == ["a1", "b1", "c1", "a1"]


@pytest.mark.parametrize("user", ["", "x", "a b", "a/b", "x" * 65])
def test_only_what_sts_takes_as_a_source_identity(user: str) -> None:
    with pytest.raises(SigningUnavailableError):
        _sessions(FakeSts(), Clock()).s3_for(user)


def test_a_role_that_cannot_be_assumed_signs_nothing() -> None:
    sts = FakeSts(fail=True)
    with pytest.raises(SigningUnavailableError):
        _sessions(sts, Clock()).s3_for("user-1")


def _run() -> Run:
    return Run(
        run_id="b" * 32,
        automation_id="a" * 32,
        trigger="manual",
        status=RunStatus.OK,
        queued_at=0,
        report_meta={"file": "informe-2026-10-21-0a1b.pdf"},
    )


def test_a_pdf_link_is_signed_by_the_owner_session_of_the_presign_role() -> None:
    sts = FakeSts()
    links = S3Links(_sessions(sts, Clock()), "reports-bucket")
    run = _run()
    url = links.link(run, owner_id="owner-1")
    query = parse_qs(urlparse(url).query)
    assert query["X-Amz-Security-Token"] == ["presign-token-1"]
    assert query["X-Amz-Credential"][0].startswith("ASIAPRESIGN000000001/")
    assert sts.calls[0]["SourceIdentity"] == "owner-1"


def test_without_the_presign_role_no_pdf_link_is_issued() -> None:
    run = _run()
    with pytest.raises(SigningUnavailableError):
        S3Links(None, "reports-bucket").link(run, owner_id="owner-1")
