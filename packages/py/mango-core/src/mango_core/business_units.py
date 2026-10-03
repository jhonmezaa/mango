"""Area (business unit) -> OU mapping schema shared by mango-api and the connector (D17).

The mapping defines data isolation between areas (TM-003, TM-A6), so every reader and writer
validates it with the same rules as the IaC schema (``infra/lib/config/schema.ts``).
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping

AREA_RE = re.compile(r"^[a-z0-9-]{2,32}$")
OU_RE = re.compile(r"^ou-[0-9a-z]{4,32}-[0-9a-z]{8,32}$")
# Sized so the largest valid proposal (with a worst-case escaped reason) fits the 32 KiB
# request body limit of mango-api (review ADM-08); keep in sync with `infra/lib/config/schema.ts`
# and the admin SPA.
MAX_AREAS = 20
MAX_OUS_PER_AREA = 15

Units = dict[str, tuple[str, ...]]


class InvalidMappingError(ValueError):
    """The mapping does not satisfy the schema; readers must fail closed."""


def validate_units(raw: object) -> Units:
    """Return a normalized mapping (sorted, de-duplicated OUs) or raise."""
    if not isinstance(raw, Mapping):
        raise InvalidMappingError("mapping must be an object")
    if len(raw) > MAX_AREAS:
        raise InvalidMappingError("too many areas")
    units: Units = {}
    for area, ous in raw.items():
        if not isinstance(area, str) or not AREA_RE.fullmatch(area):
            raise InvalidMappingError("invalid area name")
        if not isinstance(ous, list | tuple) or not 1 <= len(ous) <= MAX_OUS_PER_AREA:
            raise InvalidMappingError(f"each area needs 1 to {MAX_OUS_PER_AREA} OUs")
        for ou in ous:
            if not isinstance(ou, str) or not OU_RE.fullmatch(ou):
                raise InvalidMappingError("invalid OU id")
        units[area] = tuple(sorted(set(ous)))
    return dict(sorted(units.items()))


def dumps_units(units: Units) -> str:
    """Canonical JSON used to store the mapping."""
    return json.dumps({k: list(v) for k, v in sorted(units.items())}, separators=(",", ":"))


def loads_units(raw: str) -> Units:
    try:
        value = json.loads(raw)
    except ValueError as exc:
        raise InvalidMappingError("mapping is not valid JSON") from exc
    return validate_units(value)


def changed_areas(before: Units, after: Units) -> frozenset[str]:
    """Areas added, removed or whose OUs changed."""
    return frozenset(a for a in before.keys() | after.keys() if before.get(a) != after.get(a))
