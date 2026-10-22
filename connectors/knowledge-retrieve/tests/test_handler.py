"""The knowledge-retrieve tool against moto DynamoDB and a Bedrock that applies the filter
(D88 (14), (22), (27); TM-K1, TM-K2, TM-K3).

The isolation cases (R4 of the plan): two knowledge bases of two groups and two areas, one
agent with both. Nobody outside the groups of a base gets a fragment of it, whatever the model
asks, and with nothing to search Bedrock is not called.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from mango_core.identity import IdentityError
from mango_core.rate_limits import RateLimitStore, SharedRateLimiter
from mango_knowledge_retrieve.audit import AuditWriter
from mango_knowledge_retrieve.handler import (
    LIMIT_NAME,
    NOTICE,
    RESERVED_CONTEXT_ARG,
    Deps,
    Settings,
    handle,
)
from mango_knowledge_retrieve.registry import Registry

HR = "01JABCDEFGHJKMNPQRSTVWXYZ0"
"""Base of `hr`, for the area `finanzas`."""
OPS = "01JABCDEFGHJKMNPQRSTVWXYZ1"
"""Base of `ops`, for every area."""
GONE = "01JABCDEFGHJKMNPQRSTVWXYZ2"
"""Of `hr` too, being deleted."""
OTHER = "01JABCDEFGHJKMNPQRSTVWXYZ3"
"""Of `hr`, but not one of the agent's."""
SETTINGS = Settings(
    namespace="poc",
    issuer="https://cognito-idp.us-east-1.amazonaws.com/us-east-1_example",
    client_id="web",
    knowledge_table="knowledge",
    knowledge_base_id="BEDROCKKB1",
    rate_limits_table="rate-limits",
    audit_stream="audit",
    audit_index_table="audit-index",
)
USERS = {
    "token-hr": {"sub": "user-hr", "cognito:groups": ["hr"]},
    "token-ops": {"sub": "user-ops", "cognito:groups": ["ops"]},
    "token-both": {"sub": "user-both", "cognito:groups": ["hr", "ops"]},
    "token-admin": {"sub": "user-admin", "cognito:groups": ["mango-admins"], "mango_admin": "true"},
}


@dataclass
class Bedrock:
    """``Retrieve`` over a corpus, applying the filter as S3 Vectors does."""

    corpus: list[dict[str, Any]]
    calls: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None

    def __call__(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        if self.error:
            raise ClientError({"Error": {"Code": self.error, "Message": "m"}}, "Retrieve")
        conditions = kwargs["retrievalConfiguration"]["vectorSearchConfiguration"]["filter"]
        wanted = {c["in"]["key"]: set(c["in"]["value"]) for c in conditions["andAll"]}
        for values in wanted.values():
            if not values:
                raise ClientError({"Error": {"Code": "ValidationException"}}, "Retrieve")
        return {
            "retrievalResults": [
                {
                    "content": {"text": doc["text"]},
                    "score": 0.9,
                    "metadata": {
                        "kb_id": doc["kb_id"],
                        "doc_id": doc["doc_id"],
                        "business_unit": doc["business_unit"],
                        "x-amz-bedrock-kb-chunk-id": f"chunk-{doc['doc_id']}",
                        "x-amz-bedrock-kb-document-page-number": 2.0,
                    },
                }
                for doc in self.corpus
                if all(doc[key] in values for key, values in wanted.items())
            ]
        }


@dataclass
class Firehose:
    records: list[dict[str, Any]] = field(default_factory=list)
    fail: bool = False

    def put_record(self, **kwargs: Any) -> None:
        if self.fail:
            raise RuntimeError("firehose down")
        self.records.append(json.loads(kwargs["Record"]["Data"]))


@dataclass
class Env:
    deps: Deps
    bedrock: Bedrock
    firehose: Firehose
    db: Any
    metrics: list[tuple[str, float]]


def _verify(token: str) -> dict[str, Any]:
    if token not in USERS:
        raise IdentityError("invalid access token")
    return USERS[token]


def _table(db: Any, name: str) -> None:
    db.create_table(
        TableName=name,
        KeySchema=[
            {"AttributeName": "PK", "KeyType": "HASH"},
            {"AttributeName": "SK", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": "PK", "AttributeType": "S"},
            {"AttributeName": "SK", "AttributeType": "S"},
        ],
        BillingMode="PAY_PER_REQUEST",
    )


def _kb(
    db: Any, kb_id: str, name: str, area: str, groups: list[str], *, status: str = "ok"
) -> None:
    db.put_item(
        TableName="knowledge",
        Item={
            "PK": {"S": f"KB#{kb_id}"},
            "SK": {"S": "META"},
            "kb_id": {"S": kb_id},
            "name": {"S": name},
            "business_unit": {"S": area},
            "groups": {"SS": groups},
            "status": {"S": status},
        },
    )


def _doc(db: Any, kb_id: str, doc_id: str, name: str) -> None:
    db.put_item(
        TableName="knowledge",
        Item={
            "PK": {"S": f"KB#{kb_id}"},
            "SK": {"S": f"DOC#{doc_id}"},
            "kb_id": {"S": kb_id},
            "doc_id": {"S": doc_id},
            "name": {"S": name},
        },
    )


@pytest.fixture
def env() -> Iterator[Env]:
    with mock_aws():
        db = boto3.client("dynamodb", region_name="us-east-1")
        for name in ("knowledge", "rate-limits", "audit-index"):
            _table(db, name)
        _kb(db, HR, "Nómina", "finanzas", ["hr"])
        _kb(db, OPS, "Runbooks", "all", ["ops"])
        _kb(db, GONE, "Vieja", "finanzas", ["hr"], status="deleting")
        _kb(db, OTHER, "Ajena", "finanzas", ["hr"])
        _doc(db, HR, "DOCHR", "nomina.pdf")
        _doc(db, OPS, "DOCOPS", "runbook.md")
        bedrock = Bedrock(
            [
                {"kb_id": HR, "business_unit": "finanzas", "doc_id": "DOCHR", "text": "salarios"},
                {"kb_id": OPS, "business_unit": "all", "doc_id": "DOCOPS", "text": "reinicio"},
                {"kb_id": GONE, "business_unit": "finanzas", "doc_id": "DOCG", "text": "vieja"},
                {"kb_id": OTHER, "business_unit": "finanzas", "doc_id": "DOCX", "text": "ajena"},
            ]
        )
        firehose = Firehose()
        metrics: list[tuple[str, float]] = []
        deps = Deps(
            settings=SETTINGS,
            verify=_verify,
            registry=Registry(db, "knowledge"),
            retrieve=bedrock,
            limiter=SharedRateLimiter(
                RateLimitStore(db, "rate-limits"), LIMIT_NAME, 3, 60, pause=lambda _s: None
            ),
            audit=AuditWriter(firehose, "audit", db, "audit-index"),
            metric=lambda name, value: metrics.append((name, value)),
        )
        yield Env(deps, bedrock, firehose, db, metrics)


def _context(tool: str = "knowledge___retrieve") -> SimpleNamespace:
    return SimpleNamespace(
        client_context=SimpleNamespace(custom={"bedrockAgentCoreToolName": tool})
    )


def _call(
    env: Env,
    token: str = "token-hr",
    *,
    signed: list[str] | None = None,
    tool: str = "knowledge___retrieve",
    **arguments: Any,
) -> dict[str, Any]:
    event = {
        "query": "¿qué dice?",
        **arguments,
        RESERVED_CONTEXT_ARG: {
            "token": token,
            "knowledge_bases": [HR, OPS, GONE] if signed is None else signed,
            "agent_id": "ayuda",
            "agent_version": 2,
        },
    }
    return handle(event, _context(tool), env.deps)


def _texts(answer: dict[str, Any]) -> list[str]:
    return [f["text"] for f in answer["fragments"]]


def _audited(env: Env) -> dict[str, Any]:
    [record] = [r for r in env.firehose.records if r["event"] == "kb.retrieve"][-1:]
    return record


# --- Isolation ---------------------------------------------------------------------------


def test_a_person_gets_fragments_only_of_the_bases_of_their_groups(env: Env) -> None:
    answer = _call(env, "token-hr")
    assert _texts(answer) == ["salarios"]
    assert answer["notice"] == NOTICE
    [fragment] = answer["fragments"]
    assert fragment == {
        "knowledge_base": "Nómina",
        "knowledge_base_id": HR,
        "document": "nomina.pdf",
        "page": 2,
        "score": 0.9,
        "text": "salarios",
    }
    assert _texts(_call(env, "token-ops")) == ["reinicio"]
    assert sorted(_texts(_call(env, "token-both"))) == ["reinicio", "salarios"]


def test_the_filter_names_only_what_the_person_may_use(env: Env) -> None:
    _call(env, "token-ops")
    vector = env.bedrock.calls[-1]["retrievalConfiguration"]["vectorSearchConfiguration"]
    assert vector["filter"] == {
        "andAll": [
            {"in": {"key": "kb_id", "value": [OPS]}},
            {"in": {"key": "business_unit", "value": ["all"]}},
        ]
    }


def test_an_administrator_is_not_in_the_groups_and_gets_nothing(env: Env) -> None:
    # Rule 5: being an administrator does not give the use of a knowledge base.
    answer = _call(env, "token-admin")
    assert answer["status"] == "no_results"
    assert answer["fragments"] == []
    assert env.bedrock.calls == []


def test_with_nothing_to_search_bedrock_is_not_called(env: Env) -> None:
    # An empty `in` makes Bedrock refuse the search (D88 (27)); it is never asked.
    assert _call(env, "token-ops", signed=[HR])["fragments"] == []
    assert _call(env, "token-hr", signed=[])["fragments"] == []
    assert env.bedrock.calls == []
    assert _audited(env)["detail"]["outcome"] == "nothing_to_search"


def test_the_model_cannot_name_a_base_outside_the_agent(env: Env) -> None:
    # OTHER is a base of `hr` the agent does not have: asking for it searches nothing.
    answer = _call(env, "token-hr", knowledge_bases=[OTHER])
    assert answer["fragments"] == []
    assert env.bedrock.calls == []
    # Naming one of the agent's narrows the search to it.
    assert _texts(_call(env, "token-both", knowledge_bases=[OPS, OTHER, "cualquier cosa"])) == [
        "reinicio"
    ]


def test_a_base_being_deleted_is_not_searched(env: Env) -> None:
    _call(env, "token-hr", signed=[GONE, HR])
    kb_filter = env.bedrock.calls[-1]["retrievalConfiguration"]["vectorSearchConfiguration"]
    assert kb_filter["filter"]["andAll"][0]["in"]["value"] == [HR]


def test_a_change_of_groups_holds_at_once(env: Env) -> None:
    # The groups of a base are read on every call (D88 (22)): no reindexing, no cache.
    assert _texts(_call(env, "token-ops", signed=[HR])) == []
    _kb(env.db, HR, "Nómina", "finanzas", ["hr", "ops"])
    assert _texts(_call(env, "token-ops", signed=[HR])) == ["salarios"]


def test_a_fragment_bedrock_returns_from_another_base_is_dropped(env: Env) -> None:
    def leaky(**kwargs: Any) -> dict[str, Any]:
        env.bedrock.calls.append(kwargs)
        return {
            "retrievalResults": [
                {"content": {"text": "ajena"}, "metadata": {"kb_id": OTHER, "doc_id": "DOCX"}},
                {"content": {"text": "salarios"}, "metadata": {"kb_id": HR, "doc_id": "DOCHR"}},
            ]
        }

    deps = Deps(**{**env.deps.__dict__, "retrieve": leaky})
    event = {
        "query": "q",
        RESERVED_CONTEXT_ARG: {
            "token": "token-hr",
            "knowledge_bases": [HR],
            "agent_id": "ayuda",
            "agent_version": 2,
        },
    }
    assert _texts(handle(event, _context(), deps)) == ["salarios"]


# --- Who asks and what -------------------------------------------------------------------


def test_without_the_interceptor_context_nothing_is_searched(env: Env) -> None:
    assert handle({"query": "q"}, _context(), env.deps)["error"]["code"] == "unauthenticated"
    # A context the model wrote has no knowledge bases mango-api signed.
    event = {"query": "q", RESERVED_CONTEXT_ARG: {"token": "token-hr"}}
    assert handle(event, _context(), env.deps)["error"]["code"] == "unauthenticated"
    assert _call(env, "token-forged")["error"]["code"] == "unauthenticated"
    assert env.bedrock.calls == []


def test_only_the_query_and_some_bases_are_accepted(env: Env) -> None:
    assert _call(env, query="")["error"]["code"] == "invalid_arguments"
    assert _call(env, query="x" * 1001)["error"]["code"] == "invalid_arguments"
    assert _call(env, filter={"kb_id": OTHER})["error"]["code"] == "invalid_arguments"
    assert _call(env, tool="knowledge___other")["error"]["code"] == "unknown_tool"
    assert env.bedrock.calls == []


def test_searches_are_limited_per_person(env: Env) -> None:
    for _ in range(3):
        assert "error" not in _call(env, "token-hr")
    assert _call(env, "token-hr")["error"]["code"] == "rate_limited"
    # Another person keeps their own.
    assert "error" not in _call(env, "token-ops")


# --- Audit, throttling and failures ------------------------------------------------------


def test_each_search_is_audited_with_ids_and_counts(env: Env) -> None:
    _call(env, "token-hr", query="¿cuánto es el salario?")
    record = _audited(env)
    assert record["user_id"] == "user-hr"
    assert record["detail"] == {
        "agent_id": "ayuda",
        "agent_version": 2,
        "requested": sorted([HR, OPS, GONE]),
        "allowed": [HR],
        "returned": [HR],
        "fragments": ["chunk-DOCHR"],
        "query_chars": len("¿cuánto es el salario?"),
        "outcome": "ok",
    }
    # Never the query, a name nor a fragment.
    line = json.dumps(record)
    assert "salario" not in line
    assert "Nómina" not in line
    assert "nomina.pdf" not in line
    index = env.db.scan(TableName="audit-index")["Items"]
    assert len(index) == 1


def test_without_the_audit_nothing_is_answered(env: Env) -> None:
    env.firehose.fail = True
    assert _call(env, "token-hr")["error"]["code"] == "unavailable"


def test_a_throttled_search_says_busy_and_publishes_the_metric(env: Env) -> None:
    env.bedrock.error = "ThrottlingException"
    assert _call(env, "token-hr")["error"]["code"] == "busy"
    assert env.metrics == [("RetrieveThrottles", 1)]
    assert _audited(env)["detail"]["outcome"] == "throttled"


def test_a_failed_search_is_never_retried_without_its_filter(env: Env) -> None:
    env.bedrock.error = "ValidationException"
    assert _call(env, "token-hr")["error"]["code"] == "unavailable"
    assert len(env.bedrock.calls) == 1
    assert "filter" in env.bedrock.calls[0]["retrievalConfiguration"]["vectorSearchConfiguration"]


def test_a_document_without_its_record_keeps_a_generic_name(env: Env) -> None:
    env.db.delete_item(
        TableName="knowledge", Key={"PK": {"S": f"KB#{HR}"}, "SK": {"S": "DOC#DOCHR"}}
    )
    [fragment] = _call(env, "token-hr")["fragments"]
    assert fragment["document"] == "Documento"
