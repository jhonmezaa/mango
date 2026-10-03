import json
from typing import Any

import boto3
from botocore.stub import Stubber

from mango_core.identity import UserContext
from mango_cost_explorer.mapping import MappingCache, load_mapping
from mango_cost_explorer.scope import Account, resolve_scope

OU_SEC = "ou-abcd-22222222"
KEY = {"PK": {"S": "BU_MAPPING"}, "SK": {"S": "CURRENT"}}
LEAD = UserContext("u-bu", "bu-lead", "security", is_admin=False)
ACCOUNTS = [Account("222222222222", "Audit", ("r-abcd", OU_SEC))]


def _db() -> Any:
    return boto3.client(
        "dynamodb",
        region_name="us-east-1",
        aws_access_key_id="x",
        aws_secret_access_key="x",
    )


def _item(units: object) -> dict[str, Any]:
    return {"Item": {**KEY, "units": {"S": json.dumps(units)}, "version": {"N": "3"}}}


def _params() -> dict[str, Any]:
    return {"TableName": "settings", "Key": KEY, "ConsistentRead": True}


def test_reads_only_the_mapping_item() -> None:
    db = _db()
    with Stubber(db) as stub:
        stub.add_response("get_item", _item({"security": [OU_SEC]}), _params())
        assert load_mapping(db, "settings") == {"security": frozenset({OU_SEC})}
        stub.assert_no_pending_responses()


class _Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def test_cache_expires_after_at_most_five_minutes() -> None:
    db, clock = _db(), _Clock()
    cache = MappingCache(lambda: load_mapping(db, "settings"), ttl_seconds=3600, clock=clock)
    with Stubber(db) as stub:
        stub.add_response("get_item", _item({"security": [OU_SEC]}), _params())
        stub.add_response("get_item", _item({"sandbox": [OU_SEC]}), _params())
        assert "security" in cache.get()
        clock.now = 299
        assert "security" in cache.get()
        clock.now = 301
        assert set(cache.get()) == {"sandbox"}
        stub.assert_no_pending_responses()


def _fails_closed(response: dict[str, Any] | None) -> None:
    db = _db()
    cache = MappingCache(lambda: load_mapping(db, "settings"))
    with Stubber(db) as stub:
        if response is None:
            stub.add_client_error("get_item", "AccessDeniedException")
        else:
            stub.add_response("get_item", response, _params())
        mapping = cache.get()
    assert mapping == {}
    # A bu-lead sees no accounts without a valid mapping.
    assert resolve_scope(LEAD, ACCOUNTS, mapping).accounts == ()


def test_missing_mapping_fails_closed() -> None:
    _fails_closed({})


def test_unreadable_mapping_fails_closed() -> None:
    _fails_closed(None)


def test_tampered_mapping_fails_closed() -> None:
    _fails_closed(_item({"security": ["*"]}))
    _fails_closed(_item({"security": [OU_SEC], "BAD AREA": [OU_SEC]}))
    _fails_closed({"Item": {**KEY, "units": {"S": "{not json"}}})


def test_failures_are_not_cached() -> None:
    db = _db()
    cache = MappingCache(lambda: load_mapping(db, "settings"))
    with Stubber(db) as stub:
        stub.add_client_error("get_item", "ProvisionedThroughputExceededException")
        stub.add_response("get_item", _item({"security": [OU_SEC]}), _params())
        assert cache.get() == {}
        assert cache.get() == {"security": frozenset({OU_SEC})}
