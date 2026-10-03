"""Public half of the key the Gateway interceptor signs pack callers with (D37).

A pack over account data verifies who is calling with this key. The provisioner reads it from
KMS (``GetPublicKey`` on the one key the stack names) and hands it to the pack runtime as an
environment variable: it is not a secret, and the pack can never sign with it.
"""

from __future__ import annotations

import base64
from typing import TYPE_CHECKING

from botocore.exceptions import BotoCoreError, ClientError

from mango_provisioner.errors import StepError, aws_error
from mango_provisioner.packs.config import PackSettings

if TYPE_CHECKING:
    from mypy_boto3_kms import KMSClient

_KEY_SPEC = "ECC_NIST_P256"
_KEY_USAGE = "SIGN_VERIFY"
_MAX_KEY_BYTES = 512


class IdentityKey:
    def __init__(self, kms: KMSClient, settings: PackSettings) -> None:
        self._kms = kms
        self._settings = settings

    def public_key(self) -> str:
        """Base64 of the DER public key, or a ``StepError`` if the installation has none."""
        key_arn = self._settings.identity_key_arn
        if key_arn is None:
            raise StepError("identity_unavailable")
        try:
            response = self._kms.get_public_key(KeyId=key_arn)
        except (ClientError, BotoCoreError) as exc:
            raise aws_error("GetPublicKey", exc) from None
        der = response.get("PublicKey")
        if (
            response.get("KeySpec") != _KEY_SPEC
            or response.get("KeyUsage") != _KEY_USAGE
            or not isinstance(der, bytes)
            or not 0 < len(der) <= _MAX_KEY_BYTES
        ):
            raise StepError("identity_key_invalid")
        return base64.b64encode(der).decode()
