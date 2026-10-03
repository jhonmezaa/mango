"""AdminProbe Lambda (D17, TM-A7): read-only checks on behalf of a Mango administrator.

Invoked only by mango-api through IAM (``lambda:InvokeFunction`` on this function). The
payload carries the operation and the administrator ``sub`` taken from the verified access
token; it becomes the ``SourceIdentity`` of the chain ``probe -> BillingBroker ->
BillingReader`` so the payer's CloudTrail records which administrator triggered each call.
The same holds for the chain to a member account, ``probe -> ReadBroker -> ReadOnly``.

Operations use free, read-only APIs and a per-call session policy:

* ``organization``: OU tree (id, name, parent, name path) to validate the area mapping.
* ``connectivity``: broker assume, billing reader assume and an Organizations read.
* ``member_access``: Read broker assume, the ``ReadOnly`` role of one member account
  (``account_id``) and proof that the broker refuses a session without ``SourceIdentity``.
* ``member_accounts``: id and name of the active accounts under the configured targets of
  the member roles (``orgAccess``), which are the accounts ``member_access`` is meant for.

Check results never include exception text, ARNs or account ids: only fixed, short details.
Raw events are never logged.
"""

from __future__ import annotations

import json
import logging
import os
import re
from collections.abc import Callable
from dataclasses import dataclass
from functools import cache
from typing import TYPE_CHECKING, Any

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from mango_aws import CallerIdentity, CrossAccountSessions, RoleChain, build_session_policy

if TYPE_CHECKING:
    from mypy_boto3_organizations import OrganizationsClient
    from mypy_boto3_sts import STSClient

logger = logging.getLogger()
logger.setLevel(logging.INFO)

AGENT_TAG = "admin-probe"
ORGANIZATION_ACTIONS = (
    "organizations:ListRoots",
    "organizations:ListOrganizationalUnitsForParent",
)
CONNECTIVITY_ACTIONS = ("organizations:ListRoots",)
MAX_OU_DEPTH = 5  # AWS Organizations allows at most five levels of OUs under the root.
MAX_OUS = 1000
MAX_NAME_LENGTH = 128
_ACCESS_DENIED = frozenset({"AccessDenied", "AccessDeniedException", "AccessDeniedForDependency"})
# The member role holds no data action a check could use: the session only proves where it is.
MEMBER_ACCESS_ACTIONS = ("sts:GetCallerIdentity",)
_ACCOUNT_ID_RE = re.compile(r"^\d{12}$", re.ASCII)
UNATTRIBUTED_SESSION = "mango-probe-unattributed"
MEMBER_ACCOUNTS_ACTIONS = (
    "organizations:ListAccounts",
    "organizations:ListChildren",
    "organizations:ListOrganizationalUnitsForParent",
)
MAX_MEMBER_ACCOUNTS = 50


@dataclass(frozen=True)
class Settings:
    broker_role_arn: str
    reader_role_arn: str
    read_broker_role_arn: str
    member_read_role_name: str
    org_access_targets: tuple[str, ...] = ()
    """Root or OUs the member roles are deployed to; empty when ``orgAccess`` is not set."""
    org_access_excluded: frozenset[str] = frozenset()

    @staticmethod
    def from_env() -> Settings:
        return Settings(
            broker_role_arn=os.environ["BILLING_BROKER_ROLE_ARN"],
            reader_role_arn=os.environ["BILLING_READER_ROLE_ARN"],
            read_broker_role_arn=os.environ["READ_BROKER_ROLE_ARN"],
            member_read_role_name=os.environ["MEMBER_READ_ROLE_NAME"],
            org_access_targets=_listed(os.environ.get("ORG_ACCESS_TARGETS", "")),
            org_access_excluded=frozenset(
                _listed(os.environ.get("ORG_ACCESS_EXCLUDED_ACCOUNT_IDS", ""))
            ),
        )

    def never_member_accounts(self) -> frozenset[str]:
        """Excluded by configuration, plus the management and the Mango accounts (D51)."""
        own = {_account_of(self.reader_role_arn), _account_of(self.read_broker_role_arn)}
        return self.org_access_excluded | own

    def member_chain(self, account_id: str) -> RoleChain:
        """Read broker and the role behind it in ``account_id`` (same name in every account)."""
        partition = self.read_broker_role_arn.split(":iam::", 1)[0]
        return RoleChain(
            self.read_broker_role_arn,
            f"{partition}:iam::{account_id}:role/{self.member_read_role_name}",
        )


def _listed(value: str) -> tuple[str, ...]:
    return tuple(item for item in value.split(",") if item)


def _account_of(role_arn: str) -> str:
    return role_arn.split(":")[4]


class _Runtime:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.sts: STSClient = boto3.client("sts")
        self.sessions = CrossAccountSessions(self.sts)
        self.chain = RoleChain(settings.broker_role_arn, settings.reader_role_arn)


class _InvalidRequestError(ValueError):
    pass


class _CheckFailedError(Exception):
    """A check that reached AWS and got an answer it must not accept; ``detail`` is fixed text."""

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


@cache
def _runtime() -> _Runtime:
    return _Runtime(Settings.from_env())


def _caller(actor: str) -> CallerIdentity:
    return CallerIdentity(
        source_identity=actor, tags={"mango_user": actor, "mango_agent": AGENT_TAG}
    )


def _organizations(session: Any) -> OrganizationsClient:
    client: OrganizationsClient = session.client("organizations", region_name="us-east-1")
    return client


def _name(value: object, fallback: str) -> str:
    return value[:MAX_NAME_LENGTH] if isinstance(value, str) and value else fallback


def list_ous(org: OrganizationsClient) -> list[dict[str, Any]]:
    """Walk the OU tree breadth-first; ``path`` holds OU names from the top level down."""
    out: list[dict[str, Any]] = []
    queue: list[tuple[str, list[str]]] = [(r["Id"], []) for r in org.list_roots()["Roots"]]
    paginator = org.get_paginator("list_organizational_units_for_parent")
    while queue and len(out) < MAX_OUS:
        parent_id, names = queue.pop(0)
        for page in paginator.paginate(ParentId=parent_id):
            for ou in page["OrganizationalUnits"]:
                path = [*names, _name(ou.get("Name"), ou["Id"])]
                out.append({"id": ou["Id"], "name": path[-1], "parent_id": parent_id, "path": path})
                if len(path) < MAX_OU_DEPTH:
                    queue.append((ou["Id"], path))
    return sorted(out[:MAX_OUS], key=lambda o: (o["path"], o["id"]))


def _detail(exc: Exception) -> str:
    if isinstance(exc, ClientError):
        code = str(exc.response.get("Error", {}).get("Code", ""))
        if code in _ACCESS_DENIED:
            return "access denied"
        if code == "AWSOrganizationsNotInUseException":
            return "organizations is not enabled"
    return "unavailable"


class _Checks:
    """Ordered checks; one that depends on a failed one is reported as skipped, not run."""

    def __init__(self) -> None:
        self.results: list[dict[str, str]] = []

    def run(self, name: str, step: Callable[[], Any], ok: str, *, chained: bool = True) -> Any:
        if chained and self.results and self.results[-1]["status"] != "ok":
            self.results.append({"name": name, "status": "error", "detail": "skipped"})
            return None
        try:
            result = step()
        except _CheckFailedError as exc:
            logger.warning(json.dumps({"event": "probe.check_failed", "check": name}))
            self.results.append({"name": name, "status": "error", "detail": exc.detail})
            return None
        except (ClientError, BotoCoreError) as exc:
            logger.warning(json.dumps({"event": "probe.check_failed", "check": name}))
            self.results.append({"name": name, "status": "error", "detail": _detail(exc)})
            return None
        self.results.append({"name": name, "status": "ok", "detail": ok})
        return result


def organization(runtime: _Runtime, actor: str, _event: dict[str, Any]) -> dict[str, Any]:
    session = runtime.sessions.assume(
        runtime.chain, _caller(actor), build_session_policy(ORGANIZATION_ACTIONS)
    )
    return {"ous": list_ous(_organizations(session))}


def connectivity(runtime: _Runtime, actor: str, _event: dict[str, Any]) -> dict[str, Any]:
    caller = _caller(actor)
    checks = _Checks()
    broker = checks.run(
        "broker", lambda: runtime.sessions.assume_broker(runtime.chain, caller), "ok"
    )
    reader = checks.run(
        "billing_reader",
        lambda: runtime.sessions.assume_target(
            broker, runtime.chain, caller, build_session_policy(CONNECTIVITY_ACTIONS)
        ),
        "ok",
    )
    checks.run(
        "organizations",
        lambda: _organizations(reader).list_roots()["Roots"],
        "organization readable",
    )
    return {"checks": checks.results}


def _session_account(session: Any, expected: str) -> None:
    sts: STSClient = session.client("sts")
    if sts.get_caller_identity().get("Account") != expected:
        raise _CheckFailedError("unexpected account")


def _refuses_unattributed(sts: STSClient, broker_role_arn: str) -> None:
    """The broker must refuse a session that names no person (rule 5)."""
    try:
        sts.assume_role(
            RoleArn=broker_role_arn, RoleSessionName=UNATTRIBUTED_SESSION, DurationSeconds=900
        )
    except ClientError as exc:
        if str(exc.response.get("Error", {}).get("Code", "")) in _ACCESS_DENIED:
            return
        raise
    # The credentials of that session are dropped here: nothing uses them.
    raise _CheckFailedError("accepted without source identity")


def member_access(runtime: _Runtime, actor: str, event: dict[str, Any]) -> dict[str, Any]:
    account_id = event.get("account_id")
    if not isinstance(account_id, str) or not _ACCOUNT_ID_RE.fullmatch(account_id):
        raise _InvalidRequestError("account_id")
    caller = _caller(actor)
    chain = runtime.settings.member_chain(account_id)
    checks = _Checks()
    broker = checks.run("read_broker", lambda: runtime.sessions.assume_broker(chain, caller), "ok")
    member = checks.run(
        "member_role",
        lambda: runtime.sessions.assume_target(
            broker, chain, caller, build_session_policy(MEMBER_ACCESS_ACTIONS)
        ),
        "ok",
    )
    checks.run("account", lambda: _session_account(member, account_id), "session in the account")
    checks.run(
        "source_identity_required",
        lambda: _refuses_unattributed(runtime.sts, chain.broker_role_arn),
        "refused without source identity",
        chained=False,
    )
    return {"checks": checks.results}


def _accounts_under(org: OrganizationsClient, targets: tuple[str, ...]) -> set[str]:
    """Ids of the accounts in the target OUs and in the OUs below them."""
    accounts: set[str] = set()
    seen: set[str] = set()
    queue = list(targets)
    children = org.get_paginator("list_children")
    units = org.get_paginator("list_organizational_units_for_parent")
    while queue and len(seen) < MAX_OUS:
        parent_id = queue.pop(0)
        if parent_id in seen:
            continue
        seen.add(parent_id)
        for page in children.paginate(ParentId=parent_id, ChildType="ACCOUNT"):
            accounts.update(child["Id"] for child in page["Children"])
        for unit_page in units.paginate(ParentId=parent_id):
            queue.extend(ou["Id"] for ou in unit_page["OrganizationalUnits"])
    return accounts


def list_member_accounts(
    org: OrganizationsClient, targets: tuple[str, ...], never: frozenset[str]
) -> dict[str, Any]:
    """Active accounts under ``targets`` except ``never``, by name; at most the first 50.

    ``total`` is how many there are in all, so the caller can say how many were left out."""
    names = {
        account["Id"]: _name(account.get("Name"), account["Id"])
        for page in org.get_paginator("list_accounts").paginate()
        for account in page["Accounts"]
        # ``State`` replaces ``Status``, which AWS stops returning.
        if account.get("State", account.get("Status")) == "ACTIVE"
    }
    # The root covers every account; OUs are walked.
    wanted = (
        set(names) if any(t.startswith("r-") for t in targets) else _accounts_under(org, targets)
    )
    found = sorted(
        ({"id": i, "name": names[i]} for i in wanted - never if i in names),
        key=lambda account: (account["name"].lower(), account["id"]),
    )
    return {
        "accounts": found[:MAX_MEMBER_ACCOUNTS],
        "truncated": len(found) > MAX_MEMBER_ACCOUNTS,
        "total": len(found),
    }


def member_accounts(runtime: _Runtime, actor: str, _event: dict[str, Any]) -> dict[str, Any]:
    targets = runtime.settings.org_access_targets
    if not targets:
        return {"accounts": [], "truncated": False, "total": 0}
    session = runtime.sessions.assume(
        runtime.chain, _caller(actor), build_session_policy(MEMBER_ACCOUNTS_ACTIONS)
    )
    return list_member_accounts(
        _organizations(session), targets, runtime.settings.never_member_accounts()
    )


OPERATIONS: dict[str, Callable[[_Runtime, str, dict[str, Any]], dict[str, Any]]] = {
    "organization": organization,
    "connectivity": connectivity,
    "member_access": member_access,
    "member_accounts": member_accounts,
}


def handle(event: object, runtime: _Runtime) -> dict[str, Any]:
    if not isinstance(event, dict):
        return {"error": {"code": "invalid_request"}}
    operation = OPERATIONS.get(str(event.get("operation")))
    actor = event.get("actor")
    if operation is None or not isinstance(actor, str):
        return {"error": {"code": "invalid_request"}}
    try:
        _caller(actor)
    except ValueError:
        return {"error": {"code": "invalid_request"}}
    try:
        result = operation(runtime, actor, event)
        outcome = "ok"
    except _InvalidRequestError:
        return {"error": {"code": "invalid_request"}}
    except (ClientError, BotoCoreError):
        logger.exception("probe operation failed")
        result, outcome = {"error": {"code": "upstream_error"}}, "upstream_error"
    logger.info(
        json.dumps(
            {
                "event": "probe.call",
                "operation": event["operation"],
                "actor": actor,
                "outcome": outcome,
            }
        )
    )
    return result


def lambda_handler(event: object, _context: Any) -> dict[str, Any]:
    return handle(event, _runtime())
