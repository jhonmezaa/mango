"""Profile of a third-party remote MCP server, and its signed statement (D93, D98 (14)).

A profile is what a release allows of one remote service: a fixed host, the identity provider,
the toolsets an admin may pick and the tools they hold, every one of them `read`. Nothing of
the remote server runs in Mango: the profile only becomes the schema and the headers of a
Gateway target, so the schema is strict and every rule a reviewer relies on is checked here,
before the profile can be signed and again when a signature is verified.

The statement carries the tool schema itself, so the provisioner needs no other file, and is
signed like a pack statement (DSSE, same key, its own payload type).
"""

from __future__ import annotations

import base64
import binascii
import json
from typing import Annotated, Any, Final, Literal, Self

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from pydantic import (
    AfterValidator,
    Field,
    SerializerFunctionWrapHandler,
    StringConstraints,
    ValidationError,
    model_serializer,
    model_validator,
)

from mango_packs.canonical import canonical_json, sha256_hex
from mango_packs.manifest import (
    EgressHost,
    PackVersion,
    Sha256Hex,
    ShortText,
    StrictModel,
    ToolAccess,
    ToolName,
)
from mango_packs.signing import (
    ALGORITHM,
    Base64,
    GitRevision,
    PackSignatureError,
    Signature,
    load_public_key,
    signed_message,
)

PAYLOAD_TYPE: Final = "application/vnd.mango.remote-profile.v1+json"
# Inline schema quota of a Gateway target.
MAX_TOOL_SCHEMA_BYTES: Final = 1024 * 1024
# The statement carries the schema, and base64 grows it by a third.
MAX_ENVELOPE_BYTES: Final = 2 * MAX_TOOL_SCHEMA_BYTES
MAX_TOOLS: Final = 100
READONLY_HEADER: Final = "X-MCP-Readonly"
TOOLS_HEADER: Final = "X-MCP-Tools"
# The only forced headers, with the only values a profile may give them. `{tools}` stands for
# the tools of the toolsets a registration picked ({func}`forced_headers`). Never
# `X-MCP-Toolsets`: its named values do not hold every tool (D101).
FORCED_HEADERS: Final = {READONLY_HEADER: "true", TOOLS_HEADER: "{tools}"}
# Separator and limit of `X-MCP-Tools`: keep in sync with `mango_core.remote_mcp`.
TOOLS_SEPARATOR: Final = ", "
MAX_TOOLS_HEADER_CHARS: Final = 4096

RemoteProfileId = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9-]{1,23}$")]
ToolsetId = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9-]{0,23}$")]
# An OAuth scope: a name or `<resource>/<permission>`. No spaces: they separate scopes.
OAuthScope = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$")]
ProbeValue = Annotated[str, StringConstraints(max_length=100)] | int | bool
# Punctuation a toolset text may use besides letters, digits and spaces. No `<`, `>`, `&`,
# Markdown marks or line breaks: the web shows the text as it is, as plain text (TM-023).
_TEXT_PUNCTUATION: Final = frozenset(".,;:!¡?¿()«»\"'/+-")
MAX_TOOLSET_TEXT_CHARS: Final = 300


def _plain_text(value: str) -> str:
    odd = sorted({c for c in value if not (c.isalnum() or c == " " or c in _TEXT_PUNCTUATION)})
    if odd:
        raise ValueError(f"only letters, digits, spaces and plain punctuation, not {odd}")
    if "  " in value:
        raise ValueError("no runs of spaces")
    return value


# What a toolset gives the agent that an administrator must weigh (D98 (6)). Mango draws the
# badge and the amber tone of each value; the profile only names it.
ToolsetSensitivity = Literal["source_code"]
# What the profile says of a toolset and the web shows as it is (D98 (6)).
ToolsetText = Annotated[
    str,
    StringConstraints(min_length=1, max_length=MAX_TOOLSET_TEXT_CHARS, strip_whitespace=True),
    AfterValidator(_plain_text),
]


class RemoteProfileError(Exception):
    """The profile or its tool schema breaks a rule of the remote profile format."""


class Endpoint(StrictModel):
    # A fixed host: no wildcard, no IP address. The scheme is always https.
    host: EgressHost
    # The organization is the only free part of the URL, and its pattern is a constant of the
    # code (D93 (5)), never of the profile.
    path: Literal["/{organization}"]


class LinkOrg(StrictModel):
    """Where a link of the service names its organization (to classify links, design A1)."""

    # 1-based segment of the path, on every link host but `subdomain_of`.
    path_segment: Annotated[int, Field(ge=1, le=5)]
    # On this host the organization is the subdomain instead.
    subdomain_of: EgressHost | None = None


class Permission(StrictModel):
    resource: ShortText
    permission: ShortText


class Provider(StrictModel):
    # As botocore spells it, not `MicrosoftOAuth2`.
    vendor: Literal["MicrosoftOauth2"]
    display_name: ShortText
    needs_tenant: bool
    scopes: Annotated[list[OAuthScope], Field(min_length=1, max_length=10)]
    # What the catalog shows the admin before asking for the app registration.
    permissions: Annotated[list[Permission], Field(min_length=1, max_length=10)]


class Toolset(StrictModel):
    """What an administrator picks, and how the profile groups its tools. The server is not
    told the toolset: the header carries the tools (D101)."""

    id: ToolsetId
    label: ShortText
    # Its tools come with every registration.
    always: bool = False
    sensitivity: ToolsetSensitivity | None = None
    # Shown under the toolset and as the body of the amber notice, as written.
    note: ToolsetText | None = None
    # What the organization needs for the toolset to work, as written.
    requirement: ToolsetText | None = None

    @model_serializer(mode="wrap")
    def _omit_unset_fields(self, handler: SerializerFunctionWrapHandler) -> dict[str, Any]:
        # A profile signed before these fields existed has no such keys: leaving them out when
        # unset keeps its statement canonical, so it still verifies.
        data: dict[str, Any] = handler(self)
        return {
            key: value
            for key, value in data.items()
            if value is not None or key not in _OPTIONAL_TOOLSET_FIELDS
        }


_OPTIONAL_TOOLSET_FIELDS: Final = frozenset({"sensitivity", "note", "requirement"})


class Probe(StrictModel):
    tool: ToolName
    arguments: dict[ToolName, ProbeValue] = Field(default_factory=dict, max_length=10)


class RemoteTool(StrictModel):
    name: ToolName
    toolset: ToolsetId
    # Required: an unclassified tool counts as a write (D84), and a profile only has reads.
    access: ToolAccess


class RemoteProfile(StrictModel):
    schema_version: Literal[1]
    id: RemoteProfileId
    # `<revision of the server's tool list>-<revision of Mango>`.
    version: PackVersion
    name: ShortText
    operator: ShortText
    # Always true in v1: the catalog and the agent say so.
    data_leaves_aws: Literal[True]
    endpoint: Endpoint
    link_hosts: Annotated[list[EgressHost], Field(min_length=1, max_length=10)]
    link_org: LinkOrg
    provider: Provider
    forced_headers: dict[str, str]
    toolsets: Annotated[list[Toolset], Field(min_length=1, max_length=20)]
    probe: Probe
    tools: Annotated[list[RemoteTool], Field(min_length=1, max_length=MAX_TOOLS)]
    # sha256 of the canonical JSON of `tool-schema.json`.
    tools_sha256: Sha256Hex
    max_result_chars: Annotated[int, Field(ge=1024, le=1_000_000)]

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if self.forced_headers != FORCED_HEADERS:
            raise ValueError(f"forced_headers must be exactly {FORCED_HEADERS}")
        if self.link_org.subdomain_of is not None and self.link_org.subdomain_of not in set(
            self.link_hosts
        ):
            raise ValueError("link_org.subdomain_of must be one of link_hosts")
        toolsets = {toolset.id: toolset for toolset in self.toolsets}
        if len(toolsets) != len(self.toolsets):
            raise ValueError("duplicate toolset id")
        if all(toolset.always for toolset in self.toolsets):
            raise ValueError("a profile needs a toolset an administrator can pick")
        names = [tool.name for tool in self.tools]
        if len(set(names)) != len(names):
            raise ValueError("duplicate tool name")
        not_read = sorted(
            f"{t.name} ({t.access.value})" for t in self.tools if t.access is not ToolAccess.READ
        )
        if not_read:
            raise ValueError(f"every tool of a remote profile must be read (D84 (5)): {not_read}")
        undeclared = sorted(t.name for t in self.tools if t.toolset not in toolsets)
        if undeclared:
            raise ValueError(f"tools in no declared toolset: {undeclared}")
        empty = sorted(set(toolsets) - {tool.toolset for tool in self.tools})
        if empty:
            raise ValueError(f"toolsets without tools: {empty}")
        probe = next((tool for tool in self.tools if tool.name == self.probe.tool), None)
        if probe is None or not toolsets[probe.toolset].always:
            raise ValueError("the probe tool must be a tool of a toolset that is always on")
        if len(TOOLS_SEPARATOR.join(names)) > MAX_TOOLS_HEADER_CHARS:
            raise ValueError(f"the tools do not fit in {TOOLS_HEADER}")
        return self

    @property
    def tool_names(self) -> frozenset[str]:
        return frozenset(tool.name for tool in self.tools)


def tool_schema_sha256(schema: object) -> str:
    return sha256_hex(canonical_json(schema))


def check_tool_schema(profile: RemoteProfile, schema: object) -> None:
    """Fail unless `schema` is the `{"tools": [...]}` the profile pins, and claims only reads.

    The schema is what the Gateway serves to the model, as the server returned it. Its MCP
    annotations are hints from a third party: they can only make the check stricter (D84 (4)).
    """
    if not isinstance(schema, dict) or set(schema) != {"tools"}:
        raise RemoteProfileError('the tool schema must be an object with only "tools"')
    tools = schema["tools"]
    if not isinstance(tools, list) or not 1 <= len(tools) <= MAX_TOOLS:
        raise RemoteProfileError(f"the tool schema must list 1 to {MAX_TOOLS} tools")
    if len(canonical_json(schema)) > MAX_TOOL_SCHEMA_BYTES:
        raise RemoteProfileError("the tool schema exceeds the 1 MB inline schema of a target")
    names: list[str] = []
    claims: list[str] = []
    for tool in tools:
        if not isinstance(tool, dict) or not isinstance(tool.get("name"), str):
            raise RemoteProfileError("the tool schema has a tool without a name")
        names.append(tool["name"])
        annotations = tool.get("annotations")
        if isinstance(annotations, dict) and (
            annotations.get("readOnlyHint") is False or annotations.get("destructiveHint") is True
        ):
            claims.append(tool["name"])
    if len(set(names)) != len(names):
        raise RemoteProfileError("the tool schema has a duplicate tool name")
    extra = sorted(set(names) - profile.tool_names)
    missing = sorted(profile.tool_names - set(names))
    if extra or missing:
        raise RemoteProfileError(
            f"tool schema and profile differ: not in the profile {extra}, not in the schema "
            f"{missing}"
        )
    if claims:
        raise RemoteProfileError(
            f"the server annotates {sorted(claims)} as not read-only or destructive: a remote "
            "profile only has reads (D84 (4))"
        )
    actual = tool_schema_sha256(schema)
    if actual != profile.tools_sha256:
        raise RemoteProfileError(
            f"the tool schema changed: the profile pins {profile.tools_sha256}, the schema is "
            f"{actual}. Review the diff; a new schema needs review again"
        )


def picked_tools(profile: RemoteProfile, toolsets: list[str]) -> frozenset[str]:
    """The tools of a registration that picked `toolsets`, with those always on.

    A registration must pick at least one toolset that is not always on.
    """
    declared = {toolset.id: toolset for toolset in profile.toolsets}
    unknown = sorted(set(toolsets) - set(declared))
    if unknown:
        raise RemoteProfileError(f"toolsets not in profile {profile.id}: {unknown}")
    picked = set(toolsets)
    if not any(not declared[toolset].always for toolset in picked):
        raise RemoteProfileError("pick at least one toolset that is not always on")
    on = {toolset.id for toolset in profile.toolsets if toolset.always or toolset.id in picked}
    return frozenset(tool.name for tool in profile.tools if tool.toolset in on)


def forced_headers(profile: RemoteProfile, toolsets: list[str]) -> dict[str, str]:
    """The headers the Gateway sends for a registration that picked `toolsets` (D101):
    read only, and exactly its tools, sorted. The server serves no other tool."""
    tools = picked_tools(profile, toolsets)
    return {READONLY_HEADER: "true", TOOLS_HEADER: TOOLS_SEPARATOR.join(sorted(tools))}


class RemoteProfileStatement(StrictModel):
    """What the signature vouches for: this profile serves exactly this tool schema."""

    schema_version: Literal[1]
    profile: RemoteProfile
    tool_schema: dict[str, Any]
    # Commit of the Mango repository the statement was written from.
    source_revision: GitRevision

    @model_validator(mode="after")
    def _schema_is_the_pinned_one(self) -> Self:
        try:
            check_tool_schema(self.profile, self.tool_schema)
        except RemoteProfileError as error:
            raise ValueError(str(error)) from error
        return self

    def payload(self) -> bytes:
        return canonical_json(self.model_dump(mode="json"))


class RemoteEnvelope(StrictModel):
    payload_type: Literal["application/vnd.mango.remote-profile.v1+json"]
    payload: Base64
    signature: Signature


def build_envelope(statement: RemoteProfileStatement, key_id: str, signature: bytes) -> bytes:
    envelope = RemoteEnvelope(
        payload_type=PAYLOAD_TYPE,
        payload=base64.b64encode(statement.payload()).decode(),
        signature=Signature(
            algorithm=ALGORITHM, key_id=key_id, value=base64.b64encode(signature).decode()
        ),
    )
    return json.dumps(envelope.model_dump(mode="json"), indent=2).encode() + b"\n"


def verify_envelope(envelope: bytes, public_key_pem: bytes) -> RemoteProfileStatement:
    """Return the statement only if `public_key_pem` signed it. Fails closed.

    A pack envelope never verifies here, nor a profile envelope as a pack: the payload type is
    part of what is signed.
    """
    key = load_public_key(public_key_pem)
    if len(envelope) > MAX_ENVELOPE_BYTES:
        raise PackSignatureError("the envelope is too large")
    try:
        parsed = RemoteEnvelope.model_validate_json(envelope)
        payload = base64.b64decode(parsed.payload, validate=True)
        signature = base64.b64decode(parsed.signature.value, validate=True)
    except (ValidationError, binascii.Error) as error:
        raise PackSignatureError("the envelope is malformed") from error
    try:
        key.verify(signature, signed_message(payload, PAYLOAD_TYPE), ec.ECDSA(hashes.SHA256()))
    except InvalidSignature as error:
        raise PackSignatureError("the signature does not match the trusted key") from error
    try:
        statement = RemoteProfileStatement.model_validate_json(payload)
    except ValidationError as error:
        raise PackSignatureError("the signed statement is not a valid remote profile") from error
    if statement.payload() != payload:
        raise PackSignatureError("the signed statement is not in canonical form")
    return statement
