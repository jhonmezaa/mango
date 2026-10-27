"""The approved catalog of a remote target, signed with ``alias/Mango-<ns>-remote-mcp``.

``mango_core.remote_mcp.ApprovedRemote`` is the format (D98 (13)); this is the half that
signs: ``kms:Sign`` with ``MessageType=DIGEST`` over ``SHA-256(context + payload)``, the same
scheme as the pack identity and approval tokens. Only this function's role may sign with the
key (its key policy denies everyone else, TM-012). Before the item is written, the signature
is verified with the key's public half exactly as the interceptor will, so a wrong key or a
payload the interceptor would refuse fails here instead of on every call.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from botocore.exceptions import BotoCoreError, ClientError

from mango_core import remote_mcp
from mango_core.remote_mcp import ApprovedRemote, RemoteNotApprovedError
from mango_provisioner.errors import StepError, aws_error
from mango_provisioner.remotes.config import RemoteSettings

if TYPE_CHECKING:
    from mypy_boto3_kms import KMSClient

_KEY_SPEC = "ECC_NIST_P256"


class CatalogSigner:
    def __init__(self, kms: KMSClient, settings: RemoteSettings) -> None:
        self._kms = kms
        self._settings = settings

    def item(self, approved: ApprovedRemote, now: datetime) -> dict[str, Any]:
        """Typed attributes of ``MCP_REMOTE#<reg>`` / ``APPROVED`` (without the key)."""
        try:
            payload = approved.encode()
        except ValueError:
            raise StepError("approved_invalid") from None
        key = self._settings.signing_key
        try:
            signed = self._kms.sign(
                KeyId=key,
                Message=remote_mcp.signing_digest(payload),
                MessageType="DIGEST",
                SigningAlgorithm=remote_mcp.SIGNING_ALGORITHM,
            )
            public = self._kms.get_public_key(KeyId=key)
        except (ClientError, BotoCoreError) as exc:
            raise aws_error("SignApprovedRemote", exc) from None
        der, key_arn = public.get("PublicKey"), signed.get("KeyId")
        if public.get("KeySpec") != _KEY_SPEC or not isinstance(der, bytes):
            raise StepError("remote_key_invalid")
        fields = remote_mcp.item_fields(payload, signed["Signature"])
        try:
            ApprovedRemote.verify(
                remote_mcp.load_public_key(der),
                fields,
                target=approved.target,
                gateway_id=self._settings.gateway_id,
            )
        except (RemoteNotApprovedError, ValueError):
            raise StepError("approved_not_verifiable") from None
        return {
            "payload": {"S": fields["payload"]},
            "signature": {"S": fields["signature"]},
            "key_arn": {"S": str(key_arn)},
            "generation": {"N": str(approved.generation)},
            "updated_at": {"S": now.astimezone(UTC).isoformat(timespec="seconds")},
        }
