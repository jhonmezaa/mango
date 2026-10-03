"""What stands between a ``tools/call`` and the upstream tool (TM-M14).

For every call: only tools of the signed manifest, and the reserved ``_mango_ctx`` argument
never reaches the upstream tool (its schema does not know it). For a pack over account data
the call is also refused unless ``_mango_ctx`` carries an assertion of the Gateway
interceptor for this pack and this tool, and the tool then runs with AWS credentials assumed
for that person (``mango_pack_runtime.credentials``).

A pack of the member chain (D51) reads one member account per call. The account is an argument
of Mango's own (``account_id``), never one the upstream server interprets: the guard validates
it, removes it and assumes ``<Read broker> -> Mango-<ns>-ReadOnly`` of that account **before**
the tool runs. Whether the account is one Mango may read is decided by IAM in that very call
(the role only exists where the StackSet deployed it, and the broker only assumes inside the
organization); whatever fails, the answer is the same refusal.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable, Collection, Iterator, Mapping
from contextlib import contextmanager
from typing import TYPE_CHECKING, Any

from botocore.config import Config
from botocore.credentials import ReadOnlyCredentials
from botocore.exceptions import BotoCoreError, ClientError

from mango_aws import CallerIdentity, CrossAccountSessions, RoleChain
from mango_aws.broker import build_session_policy
from mango_pack_runtime import credentials
from mango_pack_runtime.config import MODE_CENTRAL_ONLY, PackConfig, Statement
from mango_pack_runtime.identity import Caller, IdentityError, IdentityVerifier

if TYPE_CHECKING:
    from mypy_boto3_sts import STSClient

logger = logging.getLogger("mango.pack")

RESERVED_CONTEXT_ARG = "_mango_ctx"
CENTRAL_SCOPE = "central"
"""``mango_bu`` session tag of a call made for a central user (no business unit)."""
ACCOUNT_ARG = "account_id"
"""Member chain: the member account a call reads. Added to every tool by the entry point."""
REGION_ARG = "region"
"""Member chain: the Region a call reads, passed on to the upstream tool once checked."""
ACCOUNT_PATTERN = r"^[0-9]{12}$"
# Nothing that could turn into another host: lowercase segments and a trailing digit.
REGION_PATTERN = r"^[a-z]{2}(-[a-z]{1,16}){1,3}-[0-9]$"
_ACCOUNT_RE = re.compile(ACCOUNT_PATTERN, re.ASCII)
_REGION_RE = re.compile(REGION_PATTERN, re.ASCII)


class RegionError(IdentityError):
    """A verified caller asked for a Region the pack cannot reach (R6).

    The network of a pack runtime only routes to the VPC endpoints of the installation's own
    Region. Unlike the other refusals, this one may be told: it says nothing about accounts.
    """

    def __init__(self, allowed: str) -> None:
        super().__init__(allowed)
        self.allowed = allowed


MemberAssume = Callable[[Caller, str], ReadOnlyCredentials]
"""Assumes the member chain for one caller in one account and returns that session's keys."""
_STS_CONFIG = Config(
    retries={"mode": "standard", "max_attempts": 3}, connect_timeout=3, read_timeout=10
)


def session_policy(statements: tuple[Statement, ...]) -> str:
    """Inline session policy of a call: exactly the statements of the signed manifest."""
    merged: list[Any] = []
    for statement in statements:
        merged += json.loads(build_session_policy(statement.actions, statement.resources))[
            "Statement"
        ]
    if not merged:
        raise ValueError("at least one statement is required")
    return json.dumps({"Version": "2012-10-17", "Statement": merged}, separators=(",", ":"))


def broker_assume(
    config: PackConfig, sts: STSClient | None = None
) -> Callable[[Caller], ReadOnlyCredentials]:
    """``pack role -> broker -> target role`` for one caller (D10, D37)."""
    if config.broker_role_arn is None or config.target_role_arn is None:
        raise ValueError("the pack has no broker")
    chain = RoleChain(config.broker_role_arn, config.target_role_arn)
    policy = session_policy(config.statements)
    sessions = _sessions(config, sts)

    def assume(caller: Caller) -> ReadOnlyCredentials:
        return _assume(sessions, chain, caller, policy)

    return assume


def member_assume(config: PackConfig, sts: STSClient | None = None) -> MemberAssume:
    """``pack role -> Read broker -> Mango-<ns>-ReadOnly`` of one member account (D51).

    The role is always the one the provisioner named; only the account changes, and it has
    already been validated by the guard.
    """
    if config.broker_role_arn is None or config.target_role_name is None:
        raise ValueError("the pack has no broker")
    broker, role = config.broker_role_arn, config.target_role_name
    partition = broker.split(":")[1]
    policy = session_policy(config.statements)
    sessions = _sessions(config, sts)

    def assume(caller: Caller, account: str) -> ReadOnlyCredentials:
        chain = RoleChain(broker, f"arn:{partition}:iam::{account}:role/{role}")
        return _assume(sessions, chain, caller, policy)

    return assume


def _sessions(config: PackConfig, sts: STSClient | None) -> CrossAccountSessions:
    if sts is None:
        # The only client that signs with the pack's own role.
        sts = credentials.platform_session().client(
            "sts", region_name=config.region, config=_STS_CONFIG
        )
    return CrossAccountSessions(sts)


def _assume(
    sessions: CrossAccountSessions, chain: RoleChain, caller: Caller, policy: str
) -> ReadOnlyCredentials:
    session = sessions.assume(
        chain,
        CallerIdentity(
            source_identity=caller.subject,
            tags={
                "mango_user": caller.subject,
                "mango_agent": caller.agent_id,
                "mango_bu": CENTRAL_SCOPE,
            },
        ),
        policy,
    )
    # Explicit keys of the assumed session: never resolved through the default chain.
    assumed = session.get_credentials()
    if assumed is None:
        raise RuntimeError("the assumed session has no credentials")
    frozen: ReadOnlyCredentials = assumed.get_frozen_credentials()
    return frozen


def _account_of(role_arn: str | None) -> str | None:
    parts = (role_arn or "").split(":")
    return parts[4] if len(parts) > 4 else None  # noqa: PLR2004 - arn:partition:iam::account:…


def _is_region(value: object) -> bool:
    """No Region (the upstream default) or something that can only be a Region name."""
    return value is None or (isinstance(value, str) and bool(_REGION_RE.fullmatch(value)))


class CallGuard:
    def __init__(
        self,
        config: PackConfig,
        *,
        verifier: IdentityVerifier | None = None,
        assume: Callable[[Caller], ReadOnlyCredentials] | None = None,
        member_assume: MemberAssume | None = None,
        hidden_arguments: Collection[str] = (),
    ) -> None:
        self._config = config
        self._verifier = verifier
        self._assume = assume
        self._member_assume = member_assume
        # Arguments of upstream tools the model must never set (another profile, other
        # accounts): named by the pack's entry point, removed like `_mango_ctx`.
        self._hidden = frozenset(hidden_arguments)
        # The Mango account holds the broker, never a role to read (D51).
        self._own_account = _account_of(config.broker_role_arn)

    @contextmanager
    def call(self, tool: str, arguments: Mapping[str, Any] | None) -> Iterator[dict[str, Any]]:
        """The arguments the upstream tool may see, with the caller bound while it runs.

        Raises ``IdentityError`` before anything of the tool runs.
        """
        supplied = dict(arguments or {})
        context = supplied.pop(RESERVED_CONTEXT_ARG, None)
        for name in self._hidden:
            supplied.pop(name, None)
        config = self._config
        # An argument of Mango's own in the member chain; in any other pack it is the tool's.
        account = supplied.pop(ACCOUNT_ARG, None) if config.member_chain else None
        if tool not in config.tools:
            # Not a tool of the signed manifest (the entry point removed it from the server).
            raise IdentityError
        if not config.needs_caller:
            yield supplied
            return
        assume = self._assume
        if self._verifier is None or (
            self._member_assume is None if config.member_chain else assume is None
        ):
            # A pack over account data that cannot verify callers serves no call at all.
            self._log(tool, None, "rejected")
            raise IdentityError
        assertion = context.get("identity") if isinstance(context, dict) else None
        try:
            caller = self._verifier.verify(assertion, tool)
            if config.identity_mode == MODE_CENTRAL_ONLY and not caller.central:
                # Cedar L2 and the interceptor already refuse it; the server does not filter
                # by area, so it never serves anyone else either (TM-M3).
                raise IdentityError  # noqa: TRY301
        except IdentityError:
            self._log(tool, None, "rejected")
            raise
        if config.member_chain:
            try:
                frozen = self._member_session(caller, account, supplied)
            except IdentityError:
                self._log(tool, caller, "rejected")
                raise

            def assume(_caller: Caller) -> ReadOnlyCredentials:
                return frozen  # the session of this call, already assumed

        if assume is None:  # unreachable: checked above for the chain of this pack
            raise IdentityError
        outcome = "error"
        try:
            with credentials.calling(caller, assume):
                yield supplied
            outcome = "ok"
        finally:
            self._log(tool, caller, outcome)

    def _member_session(
        self, caller: Caller, account: object, arguments: Mapping[str, Any]
    ) -> ReadOnlyCredentials:
        """The session of a call of the member chain, assumed before the tool runs.

        Every failure is the same ``IdentityError``: a malformed account, the Mango account, a
        Region that is not one, an account without the role or outside the organization (IAM
        says so, in this very call). The answer never tells which.

        The one exception is a well-formed Region other than the installation's: the pack
        network has no route to it (R6), and saying so (``RegionError``) reveals nothing.
        """
        region = arguments.get(REGION_ARG)
        if (
            not isinstance(account, str)
            or not _ACCOUNT_RE.fullmatch(account)
            or account == self._own_account
            or not _is_region(region)
            or self._member_assume is None
        ):
            raise IdentityError
        if region is not None and region != self._config.region:
            raise RegionError(self._config.region or "")
        try:
            return self._member_assume(caller, account)
        except (ClientError, BotoCoreError):
            raise IdentityError from None

    def _log(self, tool: str, caller: Caller | None, outcome: str) -> None:
        # Who called what, never arguments or results (D16).
        logger.info(
            json.dumps(
                {
                    "event": "pack.call",
                    "pack": self._config.pack_id,
                    "tool": tool,
                    "user": caller.subject if caller else None,
                    "agent": caller.agent_id if caller else None,
                    "outcome": outcome,
                }
            )
        )


def build_guard(config: PackConfig, hidden_arguments: Collection[str] = ()) -> CallGuard:
    """Guard of a pack as configured.

    For a pack over account data, from here on the only AWS credentials its code can resolve
    are the caller's. If the runtime was not given the broker and the identity key, the pack
    still lists its tools (the build compares them with the manifest) and refuses every call.
    """
    if not config.needs_caller:
        return CallGuard(config, hidden_arguments=hidden_arguments)
    credentials.install()
    if not config.can_verify or config.identity_public_key is None:
        logger.warning(json.dumps({"event": "pack.locked", "pack": config.pack_id}))
        return CallGuard(config, hidden_arguments=hidden_arguments)
    verifier = IdentityVerifier(config.identity_public_key, config.pack_id)
    if config.member_chain:
        return CallGuard(
            config,
            verifier=verifier,
            member_assume=member_assume(config),
            hidden_arguments=hidden_arguments,
        )
    return CallGuard(
        config,
        verifier=verifier,
        assume=broker_assume(config),
        hidden_arguments=hidden_arguments,
    )
