"""The code tools against moto (DynamoDB, KMS, S3, Firehose) and a fake Code Interpreter whose
sessions really run Python (D114, D115; TM-CI1, CI2, CI4, CI6, CI7, CI9, CI11)."""

from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from dataclasses import dataclass, replace
from types import SimpleNamespace
from typing import Any

import boto3
import pytest
from moto import mock_aws

from mango_code_interpreter import handler as code
from mango_code_interpreter import outputs
from mango_code_interpreter.audit import AuditWriter
from mango_code_interpreter.handler import (
    CELLS_PER_TURN,
    NOTICE,
    RESERVED_CONTEXT_ARG,
    Deps,
    Settings,
    handle,
)
from mango_code_interpreter.sandbox import Sandbox
from mango_code_interpreter.sessions import RlsClients, SessionStore
from mango_core import chat_files
from mango_core.code_sandbox import Prices, cell_use, cost, run_sk, session_sk, turn_prefix
from mango_core.identity import IdentityError
from mango_core.rate_limits import RateLimitStore, SharedRateLimiter

SLOW_MARKER = "# fake: never returns"
"""As ``conftest.SLOW_MARKER``: the fake times out like a read timeout of the client."""
REGION = "us-east-1"
CONV = "c" * 32
OTHER_CONV = "d" * 32
TURN = "e" * 32
USERS = {
    "token-ana": {"sub": "user-ana", "cognito:groups": ["ventas"]},
    "token-bob": {"sub": "user-bob", "cognito:groups": ["ventas"]},
}


@dataclass
class World:
    deps: Deps
    agentcore: Any
    dynamodb: Any
    s3: Any
    firehose_records: list[dict[str, Any]]
    metrics: list[tuple[str, float]]
    clock: list[float]

    def item(self, user: str, sk: str) -> dict[str, Any] | None:
        got = self.dynamodb.get_item(
            TableName="conversations", Key={"PK": {"S": f"USER#{user}"}, "SK": {"S": sk}}
        )
        return got.get("Item")

    def runs(self, user: str, turn: str = TURN) -> list[dict[str, Any]]:
        return self.dynamodb.query(
            TableName="conversations",
            KeyConditionExpression="PK = :pk AND begins_with(SK, :p)",
            ExpressionAttributeValues={
                ":pk": {"S": f"USER#{user}"},
                ":p": {"S": turn_prefix(turn)},
            },
        )["Items"]


def _verify(token: str) -> dict[str, Any]:
    if token not in USERS:
        raise IdentityError("bad token")
    return USERS[token]


def _table(dynamodb: Any, name: str) -> None:
    dynamodb.create_table(
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


@pytest.fixture
def world(agentcore: Any) -> Iterator[World]:
    with mock_aws():
        dynamodb = boto3.client("dynamodb", region_name=REGION)
        for name in ("conversations", "rate-limits", "audit-index"):
            _table(dynamodb, name)
        kms = boto3.client("kms", region_name=REGION)
        key = kms.create_key()["KeyMetadata"]["Arn"]
        s3 = boto3.client("s3", region_name=REGION)
        s3.create_bucket(Bucket="chat-files")
        records: list[dict[str, Any]] = []
        firehose = SimpleNamespace(put_record=lambda **kw: records.append(kw))
        metrics: list[tuple[str, float]] = []
        clock = [1_900_000_000.0]
        settings = Settings(
            namespace="poc",
            issuer="https://cognito-idp.us-east-1.amazonaws.com/us-east-1_example",
            client_id="web",
            interpreter_id=agentcore.interpreter_id,
            conversations_table="conversations",
            conversations_table_arn="arn:aws:dynamodb:us-east-1:111122223333:table/conversations",
            data_key_arn="arn:aws:kms:us-east-1:111122223333:key/data",
            data_role_arn="arn:aws:iam::111122223333:role/Mango-poc-ConversationData",
            session_key_arn=key,
            files_bucket="chat-files",
            rate_limits_table="rate-limits",
            audit_stream="audit",
            audit_index_table="audit-index",
            region=REGION,
            cell_seconds=5,
        )
        limits = RateLimitStore(dynamodb, "rate-limits")

        def put(key_: str, data: bytes, mime: str) -> None:
            s3.put_object(Bucket="chat-files", Key=key_, Body=data, ContentType=mime)

        def get(key_: str) -> bytes | None:
            try:
                body: bytes = s3.get_object(Bucket="chat-files", Key=key_)["Body"].read()
            except s3.exceptions.NoSuchKey:
                return None
            return body

        deps = Deps(
            settings=settings,
            verify=_verify,
            sandbox=Sandbox(agentcore, agentcore, agentcore.interpreter_id),
            store_for=lambda sub: SessionStore(dynamodb, "conversations", kms, key, sub),
            put_file=put,
            get_file=get,
            runs=SharedRateLimiter(limits, code.RUNS_LIMIT, code.RUNS_PER_MINUTE, 60),
            sessions=SharedRateLimiter(limits, code.SESSIONS_LIMIT, code.SESSIONS_PER_HOUR, 3600),
            audit=AuditWriter(firehose, "audit", dynamodb, "audit-index"),
            metric=lambda name, value: metrics.append((name, value)),
            clock=lambda: clock[0],
        )
        yield World(deps, agentcore, dynamodb, s3, records, metrics, clock)


def _ctx(token: str = "token-ana", sub: str = "user-ana", **overrides: Any) -> dict[str, Any]:
    return {
        "token": token,
        "subject": sub,
        "agent_id": "analista",
        "agent_version": 2,
        "conversation_id": CONV,
        "turn_id": TURN,
        **overrides,
    }


def _call(
    world: World, tool: str, args: dict[str, Any], ctx: dict[str, Any] | None = None
) -> dict[str, Any]:
    context = SimpleNamespace(
        client_context=SimpleNamespace(custom={"bedrockAgentCoreToolName": f"code___{tool}"})
    )
    event = {**args, RESERVED_CONTEXT_ARG: ctx if ctx is not None else _ctx()}
    return handle(event, context, world.deps)


def _run(world: World, source: str, **ctx: Any) -> dict[str, Any]:
    return _call(world, "run_python", {"code": source}, _ctx(**ctx) if ctx else None)


def _text(result: dict[str, Any]) -> str:
    assert "text" in result, result
    return str(result["text"])


def _logged(caplog: pytest.LogCaptureFixture) -> str:
    """What the connector itself logged (its logger is the root one), not boto's debug lines."""
    return "\n".join(r.getMessage() for r in caplog.records if r.name == "root")


def _audits(world: World) -> list[dict[str, Any]]:
    return [json.loads(r["Record"]["Data"]) for r in world.firehose_records]


# --- One cell ---------------------------------------------------------------------------


def test_a_cell_runs_and_answers_the_model_text_only(world: World) -> None:
    result = _run(world, "x = 21\nprint('hola')\nx * 2")
    text = _text(result)
    assert set(result) == {"text"}
    assert text.startswith(NOTICE)
    assert "status: ok" in text
    assert "hola\n42" in text
    assert "new session" in text


def test_state_persists_between_cells_of_the_same_conversation(world: World) -> None:
    _run(world, "total = 40")
    text = _text(_run(world, "total + 2"))
    assert "42" in text
    assert "new session" not in text
    assert [c for c, _ in world.agentcore.calls].count("start") == 1


def test_an_exception_is_reported_with_the_cells_own_traceback(world: World) -> None:
    text = _text(_run(world, "def f():\n    return 1 / 0\nf()"))
    assert "status: error" in text
    assert "exception: ZeroDivisionError: division by zero" in text
    assert 'File "<cell>"' in text
    assert "_mango" not in text


def test_the_cell_is_cut_at_its_own_cutoff(world: World) -> None:
    world.deps = replace(world.deps, settings=replace(world.deps.settings, cell_seconds=1))
    text = _text(_run(world, "while True:\n    pass"))
    assert "status: timeout" in text
    # The session is still sound: the next cell runs in it.
    assert "7" in _text(_run(world, "3 + 4"))


def test_a_cell_that_never_comes_back_stops_and_drops_its_session(world: World) -> None:
    _run(world, "a = 1")
    first = next(iter(world.agentcore.sessions))
    text = _text(_run(world, f"{SLOW_MARKER}\nb = 2"))
    assert "status: timeout" in text
    assert world.agentcore.sessions[first].stopped
    assert world.item("user-ana", session_sk(CONV)) is None
    assert "new session" in _text(_run(world, "1"))


def test_a_cell_that_catches_everything_still_reports(world: World) -> None:
    text = _text(
        _run(world, "try:\n    raise ValueError('x')\nexcept BaseException:\n    print('kept')")
    )
    assert "status: ok" in text
    assert "kept" in text


# --- Sessions (TM-CI1, TM-CI2) -----------------------------------------------------------


def test_one_session_per_person_and_conversation(world: World) -> None:
    _run(world, "secret = 'ana'")
    _run(world, "secret = 'other conversation'", conversation_id=OTHER_CONV)
    _run(world, "secret = 'bob'", token="token-bob", sub="user-bob")
    assert len(world.agentcore.sessions) == 3
    assert "'ana'" in _text(_run(world, "secret"))
    assert "'bob'" in _text(_run(world, "secret", token="token-bob", sub="user-bob"))


def test_the_session_id_never_leaves_the_connector(
    world: World, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    answers = [
        _run(world, "import os\nopen('a.csv', 'w').write('x,y\\n1,2\\n')\nprint(os.getcwd())"),
        _call(world, "list_files", {}),
        _call(world, "read_file", {"path": "a.csv"}),
    ]
    [session_id] = world.agentcore.sessions
    scanned = world.dynamodb.scan(TableName="conversations")["Items"]
    stored = json.dumps([{k: v for k, v in i.items() if k != "sealed"} for i in scanned])
    everything = json.dumps(answers) + _logged(caplog) + json.dumps(_audits(world)) + stored
    assert session_id not in everything
    session = world.item("user-ana", session_sk(CONV))
    assert session is not None
    assert session_id.encode() not in session["sealed"]["B"]
    # The audit names it by a short hash only.
    assert _audits(world)[0]["detail"]["session"] == session["session_hash"]["S"]


def test_a_sealed_id_does_not_open_in_another_partition_or_conversation(world: World) -> None:
    _run(world, "1")
    sealed = world.item("user-ana", session_sk(CONV))
    assert sealed is not None
    # Copied, by a bug, to another person's partition and to another conversation.
    for user, conv in (("user-bob", CONV), ("user-ana", OTHER_CONV)):
        world.dynamodb.put_item(
            TableName="conversations",
            Item={**sealed, "PK": {"S": f"USER#{user}"}, "SK": {"S": session_sk(conv)}},
        )
    token, sub = ("token-bob", "user-bob")
    assert _run(world, "1", token=token, sub=sub)["error"]["code"] == "unavailable"
    assert _run(world, "1", conversation_id=OTHER_CONV)["error"]["code"] == "unavailable"


def test_the_token_must_be_the_one_mango_api_signed_for(world: World) -> None:
    result = _run(world, "1", token="token-bob", sub="user-ana")
    assert result["error"]["code"] == "unauthenticated"
    assert world.agentcore.calls == []


@pytest.mark.parametrize(
    "ctx",
    [
        None,
        {"token": "token-ana"},
        _ctx(conversation_id="../" + "c" * 29),
        _ctx(turn_id=None),
        _ctx(token="forged"),
    ],
)
def test_without_what_the_interceptor_sets_nothing_runs(world: World, ctx: Any) -> None:
    context = SimpleNamespace(
        client_context=SimpleNamespace(custom={"bedrockAgentCoreToolName": "code___run_python"})
    )
    event: dict[str, Any] = {"code": "1"}
    if ctx is not None:
        event[RESERVED_CONTEXT_ARG] = ctx
    assert handle(event, context, world.deps)["error"]["code"] == "unauthenticated"
    assert world.agentcore.calls == []


def test_another_cell_of_the_conversation_waits(world: World) -> None:
    _run(world, "1")
    session = world.item("user-ana", session_sk(CONV))
    assert session is not None
    world.dynamodb.update_item(
        TableName="conversations",
        Key={"PK": session["PK"], "SK": session["SK"]},
        UpdateExpression="SET busy_until = :b",
        ExpressionAttributeValues={":b": {"N": str(int(world.clock[0]) + 100)}},
    )
    assert _run(world, "2")["error"]["code"] == "busy"


def test_an_expired_session_is_stopped_and_replaced(world: World) -> None:
    _run(world, "kept = 1")
    [first] = world.agentcore.sessions
    world.clock[0] += 1800 - 100
    text = _text(_run(world, "print('again')"))
    assert "new session" in text
    assert world.agentcore.sessions[first].stopped
    assert len(world.agentcore.sessions) == 2


def test_a_session_is_started_without_anything_of_the_person(world: World) -> None:
    _run(world, "1")
    [(_, start)] = [c for c in world.agentcore.calls if c[0] == "start"]
    assert start["name"].startswith("mango-")
    assert "ana" not in json.dumps(start)
    assert start["sessionTimeoutSeconds"] == 1800


# --- Files (TM-CI4, TM-CF8) ---------------------------------------------------------------

FIGURE = """
import sys, types
png = b'\\x89PNG\\r\\n\\x1a\\n' + b'0' * 32
class Figure:
    def savefig(self, path, dpi=None):
        open(path, 'wb').write(png)
pyplot = types.ModuleType('matplotlib.pyplot')
pyplot.get_fignums = lambda: [1, 2]
pyplot.figure = lambda n: Figure()
pyplot.close = lambda what: None
sys.modules['matplotlib.pyplot'] = pyplot
"""


def test_open_figures_are_saved_and_copied_to_the_chat_files(world: World) -> None:
    text = _text(_run(world, FIGURE))
    files = json.loads(world.runs("user-ana")[0]["files"]["S"])
    assert [f["kind"] for f in files] == ["figure", "figure"]
    for f in files:
        assert f["key"] == chat_files.owner_key("user-ana", CONV, f["file_id"])
        assert chat_files.parse_key(f["key"]) is not None
        body = world.s3.get_object(Bucket="chat-files", Key=f["key"])
        assert body["ContentType"] == "image/png"
        assert body["Body"].read().startswith(b"\x89PNG")
        assert f"id {f['file_id']}" in text


def test_tables_charts_and_data_files_go_out_by_id(world: World) -> None:
    source = (
        "from _mango import display_table, display_chart\n"
        "display_table([{'a': 1, 'b': 2}], 'resumen')\n"
        "display_chart({'chartType': 'bar', 'data': [{'x': 1, 'y': 2}], 'xKey': 'x',"
        " 'series': [{'key': 'y'}], 'meta': {'title': 'Ventas'}})\n"
        "open('ventas.csv', 'w').write('x,y\\n1,2\\n')\n"
    )
    text = _text(_run(world, source))
    files = {f["name"]: f for f in json.loads(world.runs("user-ana")[0]["files"]["S"])}
    assert {n: f["kind"] for n, f in files.items()} == {
        "ventas.csv": "file",
        "resumen.table.json": "table",
        "Ventas.chart.json": "chart",
    }
    assert "sandbox:/mnt/data/ventas.csv" in text
    for f in files.values():
        # Keys are made of ids only, never of the names the model chose.
        assert f["name"] not in f["key"]
    table = world.s3.get_object(Bucket="chat-files", Key=files["resumen.table.json"]["key"])
    assert json.loads(table["Body"].read())["rows"] == [[1, 2]]


@pytest.mark.parametrize(
    ("name", "content"),
    [
        ("page.html", "<script>alert(1)</script>"),
        ("logo.svg", "<svg onload=alert(1)>"),
        ("run.sh", "rm -rf /"),
        ("libro.xlsm", "PK"),
        ("tool.exe", "MZ"),
        ("data.parquet", "PAR1"),
    ],
)
def test_types_outside_the_closed_list_never_go_out(world: World, name: str, content: str) -> None:
    text = _text(_run(world, f"open({name!r}, 'w').write({content!r})"))
    assert f"{name} (type not allowed)" in text
    assert json.loads(world.runs("user-ana")[0]["files"]["S"]) == []
    assert "Contents" not in world.s3.list_objects_v2(Bucket="chat-files")


def test_a_file_whose_bytes_are_not_its_type_never_goes_out(world: World) -> None:
    text = _text(_run(world, "open('foto.png', 'w').write('<html>not a png</html>')"))
    assert "foto.png (its content is not a valid .png)" in text
    assert "Contents" not in world.s3.list_objects_v2(Bucket="chat-files")


def test_an_office_file_with_macros_never_goes_out(world: World) -> None:
    source = (
        "import zipfile\n"
        "with zipfile.ZipFile('libro.xlsx', 'w') as z:\n"
        "    z.writestr('[Content_Types].xml', '<Types/>')\n"
        "    z.writestr('xl/vbaProject.bin', 'macro')\n"
    )
    assert "libro.xlsx (its content is not a valid .xlsx)" in _text(_run(world, source))


# --- What the model and the chat get (TM-CI6) ---------------------------------------------


def test_the_model_gets_capped_output_and_the_chat_its_own_cap(world: World) -> None:
    text = _text(_run(world, "print('x' * 50_000)"))
    assert len(text) <= code.MODEL_TEXT_CHARS + 20
    assert "[truncated]" in text
    [run] = world.runs("user-ana")
    assert len(run["stdout"]["S"]) == code.CHAT_OUTPUT_CHARS
    assert run["stdout_chars"]["N"] == "50001"


def test_the_chat_result_and_the_metered_use_are_stored_for_mango_api(world: World) -> None:
    world.clock[0] += 0
    _run(world, "print('hola')")
    [run] = world.runs("user-ana")
    assert run["state"]["S"] == "done"
    assert run["status"]["S"] == "ok"
    assert run["code"]["S"] == "print('hola')"
    assert run["stdout"]["S"] == "hola\n"
    assert run["conversation_id"]["S"] == CONV
    use = cell_use(run)
    # The cell's seconds, and the memory of the session it started for its whole life.
    assert use.cpu_seconds >= 1
    assert use.session_seconds == 1800
    second = _run(world, "1")
    assert "text" in second
    assert [cell_use(r).session_seconds for r in world.runs("user-ana")].count(0) == 1
    prices = Prices.parse('{"vcpuHour": 0.0895, "gbHour": 0.00945}')
    assert cost([cell_use(r) for r in world.runs("user-ana")], prices) > 0


def test_a_cell_that_never_ends_counts_its_whole_cutoff() -> None:
    running = {"state": {"S": "running"}, "session_seconds": {"N": "1800"}}
    assert cell_use(running).cpu_seconds == 300


def test_a_turn_runs_at_most_its_cells(world: World) -> None:
    for _ in range(CELLS_PER_TURN):
        assert "text" in _run(world, "1")
    assert _run(world, "1")["error"]["code"] == "cell_limit"
    assert "text" in _run(world, "1", turn_id="f" * 32)


def test_code_execute_is_audited_without_code_output_or_names(world: World) -> None:
    _run(world, "open('secreto-ventas.csv', 'w').write('a\\n')\nprint('confidencial')")
    [record] = _audits(world)
    assert record["event"] == "code.execute"
    assert record["user_id"] == "user-ana"
    detail = record["detail"]
    assert detail["files"] == 1
    assert detail["types"] == ["csv"]
    assert detail["conversation_id"] == CONV
    assert detail["turn_id"] == TURN
    flat = json.dumps(record)
    for content in ("secreto", "confidencial", "open("):
        assert content not in flat


def test_nothing_of_the_code_or_its_output_is_logged(
    world: World, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    _run(world, "open('informe-privado.csv', 'w').write('a\\n')\nprint('dato-sensible')")
    logged = _logged(caplog)
    assert "tool.call" in logged
    for content in ("informe-privado", "dato-sensible", "open("):
        assert content not in logged


# --- Failures of the service (TM-CI7) ------------------------------------------------------


def test_a_throttled_sandbox_answers_busy_and_counts_it(world: World) -> None:
    world.agentcore.start_error = "ThrottlingException"
    assert _run(world, "1")["error"]["code"] == "busy"
    assert world.metrics == [(code.THROTTLES_METRIC, 1)]


def test_a_service_error_is_rewritten_never_echoed(world: World) -> None:
    _run(world, "1")
    world.agentcore.stream_error = "accessDeniedException"
    result = _run(world, "2")
    assert result == {
        "error": {"code": "unavailable", "message": code._UNAVAILABLE.payload["error"]["message"]}
    }


def test_new_sessions_per_person_are_limited(world: World) -> None:
    world.deps = replace(
        world.deps,
        sessions=SharedRateLimiter(
            RateLimitStore(world.dynamodb, "rate-limits"), code.SESSIONS_LIMIT, 1, 3600
        ),
    )
    assert "text" in _run(world, "1")
    assert _run(world, "1", conversation_id=OTHER_CONV)["error"]["code"] == "rate_limited"


# --- list_files and read_file (TM-CI9) ------------------------------------------------------


def test_list_and_read_files_of_the_conversation(world: World) -> None:
    _run(world, "open('notas.txt', 'w').write('uno\\ndos')")
    listing = _text(_call(world, "list_files", {}))
    assert "sandbox:/mnt/data/notas.txt" in listing
    for path in ("notas.txt", "/mnt/data/notas.txt", "sandbox:/mnt/data/notas.txt"):
        assert "uno\ndos" in _text(_call(world, "read_file", {"path": path}))


@pytest.mark.parametrize(
    "path",
    [
        "../etc/passwd",
        "/etc/passwd",
        "/mnt/data/../../etc",
        "%2e%2e/x",
        "%252e%252e/x",
        "a\x00b",
        ".mango/lib/_mango.py",
        "a\\..\\b",
    ],
)
def test_read_file_stays_inside_the_logical_root(world: World, path: str) -> None:
    _run(world, "1")
    assert _call(world, "read_file", {"path": path})["error"]["code"] == "invalid_path"


def test_list_files_never_starts_a_session(world: World) -> None:
    assert "no code session" in _text(_call(world, "list_files", {}))
    assert world.agentcore.calls == []


def test_unknown_tools_and_extra_arguments_are_refused(world: World) -> None:
    assert _call(world, "run_shell", {"command": "ls"})["error"]["code"] == "unknown_tool"
    result = _call(world, "run_python", {"code": "1", "timeout": 999})
    assert result["error"]["code"] == "invalid_arguments"


# --- Row-level security ------------------------------------------------------------------


def test_the_session_policy_only_reaches_the_persons_partition() -> None:
    clients = RlsClients(
        None,
        "arn:aws:iam::111122223333:role/Mango-poc-ConversationData",
        "arn:aws:dynamodb:us-east-1:111122223333:table/Mango-poc-Conversations",
        "arn:aws:kms:us-east-1:111122223333:key/data",
        REGION,
    )
    policy = json.loads(clients.policy("user-ana"))
    [table, key] = policy["Statement"]
    assert table["Condition"] == {
        "ForAllValues:StringEquals": {"dynamodb:LeadingKeys": ["USER#user-ana"]}
    }
    assert table["Resource"].endswith("table/Mango-poc-Conversations")
    assert key["Resource"].endswith("key/data")
    # The same key actions as mango-api's row-level security, on the one key.
    assert all(s["Resource"] != "*" and "*" not in s["Resource"] for s in policy["Statement"])


def test_run_items_are_keyed_by_turn_for_the_settlement() -> None:
    assert run_sk(TURN, "r" * 32).startswith(turn_prefix(TURN))


def test_the_size_caps_hold_on_the_real_bytes_not_on_the_report(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The cell rewrites its own report to say its file is tiny.
    source = (
        "open('big.txt', 'w').write('x' * 2048)\n"
        "import _mango\n"
        "_real = _mango._changed\n"
        "_mango._changed = lambda since: [dict(f, size=1) for f in _real(since)]\n"
    )
    _run(world, "1")
    monkeypatch.setattr(outputs, "MAX_FILE_BYTES", 1024)
    text = _text(_run(world, source))
    assert "big.txt (too large)" in text


# --- Files of the chat (U1, D116) -------------------------------------------------------------


def _attach(world: World, file_id: str, name: str, data: bytes, **item: dict[str, Any]) -> None:
    world.s3.put_object(
        Bucket="chat-files", Key=chat_files.owner_key("user-ana", CONV, file_id), Body=data
    )
    world.dynamodb.put_item(
        TableName="conversations",
        Item={
            "PK": {"S": "USER#user-ana"},
            "SK": {"S": f"CFILE#{CONV}#{file_id}"},
            "file_id": {"S": file_id},
            "conversation_id": {"S": CONV},
            "origin": {"S": "upload"},
            "name": {"S": name},
            "kind": {"S": "csv"},
            "size": {"N": str(len(data))},
            "status": {"S": "ready"},
            "status_at": {"N": "1"},
            "created_at": {"N": "1"},
            "expires_at": {"N": str(int(world.clock[0]) + 3600)},
            **item,
        },
    )


READY = "01JABCDEFGHJKMNPQRSTVWXYZ0"
SCANNING = "01JABCDEFGHJKMNPQRSTVWXYZ1"


def test_the_attached_files_that_are_ready_reach_the_session_once(world: World) -> None:
    _attach(world, READY, "ventas.csv", b"x,y\n1,2\n")
    _attach(world, SCANNING, "otro.csv", b"a\n", status={"S": "scanning"})
    text = _text(_run(world, "print(open('ventas.csv').read())"))
    assert f"sandbox:/mnt/data/ventas.csv (attached by the user, id {READY})" in text
    assert "x,y\n1,2" in text
    assert "otro.csv" not in text
    # Written once per session: the next cell does not write it again.
    _run(world, "1")
    writes = [c for c in world.agentcore.calls if c[0] == "writeFiles"]
    # The helpers of the document skills when the session started, then the attached file.
    assert len(writes) == 2


def test_an_attached_name_cannot_leave_the_folder(world: World) -> None:
    _attach(world, READY, "../../etc/x.csv", b"a\n")
    text = _text(_run(world, "import os\nprint(sorted(os.listdir('.')))"))
    assert "..-..-etc-x.csv" in text or "etc-x.csv" in text
    [_, (_, write)] = [c for c in world.agentcore.calls if c[0] == "writeFiles"]
    assert ".." not in write["arguments"]["content"][0]["path"].replace("mnt/data", "")


def test_the_generated_files_are_recorded_as_the_chat_records_an_attached_one(
    world: World,
) -> None:
    _run(world, "open('resumen.csv', 'w').write('a\\n1\\n')")
    [f] = json.loads(world.runs("user-ana")[0]["files"]["S"])
    record = world.item("user-ana", f"CFILE#{CONV}#{f['file_id']}")
    assert record is not None
    assert {k: record[k] for k in ("origin", "status", "kind", "name")} == {
        "origin": {"S": "generated"},
        "status": {"S": "verifying"},
        "kind": {"S": "csv"},
        "name": {"S": "resumen.csv"},
    }
    assert record["sha256"]["S"] == f["sha256"]


# --- render_document (D117, D119) ------------------------------------------------------------

DOCX = "01JABCDEFGHJKMNPQRSTVWXYZ2"
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64


@dataclass
class FakeRender:
    """``Mango-<ns>-RenderDocument`` as its contract says (D117 (7)), writing into moto's S3."""

    s3: Any
    events: list[dict[str, Any]]
    pages: int = 2
    answer: dict[str, Any] | None = None

    def __call__(self, event: dict[str, Any]) -> dict[str, Any]:
        self.events.append(event)
        if self.answer is not None:
            return self.answer
        prefix = event["key_out_prefix"]
        keys = [f"{prefix}page-{n:03d}.png" for n in range(1, self.pages + 1)]
        self.s3.put_object(Bucket="chat-files", Key=f"{prefix}document.pdf", Body=b"%PDF-1.7")
        for key in keys:
            self.s3.put_object(Bucket="chat-files", Key=key, Body=PNG)
        return {
            "status": "ready",
            "kind": "docx",
            "pdf_key": f"{prefix}document.pdf",
            "page_keys": keys,
            "pages_total": self.pages,
            "pages_rendered": self.pages,
            "truncated": False,
        }


@pytest.fixture
def render(world: World) -> FakeRender:
    fake = FakeRender(world.s3, [])
    world.deps = replace(
        world.deps, render=fake, sleep=lambda s: world.clock.__setitem__(0, world.clock[0] + s)
    )
    return fake


def _render(world: World, file: str, **args: Any) -> dict[str, Any]:
    return _call(world, "render_document", {"file": file, **args})


def test_a_new_session_gets_the_helpers_of_the_document_skills(world: World) -> None:
    text = _text(_run(world, "import mango_docs\nmango_docs.clean_text('a\u2011b\u200bc')"))
    assert "'a-bc'" in text
    [(_, write)] = [c for c in world.agentcore.calls if c[0] == "writeFiles"]
    [item] = write["arguments"]["content"]
    assert item["path"].endswith("/.mango/lib/mango_docs.py")


def test_a_document_is_rendered_into_the_session_by_name(world: World, render: FakeRender) -> None:
    _attach(world, DOCX, "informe.docx", b"PK\x03\x04docx", kind={"S": "docx"})
    text = _text(_render(world, "informe.docx"))
    assert text.startswith(NOTICE)
    assert "status: ready" in text
    assert f"id {DOCX}" in text
    assert "pages: 2 rendered of 2" in text
    # The keys come from the signed identity, never from the model (D117 (7)).
    [event] = render.events
    assert event["key_in"] == chat_files.owner_key("user-ana", CONV, DOCX)
    assert event["key_out_prefix"].startswith(f"owner/user-ana/conv/{CONV}/renders/")
    assert event["bucket"] == "chat-files"
    assert event["pages_max"] == 20
    # The pages are in a hidden folder of the session: never handed out to the person.
    folder = text.split("folder: ", 1)[1].split(" ", 1)[0]
    assert folder.startswith(".renders/informe-")
    session_id = next(iter(world.agentcore.sessions))
    written = sorted(p.name for p in (world.agentcore.data_root(session_id) / folder).iterdir())
    assert written == ["document.pdf", "page-001.png", "page-002.png"]
    listing = _text(_run(world, "import os\nsorted(os.listdir('.'))"))
    assert "files shown to the user" not in listing


def test_a_render_is_a_cell_of_the_turn_charged_its_seconds(
    world: World, render: FakeRender
) -> None:
    _attach(world, DOCX, "informe.docx", b"PK\x03\x04docx")
    _render(world, DOCX)
    [run] = world.runs("user-ana")
    assert run["tool"] == {"S": "render_document"}
    assert run["file_id"] == {"S": DOCX}
    assert "code" not in run
    assert run["state"] == {"S": "done"}
    assert cell_use(run).cpu_seconds >= 1
    [audit] = [a for a in _audits(world) if a["event"] == "code.render"]
    assert audit["detail"]["outcome"] == "ready"
    assert audit["detail"]["pages"] == 2
    assert "informe" not in json.dumps(audit)


def test_another_conversations_file_is_not_found(world: World, render: FakeRender) -> None:
    _attach(world, DOCX, "informe.docx", b"PK\x03\x04docx")
    result = _call(world, "render_document", {"file": DOCX}, _ctx(conversation_id=OTHER_CONV))
    assert result["error"]["code"] == "not_found"
    assert render.events == []
    bob = _call(world, "render_document", {"file": DOCX}, _ctx(token="token-bob", sub="user-bob"))
    assert bob["error"]["code"] == "not_found"


def test_only_office_files_are_rendered(world: World, render: FakeRender) -> None:
    _attach(world, DOCX, "informe.pdf", b"%PDF-1.7")
    result = _render(world, "informe.pdf")
    assert result["error"]["code"] == "unsupported"
    assert "mango_docs.render_pdf" in result["error"]["message"]
    assert render.events == []


def test_without_the_render_function_it_says_so(world: World) -> None:
    _attach(world, DOCX, "informe.docx", b"PK\x03\x04docx")
    assert _render(world, DOCX)["error"]["code"] == "unavailable"


def test_a_file_whose_scan_never_clears_is_not_rendered(world: World, render: FakeRender) -> None:
    _attach(world, DOCX, "informe.docx", b"PK\x03\x04docx")
    world.deps = replace(world.deps, readable=lambda key: False)
    text = _text(_render(world, DOCX))
    assert "status: refused" in text
    assert "still being scanned" in text
    assert render.events == []


def test_pages_still_being_scanned_are_announced_not_written(
    world: World, render: FakeRender
) -> None:
    _attach(world, DOCX, "informe.docx", b"PK\x03\x04docx")
    world.deps = replace(world.deps, readable=lambda key: "/renders/" not in key)
    text = _text(_render(world, DOCX))
    assert "status: pending" in text
    paths = [
        item["path"]
        for name, call in world.agentcore.calls
        if name == "writeFiles"
        for item in call["arguments"]["content"]
    ]
    assert not [p for p in paths if "/.renders/" in p]


def test_keys_outside_the_chosen_prefix_are_never_read(world: World, render: FakeRender) -> None:
    _attach(world, DOCX, "informe.docx", b"PK\x03\x04docx")
    other = chat_files.owner_key("user-bob", CONV, DOCX)
    render.answer = {
        "status": "ready",
        "kind": "docx",
        "pdf_key": other,
        "page_keys": [],
        "pages_total": 1,
        "pages_rendered": 0,
    }
    text = _text(_render(world, DOCX))
    assert "status: failed" in text


def test_a_refusal_of_the_function_is_explained(world: World, render: FakeRender) -> None:
    _attach(world, DOCX, "informe.docx", b"PK\x03\x04docx")
    render.answer = {"status": "refused", "reason": "macros"}
    assert "macros" in _text(_render(world, DOCX))


def test_renders_count_against_the_cells_of_the_turn(world: World, render: FakeRender) -> None:
    _attach(world, DOCX, "informe.docx", b"PK\x03\x04docx")
    for _ in range(CELLS_PER_TURN):
        _text(_render(world, DOCX))
    assert _render(world, DOCX)["error"]["code"] == "cell_limit"


@pytest.mark.parametrize("pages", [0, 51, "5", True])
def test_pages_outside_the_range_are_refused(world: World, render: FakeRender, pages: Any) -> None:
    assert _render(world, DOCX, pages=pages)["error"]["code"] == "invalid_arguments"


def test_helpers_that_do_not_match_their_digest_are_never_written(world: World) -> None:
    # TM-CI12: the session still runs, without them, and the mismatch is counted.
    world.deps = replace(world.deps, docs_helper=code._DOCS_SOURCE + b"\nimport os\n")
    text = _text(
        _run(world, "import importlib.util\nimportlib.util.find_spec('mango_docs') is None")
    )
    assert "True" in text
    assert [c for c in world.agentcore.calls if c[0] == "writeFiles"] == []
    assert (code.DOCS_MISMATCH_METRIC, 1) in world.metrics


def test_the_pinned_digest_is_the_reviewed_file() -> None:
    import hashlib  # noqa: PLC0415

    assert hashlib.sha256(code._DOCS_SOURCE).hexdigest() == code.DOCS_SHA256
