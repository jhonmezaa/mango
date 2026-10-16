"""Daily health of the connected member accounts (D84, precises D17).

Once a day (EventBridge rule, asynchronous) this function checks that Mango can still enter
every member account through the same chain as the on-demand check of Settings > Connectivity
(``probe -> ReadBroker -> ReadOnly``), and records the result for that screen:

* It runs with a role of its own, ``Mango-<ns>-AccountHealth``, never the AdminProbe's, and
  always as the fixed system identity ``mango-health`` (``SourceIdentity``), which is what the
  CloudTrail of every account shows. The brokers accept that identity from this role only, and
  this role with no other (``infra/lib/constructs/account-health.ts``).
* It only proves the entry: the session in each member account is limited to
  ``sts:GetCallerIdentity`` and reads no data. The list of accounts comes from the payer chain
  with a session limited to the Organizations listing the probe uses.
* Each account ends ``valid`` (the session is in that account), ``invalid`` (the broker or the
  account's role refused it, or the session is elsewhere) or ``pending`` (not determined this
  run: a transient error, more accounts than one run checks, or no time left).

The result goes to one item of the Settings table, which only this function can write, and to
CloudWatch metrics (embedded metric format) whose alarm notifies the alerts topic. If the
accounts cannot be listed the invocation fails and nothing is written: Lambda retries it and
then sends the event to the dead-letter queue, which has its own alarm.

Nothing here logs ARNs, exception text or raw events: account ids, fixed codes and counts.
"""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import cache
from typing import TYPE_CHECKING, Any, Literal, Protocol

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from mango_admin_probe.handler import (
    MEMBER_ACCESS_ACTIONS,
    MEMBER_ACCOUNTS_ACTIONS,
    SYSTEM_IDENTITY,
    UNATTRIBUTED_SESSION,
    Settings,
    list_member_accounts,
)
from mango_aws import CallerIdentity, CrossAccountSessions, RoleChain, build_session_policy

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient
    from mypy_boto3_organizations import OrganizationsClient
    from mypy_boto3_sts import STSClient

logger = logging.getLogger()
logger.setLevel(logging.INFO)

AGENT_TAG = "account-health"
HEALTH_PARTITION = "ACCOUNT_HEALTH"
HEALTH_SORT_KEY = "MEMBER"
SCHEMA_VERSION = 1
MAX_HEALTH_ACCOUNTS = 500
"""Accounts one run checks; the rest are recorded ``pending`` (and counted in ``total``)."""
WORKERS = 8
TIME_MARGIN_MS = 30_000
"""No new account is started with less than this left: the result must still be written."""
METRIC_NAMESPACE = "Mango/AccountHealth"
METRIC_DIMENSION = "Installation"
_ACCESS_DENIED = frozenset({"AccessDenied", "AccessDeniedException"})
_CLIENT_CONFIG = Config(
    retries={"mode": "standard", "max_attempts": 3}, connect_timeout=3, read_timeout=10
)

Status = Literal["valid", "invalid", "pending"]
Reason = Literal[
    "broker_refused", "role_refused", "unexpected_account", "unavailable", "not_checked"
]


@dataclass(frozen=True)
class AccountHealth:
    account_id: str
    name: str
    status: Status
    reason: Reason | None = None

    def as_item(self) -> dict[str, str]:
        item = {"id": self.account_id, "name": self.name, "status": self.status}
        if self.reason is not None:
            item["reason"] = self.reason
        return item


@dataclass(frozen=True)
class Report:
    checked_at: datetime
    accounts: tuple[AccountHealth, ...]
    total: int
    identity_required: bool | None
    """Whether the broker refuses a session without ``SourceIdentity``; None if not settled."""

    def count(self, status: Status) -> int:
        return sum(1 for account in self.accounts if account.status == status)


class _Sessions(Protocol):
    def assume(self, chain: RoleChain, caller: CallerIdentity, session_policy: str) -> Any: ...

    def assume_broker(self, chain: RoleChain, caller: CallerIdentity) -> Any: ...

    def assume_target(
        self, broker_sts: Any, chain: RoleChain, caller: CallerIdentity, session_policy: str
    ) -> Any: ...


def system_caller() -> CallerIdentity:
    """The only identity this function ever uses (D84)."""
    return CallerIdentity(
        source_identity=SYSTEM_IDENTITY,
        tags={"mango_user": SYSTEM_IDENTITY, "mango_agent": AGENT_TAG},
    )


def _code(exc: ClientError) -> str:
    return str(exc.response.get("Error", {}).get("Code", ""))


class HealthCheck:
    def __init__(
        self,
        settings: Settings,
        sessions: _Sessions,
        sts: STSClient,
        remaining_ms: Callable[[], int] = lambda: 900_000,
    ) -> None:
        self._settings = settings
        self._sessions = sessions
        self._sts = sts
        self._remaining_ms = remaining_ms
        self._caller = system_caller()

    def _accounts(self) -> dict[str, Any]:
        settings = self._settings
        if not settings.org_access_targets:
            return {"accounts": [], "truncated": False, "total": 0}
        session = self._sessions.assume(
            RoleChain(settings.broker_role_arn, settings.reader_role_arn),
            self._caller,
            build_session_policy(MEMBER_ACCOUNTS_ACTIONS),
        )
        org: OrganizationsClient = session.client(
            "organizations", region_name="us-east-1", config=_CLIENT_CONFIG
        )
        return list_member_accounts(
            org,
            settings.org_access_targets,
            settings.never_member_accounts(),
            limit=MAX_HEALTH_ACCOUNTS,
        )

    def _identity_required(self) -> bool | None:
        """The broker must refuse a session that names nobody (rule 5, TM-O3)."""
        try:
            self._sts.assume_role(
                RoleArn=self._settings.read_broker_role_arn,
                RoleSessionName=UNATTRIBUTED_SESSION,
                DurationSeconds=900,
            )
        except ClientError as exc:
            return True if _code(exc) in _ACCESS_DENIED else None
        except BotoCoreError:
            return None
        # The credentials of that session are dropped here: nothing uses them.
        return False

    def _check(self, broker: Any, account_id: str, name: str) -> AccountHealth:
        if self._remaining_ms() < TIME_MARGIN_MS:
            return AccountHealth(account_id, name, "pending", "not_checked")
        chain = self._settings.member_chain(account_id)
        try:
            session = self._sessions.assume_target(
                broker, chain, self._caller, build_session_policy(MEMBER_ACCESS_ACTIONS)
            )
            sts: STSClient = session.client("sts", config=_CLIENT_CONFIG)
            account = sts.get_caller_identity().get("Account")
        except ClientError as exc:
            if _code(exc) in _ACCESS_DENIED:
                # A missing role and a trust that refuses the broker are the same answer.
                return AccountHealth(account_id, name, "invalid", "role_refused")
            return AccountHealth(account_id, name, "pending", "unavailable")
        except BotoCoreError:
            return AccountHealth(account_id, name, "pending", "unavailable")
        if account != account_id:
            return AccountHealth(account_id, name, "invalid", "unexpected_account")
        return AccountHealth(account_id, name, "valid")

    def run(self, now: datetime) -> Report:
        listed = self._accounts()  # raises: nothing is written without the list
        accounts: list[dict[str, str]] = listed["accounts"]
        total = int(listed["total"])
        identity = self._identity_required()
        if not accounts:
            return Report(now, (), total, identity)
        try:
            broker = self._sessions.assume_broker(
                self._settings.member_chain(accounts[0]["id"]), self._caller
            )
        except ClientError as exc:
            if _code(exc) not in _ACCESS_DENIED:
                raise
            refused = tuple(
                AccountHealth(a["id"], a["name"], "invalid", "broker_refused") for a in accounts
            )
            return Report(now, refused, total, identity)
        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            checked = tuple(pool.map(lambda a: self._check(broker, a["id"], a["name"]), accounts))
        return Report(now, checked, total, identity)


def item(report: Report) -> dict[str, Any]:
    """The Settings item the Connectivity screen reads (``mango_api.account_health``)."""
    return {
        "PK": {"S": HEALTH_PARTITION},
        "SK": {"S": HEALTH_SORT_KEY},
        "schema_version": {"N": str(SCHEMA_VERSION)},
        "checked_at": {"S": report.checked_at.astimezone(UTC).isoformat(timespec="seconds")},
        "accounts": {
            "S": json.dumps([a.as_item() for a in report.accounts], separators=(",", ":"))
        },
        "total": {"N": str(report.total)},
        "identity_required": (
            {"NULL": True}
            if report.identity_required is None
            else {"BOOL": report.identity_required}
        ),
    }


def metrics_record(namespace: str, report: Report) -> dict[str, Any]:
    """Embedded metric format: CloudWatch Logs turns this log line into metrics."""
    values = {
        "Runs": 1,
        "ValidAccounts": report.count("valid"),
        "InvalidAccounts": report.count("invalid"),
        "PendingAccounts": report.count("pending") + max(0, report.total - len(report.accounts)),
        "IdentityNotRequired": 1 if report.identity_required is False else 0,
    }
    return {
        "_aws": {
            "Timestamp": int(report.checked_at.timestamp() * 1000),
            "CloudWatchMetrics": [
                {
                    "Namespace": METRIC_NAMESPACE,
                    "Dimensions": [[METRIC_DIMENSION]],
                    "Metrics": [{"Name": name, "Unit": "Count"} for name in values],
                }
            ],
        },
        METRIC_DIMENSION: namespace,
        **values,
    }


def handle(
    check: HealthCheck, dynamodb: DynamoDBClient, table: str, namespace: str, now: datetime
) -> dict[str, Any]:
    report = check.run(now)
    dynamodb.put_item(TableName=table, Item=item(report))
    for account in report.accounts:
        if account.status == "invalid":
            logger.warning(
                json.dumps(
                    {
                        "event": "account_health.invalid",
                        "account_id": account.account_id,
                        "reason": account.reason,
                    }
                )
            )
    # Printed as-is (not through `logging`) so the `_aws` key stays at the root of the line.
    print(json.dumps(metrics_record(namespace, report)))
    summary = {
        "valid": report.count("valid"),
        "invalid": report.count("invalid"),
        "pending": report.count("pending"),
        "total": report.total,
        "identity_required": report.identity_required,
    }
    logger.info(json.dumps({"event": "account_health.summary", **summary}))
    return summary


@cache
def _clients() -> tuple[Settings, Any, Any]:
    sts = boto3.client("sts", config=_CLIENT_CONFIG)
    return Settings.from_env(), sts, boto3.client("dynamodb", config=_CLIENT_CONFIG)


def lambda_handler(_event: object, context: Any) -> dict[str, Any]:
    settings, sts, dynamodb = _clients()
    check = HealthCheck(
        settings,
        CrossAccountSessions(sts),
        sts,
        remaining_ms=context.get_remaining_time_in_millis,
    )
    return handle(
        check,
        dynamodb,
        os.environ["SETTINGS_TABLE"],
        os.environ["MANGO_NAMESPACE"],
        datetime.now(UTC),
    )
