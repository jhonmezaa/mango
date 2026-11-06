"""The one Athena query of a run (D104 (6), TM-CUR6): the CUR 2.0 rows of the window, summed by
day, usage account, product (its code, billing entity and family), caller and kind of usage.

Its text is fixed by this module; only the dates travel, as execution parameters. It does not
filter by account or product: the rows that are not of the installation's account or of
Bedrock must be seen to be refused (TM-CUR1). Athena runs it in the function's workgroup, which
enforces where the results go, their encryption and a cap on the bytes a query may read.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
from typing import TYPE_CHECKING, Any, Final

if TYPE_CHECKING:
    from mypy_boto3_athena import AthenaClient

TOKEN_USAGE: Final = r"([Ii]nput|[Oo]utput)[-_]{0,1}[Tt]oken"  # noqa: S105
"""The usage types of model tokens (input, output, cache read and cache write). Bedrock's own rows
name them as its CUR guide does (``USE1-Claude4.6Sonnet-input-tokens``,
``…-cache-read-input-token-count``; ``cost-mgmt-understanding-cur-data``); the rows of a model
sold through AWS Marketplace in Marketplace's way (``USE1-MP:USE1_InputTokenCount-Units``,
``…_CacheReadInputTokenCount-Units``, ``APN1-MP:APN1_output_tokens_global_standard-Units``).
What Mango counts per turn is model tokens; anything else of Bedrock (a guardrail, for one) is
reported apart and never compared. No ``?`` in it: Athena's execution parameters are ``?``."""

_SQL: Final = """
SELECT
  date_format(line_item_usage_start_date, '%Y-%m-%d') AS day,
  line_item_usage_account_id AS account,
  line_item_product_code AS product,
  coalesce(bill_billing_entity, '') AS entity,
  coalesce(product_product_family, '') AS family,
  coalesce(line_item_iam_principal, '') AS principal,
  regexp_like(line_item_usage_type, '{tokens}') AS tokens,
  line_item_line_item_type AS kind,
  sum(coalesce(pricing_public_on_demand_cost, line_item_unblended_cost, 0)) AS list_cost,
  count(*) AS line_items
FROM "{database}"."{table}"
WHERE billing_period BETWEEN ? AND ?
  AND line_item_usage_start_date >= CAST(? AS timestamp)
  AND line_item_usage_start_date < CAST(? AS timestamp)
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
"""
"""The list price is the public on-demand cost. Where a row has none, the unblended cost stands in
for it: whether the rows of AWS Marketplace carry a public on-demand cost is not documented, and
Marketplace's model prices are list prices (D104, precision of 2026-11-06). The files delivered
before that precision have no billing entity nor product family: they read as empty."""

_DONE: Final = frozenset({"SUCCEEDED", "FAILED", "CANCELLED"})
_PAGE: Final = 1000


class QueryError(Exception):
    """Athena did not answer the query: nothing was compared (the run fails and is retried)."""


@dataclass(frozen=True)
class Row:
    """One sum of the bill: a day, an account, a product, a caller and a kind of usage."""

    day: str
    account: str
    product: str
    entity: str
    """``bill_billing_entity``: ``AWS`` or ``AWS Marketplace``."""
    family: str
    """``product_product_family``: ``Amazon Bedrock`` on every Bedrock line item."""
    principal: str
    tokens: bool
    kind: str
    list_cost: Decimal
    line_items: int


def sql(database: str, table: str) -> str:
    return _SQL.format(database=database, table=table, tokens=TOKEN_USAGE).strip()


def parameters(first: str, last: str) -> list[str]:
    """Billing periods and dates of the window ``first``..``last`` (days, both included)."""
    end = _next_day(last)
    return [
        f"'{first[:7]}'",
        f"'{last[:7]}'",
        f"'{first} 00:00:00'",
        f"'{end} 00:00:00'",
    ]


def _next_day(day: str) -> str:
    return (date.fromisoformat(day) + timedelta(days=1)).isoformat()


def _row(values: list[str]) -> Row:
    day, account, product, entity, family, principal, tokens, kind, cost, count = values
    try:
        amount = Decimal(cost or "0")
        items = int(count or "0")
    except (InvalidOperation, ValueError) as exc:
        raise QueryError("unreadable result") from exc
    if not amount.is_finite():
        raise QueryError("unreadable result")
    return Row(
        day=day,
        account=account,
        product=product,
        entity=entity,
        family=family,
        principal=principal,
        tokens=tokens == "true",
        kind=kind,
        list_cost=amount,
        line_items=items,
    )


class Athena:
    def __init__(
        self,
        client: AthenaClient,
        workgroup: str,
        database: str,
        *,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._client = client
        self._workgroup = workgroup
        self._database = database
        self._sleep = sleep
        self._clock = clock

    def run(self, statement: str, params: list[str], timeout_seconds: float) -> list[Row]:
        started = self._client.start_query_execution(
            QueryString=statement,
            WorkGroup=self._workgroup,
            # The query names its table in full; the context is so that Athena never falls back
            # to the `default` database, which Lake Formation would ask DESCRIBE on in an account
            # whose catalog it governs (D104).
            QueryExecutionContext={"Catalog": "AwsDataCatalog", "Database": self._database},
            ExecutionParameters=params,
        )
        query_id = started["QueryExecutionId"]
        deadline = self._clock() + timeout_seconds
        wait = 0.5
        while True:
            execution = self._client.get_query_execution(QueryExecutionId=query_id)
            state = execution["QueryExecution"]["Status"]["State"]
            if state in _DONE:
                break
            if self._clock() >= deadline:
                self._client.stop_query_execution(QueryExecutionId=query_id)
                raise QueryError("query timed out")
            self._sleep(wait)
            wait = min(wait * 2, 5.0)
        if state != "SUCCEEDED":
            # Only the kind of error goes to the log: Athena's reason may quote a value of a row
            # (an account, a caller's ARN), which is billing data.
            reason = execution["QueryExecution"]["Status"].get("StateChangeReason", "")
            kind = reason.split(":", 1)[0].strip()[:60] if ":" in reason else "unknown"
            raise QueryError(f"query {state.lower()}: {kind}")
        return self._results(query_id)

    def _results(self, query_id: str) -> list[Row]:
        rows: list[Row] = []
        token: str | None = None
        header = True
        while True:
            request: dict[str, Any] = {"QueryExecutionId": query_id, "MaxResults": _PAGE}
            if token:
                request["NextToken"] = token
            page = self._client.get_query_results(**request)
            for raw in page["ResultSet"]["Rows"]:
                if header:
                    # The first row of the first page is the names of the columns.
                    header = False
                    continue
                rows.append(_row([cell.get("VarCharValue", "") for cell in raw["Data"]]))
            token = page.get("NextToken")
            if not token:
                return rows
