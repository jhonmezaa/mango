"""The owner's token for one task run (D78, TM-T1): what Cognito answers decides a pause."""

from __future__ import annotations

import base64
import hashlib
import hmac
from dataclasses import dataclass, field
from typing import Any

import pytest
from botocore.exceptions import ClientError
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils

from mango_api.task_identity import (
    OwnerAccessLostError,
    TaskIdentityUnavailableError,
    TaskTokens,
)
from mango_core import task_identity
from mango_core.identity import IdentityError

SUB = "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0"
RUN = "a" * 32
CLIENT = "tasksclient"
KEY = ec.generate_private_key(ec.SECP256R1())
PUBLIC = KEY.public_key().public_bytes(
    serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
)


SECRET = "s3cr3t-of-the-tasks-client"


def _hash(username: str) -> str:
    """SECRET_HASH as Cognito defines it: HMAC-SHA256(secret, username + client id), base64."""
    digest = hmac.new(SECRET.encode(), (username + CLIENT).encode(), hashlib.sha256).digest()
    return base64.b64encode(digest).decode()


def _error(code: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": "x"}}, "op")


@dataclass
class FakeKms:
    def sign(self, **request: Any) -> dict[str, Any]:
        assert request["MessageType"] == "DIGEST"
        signature = KEY.sign(request["Message"], ec.ECDSA(utils.Prehashed(hashes.SHA256())))
        return {"Signature": signature}


@dataclass
class FakeCognito:
    """The challenge Lambda's checks, done here with the public half of the key."""

    username: str | None = SUB
    enabled: bool = True
    status: str = "CONFIRMED"
    initiate_error: str | None = None
    respond_error: str | None = None
    revoked: list[str] = field(default_factory=list)
    nonce: str = "n" * 43

    def list_users(self, **request: Any) -> dict[str, Any]:
        assert request["Filter"] == f'sub = "{SUB}"'
        user = {"Username": self.username, "Enabled": self.enabled, "UserStatus": self.status}
        return {"Users": [user] if self.username else []}

    def admin_initiate_auth(self, **request: Any) -> dict[str, Any]:
        assert (request["AuthFlow"], request["ClientId"]) == ("CUSTOM_AUTH", CLIENT)
        assert request["AuthParameters"] == {
            "USERNAME": self.username,
            "SECRET_HASH": _hash(str(self.username)),
        }
        if self.initiate_error:
            raise _error(self.initiate_error)
        return {
            "ChallengeName": "CUSTOM_CHALLENGE",
            "Session": "s",
            "ChallengeParameters": {"nonce": self.nonce},
        }

    def admin_respond_to_auth_challenge(self, **request: Any) -> dict[str, Any]:
        if self.respond_error:
            raise _error(self.respond_error)
        assert request["ChallengeResponses"]["SECRET_HASH"] == _hash(str(self.username))
        verified = task_identity.TaskIdentityVerifier(PUBLIC).verify(
            request["ChallengeResponses"]["ANSWER"], subject=SUB, nonce=self.nonce, client_id=CLIENT
        )
        assert verified.run_id == RUN
        return {"AuthenticationResult": {"AccessToken": "token", "RefreshToken": "refresh"}}

    def revoke_token(self, **request: Any) -> dict[str, Any]:
        assert request["ClientSecret"] == SECRET
        self.revoked.append(request["Token"])
        return {}


@dataclass
class FakeVerifier:
    claims: dict[str, Any] = field(
        default_factory=lambda: {
            "sub": SUB,
            "cognito:groups": ["finops-central"],
            "exp": 2_000_000_000,
        }
    )

    def verify(self, token: str) -> dict[str, Any]:
        if token != "token":
            raise IdentityError("invalid")
        return self.claims


def _tokens(cognito: FakeCognito, verifier: FakeVerifier | None = None) -> TaskTokens:
    return TaskTokens(
        cognito=cognito,  # type: ignore[arg-type]
        kms=FakeKms(),  # type: ignore[arg-type]
        user_pool_id="pool",
        client_id=CLIENT,
        key_arn="arn:aws:kms:us-east-1:111122223333:key/k",
        verifier=verifier or FakeVerifier(),  # type: ignore[arg-type]
        client_secret=SECRET,
    )


def test_the_owner_gets_a_token_for_this_run_and_the_refresh_token_is_revoked() -> None:
    cognito = FakeCognito()
    caller = _tokens(cognito).caller_for(SUB, RUN)
    assert (caller.user.user_id, caller.token) == (SUB, "token")
    assert cognito.revoked == ["refresh"]


def test_a_federated_person_signs_in_with_their_own_user_name() -> None:
    cognito = FakeCognito(username="okta_user-7")
    assert _tokens(cognito).caller_for(SUB, RUN).user.user_id == SUB


@pytest.mark.parametrize(
    "cognito",
    [
        FakeCognito(enabled=False),
        FakeCognito(status="UNCONFIRMED"),
        # A3 of the second review: who must set a new password first acts through no task.
        FakeCognito(status="RESET_REQUIRED"),
        FakeCognito(status="FORCE_CHANGE_PASSWORD"),
    ],
)
def test_a_disabled_or_unconfirmed_person_has_lost_access(cognito: FakeCognito) -> None:
    """Decided from the user pool before the flow (H3 of the review)."""
    with pytest.raises(OwnerAccessLostError):
        _tokens(cognito).caller_for(SUB, RUN)


def test_a_person_who_is_not_in_the_pool_has_lost_access() -> None:
    with pytest.raises(OwnerAccessLostError):
        _tokens(FakeCognito(username=None)).caller_for(SUB, RUN)


def test_a_person_without_groups_has_lost_access() -> None:
    verifier = FakeVerifier(claims={"sub": SUB, "exp": 2_000_000_000})
    with pytest.raises(OwnerAccessLostError):
        _tokens(FakeCognito(), verifier).caller_for(SUB, RUN)


@pytest.mark.parametrize(
    "cognito",
    [
        FakeCognito(initiate_error="TooManyRequestsException"),
        # The challenge function could not read its parameter (SSM), or the user pool's
        # protection refused the flow: Cognito says «not authorized», the person is fine.
        FakeCognito(initiate_error="NotAuthorizedException"),
        FakeCognito(initiate_error="UserNotFoundException"),
        # A refused answer is our key or our clock, never the person: no pause.
        FakeCognito(respond_error="NotAuthorizedException"),
    ],
)
def test_anything_else_is_a_failed_run_never_a_pause(cognito: FakeCognito) -> None:
    with pytest.raises(TaskIdentityUnavailableError):
        _tokens(cognito).caller_for(SUB, RUN)


def test_a_token_of_someone_else_is_never_used() -> None:
    verifier = FakeVerifier(
        claims={"sub": "other", "cognito:groups": ["finops-central"], "exp": 2_000_000_000}
    )
    with pytest.raises(TaskIdentityUnavailableError):
        _tokens(FakeCognito(), verifier).caller_for(SUB, RUN)


def test_a_subject_that_is_not_one_never_reaches_a_filter() -> None:
    with pytest.raises(TaskIdentityUnavailableError):
        _tokens(FakeCognito()).caller_for('x" or name = "y', RUN)
