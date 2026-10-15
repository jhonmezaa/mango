"""Custom auth challenge of the tasks client of the user pool (D78, TM-T1, TM-T2).

One function serves the three triggers of ``CUSTOM_AUTH``. Cognito only calls them for a client
that allows that flow, and only the tasks client ``Mango-<ns>-tasks`` does (an infrastructure
test keeps the web client on SRP). Tokens are issued after exactly one challenge, answered
with an assertion that only mango-api can sign (``mango_core.task_identity``): this person,
this client and the nonce of this challenge, valid for a minute. Everything else fails.

* **Define:** fails for any other client or any session that is not one correct
  ``CUSTOM_CHALLENGE``. A person who does not exist gets the same challenge as one who does
  (D78, after the review): no answer tells whether an email is in the directory; the answer
  then fails at Verify, which finds no subject. MFA is not asked: it is not a sign-in of a
  person, and the password is never involved. That is exactly the power this function holds (TM-T1).
* **Create:** a random nonce, public (mango-api signs it) and private (the verifier compares).
* **Verify:** the signature with the public key of the task identity key (this function cannot
  sign), the subject of the user Cognito resolved, the nonce and the client.

The client id is read from SSM because the user pool depends on this function: an
environment variable would close a cycle. Nothing of the event is logged.
"""

from __future__ import annotations

import logging
import os
import secrets
from functools import cache
from typing import TYPE_CHECKING, Any

import boto3
from botocore.config import Config

from mango_core import task_identity

if TYPE_CHECKING:
    from mypy_boto3_kms import KMSClient
    from mypy_boto3_ssm import SSMClient

logger = logging.getLogger()
logger.setLevel(logging.INFO)

_DEFINE = "DefineAuthChallenge_Authentication"
_CREATE = "CreateAuthChallenge_Authentication"
_VERIFY = "VerifyAuthChallengeResponse_Authentication"
_METADATA = "MANGO_TASK"
# Inside the 5 s Cognito gives a trigger.
_CONFIG = Config(retries={"mode": "standard", "max_attempts": 2}, connect_timeout=1, read_timeout=2)


@cache
def _kms() -> KMSClient:
    return boto3.client("kms", config=_CONFIG)


@cache
def _ssm() -> SSMClient:
    return boto3.client("ssm", config=_CONFIG)


@cache
def _verifier() -> task_identity.TaskIdentityVerifier:
    key = _kms().get_public_key(KeyId=os.environ["TASK_IDENTITY_KEY_ARN"])
    return task_identity.TaskIdentityVerifier(key["PublicKey"])


@cache
def _tasks_client_id() -> str:
    value = _ssm().get_parameter(Name=os.environ["TASKS_CLIENT_PARAMETER"])["Parameter"]["Value"]
    if not value:
        raise RuntimeError("the tasks client id is not configured")
    return value


def _client_ok(event: dict[str, Any]) -> bool:
    client = event.get("callerContext", {}).get("clientId")
    try:
        return isinstance(client, str) and bool(client) and client == _tasks_client_id()
    except Exception:
        logger.exception("the tasks client id could not be read; failing closed")
        return False


def _define(event: dict[str, Any]) -> dict[str, Any]:
    request = event.get("request", {})
    response = event.setdefault("response", {})
    response.update({"issueTokens": False, "failAuthentication": True})
    if not _client_ok(event):
        return event
    session = request.get("session") or []
    if not session:
        response.update(
            {"challengeName": task_identity.CHALLENGE_NAME, "failAuthentication": False}
        )
        return event
    if (
        not request.get("userNotFound")
        and len(session) == 1
        and session[0].get("challengeName") == task_identity.CHALLENGE_NAME
        and session[0].get("challengeResult") is True
        and session[0].get("challengeMetadata") == _METADATA
    ):
        response.update({"issueTokens": True, "failAuthentication": False})
    return event


def _create(event: dict[str, Any]) -> dict[str, Any]:
    response = event.setdefault("response", {})
    if not _client_ok(event) or event.get("request", {}).get("challengeName") != (
        task_identity.CHALLENGE_NAME
    ):
        # Nothing to answer: the next Define fails the flow.
        response.update({"publicChallengeParameters": {}, "privateChallengeParameters": {}})
        return event
    nonce = secrets.token_urlsafe(32)
    response.update(
        {
            "publicChallengeParameters": {task_identity.NONCE_PARAMETER: nonce},
            "privateChallengeParameters": {task_identity.NONCE_PARAMETER: nonce},
            "challengeMetadata": _METADATA,
        }
    )
    return event


def _verify(event: dict[str, Any]) -> dict[str, Any]:
    request = event.get("request", {})
    response = event.setdefault("response", {})
    response["answerCorrect"] = False
    if not _client_ok(event):
        return event
    subject = request.get("userAttributes", {}).get("sub")
    nonce = request.get("privateChallengeParameters", {}).get(task_identity.NONCE_PARAMETER)
    if not isinstance(subject, str) or not isinstance(nonce, str):
        return event
    try:
        _verifier().verify(
            request.get("challengeAnswer"),
            subject=subject,
            nonce=nonce,
            client_id=event["callerContext"]["clientId"],
        )
    except task_identity.TaskIdentityError:
        logger.warning("a task identity answer was refused")
        return event
    except Exception:
        logger.exception("a task identity answer could not be checked; failing closed")
        return event
    response["answerCorrect"] = True
    return event


def lambda_handler(event: dict[str, Any], _context: object) -> dict[str, Any]:
    source = event.get("triggerSource")
    if source == _DEFINE:
        return _define(event)
    if source == _CREATE:
        return _create(event)
    if source == _VERIFY:
        return _verify(event)
    # Any other trigger is not this function's: fail closed in the shape Define reads.
    logger.error("unexpected trigger source")
    event.setdefault("response", {}).update({"issueTokens": False, "failAuthentication": True})
    return event
