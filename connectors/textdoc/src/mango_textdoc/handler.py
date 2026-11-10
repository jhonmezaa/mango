"""AgentCore Gateway Lambda target of the ``textdoc`` tools: the Canvas of the chat (D124;
threat model ``canvas-threat-model.md``).

The model gives a title, a kind and a text (``create``), a new text or literal edits
(``update``) or quotes and comments (``comment``). Everything else comes from elsewhere, as in
the code connector (``connectors/code-interpreter``):

* **Who asks:** the REQUEST interceptor puts the caller's access token in ``_mango_ctx``; it is
  verified here again, and its subject must be the one mango-api signed (TM-CV1).
* **Which conversation and turn:** the ones mango-api signed into the invocation (claims
  ``conv`` and ``turn``), handed over by the interceptor. The model names a document only by
  the id ``create`` gave it, and only inside that conversation (TM-CV1).
* **Where it writes:** only in Mango: the person's partition of ``Conversations``, with
  credentials of ``Mango-<ns>-ConversationData`` limited to ``USER#<sub>`` (row-level
  security, ``mango_core.textdocs``). It reaches no other system (rule 3).

Nothing the model sends is run: edits are literal (never a regular expression), the text is
checked (no control characters, at most 256 KiB) and stays data. Every call is audited as
``textdoc.write`` with ids, kinds and sizes, never a title, a text nor a comment, and answers
the model with one short text (``{"text": …}``) or an error (``{"error": {"code",
"message"}}``). A person may make ``CALLS_PER_MINUTE`` calls a minute (``RateLimits``).

Raw events, titles, texts and comments are never logged (D16).
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from functools import cache
from typing import Annotated, Any, Literal

import boto3
from botocore.config import Config
from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
)

from mango_core import textdocs
from mango_core.harness_tools import TEXTDOC_TOOLS
from mango_core.identity import AccessTokenVerifier, IdentityError, UserContext, user_from_claims
from mango_core.invocation import SCOPE_ID_PATTERN
from mango_core.rate_limits import RateLimitStore, SharedRateLimiter
from mango_core.textdocs import (
    Edit,
    TextdocError,
    TextdocStore,
    TextdocStoreUnavailableError,
)
from mango_textdoc.audit import AuditWriter
from mango_textdoc.screen import ScreenUnavailableError, make_screen

logger = logging.getLogger()
logger.setLevel(logging.INFO)

RESERVED_CONTEXT_ARG = "_mango_ctx"
TOOL_NAME_KEY = "bedrockAgentCoreToolName"
TOOL_NAME_DELIMITER = "___"
CALLS_LIMIT = "textdoc.write"
CALLS_PER_MINUTE = 30
_MAX_CONTENT_CHARS = textdocs.MAX_CONTENT_BYTES
"""Characters the schema lets through; the store then checks the size in UTF-8."""
_AWS_CONFIG = Config(retries={"mode": "standard", "max_attempts": 2}, read_timeout=10)
_CREDENTIAL_SECONDS = 600
_MAX_CLIENTS = 64

Text = Annotated[str, StringConstraints(max_length=_MAX_CONTENT_CHARS)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreateArguments(_Strict):
    title: Annotated[str, StringConstraints(min_length=1, max_length=400)]
    kind: Literal["document", "code/python", "code/react", "code/html"]
    content: Text


class EditArgument(_Strict):
    find: Annotated[str, StringConstraints(min_length=1, max_length=textdocs.MAX_FIND_CHARS)]
    replace: Text
    all: bool = False


# The id the agent was told is in lowercase (``textdocs.told_id``); it is stored in capitals.
TextdocId = Annotated[
    str, StringConstraints(min_length=1, max_length=64), AfterValidator(textdocs.stored_id)
]


class UpdateArguments(_Strict):
    textdoc_id: TextdocId
    content: Text | None = None
    edits: Annotated[list[EditArgument], Field(max_length=textdocs.MAX_EDITS)] | None = None
    note: Annotated[str, StringConstraints(max_length=400)] = ""


class CommentArgument(_Strict):
    quote: Annotated[str, StringConstraints(min_length=1, max_length=textdocs.MAX_QUOTE_CHARS)]
    text: Annotated[str, StringConstraints(min_length=1, max_length=textdocs.MAX_COMMENT_CHARS)]


class CommentArguments(_Strict):
    textdoc_id: TextdocId
    comments: Annotated[
        list[CommentArgument], Field(min_length=1, max_length=textdocs.MAX_COMMENTS_PER_CALL)
    ]


ScopeId = Annotated[str, StringConstraints(pattern=SCOPE_ID_PATTERN)]


class _Context(BaseModel):
    """What the interceptor sets (the model's own ``_mango_ctx`` is removed before)."""

    model_config = ConfigDict(extra="ignore")

    token: Annotated[str, StringConstraints(min_length=1)]
    subject: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    agent_id: Annotated[str, StringConstraints(pattern=r"^[a-z0-9]{2,16}$")]
    agent_version: Annotated[int, Field(ge=1)]
    conversation_id: ScopeId
    turn_id: ScopeId
    playground: bool = False


@dataclass(frozen=True)
class Settings:
    issuer: str
    client_id: str
    conversations_table: str
    conversations_table_arn: str
    data_key_arn: str
    data_role_arn: str
    rate_limits_table: str
    audit_stream: str
    audit_index_table: str
    region: str
    guardrail_id: str
    guardrail_version: str
    tasks_client_id: str = ""

    @staticmethod
    def from_env() -> Settings:
        env = os.environ
        return Settings(
            issuer=env["COGNITO_ISSUER"],
            client_id=env["COGNITO_CLIENT_ID"],
            conversations_table=env["CONVERSATIONS_TABLE"],
            conversations_table_arn=env["CONVERSATIONS_TABLE_ARN"],
            data_key_arn=env["DATA_KEY_ARN"],
            data_role_arn=env["DATA_ROLE_ARN"],
            rate_limits_table=env["RATE_LIMITS_TABLE"],
            audit_stream=env["AUDIT_STREAM"],
            audit_index_table=env["AUDIT_INDEX_TABLE"],
            region=env["AWS_REGION"],
            guardrail_id=env["GUARDRAIL_ID"],
            guardrail_version=env["GUARDRAIL_VERSION"],
            tasks_client_id=env.get("TASKS_CLIENT_ID", ""),
        )


class RlsClients:
    """A DynamoDB client per person, from ``Mango-<ns>-ConversationData`` with a session policy
    that only reaches that person's partition of ``Conversations`` (as the code connector)."""

    def __init__(self, sts: Any, role_arn: str, table_arn: str, key_arn: str, region: str) -> None:
        self._sts = sts
        self._role = role_arn
        self._table = table_arn
        self._key = key_arn
        self._region = region
        self._cache: OrderedDict[str, tuple[float, Any]] = OrderedDict()
        self._lock = threading.Lock()

    def policy(self, user_id: str) -> str:
        return json.dumps(
            {
                "Version": "2012-10-17",
                "Statement": [
                    {
                        "Effect": "Allow",
                        "Action": [
                            "dynamodb:GetItem",
                            "dynamodb:PutItem",
                            "dynamodb:UpdateItem",
                            "dynamodb:Query",
                        ],
                        "Resource": self._table,
                        "Condition": {
                            "ForAllValues:StringEquals": {
                                "dynamodb:LeadingKeys": [f"USER#{user_id}"]
                            }
                        },
                    },
                    {
                        "Effect": "Allow",
                        "Action": ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey*"],
                        "Resource": self._key,
                    },
                ],
            },
            separators=(",", ":"),
        )

    def for_user(self, user_id: str) -> Any:
        now = time.monotonic()
        with self._lock:
            cached = self._cache.get(user_id)
            if cached and now - cached[0] < _CREDENTIAL_SECONDS:
                return cached[1]
        creds = self._sts.assume_role(
            RoleArn=self._role,
            RoleSessionName=f"mango-textdoc-{user_id[:40]}",
            DurationSeconds=900,
            Policy=self.policy(user_id),
        )["Credentials"]
        client = boto3.client(
            "dynamodb",
            region_name=self._region,
            config=_AWS_CONFIG,
            aws_access_key_id=creds["AccessKeyId"],
            aws_secret_access_key=creds["SecretAccessKey"],
            aws_session_token=creds["SessionToken"],
        )
        with self._lock:
            self._cache.pop(user_id, None)
            self._cache[user_id] = (now, client)
            while len(self._cache) > _MAX_CLIENTS:
                self._cache.popitem(last=False)
        return client


@dataclass(frozen=True)
class Deps:
    settings: Settings
    verify: Callable[[str], dict[str, Any]]
    store_for: Callable[[str], TextdocStore]
    """The documents of one person (``sub``), with their row-level security credentials."""
    calls: SharedRateLimiter
    audit: AuditWriter
    screen: Callable[[str], str]
    """A version as it may be stored: masked or refused by the base guardrail (``screen``)."""


@cache
def _deps() -> Deps:
    settings = Settings.from_env()
    dynamodb = boto3.client("dynamodb", config=_AWS_CONFIG)
    rls = RlsClients(
        boto3.client("sts", config=_AWS_CONFIG),
        settings.data_role_arn,
        settings.conversations_table_arn,
        settings.data_key_arn,
        settings.region,
    )
    verifier = AccessTokenVerifier(
        settings.issuer,
        settings.client_id,
        also_clients=(settings.tasks_client_id,) if settings.tasks_client_id else (),
    )
    return Deps(
        settings=settings,
        verify=verifier.verify,
        store_for=lambda sub: TextdocStore(rls.for_user(sub), settings.conversations_table, sub),
        calls=SharedRateLimiter(
            RateLimitStore(dynamodb, settings.rate_limits_table), CALLS_LIMIT, CALLS_PER_MINUTE, 60
        ),
        audit=AuditWriter(
            boto3.client("firehose", config=_AWS_CONFIG),
            settings.audit_stream,
            dynamodb,
            settings.audit_index_table,
        ),
        screen=make_screen(
            boto3.client("bedrock-runtime", config=_AWS_CONFIG),
            settings.guardrail_id,
            settings.guardrail_version,
        ),
    )


def _error(code: str, message: str) -> dict[str, Any]:
    return {"error": {"code": code, "message": message}}


class _RejectedError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.payload = _error(code, message)


_UNAVAILABLE = _RejectedError("unavailable", "the Canvas is not available now; try again")


def _tool_name(context: Any) -> str | None:
    custom = getattr(getattr(context, "client_context", None), "custom", None) or {}
    raw = custom.get(TOOL_NAME_KEY)
    if not isinstance(raw, str):
        return None
    return raw.split(TOOL_NAME_DELIMITER, 1)[-1]


@dataclass(frozen=True)
class _Call:
    user: UserContext
    signed: _Context
    tool: str
    arguments: dict[str, Any]


def _admit(event: dict[str, Any], context: Any, deps: Deps) -> _Call:
    args = dict(event)
    try:
        signed = _Context.model_validate(args.pop(RESERVED_CONTEXT_ARG, None))
    except ValidationError:
        # Not what the interceptor sets for a turn of a version with the Canvas.
        raise _RejectedError("unauthenticated", "missing caller identity") from None
    try:
        user = user_from_claims(deps.verify(signed.token))
    except IdentityError:
        raise _RejectedError("unauthenticated", "caller identity could not be verified") from None
    if user.user_id != signed.subject:
        # The token is not the one mango-api signed the invocation for (TM-CV1).
        raise _RejectedError("unauthenticated", "caller identity could not be verified")
    tool = _tool_name(context)
    if tool not in TEXTDOC_TOOLS:
        raise _RejectedError("unknown_tool", "unknown tool")
    if signed.playground:
        # The Playground keeps no conversation: nothing to write to.
        raise _RejectedError("unavailable", "the Canvas is not available in the Playground")
    return _Call(user, signed, tool, args)


def _validated[M: BaseModel](model: type[M], args: dict[str, Any]) -> M:
    try:
        return model.model_validate(args)
    except ValidationError as exc:
        fields = sorted({".".join(str(p) for p in e["loc"]) for e in exc.errors()})
        raise _RejectedError(
            "invalid_arguments", f"invalid arguments: {', '.join(fields) or 'unexpected'}"
        ) from None


def _audit(deps: Deps, call: _Call, detail: dict[str, Any]) -> None:
    """Before answering: a write that cannot be audited is not reported as done."""
    try:
        deps.audit.emit(
            "textdoc.write",
            call.user,
            {
                "tool": call.tool,
                "agent_id": call.signed.agent_id,
                "agent_version": call.signed.agent_version,
                "conversation_id": call.signed.conversation_id,
                "turn": call.signed.turn_id,
                **detail,
            },
        )
    except Exception:
        logger.exception("a Canvas write could not be audited")
        raise _UNAVAILABLE from None


def _log(call: _Call, outcome: str) -> None:
    """Operational log: ids and the outcome; never a title, a text nor a comment."""
    logger.info(
        json.dumps(
            {
                "event": "tool.call",
                "tool": call.tool,
                "user": call.user.user_id,
                "agent": call.signed.agent_id,
                "outcome": outcome,
            }
        )
    )


def _create(call: _Call, store: TextdocStore, deps: Deps) -> dict[str, Any]:
    args = _validated(CreateArguments, call.arguments)
    doc, version = store.create(
        call.signed.conversation_id,
        title=args.title,
        kind=args.kind,
        content=deps.screen(args.content),
        by="agent",
        note="",
        turn_id=call.signed.turn_id,
    )
    _audit(
        deps,
        call,
        {"textdoc_id": doc.textdoc_id, "kind": doc.kind, "version": 1, "chars": version.chars},
    )
    return {
        "text": (
            f"Created the Canvas document «{doc.title}» (id {textdocs.told_id(doc.textdoc_id)}, "
            f"{doc.kind}, v1). "
            "The user sees it next to the chat; do not repeat its text in the answer."
        )
    }


def _update(call: _Call, store: TextdocStore, deps: Deps) -> dict[str, Any]:
    args = _validated(UpdateArguments, call.arguments)
    if (args.content is None) == (args.edits is None):
        raise _RejectedError("invalid_arguments", "give either content or edits")
    conversation = call.signed.conversation_id
    doc = store.doc(conversation, args.textdoc_id)
    if doc is None:
        raise TextdocError("not_found", "there is no such document in this conversation")
    latest = store.latest(conversation, doc.textdoc_id)
    if latest is None or latest.content is None:
        raise TextdocError("not_found", "the document has no version to update")
    if args.edits is not None:
        content = textdocs.apply_edits(
            latest.content, [Edit(e.find, e.replace, e.all) for e in args.edits]
        )
    else:
        content = args.content or ""
    content = deps.screen(content)
    if content == latest.content:
        raise TextdocError("unchanged", "the new text is the same as the latest version")
    version = store.add_version(
        conversation,
        doc.textdoc_id,
        content,
        by="agent",
        note=args.note,
        base=latest.number,
        turn_id=call.signed.turn_id,
    )
    _audit(
        deps,
        call,
        {
            "textdoc_id": doc.textdoc_id,
            "kind": doc.kind,
            "version": version.number,
            "chars": version.chars,
            "edits": len(args.edits or []),
        },
    )
    return {
        "text": (
            f"Wrote v{version.number} of «{doc.title}» (id {textdocs.told_id(doc.textdoc_id)}). "
            "The user sees it "
            "and what changed next to the chat."
        )
    }


def _comment(call: _Call, store: TextdocStore, deps: Deps) -> dict[str, Any]:
    args = _validated(CommentArguments, call.arguments)
    conversation = call.signed.conversation_id
    doc = store.doc(conversation, args.textdoc_id)
    if doc is None:
        raise TextdocError("not_found", "there is no such document in this conversation")
    latest = store.latest(conversation, doc.textdoc_id)
    if latest is None or latest.content is None:
        raise TextdocError("not_found", "the document has no version to comment")
    checked = [
        (textdocs.check_quote(latest.content, c.quote), textdocs.check_comment(c.text))
        for c in args.comments
    ]
    added = store.add_comments(
        conversation, doc.textdoc_id, latest.number, checked, turn_id=call.signed.turn_id
    )
    _audit(
        deps,
        call,
        {
            "textdoc_id": doc.textdoc_id,
            "kind": doc.kind,
            "version": latest.number,
            "comments": len(added),
        },
    )
    return {
        "text": (
            f"Added {len(added)} comment(s) to v{latest.number} of «{doc.title}». The user reads "
            "them next to the text and may answer in the chat."
        )
    }


_TOOLS: dict[str, Callable[[_Call, TextdocStore, Deps], dict[str, Any]]] = {
    "create": _create,
    "update": _update,
    "comment": _comment,
}


def _answer(call: _Call, deps: Deps) -> dict[str, Any]:
    if not deps.calls.allow(call.user.user_id):
        raise _RejectedError(
            "rate_limited", f"at most {CALLS_PER_MINUTE} Canvas calls a minute; wait a moment"
        )
    try:
        answer = _TOOLS[call.tool](call, deps.store_for(call.user.user_id), deps)
    except TextdocError as exc:
        _log(call, exc.code)
        return _error(exc.code, str(exc))
    except TextdocStoreUnavailableError:
        logger.exception("the Canvas store could not be reached")
        raise _UNAVAILABLE from None
    except ScreenUnavailableError:
        logger.exception("the base guardrail could not check a Canvas version")
        raise _UNAVAILABLE from None
    _log(call, "ok")
    return answer


def handle(event: dict[str, Any], context: Any, deps: Deps) -> dict[str, Any]:
    try:
        return _answer(_admit(event, context, deps), deps)
    except _RejectedError as rejected:
        return rejected.payload


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    return handle(event, context, _deps())
