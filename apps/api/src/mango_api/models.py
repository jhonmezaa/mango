"""Brains (D38, spec §4.5): the model catalog administrators edit.

``GET /api/admin/models``, ``PUT /api/admin/models/{id}`` and ``POST /api/admin/models/refresh``.
One administrator enables or disables a model and confirms its prices; no dual approval, and
every change is audited.

Security notes (security-best-practices, FastAPI):
* Every route declares its authorization dependency, bound to the Cedar action
  ``ManageModels``; the decision is audited and ``is_admin`` is re-checked in process
  (AUTH-001, AUTHZ-001).
* Bodies forbid extra fields; the model id is checked against the catalog, never used to
  build an AWS call (VALID-001). Responses use explicit models (RESP-001).
* Optimistic locking with the catalog ``version``, also as a DynamoDB condition.
* Each write emits ``requested`` before and ``applied`` or ``rejected`` after; without the
  first one nothing is written.
* Bedrock is only listed (``ListFoundationModels``, ``ListInferenceProfiles``): no model is
  invoked and no credential is stored. What Bedrock answers is validated before it is stored
  and is rendered as text by the SPA. The refresh is rate limited (429 + ``Retry-After``).
"""

# No `from __future__ import annotations`: FastAPI resolves route annotations at runtime.
import asyncio
import logging
import re
import unicodedata
from collections.abc import Awaitable, Callable, Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation
from types import MappingProxyType
from typing import Annotated, Any, Literal, Self

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, Path
from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StrictBool,
    model_validator,
)

from mango_api.admin import EmptyIn
from mango_api.agents_store import AgentsStore
from mango_api.audit import AuditLog
from mango_api.model_capabilities import ModelCapabilitiesError, ModelCapability
from mango_api.model_catalog import (
    MAX_CATALOG_MODELS,
    MAX_REASON_CHARS,
    ModelCatalog,
    ModelCatalogStore,
    ModelCatalogUnavailableError,
    ModelEntry,
)
from mango_api.rate_limits import Limiter
from mango_api.settings import ModelPrice
from mango_api.settings_store import VersionConflictError, iso
from mango_api.web import ApiError, Caller, rate_limited
from mango_core.agents import MODEL_ID_PATTERN, InvalidDefinitionError, VersionStatus

logger = logging.getLogger(__name__)

PLATFORM = ("Mango::Platform", "mango")
MAX_PRICE_USD = Decimal(100_000)
_PRICE_RE = re.compile(r"^\d{1,6}(\.\d{1,4})?$")
_MODEL_ID_RE = re.compile(MODEL_ID_PATTERN)
_FOUNDATION_MODEL_ARN_RE = re.compile(r"^arn:aws[a-z-]*:bedrock:[a-z0-9-]*::foundation-model/(.+)$")
_MAX_PROFILE_PAGES = 20
# Ids listed in an audit event; the counts are always exact.
_MAX_AUDITED_IDS = 50

ModelStatus = Literal["enabled", "available", "disabled", "noaccess"]


# --- Bedrock ----------------------------------------------------------------------------


class BedrockUnavailableError(Exception):
    """Bedrock could not be listed; the catalog is left as it was."""


@dataclass(frozen=True)
class BedrockModel:
    """A text model of the account's region, addressed by its inference profile id."""

    id: str
    name: str
    provider: str
    supports_vision: bool
    foundation_model: str = ""
    """Id of the model the profile routes to; the release capabilities are keyed by it."""


def _clean(value: object, max_chars: int) -> str | None:
    """Display text from Bedrock: one printable line, or nothing."""
    if not isinstance(value, str):
        return None
    text = unicodedata.normalize("NFC", value).strip()[:max_chars].strip()
    return text if text and text.isprintable() else None


class BedrockCatalog:
    """What Bedrock offers the account in this region. Read-only: nothing is invoked."""

    def __init__(self, client: Any) -> None:
        self._client = client

    def list_models(self) -> list[BedrockModel]:
        """Active system inference profiles over text models, sorted by id."""
        try:
            foundation = self._client.list_foundation_models(byOutputModality="TEXT")
            profiles: list[dict[str, Any]] = []
            request: dict[str, Any] = {"typeEquals": "SYSTEM_DEFINED", "maxResults": 100}
            for _ in range(_MAX_PROFILE_PAGES):
                page = self._client.list_inference_profiles(**request)
                profiles.extend(page.get("inferenceProfileSummaries", []))
                token = page.get("nextToken")
                if not token:
                    break
                request["nextToken"] = token
        except (ClientError, BotoCoreError) as exc:
            raise BedrockUnavailableError("bedrock could not be listed") from exc

        text_models = {
            str(m.get("modelId")): m
            for m in foundation.get("modelSummaries", [])
            if isinstance(m, dict)
        }
        found: dict[str, BedrockModel] = {}
        for profile in profiles:
            model = _from_profile(profile, text_models)
            if model is not None:
                found[model.id] = model
        return sorted(found.values(), key=lambda m: m.id)


def _from_profile(
    profile: dict[str, Any], text_models: dict[str, dict[str, Any]]
) -> BedrockModel | None:
    """A profile that is active, has a usable id and routes to one of the text models."""
    profile_id = profile.get("inferenceProfileId")
    if (
        profile.get("status") != "ACTIVE"
        or not isinstance(profile_id, str)
        or not _MODEL_ID_RE.fullmatch(profile_id)
    ):
        return None
    for target in profile.get("models") or []:
        match = _FOUNDATION_MODEL_ARN_RE.fullmatch(str(target.get("modelArn", "")))
        summary = text_models.get(match.group(1)) if match else None
        if summary is None:
            continue
        name = _clean(profile.get("inferenceProfileName"), 128) or profile_id
        provider = _clean(summary.get("providerName"), 60) or "unknown"
        return BedrockModel(
            id=profile_id,
            name=name,
            provider=provider,
            supports_vision="IMAGE" in (summary.get("inputModalities") or []),
            foundation_model=match.group(1) if match else "",
        )
    return None


# --- Validation -------------------------------------------------------------------------


def _price(value: object) -> Decimal:
    """USD per million tokens: a decimal string, ``0 < x <= 100000``, at most four decimals."""
    if not isinstance(value, str) or not _PRICE_RE.fullmatch(value):
        raise ValueError("price must be a decimal string such as '3.00'")
    try:
        amount = Decimal(value)
    except InvalidOperation as exc:
        raise ValueError("invalid price") from exc
    if not Decimal(0) < amount <= MAX_PRICE_USD:
        raise ValueError("price must be greater than 0 and at most 100000")
    return amount


def _reason(value: str) -> str:
    text = unicodedata.normalize("NFC", value).strip()
    if len(text) > MAX_REASON_CHARS:
        raise ValueError(f"at most {MAX_REASON_CHARS} characters")
    if not text.isprintable():
        raise ValueError("control or invisible characters are not allowed")
    return text


Price = Annotated[Decimal, BeforeValidator(_price)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ModelUpdateIn(_Strict):
    """Enable a model (or change the prices of an enabled one), or disable it."""

    version: Annotated[int, Field(ge=1)]
    enabled: StrictBool
    input_usd: Price | None = None
    output_usd: Price | None = None
    reason: Annotated[str, AfterValidator(_reason)] | None = None

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if self.enabled:
            if self.input_usd is None or self.output_usd is None:
                raise ValueError("an enabled model needs both prices")
            if self.reason is not None:
                raise ValueError("a reason only applies when disabling")
        elif self.input_usd is not None or self.output_usd is not None:
            raise ValueError("prices only apply to an enabled model")
        return self


# --- Responses --------------------------------------------------------------------------


class ModelAgentOut(_Strict):
    id: str
    name: str
    category: str


class AdminModelOut(_Strict):
    id: str
    name: str
    provider: str
    status: ModelStatus
    is_default: bool
    """The model of the release agent; it cannot be disabled."""
    supports_tools: bool
    supports_vision: bool
    context_tokens: int | None
    """Context size from the release capabilities; null when the release does not know it."""
    input_usd: str | None
    """USD per million tokens; null while nobody has given the model a price."""
    output_usd: str | None
    cache_read_usd: str | None
    """Cache prices follow the input price (same ratio); null while the model has no price."""
    cache_write_usd: str | None
    list_input_usd: str | None
    """Price of the installation configuration, to warn when the confirmed one differs."""
    list_output_usd: str | None
    confirmed_by: str | None
    confirmed_at: str | None
    disabled_by: str | None
    disabled_at: str | None
    disabled_reason: str | None
    agents: list[ModelAgentOut]
    """Published agents that may run on this model."""


class AdminModelsOut(_Strict):
    version: int
    region: str
    refreshed_at: str | None
    """Last time Bedrock was asked; null until the first refresh."""
    items: list[AdminModelOut]


# --- Use cases --------------------------------------------------------------------------


@dataclass
class ModelsDeps:
    store: ModelCatalogStore
    bedrock: BedrockCatalog
    agents: AgentsStore
    audit: AuditLog
    rate_limiter: Limiter
    region: str
    default_model: str
    list_prices: dict[str, ModelPrice]
    """Prices of the installation configuration, by model id."""
    clock: Callable[[], datetime]
    capabilities: Callable[[], Mapping[str, ModelCapability]] = dict
    """Release capabilities by foundation model id; raises ``ModelCapabilitiesError``."""


def _money(value: Decimal) -> str:
    return format(value.normalize(), "f")


def _status(entry: ModelEntry) -> ModelStatus:
    if entry.in_bedrock is False:
        return "noaccess"
    if entry.enabled:
        return "enabled"
    return "disabled" if entry.disabled_by is not None else "available"


def _agents_by_model(deps: ModelsDeps) -> dict[str, list[ModelAgentOut]]:
    """Published agents by each model they may run on (their default and allowed models)."""
    try:
        published = deps.agents.by_status(VersionStatus.PUBLISHED)
    except (ClientError, BotoCoreError, InvalidDefinitionError) as exc:
        # Disabling shows who is affected: without that list nothing is answered.
        raise ApiError(503, "agents_unavailable", "please try again") from exc
    by_model: dict[str, list[ModelAgentOut]] = {}
    for version in published:
        definition = version.definition
        agent = ModelAgentOut(
            id=version.agent_id, name=definition.name, category=definition.category
        )
        models = set(definition.allowed_models)
        if definition.model:
            models.add(definition.model)
        for model_id in models:
            by_model.setdefault(model_id, []).append(agent)
    for agents in by_model.values():
        agents.sort(key=lambda a: (a.name.casefold(), a.id))
    return by_model


def _model_out(
    deps: ModelsDeps, entry: ModelEntry, agents: dict[str, list[ModelAgentOut]]
) -> AdminModelOut:
    priced = entry.input_usd > 0 and entry.output_usd > 0
    listed = deps.list_prices.get(entry.id)
    return AdminModelOut(
        id=entry.id,
        name=entry.name,
        provider=entry.provider,
        status=_status(entry),
        is_default=entry.id == deps.default_model,
        supports_tools=entry.supports_tools,
        supports_vision=entry.supports_vision,
        context_tokens=entry.context_tokens,
        input_usd=_money(entry.input_usd) if priced else None,
        output_usd=_money(entry.output_usd) if priced else None,
        cache_read_usd=_money(entry.cache_read_usd) if priced else None,
        cache_write_usd=_money(entry.cache_write_usd) if priced else None,
        list_input_usd=_money(listed.input) if listed else None,
        list_output_usd=_money(listed.output) if listed else None,
        confirmed_by=entry.confirmed_by,
        confirmed_at=entry.confirmed_at,
        disabled_by=entry.disabled_by,
        disabled_at=entry.disabled_at,
        disabled_reason=entry.disabled_reason,
        agents=agents.get(entry.id, []),
    )


def models_view(deps: ModelsDeps) -> AdminModelsOut:
    catalog = deps.store.catalog()
    agents = _agents_by_model(deps)
    return AdminModelsOut(
        version=catalog.version,
        region=deps.region,
        refreshed_at=catalog.refreshed_at,
        items=[_model_out(deps, entry, agents) for entry in catalog.models],
    )


def _audited[T](
    deps: ModelsDeps, event: str, caller: Caller, detail: dict[str, Any], write: Callable[[], T]
) -> T:
    """Fail-closed audit around a catalog write, as in Admin v0 (TM-A9)."""
    actor, user = caller.user.user_id, caller.user
    try:
        deps.audit.emit(event, actor, {**detail, "outcome": "requested"}, user)
    except Exception as exc:
        raise ApiError(503, "audit_unavailable", "the change could not be audited; retry") from exc
    try:
        result = write()
    except Exception as exc:
        code = "version_conflict" if isinstance(exc, VersionConflictError) else "error"
        try:
            deps.audit.emit(event, actor, {**detail, "outcome": "rejected", "error": code}, user)
        except Exception:
            logger.exception("audit emit failed after a rejected write")
        raise
    try:
        deps.audit.emit(event, actor, {**detail, "outcome": "applied"}, user)
    except Exception:
        logger.exception("audit emit failed after an applied write")
    return result


def _replace(entry: ModelEntry, **changes: Any) -> ModelEntry:
    """A validated copy (``model_copy`` would skip validation)."""
    return ModelEntry.model_validate({**entry.model_dump(), **changes})


def _with_prices(entry: ModelEntry, input_usd: Decimal, output_usd: Decimal) -> dict[str, Any]:
    """New prices. The screen only asks for input and output: the cache prices keep their
    ratio to the input price, or cost as much as input when there was none (never cheaper)."""
    if entry.input_usd > 0:
        ratio = input_usd / entry.input_usd
        cache_read = (entry.cache_read_usd * ratio).quantize(Decimal("0.000001"))
        cache_write = (entry.cache_write_usd * ratio).quantize(Decimal("0.000001"))
    else:
        cache_read = cache_write = input_usd
    return {
        "input_usd": input_usd,
        "output_usd": output_usd,
        "cache_read_usd": min(cache_read, MAX_PRICE_USD),
        "cache_write_usd": min(cache_write, MAX_PRICE_USD),
    }


def _prices(entry: ModelEntry) -> dict[str, str]:
    return {"input_usd": _money(entry.input_usd), "output_usd": _money(entry.output_usd)}


def update_model(deps: ModelsDeps, caller: Caller, model_id: str, body: ModelUpdateIn) -> None:
    catalog = deps.store.catalog()
    entry = catalog.get(model_id)
    if entry is None:
        raise ApiError(404, "not_found", "not found")
    if body.version != catalog.version:
        raise VersionConflictError("model catalog changed")
    now = deps.clock()
    actor = caller.user.email or caller.user.user_id
    detail: dict[str, Any] = {"model": model_id, "base_version": body.version}
    if body.enabled:
        if body.input_usd is None or body.output_usd is None:  # the body validator ensures it
            raise ApiError(422, "invalid_request", "invalid fields: input_usd, output_usd")
        if entry.in_bedrock is False:
            raise ApiError(409, "model_no_access", "the account has no access to this model")
        event = "settings.model.price_updated" if entry.enabled else "settings.model.enabled"
        updated = _replace(
            entry,
            enabled=True,
            **_with_prices(entry, body.input_usd, body.output_usd),
            confirmed_by=actor,
            confirmed_at=iso(now),
            disabled_by=None,
            disabled_at=None,
            disabled_reason=None,
        )
        detail |= {"before": _prices(entry), "after": _prices(updated)}
    else:
        if not entry.enabled:
            raise ApiError(409, "model_not_enabled", "the model is not enabled")
        if model_id == deps.default_model:
            raise ApiError(409, "default_model", "the default model cannot be disabled")
        event = "settings.model.disabled"
        affected = _agents_by_model(deps).get(model_id, [])
        updated = _replace(
            entry,
            enabled=False,
            disabled_by=actor,
            disabled_at=iso(now),
            disabled_reason=body.reason or None,
        )
        detail |= {
            "reason": body.reason or None,
            "affected_agents": [a.id for a in affected[:_MAX_AUDITED_IDS]],
            "affected_agent_count": len(affected),
        }
    models = tuple(updated if m.id == model_id else m for m in catalog.models)
    _audited(
        deps,
        event,
        caller,
        detail,
        lambda: deps.store.save(catalog.version, models, caller.user.user_id, now),
    )


def merge_bedrock(
    models: Iterable[ModelEntry],
    listed: Iterable[BedrockModel],
    prices: dict[str, ModelPrice],
    capabilities: Mapping[str, ModelCapability] = MappingProxyType({}),
) -> tuple[tuple[ModelEntry, ...], list[str], list[str]]:
    """The catalog after asking Bedrock, the ids it gained and the ids Bedrock no longer lists.

    Known models keep their state and prices; only what Bedrock and the release describe is
    updated. A new model starts disabled, and without a price unless the installation
    configuration has one. Bedrock does not say whether a model supports tool use: that comes
    from the release capabilities, and a model they do not list starts without it (fail
    closed). A known model the release does not list keeps the capabilities it had.
    """
    by_id = {m.id: m for m in listed}
    merged: list[ModelEntry] = []
    missing: list[str] = []
    for entry in models:
        bedrock = by_id.pop(entry.id, None)
        if bedrock is None:
            missing.append(entry.id)
            merged.append(_replace(entry, in_bedrock=False))
        else:
            known = capabilities.get(bedrock.foundation_model)
            merged.append(
                _replace(
                    entry,
                    name=bedrock.name,
                    provider=bedrock.provider,
                    supports_vision=bedrock.supports_vision,
                    in_bedrock=True,
                    **(
                        {
                            "supports_tools": known.supports_tools,
                            "context_tokens": known.context_tokens,
                        }
                        if known
                        else {}
                    ),
                )
            )
    added: list[str] = []
    for bedrock in sorted(by_id.values(), key=lambda m: m.id):
        if len(merged) >= MAX_CATALOG_MODELS:
            logger.warning("model catalog is full; some Bedrock models were left out")
            break
        price = prices.get(bedrock.id)
        known = capabilities.get(bedrock.foundation_model)
        merged.append(
            ModelEntry(
                id=bedrock.id,
                name=bedrock.name,
                provider=bedrock.provider,
                enabled=False,
                supports_tools=known.supports_tools if known else False,
                context_tokens=known.context_tokens if known else None,
                supports_vision=bedrock.supports_vision,
                input_usd=price.input if price else Decimal(0),
                output_usd=price.output if price else Decimal(0),
                cache_read_usd=price.cache_read if price else Decimal(0),
                cache_write_usd=price.cache_write if price else Decimal(0),
                in_bedrock=True,
            )
        )
        added.append(bedrock.id)
    return tuple(merged), added, missing


def refresh(deps: ModelsDeps, caller: Caller) -> None:
    user_id = caller.user.user_id
    if not deps.rate_limiter.allow(user_id):
        raise rate_limited(deps.rate_limiter.retry_after(user_id))
    catalog: ModelCatalog = deps.store.catalog()
    try:
        listed = deps.bedrock.list_models()
    except BedrockUnavailableError as exc:
        logger.warning("bedrock listing failed: %s", exc)
        raise ApiError(502, "bedrock_unavailable", "Bedrock could not be reached") from exc
    try:
        capabilities = deps.capabilities()
    except ModelCapabilitiesError as exc:
        # Without the release data every new model would lose tool use: change nothing.
        logger.exception("model capabilities unavailable")
        raise ApiError(503, "capabilities_unavailable", "please try again") from exc
    models, added, missing = merge_bedrock(catalog.models, listed, deps.list_prices, capabilities)
    now = deps.clock()
    _audited(
        deps,
        "settings.models.refreshed",
        caller,
        {
            "base_version": catalog.version,
            "added": added[:_MAX_AUDITED_IDS],
            "added_count": len(added),
            "missing": missing[:_MAX_AUDITED_IDS],
            "missing_count": len(missing),
        },
        lambda: deps.store.save(catalog.version, models, user_id, now, refreshed=True),
    )


# --- Router -----------------------------------------------------------------------------


Authorize = Callable[..., Awaitable[None]]


def models_router(
    deps: ModelsDeps,
    current_user: Callable[..., Awaitable[Caller]],
    authorize: Authorize,
) -> APIRouter:
    router = APIRouter(prefix="/api/admin/models")

    def manage_models(*, read_only: bool = False) -> Callable[[Caller], Awaitable[Caller]]:
        async def dependency(caller: Annotated[Caller, Depends(current_user)]) -> Caller:
            await authorize(caller, "ManageModels", *PLATFORM, read_only=read_only)
            # Defense in depth: the Cedar policy already requires isAdmin.
            if not caller.user.is_admin:
                raise ApiError(403, "forbidden", "not allowed")
            return caller

        return dependency

    View = Annotated[Caller, Depends(manage_models(read_only=True))]  # noqa: N806
    Manage = Annotated[Caller, Depends(manage_models())]  # noqa: N806
    ModelId = Annotated[str, Path(pattern=MODEL_ID_PATTERN)]  # noqa: N806

    async def run[T](fn: Callable[..., T], *args: Any) -> T:
        try:
            return await asyncio.to_thread(fn, *args)
        except VersionConflictError as exc:
            raise ApiError(409, "version_conflict", "catalog changed; reload and retry") from exc
        except ModelCatalogUnavailableError as exc:
            raise ApiError(503, "models_unavailable", "please try again") from exc

    @router.get("", response_model=AdminModelsOut)
    async def get_admin_models(_caller: View) -> AdminModelsOut:
        return await run(models_view, deps)

    @router.post("/refresh", response_model=AdminModelsOut)
    async def refresh_admin_models(_body: EmptyIn, caller: Manage) -> AdminModelsOut:
        await run(refresh, deps, caller)
        return await run(models_view, deps)

    @router.put("/{model_id}", response_model=AdminModelsOut)
    async def put_admin_model(
        model_id: ModelId, body: ModelUpdateIn, caller: Manage
    ) -> AdminModelsOut:
        await run(update_model, deps, caller, model_id, body)
        return await run(models_view, deps)

    return router
