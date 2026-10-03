"""Role chaining through Mango broker roles with least privilege per call.

Every cross-account call follows the chain ``connector role -> broker -> target role``:

* The first hop sets ``SourceIdentity`` to the end user, so CloudTrail in the target
  account records which person triggered the call. It cannot be changed later in the chain.
* Session tags identify the user, agent and business unit and are transitive.
* The second hop attaches an inline session policy limited to the actions the tool needs,
  so the effective permissions are the intersection of the shared role and the call.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

import boto3

if TYPE_CHECKING:
    from mypy_boto3_sts import STSClient
    from mypy_boto3_sts.type_defs import CredentialsTypeDef

# IAM constraints for SourceIdentity and session tags.
_SOURCE_IDENTITY_RE = re.compile(r"^[\w+=,.@-]{2,64}$", re.ASCII)
_TAG_KEY_RE = re.compile(r"^[\w.:/=+\-@]{1,128}$", re.ASCII)
_TAG_VALUE_RE = re.compile(r"^[\w .:/=+\-@]{0,256}$", re.ASCII)
_ACTION_RE = re.compile(r"^[a-z0-9-]+:[A-Za-z0-9]+$")
_ROLE_ARN_RE = re.compile(r"^arn:aws[a-z-]*:iam::\d{12}:role/[\w+=,.@/-]{1,128}$")

MAX_SESSION_TAGS = 50
DEFAULT_SESSION_SECONDS = 900


@dataclass(frozen=True)
class CallerIdentity:
    """End user on whose behalf a cross-account call is made.

    ``source_identity`` must come from a verified token, never from model output.
    """

    source_identity: str
    tags: Mapping[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not _SOURCE_IDENTITY_RE.fullmatch(self.source_identity):
            raise ValueError("source_identity does not satisfy IAM SourceIdentity constraints")
        if len(self.tags) > MAX_SESSION_TAGS:
            raise ValueError("too many session tags")
        for key, value in self.tags.items():
            if not _TAG_KEY_RE.fullmatch(key) or not _TAG_VALUE_RE.fullmatch(value):
                raise ValueError(f"invalid session tag {key!r}")


@dataclass(frozen=True)
class RoleChain:
    """Broker role in the Mango account and the target role it is allowed to assume."""

    broker_role_arn: str
    target_role_arn: str

    def __post_init__(self) -> None:
        for arn in (self.broker_role_arn, self.target_role_arn):
            if not _ROLE_ARN_RE.fullmatch(arn):
                raise ValueError(f"invalid role ARN {arn!r}")


def build_session_policy(actions: Sequence[str], resources: Sequence[str] = ("*",)) -> str:
    """Return an inline session policy allowing exactly ``actions``.

    Wildcard actions are rejected so a call can never widen to a whole service.
    ``resources`` defaults to ``*`` only because some APIs (e.g. Cost Explorer) do not
    support resource-level permissions; callers should pass concrete ARNs when possible.
    """
    if not actions:
        raise ValueError("at least one action is required")
    for action in actions:
        if not _ACTION_RE.fullmatch(action):
            raise ValueError(f"invalid or wildcard action {action!r}")
    if not resources:
        raise ValueError("at least one resource is required")
    policy = {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Action": sorted(set(actions)),
                "Resource": list(resources),
            }
        ],
    }
    return json.dumps(policy, separators=(",", ":"))


def _session_name(caller: CallerIdentity) -> str:
    digest = hashlib.sha256(caller.source_identity.encode()).hexdigest()[:24]
    return f"mango-{digest}"


class CrossAccountSessions:
    """Creates boto3 sessions in a target account through a broker role."""

    def __init__(
        self,
        sts_client: STSClient | None = None,
        duration_seconds: int = DEFAULT_SESSION_SECONDS,
    ) -> None:
        self._sts = sts_client if sts_client is not None else boto3.client("sts")
        self._duration = duration_seconds

    def assume(
        self,
        chain: RoleChain,
        caller: CallerIdentity,
        session_policy: str,
    ) -> boto3.Session:
        broker_sts = self.assume_broker(chain, caller)
        return self.assume_target(broker_sts, chain, caller, session_policy)

    def assume_broker(self, chain: RoleChain, caller: CallerIdentity) -> STSClient:
        """First hop: the broker session, with SourceIdentity and transitive session tags."""
        tags = [{"Key": k, "Value": v} for k, v in sorted(caller.tags.items())]
        broker = self._sts.assume_role(
            RoleArn=chain.broker_role_arn,
            RoleSessionName=_session_name(caller),
            DurationSeconds=self._duration,
            SourceIdentity=caller.source_identity,
            Tags=tags,  # type: ignore[arg-type]
            TransitiveTagKeys=[t["Key"] for t in tags],
        )
        return self._client_from(broker["Credentials"])

    def assume_target(
        self,
        broker_sts: STSClient,
        chain: RoleChain,
        caller: CallerIdentity,
        session_policy: str,
    ) -> boto3.Session:
        """Second hop: the target role, limited by the per-call session policy."""
        target = broker_sts.assume_role(
            RoleArn=chain.target_role_arn,
            RoleSessionName=_session_name(caller),
            DurationSeconds=self._duration,
            SourceIdentity=caller.source_identity,
            Policy=session_policy,
        )
        creds = target["Credentials"]
        return boto3.Session(
            aws_access_key_id=creds["AccessKeyId"],
            aws_secret_access_key=creds["SecretAccessKey"],
            aws_session_token=creds["SessionToken"],
        )

    def _client_from(self, creds: CredentialsTypeDef) -> STSClient:
        region = self._sts.meta.region_name
        return boto3.client(
            "sts",
            region_name=region,
            aws_access_key_id=creds["AccessKeyId"],
            aws_secret_access_key=creds["SecretAccessKey"],
            aws_session_token=creds["SessionToken"],
        )
