"""AgentCore Identity side of a remote MCP: the return URL and the providers of a registration.

* The Gateway's workload identity must list the SPA return URL (``/conexiones/vuelta``, D98
  (1)) in ``allowedResourceOauth2ReturnUrls``; Identity refuses any other (T1, 2026-10-27).
  The URL comes from the stack; whatever else the identity already allows is kept.
* mango-api creates a provider when an administrator asks (it holds the secret, D93 (7));
  this provisioner only deletes them: the previous generation once a new tenant or app is
  live, and every generation when the registration is disabled. Deleting the provider cuts
  every person's token at once (P7d) and takes its secret with it (D96 (4)).
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from botocore.exceptions import BotoCoreError, ClientError

from mango_provisioner.errors import StepError, aws_error, error_code
from mango_provisioner.remotes.config import RemoteSettings

if TYPE_CHECKING:
    from mypy_boto3_bedrock_agentcore_control import BedrockAgentCoreControlClient

MAX_RETURN_URLS = 20
_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,255}$")
_NOT_FOUND = "ResourceNotFoundException"


class RemoteIdentity:
    def __init__(self, agentcore: BedrockAgentCoreControlClient, settings: RemoteSettings) -> None:
        self._ac = agentcore
        self._settings = settings

    def _workload_identity(self) -> str:
        """Name of the Gateway's own workload identity, as the Gateway reports it."""
        settings = self._settings
        try:
            gateway = self._ac.get_gateway(gatewayIdentifier=settings.gateway_id)
        except (ClientError, BotoCoreError) as exc:
            raise aws_error("GetGateway", exc) from None
        arn = (gateway.get("workloadIdentityDetails") or {}).get("workloadIdentityArn")
        prefix = settings.workload_identity_arn_prefix
        name = arn[len(prefix) - len(settings.workload_identity_prefix) :] if arn else ""
        if not isinstance(arn, str) or not arn.startswith(prefix) or not _NAME_RE.fullmatch(name):
            # Not the identity IAM lets this role change: say so instead of AccessDenied.
            raise StepError("workload_identity_unexpected")
        return name

    def ensure_return_url(self) -> None:
        """Add Mango's return URL to the Gateway's workload identity. Idempotent."""
        name = self._workload_identity()
        url = self._settings.return_url
        try:
            current = self._ac.get_workload_identity(name=name)
            allowed = list(current.get("allowedResourceOauth2ReturnUrls") or [])
            if url in allowed:
                return
            if len(allowed) >= MAX_RETURN_URLS:
                raise StepError("return_urls_full")
            self._ac.update_workload_identity(
                name=name, allowedResourceOauth2ReturnUrls=[*allowed, url]
            )
        except (ClientError, BotoCoreError) as exc:
            raise aws_error("WorkloadIdentity", exc) from None

    def delete_providers(self, registration_id: str, generations: range) -> None:
        """Delete the providers of ``generations``; one that is already gone is fine."""
        for generation in generations:
            name = self._settings.provider_name(registration_id, generation)
            try:
                self._ac.delete_oauth2_credential_provider(name=name)
            except ClientError as exc:
                if error_code(exc) != _NOT_FOUND:
                    raise aws_error("DeleteOauth2CredentialProvider", exc) from None
            except BotoCoreError as exc:
                raise aws_error("DeleteOauth2CredentialProvider", exc) from None
