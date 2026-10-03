import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
import yaml

from mango_pack_builder.pack import (
    PackError,
    check_pack,
    load_pack,
    parse_constraints,
    parse_lock,
)
from mango_pack_runtime.guard import session_policy

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
        ("fake-mcp-server<2\n", "upstream package itself"),
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
    }
    actions = [action for statement in manifest.iam for action in statement.actions]
    # Metrics, alarms and the metadata of log groups: no log content (user, 2026-10-02).
    assert sorted(actions) == [
        "cloudwatch:DescribeAlarmHistory",
        "cloudwatch:DescribeAlarms",
        "cloudwatch:GetMetricData",
        "logs:DescribeLogGroups",
        "logs:DescribeQueryDefinitions",
    ]
    assert len(session_policy(tuple(manifest.iam))) < 2048
    # Alarms have ARNs: no "*" there.
    scoped = [statement for statement in manifest.iam if "*" not in statement.resources]
    assert [s.resources for s in scoped] == [["arn:aws:cloudwatch:*:*:alarm:*"]]

    source = pack.entrypoint.read_text()
    assert source.index("pack = load(") < source.index("from awslabs.")
    assert source.index("upstream_logger.remove()") < source.index("from awslabs.")
    for hidden in ("profile_name", "account_identifiers", "include_linked_accounts"):
        assert f'"{hidden}"' in source

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
