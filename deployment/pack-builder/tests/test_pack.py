import importlib.util
import json
import re
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
import yaml

from mango_pack_builder.cli import main
from mango_pack_builder.pack import (
    PackError,
    check_pack,
    load_pack,
    parse_constraints,
    parse_lock,
)
from mango_pack_builder.snapshot import snapshot_json
from mango_pack_runtime.guard import session_policy
from mango_packs.manifest import ToolAccess
from mango_packs.tools import tools_hash

from .conftest import LOCK, WHEEL_SHA256

REPO = Path(__file__).parents[3]


def _edit_manifest(pack_dir: Path, **changes: object) -> None:
    path = pack_dir / "manifest.yaml"
    path.write_text(yaml.safe_dump({**yaml.safe_load(path.read_text()), **changes}))


def test_valid_pack(pack_dir: Path) -> None:
    pack = load_pack(pack_dir)
    check_pack(pack)
    assert pack.artifact_name == "fake-pack-1.0.0-1.zip"


def test_parse_lock() -> None:
    locked = parse_lock(LOCK)
    assert locked["fake-mcp-server"] == ("1.0.0", frozenset({WHEEL_SHA256, "b" * 64}))
    assert locked["dep"][0] == "2.0"


@pytest.mark.parametrize(
    "lock",
    [
        "",
        "# only a comment\n",
        "fake-mcp-server==1.0.0\n",
        "fake-mcp-server>=1.0.0 --hash=sha256:" + "a" * 64,
        "https://evil.example/pkg.whl --hash=sha256:" + "a" * 64,
        "-e ./local --hash=sha256:" + "a" * 64,
        "--extra-index-url https://evil.example/simple\n" + LOCK,
        LOCK + LOCK,
    ],
)
def test_lock_must_pin_every_requirement_by_hash(lock: str) -> None:
    with pytest.raises(PackError):
        parse_lock(lock)


def test_manifest_must_be_strict_yaml_named_after_its_directory(pack_dir: Path) -> None:
    _edit_manifest(pack_dir, id="other-pack")
    with pytest.raises(PackError, match="must match its directory"):
        load_pack(pack_dir)
    _edit_manifest(pack_dir, id="fake-pack", unknown=True)
    with pytest.raises(PackError, match="not a valid manifest"):
        load_pack(pack_dir)
    (pack_dir / "manifest.yaml").write_text("!!python/object/apply:os.system ['true']\n")
    with pytest.raises(PackError, match="not valid YAML"):
        load_pack(pack_dir)
    (pack_dir / "manifest.yaml").unlink()
    with pytest.raises(PackError, match="not found"):
        load_pack(pack_dir)


def test_requirements_pin_only_the_declared_package(pack_dir: Path) -> None:
    (pack_dir / "requirements.in").write_text("fake-mcp-server==1.0.0\nrequests\n")
    with pytest.raises(PackError, match="must contain exactly"):
        check_pack(load_pack(pack_dir))


def test_lock_must_match_the_declared_version_and_wheel(pack_dir: Path) -> None:
    (pack_dir / "requirements.lock").write_text(LOCK.replace("1.0.0", "1.0.1"))
    with pytest.raises(PackError, match="the lock pins"):
        check_pack(load_pack(pack_dir))
    (pack_dir / "requirements.lock").write_text(LOCK.replace(WHEEL_SHA256, "d" * 64))
    with pytest.raises(PackError, match=r"source\.sha256"):
        check_pack(load_pack(pack_dir))


def test_entrypoint_must_exist(pack_dir: Path) -> None:
    (pack_dir / "entrypoint.py").unlink()
    with pytest.raises(PackError, match="entry point"):
        check_pack(load_pack(pack_dir))


@pytest.mark.parametrize("directory", sorted((REPO / "packs").glob("*/manifest.yaml")))
def test_packs_of_the_release_are_valid(directory: Path) -> None:
    pack = load_pack(directory.parent)
    check_pack(pack)
    assert pack.snapshot.is_file()
    assert pack.manifest.quarantine_error(datetime.now(UTC)) is None
    # D84: every tool of the release is classified, and only as `read` (no pack serves more).
    assert all(tool.access is ToolAccess.READ for tool in pack.manifest.tools)
    assert pack.manifest.installable
    assert main(["check", str(directory.parent)]) == 0


def test_check_refuses_a_tool_classified_below_its_annotations(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """D84: the offline `check` step compares the classes with the reviewed snapshot."""
    pack_dir = tmp_path / "aws-pricing"
    shutil.copytree(REPO / "packs" / "aws-pricing", pack_dir)
    snapshot = json.loads((pack_dir / "tools.snapshot.json").read_text())
    snapshot[0]["annotations"] = {"readOnlyHint": False, "destructiveHint": True}
    (pack_dir / "tools.snapshot.json").write_bytes(snapshot_json(snapshot))
    manifest = (pack_dir / "manifest.yaml").read_text()
    pinned = tools_hash(snapshot)
    manifest = re.sub(r'tools_hash: "sha256:[0-9a-f]{64}"', f'tools_hash: "{pinned}"', manifest)
    (pack_dir / "manifest.yaml").write_text(manifest)
    assert main(["check", str(pack_dir)]) == 1
    assert "more than the manifest classifies" in capsys.readouterr().err


def test_pricing_pack_keeps_file_system_tools_out() -> None:
    manifest = load_pack(REPO / "packs" / "aws-pricing").manifest
    assert manifest.data_tier == "public"
    assert manifest.identity_mode == "service"
    assert not manifest.tool_names & {
        "analyze_cdk_project",
        "analyze_terraform_project",
        "generate_cost_report",
    }
    assert {action.split(":")[0] for statement in manifest.iam for action in statement.actions} == {
        "pricing"
    }


def test_billing_pack_reads_account_data_only_as_the_caller() -> None:
    pack = load_pack(REPO / "packs" / "aws-billing")
    manifest = pack.manifest
    assert manifest.data_tier == "account_data"
    assert manifest.identity_mode == "central_only"
    assert manifest.installable
    # A database shared by every caller, queries that write to S3 and operations that start
    # a job in the payer account stay out (packs/aws-billing/manifest.yaml).
    assert manifest.tool_names == {
        "cost-explorer",
        "cost-anomaly",
        "sp-performance",
        "ri-performance",
        "cost-comparison",
        "budgets",
        "budget-notifications",
        "compute-optimizer",
        "cost-optimization",
    }
    assert not manifest.tool_names & {
        "session-sql",
        "storage-lens",
        "sp-recommendation",
        "sp-purchase-analyzer",
        "compute-optimizer-automation",
        "budget-actions",
    }
    actions = [action for statement in manifest.iam for action in statement.actions]
    assert len(set(actions)) == len(actions)
    assert {action.split(":")[0] for action in actions} == {
        "ce",
        "budgets",
        "compute-optimizer",
        "cost-optimization-hub",
        # Inventory Compute Optimizer checks the caller against; no tool calls these.
        "ec2",
        "autoscaling",
        "lambda",
        "rds",
        "ecs",
    }
    # It returns the environment variables of every function of the payer account.
    assert "lambda:ListFunctions" not in actions
    # Read-only by name (D43): Budgets calls its only read action `ViewBudget`.
    assert all(
        action == "budgets:ViewBudget"
        or action.split(":")[1].startswith(("Get", "List", "Describe"))
        for action in actions
    )
    # Budgets has ARNs: no "*" there.
    scoped = [statement for statement in manifest.iam if "*" not in statement.resources]
    assert [(s.actions, s.resources) for s in scoped] == [
        (["budgets:ViewBudget"], ["arn:aws:budgets::*:budget/*"])
    ]
    # STS refuses a session policy over 2048 characters: every call of the pack would fail.
    assert len(session_policy(tuple(manifest.iam))) < 2048
    # The entry point loads Mango's common code before it imports the upstream server.
    source = pack.entrypoint.read_text()
    assert source.index("pack = load()") < source.index("from awslabs.")


# --- Upper bounds for the lock (constraints.txt) ----------------------------------------------


def test_constraints_are_upper_bounds_of_packages_the_lock_pins(pack_dir: Path) -> None:
    assert load_pack(pack_dir).constraints is None
    (pack_dir / "constraints.txt").write_text("# why\ndep<2.1\n")
    pack = load_pack(pack_dir)
    assert parse_constraints(pack.constraints.read_text()) == {"dep": "2.1"}  # type: ignore[union-attr]
    check_pack(pack)


@pytest.mark.parametrize(
    ("content", "match"),
    [
        ("dep>=1\n", "only 'name<version'"),
        ("dep==2.0\n", "only 'name<version'"),
        ("dep<2 --hash=sha256:" + "a" * 64 + "\n", "only 'name<version'"),
        ("--index-url https://example.test/simple\n", "only 'name<version'"),
        ("dep @ https://example.test/dep.whl\n", "only 'name<version'"),
        ("-r other.txt\n", "only 'name<version'"),
        ("dep<2 ; sys_platform == 'linux'\n", "only 'name<version'"),
        ("dep<2\nDep<3\n", "more than once"),
        ("# nothing\n", "empty"),
        ("fake-mcp-server<2\n", r"must not bound what requirements\.in pins"),
        ("other<2\n", "does not pin"),
    ],
)
def test_constraints_can_do_nothing_else(pack_dir: Path, content: str, match: str) -> None:
    (pack_dir / "constraints.txt").write_text(content)
    with pytest.raises(PackError, match=match):
        check_pack(load_pack(pack_dir))


def test_cloudwatch_pack_reads_member_accounts_only_as_the_caller() -> None:
    pack = load_pack(REPO / "packs" / "aws-cloudwatch")
    manifest = pack.manifest
    assert (manifest.data_tier, manifest.identity_mode) == ("account_data", "central_only")
    assert manifest.member_chain and manifest.installable
    assert manifest.tool_names == {
        "get_metric_data",
        "get_metric_metadata",
        "analyze_metric",
        "get_recommended_metric_alarms",
        "get_active_alarms",
        "get_alarm_history",
        "describe_log_groups",
        # Log content, through the bounded wrappers of the entry point (D55 (3), proposed).
        "execute_log_insights_query",
        "analyze_log_group",
    }
    actions = [action for statement in manifest.iam for action in statement.actions]
    # Metrics, alarms, the metadata of log groups and bounded Logs Insights queries. Nothing
    # that stops a query or lists the queries of other people.
    assert sorted(actions) == [
        "cloudwatch:DescribeAlarmHistory",
        "cloudwatch:DescribeAlarms",
        "cloudwatch:GetMetricData",
        "logs:DescribeLogGroups",
        "logs:DescribeQueryDefinitions",
        "logs:GetQueryResults",
        "logs:ListAnomalies",
        "logs:ListLogAnomalyDetectors",
        "logs:StartQuery",
    ]
    assert len(session_policy(tuple(manifest.iam))) < 2048
    # Alarms, log groups and anomaly detectors have ARNs: no "*" there.
    scoped = [statement for statement in manifest.iam if "*" not in statement.resources]
    assert [s.resources for s in scoped] == [
        ["arn:aws:cloudwatch:*:*:alarm:*"],
        ["arn:aws:logs:*:*:log-group:*"],
        ["arn:aws:logs:*:*:anomaly-detector:*"],
    ]

    source = pack.entrypoint.read_text()
    assert source.index("pack = load(") < source.index("from awslabs.")
    assert source.index("upstream_logger.remove()") < source.index("from awslabs.")
    for hidden in ("profile_name", "account_identifiers", "include_linked_accounts"):
        assert f'"{hidden}"' in source
    # The log tools are replaced by the bounded wrappers before the pack is served.
    assert source.index("bound_log_tools(mcp,") < source.index(".serve(mcp)")

    # What the Gateway and the model see (tools.snapshot.json, pinned by tools_hash).
    tools = json.loads(pack.snapshot.read_text())
    assert {tool["name"] for tool in tools} == manifest.tool_names
    for tool in tools:
        schema = tool["inputSchema"]
        properties = schema["properties"]
        assert properties["account_id"]["pattern"] == "^[0-9]{12}$"
        assert schema["required"][0] == "account_id"
        assert not {"profile_name", "account_identifiers", "include_linked_accounts"} & set(
            properties
        )
        assert schema.get("additionalProperties") is not False
        if "region" in properties:
            assert "^[a-z]{2}(-[a-z]{1,16}){1,3}-[0-9]$" in json.dumps(properties["region"])
    assert pack.build_options.compression == "deflate"


def test_elasticache_pack_reads_member_accounts_only_as_the_caller() -> None:
    pack = load_pack(REPO / "packs" / "aws-elasticache")
    manifest = pack.manifest
    assert (manifest.data_tier, manifest.identity_mode) == ("account_data", "central_only")
    assert manifest.member_chain and manifest.installable
    assert manifest.tool_names == {
        "describe-cache-clusters",
        "describe-replication-groups",
        "describe-serverless-caches",
        "describe-events",
        "describe-cache-engine-versions",
        "describe-engine-default-parameters",
        "describe-service-updates",
    }
    # test-migration is Write in IAM although upstream marks it read-only-safe; no logs.
    assert "test-migration" not in manifest.tool_names
    actions = [action for statement in manifest.iam for action in statement.actions]
    assert sorted(actions) == [
        "elasticache:DescribeCacheClusters",
        "elasticache:DescribeCacheEngineVersions",
        "elasticache:DescribeEngineDefaultParameters",
        "elasticache:DescribeEvents",
        "elasticache:DescribeReplicationGroups",
        "elasticache:DescribeServerlessCaches",
        "elasticache:DescribeServiceUpdates",
    ]
    assert len(session_policy(tuple(manifest.iam))) < 2048
    # Clusters, replication groups and serverless caches have ARNs: no "*" there.
    scoped = [statement for statement in manifest.iam if "*" not in statement.resources]
    assert [s.resources for s in scoped] == [
        [
            "arn:aws:elasticache:*:*:cluster:*",
            "arn:aws:elasticache:*:*:replicationgroup:*",
            "arn:aws:elasticache:*:*:serverlesscache:*",
        ]
    ]
    assert sorted(manifest.egress.aws) == ["elasticache", "sts"]

    source = pack.entrypoint.read_text()
    assert source.index("pack = load(") < source.index("from awslabs.")
    assert source.index("upstream_logger.remove()") < source.index("from awslabs.")
    # Upstream's client factory names the profile `default` (ProfileNotFound in the Runtime)
    # and reads the Region from the environment: the entry point replaces it.
    assert "BaseConnectionManager.get_connection = classmethod(get_connection)" in source
    assert "pack.config.region" in source
    assert "ignore_configured_endpoint_urls=True" in source
    assert "Context.initialize(readonly=True)" in source

    tools = json.loads(pack.snapshot.read_text())
    assert {tool["name"] for tool in tools} == manifest.tool_names
    for tool in tools:
        schema = tool["inputSchema"]
        properties = schema["properties"]
        assert properties["account_id"]["pattern"] == "^[0-9]{12}$"
        assert schema["required"][0] == "account_id"
        # No tool takes credentials, a Region or an endpoint.
        assert not {"profile_name", "region", "endpoint_url"} & set(properties)
        assert schema.get("additionalProperties") is not False


def _cloudtrail_entrypoint() -> object:
    # The module only defines the cap at import time; `main()` loads the pack.
    path = REPO / "packs" / "aws-cloudtrail" / "entrypoint.py"
    spec = importlib.util.spec_from_file_location("aws_cloudtrail_entrypoint", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_cloudtrail_pack_reads_member_accounts_only_as_the_caller() -> None:
    pack = load_pack(REPO / "packs" / "aws-cloudtrail")
    manifest = pack.manifest
    assert (manifest.data_tier, manifest.identity_mode) == ("account_data", "central_only")
    assert manifest.member_chain and manifest.installable
    # Only the 90 days of management events: CloudTrail Lake (StartQuery is Write) stays out.
    assert manifest.tool_names == {"lookup_events"}
    assert [(s.actions, s.resources) for s in manifest.iam] == [
        (["cloudtrail:LookupEvents"], ["*"])
    ]
    assert [str(endpoint) for endpoint in manifest.egress.aws] == ["sts", "cloudtrail"]

    source = pack.entrypoint.read_text()
    main_body = source[source.index("def main()") :]
    assert main_body.index("pack = load(") < main_body.index("from awslabs.")
    assert main_body.index("upstream_logger.remove()") < main_body.index("from awslabs.")
    # The cap is installed on the class before the server module registers the tool.
    assert main_body.index("CloudTrailTools.lookup_events = ") < main_body.index(
        "from awslabs.cloudtrail_mcp_server.server import"
    )

    tools = json.loads(pack.snapshot.read_text())
    assert [tool["name"] for tool in tools] == ["lookup_events"]
    schema = tools[0]["inputSchema"]
    assert schema["properties"]["account_id"]["pattern"] == "^[0-9]{12}$"
    assert schema["required"][0] == "account_id"
    assert "ctx" not in schema["properties"]
    assert schema.get("additionalProperties") is not False
    assert "^[a-z]{2}(-[a-z]{1,16}){1,3}-[0-9]$" in json.dumps(schema["properties"]["region"])
    # The guard fills a missing region with the installation's: no literal default is listed.
    assert "default" not in schema["properties"]["region"]
    assert "us-east-1" not in json.dumps(schema["properties"]["region"])


def test_cloudtrail_entrypoint_caps_each_event() -> None:
    entry: Any = _cloudtrail_entrypoint()
    limit = entry.MAX_EVENT_CHARS

    small = json.dumps({"eventName": "PutRolePolicy", "errorCode": "AccessDenied"})
    assert entry.shrink_event(small) == small
    assert entry.shrink_event(None) is None

    # Bulky fields are cut first: the small ones stay whole and the record stays JSON.
    record = {
        "eventName": "PutObject",
        "sourceIPAddress": "203.0.113.10",
        "errorCode": "AccessDenied",
        "requestParameters": {"blob": "x" * 20_000},
        "responseElements": {"blob": "y" * 20_000},
    }
    shrunk = entry.shrink_event(json.dumps(record))
    assert len(shrunk) <= limit
    parsed = json.loads(shrunk)
    assert parsed["errorCode"] == "AccessDenied"
    assert parsed["sourceIPAddress"] == "203.0.113.10"
    assert "truncated by Mango" in parsed["requestParameters"]

    # Too many small fields: the whole record is cut, with a marker.
    wide = json.dumps({f"k{i}": "v" * 50 for i in range(500)})
    cut = entry.shrink_event(wide)
    assert cut.startswith(wide.replace(", ", ",").replace(": ", ":")[:100])
    assert "truncated by Mango" in cut
    assert len(cut) < limit + 80

    # Not JSON: cut as text.
    assert "truncated by Mango" in entry.shrink_event("z" * (limit + 1))

    result = {
        "events": [{"EventName": "PutObject", "CloudTrailEvent": json.dumps(record)}, "odd"],
        "next_token": "t",
    }
    capped = entry.shrink_result(result)
    assert capped["next_token"] == "t"
    assert capped["events"][1] == "odd"
    assert len(capped["events"][0]["CloudTrailEvent"]) <= limit
    assert entry.shrink_result("not a dict") == "not a dict"
