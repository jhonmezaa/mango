"""The owner's token for one task run (D78; ``mango_core.task_identity`` has the protocol).

mango-api starts ``CUSTOM_AUTH`` on the tasks client of the user pool for the owner of the
task, signs the answer to the challenge with the task identity key in KMS and gets an access
token of that person with the groups they have now. The token is verified like any other
(JWKS, issuer, expiry, client and use) before anything is done with it.

What Cognito answers decides whether the owner lost access (D26): a person who is disabled or
no longer exists gets no token. Anything else that fails (throttling, the network, KMS) is a
failed run, never a pause: a task is never paused because AWS had a bad minute.

The refresh token Cognito also issues is never kept: it is revoked at once (best effort).
Tokens are never logged.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING

from botocore.exceptions import BotoCoreError, ClientError

from mango_api.web import Caller
from mango_core import task_identity
from mango_core.identity import AccessTokenVerifier, IdentityError, NoGroupError, user_from_claims

if TYPE_CHECKING:
    from mypy_boto3_cognito_idp import CognitoIdentityProviderClient
    from mypy_boto3_kms import KMSClient

logger = logging.getLogger(__name__)

_LOST = frozenset({"NotAuthorizedException", "UserNotFoundException", "UserNotConfirmedException"})
"""What Cognito answers for a person who may not sign in any more."""


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
    clock: Callable[[], float] = time.time

    def caller_for(self, owner_id: str, run_id: str) -> Caller:
        """The owner, as a verified caller with a token issued for this run."""
        try:
            started = self.cognito.admin_initiate_auth(
                UserPoolId=self.user_pool_id,
                ClientId=self.client_id,
                AuthFlow="CUSTOM_AUTH",
                AuthParameters={"USERNAME": owner_id},
            )
        except ClientError as exc:
            # Only here does Cognito speak about the person: disabled, deleted or unconfirmed.
            if exc.response.get("Error", {}).get("Code", "") in _LOST:
                raise OwnerAccessLostError from exc
            raise TaskIdentityUnavailableError from exc
        except BotoCoreError as exc:
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
                    "USERNAME": owner_id,
                    "ANSWER": task_identity.assemble(claims, signature),
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

    def _revoke(self, refresh_token: str) -> None:
        try:
            self.cognito.revoke_token(Token=refresh_token, ClientId=self.client_id)
        except (ClientError, BotoCoreError):
            # It dies with its validity (the shortest Cognito allows) and is never stored.
            logger.warning("the refresh token of a task run could not be revoked")
