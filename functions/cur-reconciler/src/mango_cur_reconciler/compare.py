"""What the bill says against what Mango counted (D104 (7)), without AWS calls.

The bill's rows (``query.Row``) are sorted into:

* **unexpected**: a row of another usage account or of a product that is not Bedrock. One is
  enough to refuse the whole run: the export was created without its query (TM-CUR1). A row is
  Bedrock's by its product code, or, for the models of other providers, which AWS Marketplace
  bills with a product code per model, by its billing entity (``AWS Marketplace``) and
  product family (``Amazon Bedrock``; precision of D104 of 2026-11-06). Any other Marketplace
  row is unexpected.
* **agent**: model tokens billed to a role ``Mango-<ns>-agent-<id>`` (an agent or the
  Playground): compared, per day, with ``DAY#AGENT#<id>``.
* **unattributed**, reported in a row of its own and never compared: the tokens of any other
  caller (mango-api's titles, the embeddings of the knowledge bases, a caller the export did not
  name), Bedrock usage that is not model tokens (a guardrail), and what was spent before Mango
  had the agent's counter.

The organization's total (every model token of the bill) is compared with ``DAY#ORG``, which
also holds the titles. Amounts are list prices (``pricing_public_on_demand_cost``): Mango
charges the catalog's list price, and the bill's discounts and credits are not Mango's.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Final

from mango_core import usage_days
from mango_cur_reconciler.query import Row

USAGE: Final = "Usage"
"""The line item type of what was used. Taxes, credits, discounts and refunds are not usage:
their list price is not what a turn spent."""
MAX_DEVIATIONS: Final = 50
"""Deviations listed in one audit event; the count is always complete."""
_ZERO: Final = Decimal(0)
_HUNDRED: Final = Decimal(100)
_ARN_FIELDS: Final = 6
_SESSION_PIECES: Final = 3
"""``assumed-role/<role>/<session>``."""

UNATTRIBUTED_OTHER_CALLER: Final = "other_caller"
UNATTRIBUTED_NOT_TOKENS: Final = "not_model_tokens"
UNATTRIBUTED_BEFORE_COUNTER: Final = "before_counter"


def role_name(principal: str) -> str | None:
    """The role of a caller ARN: ``arn:aws:iam::<account>:role/[<path>/]<name>`` or the
    session of one, ``arn:aws:sts::<account>:assumed-role/<name>/<session>``."""
    parts = principal.split(":", _ARN_FIELDS - 1)
    if len(parts) != _ARN_FIELDS or parts[0] != "arn":
        return None
    service, resource = parts[2], parts[5]
    if service == "iam" and resource.startswith("role/"):
        return resource.rsplit("/", 1)[-1] or None
    if service == "sts" and resource.startswith("assumed-role/"):
        pieces = resource.split("/")
        return pieces[1] if len(pieces) >= _SESSION_PIECES and pieces[1] else None
    return None


def agent_of(principal: str, prefix: str) -> str | None:
    """The agent id of a caller that is the role of an agent or of the Playground."""
    name = role_name(principal)
    if name is None or not name.startswith(prefix):
        return None
    agent = name[len(prefix) :]
    return agent if usage_days.is_agent(agent) else None


@dataclass(frozen=True)
class Deviation:
    day: str
    agent: str
    """An agent id, ``playground``, or ``*`` for the organization's total."""
    mango_usd: Decimal
    cur_usd: Decimal


@dataclass
class Sorted:
    unexpected: int = 0
    """Line items of another account or product."""
    agents: dict[str, dict[str, Decimal]] = field(default_factory=dict)
    """agent -> day -> list cost of its model tokens."""
    total: dict[str, Decimal] = field(default_factory=dict)
    """day -> list cost of every model token of the bill."""
    unattributed: dict[str, Decimal] = field(default_factory=dict)
    """reason -> list cost."""
    line_items: int = 0


@dataclass(frozen=True)
class Bedrock:
    """What makes a row of the bill Bedrock's (``config.Settings``)."""

    product_codes: frozenset[str]
    marketplace_entity: str
    product_family: str

    def owns(self, row: Row) -> bool:
        if row.product in self.product_codes:
            return True
        return row.entity == self.marketplace_entity and row.family == self.product_family

    def cost(self, row: Row) -> Decimal:
        """The list cost of a row: AWS Marketplace's rows bring a public on-demand cost of 0, and
        their unblended cost is the list price (precision of D104 of 2026-11-07)."""
        return row.unblended_cost if row.entity == self.marketplace_entity else row.list_cost


def sort(rows: Iterable[Row], *, account: str, bedrock: Bedrock, prefix: str) -> Sorted:
    result = Sorted()
    agents: defaultdict[str, defaultdict[str, Decimal]] = defaultdict(lambda: defaultdict(Decimal))
    total: defaultdict[str, Decimal] = defaultdict(Decimal)
    unattributed: defaultdict[str, Decimal] = defaultdict(Decimal)
    for row in rows:
        result.line_items += row.line_items
        if row.account != account or not bedrock.owns(row):
            result.unexpected += row.line_items
            continue
        if row.kind != USAGE:
            continue
        cost = bedrock.cost(row)
        if not row.tokens:
            unattributed[UNATTRIBUTED_NOT_TOKENS] += cost
            continue
        total[row.day] += cost
        agent = agent_of(row.principal, prefix)
        if agent is None:
            unattributed[UNATTRIBUTED_OTHER_CALLER] += cost
        else:
            agents[agent][row.day] += cost
    result.agents = {agent: dict(days) for agent, days in agents.items()}
    result.total = dict(total)
    result.unattributed = dict(unattributed)
    return result


def deviates(mango: Decimal, cur: Decimal, *, percent: Decimal, usd: Decimal) -> bool:
    """Past both thresholds: more than ``usd`` and more than ``percent`` of the larger."""
    difference = abs(cur - mango)
    return difference > usd and difference * _HUNDRED > percent * max(mango, cur)


@dataclass
class Comparison:
    days: list[str]
    """The closed days the agents are compared on (after their counters existed)."""
    org_days: int = 0
    """The closed days the organization's total is compared on."""
    agents: int = 0
    deviations: list[Deviation] = field(default_factory=list)
    mango_usd: Decimal = _ZERO
    """What ``DAY#ORG`` says of the compared days."""
    cur_usd: Decimal = _ZERO
    """Every model token of the bill on the compared days."""
    agents_mango_usd: Decimal = _ZERO
    agents_cur_usd: Decimal = _ZERO


def compare(
    sorted_rows: Sorted,
    *,
    window: list[str],
    since: str | None,
    org_since: str | None,
    org: Mapping[str, Decimal],
    agents: Mapping[str, Mapping[str, Decimal]],
    percent: Decimal,
    usd: Decimal,
) -> Comparison:
    """``since``: the first day every turn added to its agent's counter (the day after the first
    agent counter seen: that one may be partial). Days of the agents before it are not compared,
    and what the bill says of them goes to ``before_counter``. ``org_since``: the same for
    ``DAY#ORG``, older (D102). ``org`` and ``agents``: Mango's counters by day."""
    days = [day for day in window if since is not None and day >= since]
    org_days = [day for day in window if org_since is not None and day >= org_since]
    compared = set(days)
    result = Comparison(days=days)
    before = sum(
        (
            cost
            for days_of_agent in sorted_rows.agents.values()
            for day, cost in days_of_agent.items()
            if day not in compared
        ),
        start=_ZERO,
    )
    if before:
        sorted_rows.unattributed[UNATTRIBUTED_BEFORE_COUNTER] = (
            sorted_rows.unattributed.get(UNATTRIBUTED_BEFORE_COUNTER, _ZERO) + before
        )
    result.org_days = len(org_days)
    for day in org_days:
        mango = org.get(day, _ZERO)
        cur = sorted_rows.total.get(day, _ZERO)
        result.mango_usd += mango
        result.cur_usd += cur
        if deviates(mango, cur, percent=percent, usd=usd):
            result.deviations.append(Deviation(day, "*", mango, cur))
    names = sorted(set(sorted_rows.agents) | set(agents))
    for agent in names:
        billed = sorted_rows.agents.get(agent, {})
        counted = agents.get(agent, {})
        result.agents += 1
        for day in days:
            mango = counted.get(day, _ZERO)
            cur = billed.get(day, _ZERO)
            result.agents_mango_usd += mango
            result.agents_cur_usd += cur
            if deviates(mango, cur, percent=percent, usd=usd):
                result.deviations.append(Deviation(day, agent, mango, cur))
    return result
