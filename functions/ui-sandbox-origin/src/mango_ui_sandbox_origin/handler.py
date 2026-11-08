"""Custom resource that writes the origin of the SPA to the UI sandbox's key value store (D123 (2)).

The distribution of the UI sandbox (the second origin, D123) may only be framed by the SPA:
its CloudFront Function puts ``frame-ancestors <SPA origin>`` on every answer, reading the origin
from a CloudFront KeyValueStore. The value cannot be in the template of the function: the CSP of
the SPA names the sandbox distribution (``frame-src``), so the sandbox naming the SPA would close
a cycle between the two distributions. This resource runs once both exist and writes the key.

CloudFormation invokes it synchronously with::

    {"RequestType": "Create" | "Update" | "Delete",
     "ResourceProperties": {"KeyValueStoreArn": "arn:…:key-value-store/<id>",
                            "Key": "spa_origin", "Value": "https://d123.cloudfront.net"}, …}

and it answers at the pre-signed ``ResponseURL``. Only an exact ``https`` origin is written
(no path, port, wildcard or CSP separator), and only to the key this module names: the role
can reach this one store only. ``Delete`` writes nothing: the store goes with its stack, and
the function reads a missing key as ``frame-ancestors 'none'`` (fails closed, TM-UI11).
"""

from __future__ import annotations

import json
import logging
import re
import urllib.request
from collections.abc import Mapping
from typing import Any, Final

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

#: The only key written: the CloudFront Function reads this one (``ui-sandbox-origin.ts``).
SPA_ORIGIN_KEY: Final = "spa_origin"

#: An exact https origin: lowercase host labels, no port, path, wildcard or CSP separator.
_LABEL: Final = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
_ORIGIN = re.compile(rf"https://{_LABEL}(?:\.{_LABEL})+")
_MAX_ORIGIN: Final = 260
_KVS_ARN = re.compile(r"arn:aws[a-z-]*:cloudfront::\d{12}:key-value-store/[0-9a-f-]{36}")


class InvalidRequestError(ValueError):
    """The properties of the resource are not what this function writes."""


def validate(properties: Mapping[str, Any]) -> tuple[str, str]:
    """The store and the origin to write, or :class:`InvalidRequestError`."""
    names = ("KeyValueStoreArn", "Key", "Value")
    arn, key, value = (str(properties.get(name, "")) for name in names)
    if not _KVS_ARN.fullmatch(arn):
        raise InvalidRequestError("KeyValueStoreArn is not a key value store")
    if key != SPA_ORIGIN_KEY:
        raise InvalidRequestError(f"only {SPA_ORIGIN_KEY} is written")
    if len(value) > _MAX_ORIGIN or not _ORIGIN.fullmatch(value):
        raise InvalidRequestError("Value is not an exact https origin")
    return arn, value


def write(client: Any, arn: str, value: str) -> None:
    """Put the key, with the store's current ETag (the API refuses a write without it)."""
    etag = client.describe_key_value_store(KvsARN=arn)["ETag"]
    client.put_key(KvsARN=arn, Key=SPA_ORIGIN_KEY, Value=value, IfMatch=etag)


def respond(event: Mapping[str, Any], status: str, reason: str = "") -> None:
    """Answer CloudFormation at the pre-signed URL of the request."""
    body = json.dumps(
        {
            "Status": status,
            "Reason": reason[:400] or "See the function's log group",
            "PhysicalResourceId": event.get("PhysicalResourceId") or "mango-ui-sandbox-origin",
            "StackId": event["StackId"],
            "RequestId": event["RequestId"],
            "LogicalResourceId": event["LogicalResourceId"],
        }
    ).encode()
    url = str(event["ResponseURL"])
    if not url.startswith("https://"):
        raise ValueError("ResponseURL")
    request = urllib.request.Request(  # noqa: S310 - https only, checked above
        url, data=body, method="PUT", headers={"Content-Type": "", "Content-Length": str(len(body))}
    )
    with urllib.request.urlopen(request, timeout=30):  # noqa: S310
        pass


def handle(event: Mapping[str, Any], client_factory: Any = None) -> tuple[str, str]:
    """Status and reason of the answer to CloudFormation (the resource's properties are trusted
    only as far as :func:`validate` checks them)."""
    if event.get("RequestType") == "Delete":
        return "SUCCESS", "nothing to delete"
    try:
        arn, value = validate(event.get("ResourceProperties") or {})
    except InvalidRequestError as exc:
        return "FAILED", str(exc)
    client = (client_factory or (lambda: boto3.client("cloudfront-keyvaluestore")))()
    try:
        write(client, arn, value)
    except Exception as exc:  # noqa: BLE001 - every failure is answered to CloudFormation
        logger.warning("key value store write failed", extra={"error": type(exc).__name__})
        return "FAILED", f"could not write the key value store ({type(exc).__name__})"
    logger.info("key value store written", extra={"key": SPA_ORIGIN_KEY})
    return "SUCCESS", ""


def lambda_handler(event: dict[str, Any], _context: Any) -> None:
    try:
        status, reason = handle(event)
    except Exception as exc:  # noqa: BLE001 - CloudFormation must get an answer, never wait
        status, reason = "FAILED", f"unexpected error ({type(exc).__name__})"
    respond(event, status, reason)
