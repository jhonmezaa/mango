"""Mango groups: names and the typed registry of access groups (D26).

A group is a Cognito group. Membership reaches Mango in the ``cognito:groups`` claim of the
verified access token. The registry (Settings table, partition ``GROUPS``) gives each access
group a type; it is seeded once by IaC, changed afterwards in the app with dual approval, and
validated by every reader with the same rules as the IaC schema
(``infra/lib/config/schema.ts``).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from mango_core.business_units import AREA_RE

GROUP_ADMIN = "mango-admin"
GROUP_AGENT_CREATOR = "mango-agent-creator"
# Groups the pre-token trigger turns into the FinOps role claim; Mango cannot work without them.
ROLE_GROUPS = frozenset({"finops-central", "bu-lead"})
# Prefix of the groups that grant permissions (never access to agents): not in the registry.
RESERVED_PREFIX = "mango-"
_AREA_GROUP_RE = re.compile(r"^bu-([a-z0-9-]{2,32})$")
# A group created in the app; the registry also accepts the longer ids IaC may have seeded.
NEW_GROUP_NAME_PATTERN = r"^[a-z0-9][a-z0-9-]{1,31}$"

# Cognito allows other characters; Mango groups are lowercase so the groups Cognito creates
# for federated identity providers (``<pool id>_<provider>``) can never be mistaken for one.
_GROUP_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,63}$")
# Cognito's own limit of groups per user.
MAX_USER_GROUPS = 100

TYPE_CENTRAL = "central"
TYPE_AREA = "area"
TYPE_GENERAL = "general"
GROUP_TYPES = frozenset({TYPE_CENTRAL, TYPE_AREA, TYPE_GENERAL})
MAX_DESCRIPTION_LENGTH = 200
MAX_GROUPS = 100


class InvalidGroupError(ValueError):
    """A registry entry does not satisfy the schema; readers must fail closed."""


def is_group_name(value: object) -> bool:
    return isinstance(value, str) and _GROUP_NAME_RE.fullmatch(value) is not None


def is_reserved_name(group_id: str) -> bool:
    """Permission groups (``mango-admin``, ``mango-agent-creator``) never enter the registry."""
    return group_id.startswith(RESERVED_PREFIX)


def fixed_shape(group_id: str) -> tuple[str, str | None] | None:
    """``(type, area)`` of a group whose name already means something to the pre-token trigger.

    ``finops-central`` and ``bu-lead`` carry the FinOps role and ``bu-<area>`` the business
    unit claim, so the registry may only describe them as what they are.
    """
    if group_id == "finops-central":
        return TYPE_CENTRAL, None
    if group_id == "bu-lead":
        return TYPE_GENERAL, None
    match = _AREA_GROUP_RE.fullmatch(group_id)
    return (TYPE_AREA, match.group(1)) if match else None


@dataclass(frozen=True)
class GroupDef:
    """An access group: who may be given an agent, and which data its members may reach."""

    id: str
    type: str
    area: str | None
    description: str

    def __post_init__(self) -> None:
        if not is_group_name(self.id):
            raise InvalidGroupError("invalid group id")
        if self.type not in GROUP_TYPES:
            raise InvalidGroupError("invalid group type")
        # Only area groups carry an area, and they always do.
        if (self.type == TYPE_AREA) != (self.area is not None):
            raise InvalidGroupError("area is required for area groups only")
        if self.area is not None and not AREA_RE.fullmatch(self.area):
            raise InvalidGroupError("invalid area")
        if len(self.description) > MAX_DESCRIPTION_LENGTH or not self.description.isprintable():
            raise InvalidGroupError("invalid description")

    @property
    def is_central(self) -> bool:
        return self.type == TYPE_CENTRAL
