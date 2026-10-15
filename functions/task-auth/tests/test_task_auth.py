"""The custom auth challenge of task runs (D78, TM-T1, TM-T2)."""

from __future__ import annotations

import time
from typing import Any

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils

from mango_core import task_identity
from mango_task_auth import handler

CLIENT = "tasksclient"
SUB = "user-1"
RUN = "a" * 32


@pytest.fixture
def key(monkeypatch: pytest.MonkeyPatch) -> ec.EllipticCurvePrivateKey:
    private = ec.generate_private_key(ec.SECP256R1())
    public = private.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    monkeypatch.setattr(handler, "_verifier", lambda: task_identity.TaskIdentityVerifier(public))
    monkeypatch.setattr(handler, "_tasks_client_id", lambda: CLIENT)
    return private


def _event(source: str, client: str = CLIENT, **request: Any) -> dict[str, Any]:
    return {
        "triggerSource": source,
        "callerContext": {"clientId": client},
        "request": {"userAttributes": {"sub": SUB}, **request},
        "response": {},
    }


def _answer(key: ec.EllipticCurvePrivateKey, nonce: str, subject: str = SUB) -> str:
    claims = task_identity.encode_claims(
        subject=subject, run_id=RUN, nonce=nonce, client_id=CLIENT, expires_at=int(time.time()) + 30
    )
    signature = key.sign(
        task_identity.signing_digest(claims), ec.ECDSA(utils.Prehashed(hashes.SHA256()))
    )
    return task_identity.assemble(claims, signature)


def _round(key: ec.EllipticCurvePrivateKey, answer: str | None = None) -> bool:
    """One whole flow: define, create, verify, define. True when tokens are issued."""
    first = handler.lambda_handler(_event(handler._DEFINE, session=[]), None)
    assert first["response"]["challengeName"] == "CUSTOM_CHALLENGE"
    created = handler.lambda_handler(
        _event(handler._CREATE, challengeName="CUSTOM_CHALLENGE", session=[]), None
    )["response"]
    nonce = created["privateChallengeParameters"]["nonce"]
    assert created["publicChallengeParameters"]["nonce"] == nonce
    verified = handler.lambda_handler(
        _event(
            handler._VERIFY,
            privateChallengeParameters={"nonce": nonce},
            challengeAnswer=answer if answer is not None else _answer(key, nonce),
        ),
        None,
    )["response"]["answerCorrect"]
    session = [
        {
            "challengeName": "CUSTOM_CHALLENGE",
            "challengeResult": verified,
            "challengeMetadata": created["challengeMetadata"],
        }
    ]
    final = handler.lambda_handler(_event(handler._DEFINE, session=session), None)["response"]
    return bool(final["issueTokens"]) and not final["failAuthentication"]


def test_a_signed_answer_gets_tokens(key: ec.EllipticCurvePrivateKey) -> None:
    assert _round(key)


def test_an_unsigned_or_foreign_answer_gets_nothing(key: ec.EllipticCurvePrivateKey) -> None:
    assert not _round(key, "v1.e30.AAAA")
    other = ec.generate_private_key(ec.SECP256R1())
    assert not _round(key, _answer(other, "x" * 43))


def test_an_answer_for_another_person_gets_nothing(key: ec.EllipticCurvePrivateKey) -> None:
    created = handler.lambda_handler(
        _event(handler._CREATE, challengeName="CUSTOM_CHALLENGE"), None
    )["response"]
    nonce = created["privateChallengeParameters"]["nonce"]
    verified = handler.lambda_handler(
        _event(
            handler._VERIFY,
            privateChallengeParameters={"nonce": nonce},
            challengeAnswer=_answer(key, nonce, subject="user-2"),
        ),
        None,
    )
    assert verified["response"]["answerCorrect"] is False


def test_an_answer_to_an_earlier_challenge_gets_nothing(key: ec.EllipticCurvePrivateKey) -> None:
    """Each challenge has its own nonce: a captured answer cannot be replayed."""
    old = _answer(key, "o" * 43)
    created = handler.lambda_handler(
        _event(handler._CREATE, challengeName="CUSTOM_CHALLENGE"), None
    )["response"]
    verified = handler.lambda_handler(
        _event(
            handler._VERIFY,
            privateChallengeParameters={"nonce": created["privateChallengeParameters"]["nonce"]},
            challengeAnswer=old,
        ),
        None,
    )
    assert verified["response"]["answerCorrect"] is False


@pytest.mark.usefixtures("key")
def test_another_client_never_gets_a_challenge_nor_tokens() -> None:
    define = handler.lambda_handler(_event(handler._DEFINE, client="webclient", session=[]), None)
    assert define["response"]["failAuthentication"] is True
    assert "challengeName" not in define["response"]
    issued = handler.lambda_handler(
        _event(
            handler._DEFINE,
            client="webclient",
            session=[
                {
                    "challengeName": "CUSTOM_CHALLENGE",
                    "challengeResult": True,
                    "challengeMetadata": "MANGO_TASK",
                }
            ],
        ),
        None,
    )
    assert issued["response"]["issueTokens"] is False


@pytest.mark.usefixtures("key")
@pytest.mark.parametrize(
    "session",
    [
        [
            {
                "challengeName": "CUSTOM_CHALLENGE",
                "challengeResult": False,
                "challengeMetadata": "MANGO_TASK",
            }
        ],
        [{"challengeName": "PASSWORD_VERIFIER", "challengeResult": True}],
        [{"challengeName": "CUSTOM_CHALLENGE", "challengeResult": True}],
        [
            {
                "challengeName": "CUSTOM_CHALLENGE",
                "challengeResult": False,
                "challengeMetadata": "MANGO_TASK",
            },
            {
                "challengeName": "CUSTOM_CHALLENGE",
                "challengeResult": True,
                "challengeMetadata": "MANGO_TASK",
            },
        ],
    ],
)
def test_only_one_correct_challenge_issues_tokens(session: list[dict[str, Any]]) -> None:
    """A wrong answer is never retried in the same flow, and no other challenge counts."""
    response = handler.lambda_handler(_event(handler._DEFINE, session=session), None)["response"]
    assert response["issueTokens"] is False
    assert response["failAuthentication"] is True


@pytest.mark.usefixtures("key")
def test_an_unknown_user_gets_the_same_challenge_and_never_tokens() -> None:
    """No answer tells whether a person exists (AGENTS.md, D20): same challenge, then failure."""
    first = handler.lambda_handler(_event(handler._DEFINE, session=[], userNotFound=True), None)
    assert first["response"]["challengeName"] == "CUSTOM_CHALLENGE"
    assert first["response"]["failAuthentication"] is False
    unknown = _event(
        handler._VERIFY, privateChallengeParameters={"nonce": "n" * 43}, challengeAnswer="v1.x.y"
    )
    unknown["request"]["userAttributes"] = {}
    assert handler.lambda_handler(unknown, None)["response"]["answerCorrect"] is False
    # Even with a correct-looking session, a person who does not exist gets no tokens.
    final = handler.lambda_handler(
        _event(
            handler._DEFINE,
            userNotFound=True,
            session=[
                {
                    "challengeName": "CUSTOM_CHALLENGE",
                    "challengeResult": True,
                    "challengeMetadata": "MANGO_TASK",
                }
            ],
        ),
        None,
    )["response"]
    assert final["issueTokens"] is False


def test_without_the_client_parameter_everything_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    def broken() -> str:
        raise RuntimeError("ssm down")

    monkeypatch.setattr(handler, "_tasks_client_id", broken)
    response = handler.lambda_handler(_event(handler._DEFINE, session=[]), None)["response"]
    assert response["failAuthentication"] is True


def test_any_other_trigger_fails_closed() -> None:
    response = handler.lambda_handler(_event("PreSignUp_SignUp"), None)["response"]
    assert response == {"issueTokens": False, "failAuthentication": True}
