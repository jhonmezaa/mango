"""The owner's token for one task run (D78; ``mango_core.task_identity`` has the protocol).

mango-api starts ``CUSTOM_AUTH`` on the tasks client of the user pool for the owner of the
task, signs the answer to the challenge with the task identity key in KMS and gets an access
token of that person with the groups they have now. The token is verified like any other
(JWKS, issuer, expiry, client and use) before anything is done with it.

Whether the owner lost access (D26) is decided before the flow starts, from the user pool
itself (``ListUsers`` by subject): a person who no longer exists, is disabled or was never
confirmed. Anything that fails after that (the flow, the challenge, throttling, KMS) is a failed
run, never a pause: a task is never paused because AWS had a bad minute.

The tasks client has a secret (D78, after the review of 2026-10-15): nobody but mango-api can
start its flow. The secret lives in Secrets Manager; mango-api reads it once and only computes
``SECRET_HASH`` with it. It is never logged.

The refresh token Cognito also issues is never kept: it is revoked at once (best effort).
Tokens are never logged.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from botocore.exceptions import BotoCoreError, ClientError

from mango_api.web import Caller
from mango_core import task_identity
from mango_core.identity import AccessTokenVerifier, IdentityError, NoGroupError, user_from_claims

if TYPE_CHECKING:
    from mypy_boto3_cognito_idp import CognitoIdentityProviderClient
    from mypy_boto3_kms import KMSClient

logger = logging.getLogger(__name__)

_SUB_RE = re.compile(r"^[A-Za-z0-9-]{1,64}$")
"""A Cognito subject (a UUID); anything else never reaches a ``ListUsers`` filter."""
_NOT_SIGNING_IN = frozenset({"UNCONFIRMED", "ARCHIVED", "COMPROMISED", "UNKNOWN"})
"""States of a person who may not sign in (``UserStatus``)."""


class OwnerAccessLostError(Exception):
    """The owner of the task may not act any more: the run is skipped and the task pauses."""


class TaskIdentityUnavailableError(Exception):
    """No token could be obtained for a reason that says nothing about the owner."""


@dataclass(frozen=True)
class TaskTokens:
    cognito: CognitoIdentityProviderClient
    kms: KMSClient
    user_pool_id: str
    client_id: str
    key_arn: str
    verifier: AccessTokenVerifier
    client_secret: str = field(default="", repr=False)
    """Secret of the tasks client (Secrets Manager); never logged nor shown."""
    clock: Callable[[], float] = time.time

    def _secret_hash(self, username: str) -> dict[str, str]:
        if not self.client_secret:
            return {}
        digest = hmac.new(
            self.client_secret.encode(), (username + self.client_id).encode(), hashlib.sha256
        ).digest()
        return {"SECRET_HASH": base64.b64encode(digest).decode()}

    def caller_for(self, owner_id: str, run_id: str) -> Caller:
        """The owner, as a verified caller with a token issued for this run."""
        username = self._username(owner_id)
        try:
            started = self.cognito.admin_initiate_auth(
                UserPoolId=self.user_pool_id,
                ClientId=self.client_id,
                AuthFlow="CUSTOM_AUTH",
                AuthParameters={"USERNAME": username, **self._secret_hash(username)},
            )
        except (ClientError, BotoCoreError) as exc:
            # The person was there a moment ago: a refusal now is the challenge, the user
            # pool's protection or the network, not the person (TM-T3). A failed run.
            raise TaskIdentityUnavailableError from exc
        try:
            nonce = started.get("ChallengeParameters", {}).get(task_identity.NONCE_PARAMETER, "")
            if started.get("ChallengeName") != task_identity.CHALLENGE_NAME or not nonce:
                raise TaskIdentityUnavailableError
            claims = task_identity.encode_claims(
                subject=owner_id,
                run_id=run_id,
                nonce=nonce,
                client_id=self.client_id,
                expires_at=int(self.clock()) + task_identity.TTL_SECONDS,
            )
            signature = self.kms.sign(
                KeyId=self.key_arn,
                Message=task_identity.signing_digest(claims),
                MessageType="DIGEST",
                SigningAlgorithm=task_identity.SIGNING_ALGORITHM,
            )["Signature"]
            answered = self.cognito.admin_respond_to_auth_challenge(
                UserPoolId=self.user_pool_id,
                ClientId=self.client_id,
                ChallengeName=task_identity.CHALLENGE_NAME,
                Session=started["Session"],
                ChallengeResponses={
                    "USERNAME": username,
                    "ANSWER": task_identity.assemble(claims, signature),
                    **self._secret_hash(username),
                },
            )
        except (ClientError, BotoCoreError, KeyError, ValueError) as exc:
            # A refused answer says nothing about the person (our key, our clock): a failed
            # run, never a pause.
            raise TaskIdentityUnavailableError from exc
        result = answered.get("AuthenticationResult", {})
        token = result.get("AccessToken")
        if not token:
            # Another challenge, or none: the reply is not what this client can produce.
            raise TaskIdentityUnavailableError
        refresh = result.get("RefreshToken")
        if refresh:
            self._revoke(refresh)
        try:
            verified = self.verifier.verify(token)
            user = user_from_claims(verified)
        except NoGroupError as exc:
            # A verified person without any Mango group (D20): no access at all.
            raise OwnerAccessLostError from exc
        except IdentityError as exc:
            raise TaskIdentityUnavailableError from exc
        if user.user_id != owner_id:
            logger.error("the token of a task run belongs to someone else")
            raise TaskIdentityUnavailableError
        return Caller(user=user, token=token, expires_at=int(verified["exp"]))

    def _username(self, owner_id: str) -> str:
        """The Cognito user name of the owner, found by subject. With the email as user name
        attribute it is the subject itself; a federated person (D20, SSO) has another one."""
        if not _SUB_RE.fullmatch(owner_id):
            # Never part of a filter expression unless it is plainly a subject.
            raise TaskIdentityUnavailableError
        try:
            users = self.cognito.list_users(
                UserPoolId=self.user_pool_id,
                Filter=f'sub = "{owner_id}"',
                Limit=1,
                AttributesToGet=[],
            ).get("Users", [])
        except (ClientError, BotoCoreError) as exc:
            raise TaskIdentityUnavailableError from exc
        if not users or not users[0].get("Username"):
            # The person no longer exists: no access at all (D26).
            raise OwnerAccessLostError
        person = users[0]
        if person.get("Enabled") is False or person.get("UserStatus") in _NOT_SIGNING_IN:
            # Disabled, or may not sign in: the same as a person who left.
            raise OwnerAccessLostError
        return str(person["Username"])

    def _revoke(self, refresh_token: str) -> None:
        try:
            self.cognito.revoke_token(
                Token=refresh_token,
                ClientId=self.client_id,
                **({"ClientSecret": self.client_secret} if self.client_secret else {}),
            )
        except (ClientError, BotoCoreError):
            # It dies with its validity (the shortest Cognito allows) and is never stored.
            logger.warning("the refresh token of a task run could not be revoked")
