"""Cognito pre token generation trigger, event version V2_0 (D14, TM-I4).

Mango claims are derived only from Cognito group membership, which only IaC or an
administrator can change. User-editable attributes are never used for authorization.

Groups:
* ``finops-central`` or ``bu-lead``: the user's FinOps role (central wins if both).
* ``bu-<name>``: business unit for bu-lead users (exactly one is expected).
* ``mango-admin``: Mango administrator.
* Any other group (``mango-agent-creator``, access groups): no role claim is added. Cognito
  lists every group of the user in ``cognito:groups``, which this trigger never overrides;
  mango-api reads it from the verified access token. A user may have groups without a FinOps
  role.

``mango_central`` (D35, TM-M13) says the user belongs to at least one access group whose type
in the registry is ``central`` (Settings table, partition ``GROUPS``; changing a type needs
dual approval in mango-api). The Gateway reads it to decide who may use account-data tools.
It is computed here, from the registry, on every token: never from a user attribute and never
by the client. Fail closed: if the registry cannot be read, or an entry is not exactly
``central``, the claim is left out and the user is not central for that token. The trigger
reads that partition and nothing else.

The access token also carries ``mango_email`` and, if the user has one, ``mango_name`` for
display only (the email attribute is immutable; the name is chosen by the user at sign-up).
Neither is ever used for authorization.

The ``aws.cognito.signin.user.admin`` scope is suppressed from every access token (D20,
TM-L2): without it the token cannot call Cognito self-service APIs (``AssociateSoftwareToken``,
``SetUserMFAPreference``, ``UpdateUserAttributes``, ``DeleteUser``, ``GlobalSignOut``). TOTP
enrollment keeps working because it uses the ``Session`` of the ``MFA_SETUP`` challenge, and
refresh uses the refresh token, not the access token's scopes.
"""

from __future__ import annotations

import logging
import os
import re
from collections.abc import Callable, Iterable
from functools import cache
from typing import TYPE_CHECKING, Any

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

ROLE_GROUPS = ("finops-central", "bu-lead")  # priority order
ADMIN_GROUP = "mango-admin"
EMAIL_CLAIM = "mango_email"
NAME_CLAIM = "mango_name"
MAX_EMAIL_LENGTH = 254
MAX_NAME_LENGTH = 128
SELF_SERVICE_SCOPE = "aws.cognito.signin.user.admin"
_BU_GROUP = re.compile(r"^bu-([a-z0-9-]{2,32})$")
CENTRAL_CLAIM = "mango_central"
SETTINGS_TABLE_ENV = "SETTINGS_TABLE"
GROUPS_PARTITION = "GROUPS"
TYPE_CENTRAL = "central"
# Same pattern as ``mango_core.groups``: the groups Cognito creates for a federated identity
# provider (``<pool id>_<provider>``) can never be mistaken for a Mango group.
_GROUP_NAME = re.compile(r"^[a-z0-9][a-z0-9-]{1,63}$")
# The registry holds at most 100 groups; anything beyond two pages is not a valid registry.
_MAX_PAGES = 2


class RegistryUnavailableError(Exception):
    """The group registry could not be read; nobody is central for this token."""


@cache
def _dynamodb() -> DynamoDBClient:
    # Cognito waits 5 seconds for the trigger: two attempts of at most 1.5 s each answer
    # (without the claim) well before that.
    return boto3.client(
        "dynamodb",
        config=Config(
            connect_timeout=0.5,
            read_timeout=1,
            retries={"total_max_attempts": 2, "mode": "standard"},
        ),
    )


def central_groups() -> frozenset[str]:
    """Ids of the groups the registry types as ``central`` (consistent read)."""
    table = os.environ.get(SETTINGS_TABLE_ENV, "")
    if not table:
        raise RegistryUnavailableError("registry not configured")
    central: set[str] = set()
    try:
        pages = (
            _dynamodb()
            .get_paginator("query")
            .paginate(
                TableName=table,
                KeyConditionExpression="PK = :pk",
                ProjectionExpression="SK, #type",
                ExpressionAttributeNames={"#type": "type"},
                ExpressionAttributeValues={":pk": {"S": GROUPS_PARTITION}},
                ConsistentRead=True,
            )
        )
        for number, page in enumerate(pages):
            if number >= _MAX_PAGES:
                raise RegistryUnavailableError("registry too large")
            for item in page.get("Items", []):
                if item.get("type", {}).get("S") == TYPE_CENTRAL:
                    central.add(str(item["SK"]["S"]))
    except (ClientError, BotoCoreError, KeyError, TypeError, AttributeError) as exc:
        raise RegistryUnavailableError(type(exc).__name__) from exc
    return frozenset(central)


def is_central(groups: Iterable[str], registry: Callable[[], frozenset[str]]) -> bool:
    """Whether one of ``groups`` is a central group. Any doubt answers no (fail closed)."""
    candidates = {g for g in groups if _GROUP_NAME.fullmatch(g)}
    if not candidates:
        return False
    try:
        return bool(candidates & registry())
    except RegistryUnavailableError:
        # The traceback names the table and the AWS error: no group names, users or tokens.
        logger.exception("group registry unavailable; mango_central withheld")
        return False


def claims_for_groups(groups: list[str]) -> dict[str, str]:
    group_set = set(groups)
    claims: dict[str, str] = {}
    role = next((r for r in ROLE_GROUPS if r in group_set), None)
    if role:
        claims["mango_role"] = role
    units = sorted(
        m.group(1) for g in group_set if g not in ROLE_GROUPS and (m := _BU_GROUP.fullmatch(g))
    )
    if len(units) == 1:
        claims["mango_business_unit"] = units[0]
    if ADMIN_GROUP in group_set:
        claims["mango_admin"] = "true"
    return claims


def display_name(value: object) -> str | None:
    """Trimmed printable name of at most ``MAX_NAME_LENGTH`` characters, or None."""
    if not isinstance(value, str):
        return None
    name = " ".join(value.split())
    if not 0 < len(name) <= MAX_NAME_LENGTH or not name.isprintable():
        return None
    return name


def lambda_handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    request = event.get("request") or {}
    group_config = request.get("groupConfiguration") or {}
    groups = [g for g in group_config.get("groupsToOverride") or [] if isinstance(g, str)]
    claims = claims_for_groups(groups)
    if is_central(groups, central_groups):
        claims[CENTRAL_CLAIM] = "true"
    access_claims = dict(claims)
    attributes = request.get("userAttributes") or {}
    email = attributes.get("email")
    if isinstance(email, str) and 0 < len(email) <= MAX_EMAIL_LENGTH:
        # ID tokens already carry the standard email and name claims.
        access_claims[EMAIL_CLAIM] = email
    name = display_name(attributes.get("name"))
    if name:
        access_claims[NAME_CLAIM] = name
    event.setdefault("response", {})["claimsAndScopeOverrideDetails"] = {
        "accessTokenGeneration": {
            "claimsToAddOrOverride": access_claims,
            "scopesToSuppress": [SELF_SERVICE_SCOPE],
        },
        "idTokenGeneration": {"claimsToAddOrOverride": claims},
    }
    return event
