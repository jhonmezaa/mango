"""Tools of the aws-rds pack against botocore's Stubber: no AWS, no network.

What is checked is what the model gets: curated views (no credentials, no secret-looking
tags), the limits of every call, and that Performance Insights is only asked for tokenized SQL.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import boto3
import pytest
import yaml
from aws_rds import curate, server
from botocore.exceptions import ClientError
from botocore.stub import ANY, Stubber
from mcp.server.mcpserver.exceptions import ToolError

REGION = "us-east-1"
PACK = Path(__file__).resolve().parents[1]
NOW = datetime.now(UTC)
RESOURCE_ID = "db-ABCDEFGHIJKLMNOPQRSTUVWX12"


class Clients:
    def __init__(self) -> None:
        self.rds = boto3.client(
            "rds", region_name=REGION, aws_access_key_id="x", aws_secret_access_key="x"
        )
        self.pi = boto3.client(
            "pi", region_name=REGION, aws_access_key_id="x", aws_secret_access_key="x"
        )
        self.rds_stub = Stubber(self.rds)
        self.pi_stub = Stubber(self.pi)
        self.regions: list[str | None] = []


@pytest.fixture
def aws(monkeypatch: pytest.MonkeyPatch) -> Iterator[Clients]:
    clients = Clients()

    def client(service: str, region: str | None) -> Any:
        clients.regions.append(region)
        return {"rds": clients.rds, "pi": clients.pi}[service]

    monkeypatch.setattr(server, "_client", client)
    with clients.rds_stub, clients.pi_stub:
        yield clients
        clients.rds_stub.assert_no_pending_responses()
        clients.pi_stub.assert_no_pending_responses()


def _instance(**extra: Any) -> dict[str, Any]:
    return {
        "DBInstanceIdentifier": "orders-db-1",
        "DbiResourceId": RESOURCE_ID,
        "DBInstanceClass": "db.r7g.large",
        "Engine": "postgres",
        "EngineVersion": "16.4",
        "DBInstanceStatus": "available",
        "MultiAZ": True,
        "MasterUsername": "postgres",
        "MasterUserSecret": {
            "SecretArn": "arn:aws:secretsmanager:us-east-1:111122223333:secret:rds!db-1",
            "SecretStatus": "active",
            "KmsKeyId": "alias/x",
        },
        "Endpoint": {
            "Address": "orders-db-1.example.us-east-1.rds.amazonaws.com",
            "Port": 5432,
            "HostedZoneId": "Z1",
        },
        "AllocatedStorage": 100,
        "PerformanceInsightsEnabled": True,
        "PendingModifiedValues": {"MasterUserPassword": "****", "DBInstanceClass": "db.r7g.xlarge"},
        "DBParameterGroups": [
            {"DBParameterGroupName": "orders-pg", "ParameterApplyStatus": "in-sync"}
        ],
        "TagList": [
            {"Key": "env", "Value": "prod"},
            {"Key": "db_password", "Value": "hunter2"},
            {"Key": "note", "Value": "QUtJQUlPU0ZPRE5ON0VYQU1QTEVrZXlrZXlrZXlrZXk="},
        ],
        "InstanceCreateTime": NOW,
        **extra,
    }


# --- The tools the server serves ---


def test_the_server_serves_exactly_the_manifest_tools_all_read_only() -> None:
    manifest = yaml.safe_load((PACK / "manifest.yaml").read_text())
    tools = asyncio.run(server.mcp.list_tools())
    assert sorted(tool.name for tool in tools) == sorted(t["name"] for t in manifest["tools"])
    for tool in tools:
        assert tool.annotations is not None and tool.annotations.read_only_hint is True
        assert tool.annotations.destructive_hint is False
        properties = set((tool.input_schema or {}).get("properties") or {})
        # Mango's account_id is added by the common entry point; nothing picks credentials.
        assert not properties & {"account_id", "profile", "profile_name", "endpoint_url"}
        assert "region" in properties


def test_performance_insights_never_asks_for_sql_with_literals() -> None:
    source = (PACK / "aws_rds" / "server.py").read_text()
    assert "get_dimension_key_details" not in source
    assert '"db.sql"' not in source
    assert "db.sql" not in "".join(server.PI_GROUPS).replace("db.sql_tokenized", "")


# --- Instances and clusters ---


def test_instances_are_a_curated_view_without_credentials(aws: Clients) -> None:
    aws.rds_stub.add_response(
        "describe_db_instances",
        {"DBInstances": [_instance()]},
        {"DBInstanceIdentifier": "orders-db-1", "MaxRecords": 100},
    )
    answer = server.describe_db_instances("orders-db-1", region=REGION)
    [view] = answer["db_instances"]
    text = repr(answer)
    for leaked in (
        "MasterUserSecret",
        "secretsmanager",
        'postgres"',
        "hunter2",
        "****",
        "HostedZoneId",
        "db_password",
        "QUtJQUlP",
    ):
        assert leaked not in text
    assert "master" not in text.lower()
    assert view["endpoint"] == {
        "address": "orders-db-1.example.us-east-1.rds.amazonaws.com",
        "port": 5432,
    }
    assert view["tags"] == {"env": "prod"}
    assert view["pending_modifications"] == {"instance_class": "db.r7g.xlarge"}
    assert view["parameter_groups"] == [{"name": "orders-pg", "status": "in-sync"}]
    assert view["created"] == NOW.isoformat()
    assert answer["truncated"] is False
    assert aws.regions == [REGION]


def test_instances_are_paged_up_to_max_items(aws: Clients) -> None:
    aws.rds_stub.add_response(
        "describe_db_instances",
        {
            "DBInstances": [_instance(DBInstanceIdentifier=f"db-{i}") for i in range(3)],
            "Marker": "next",
        },
        {"Filters": [{"Name": "db-cluster-id", "Values": ["orders"]}], "MaxRecords": 100},
    )
    answer = server.describe_db_instances(
        db_cluster_identifier="orders", max_items=2, region=REGION
    )
    assert [v["db_instance_identifier"] for v in answer["db_instances"]] == ["db-0", "db-1"]
    assert answer["truncated"] is True


def test_clusters_keep_endpoints_and_members_and_drop_credentials(aws: Clients) -> None:
    aws.rds_stub.add_response(
        "describe_db_clusters",
        {
            "DBClusters": [
                {
                    "DBClusterIdentifier": "orders",
                    "Engine": "aurora-postgresql",
                    "Status": "available",
                    "Endpoint": "orders.cluster-x.us-east-1.rds.amazonaws.com",
                    "ReaderEndpoint": "orders.cluster-ro-x.us-east-1.rds.amazonaws.com",
                    "MasterUsername": "admin",
                    "MasterUserSecret": {"SecretArn": "arn:aws:secretsmanager:x"},
                    "DBClusterMembers": [
                        {"DBInstanceIdentifier": "orders-1", "IsClusterWriter": True},
                        {"DBInstanceIdentifier": "orders-2", "IsClusterWriter": False},
                    ],
                    "ServerlessV2ScalingConfiguration": {"MinCapacity": 0.5, "MaxCapacity": 8.0},
                    "PendingModifiedValues": {
                        "MasterUserPassword": "****",
                        "EngineVersion": "16.6",
                    },
                }
            ]
        },
        {"MaxRecords": 100},
    )
    [view] = server.describe_db_clusters(region=REGION)["db_clusters"]
    assert "admin" not in repr(view) and "secretsmanager" not in repr(view)
    assert view["writer_endpoint"].startswith("orders.cluster-x")
    assert view["members"][0] == {"db_instance_identifier": "orders-1", "is_writer": True}
    assert view["serverless_v2_scaling"] == {"min_acu": 0.5, "max_acu": 8.0}
    assert view["pending_modifications"] == {"engine_version": "16.6"}


def test_an_aws_error_is_a_short_tool_error(aws: Clients) -> None:
    aws.rds_stub.add_client_error(
        "describe_db_instances",
        "DBInstanceNotFound",
        "DBInstance nope not found.",
    )
    with pytest.raises(ToolError, match="AWS answered DBInstanceNotFound: DBInstance nope"):
        server.describe_db_instances("nope", region=REGION)


# --- Events, parameters, maintenance, snapshots ---


def test_events_read_a_bounded_window(aws: Clients) -> None:
    aws.rds_stub.add_response(
        "describe_events",
        {
            "Events": [
                {
                    "SourceIdentifier": "orders-db-1",
                    "SourceType": "db-instance",
                    "Message": "x" * 5000,
                    "EventCategories": ["failover"],
                    "Date": NOW,
                }
            ]
        },
        {
            "StartTime": ANY,
            "EndTime": ANY,
            "SourceType": "db-instance",
            "SourceIdentifier": "orders-db-1",
            "MaxRecords": 100,
        },
    )
    answer = server.describe_db_events(
        source_type="db-instance",
        source_identifier="orders-db-1",
        start_hours_ago=48,
        region=REGION,
    )
    [event] = answer["events"]
    assert event["categories"] == ["failover"]
    assert len(event["message"]) < 1100 and "cut" in event["message"]
    with pytest.raises(ToolError, match="source_type is required"):
        server.describe_db_events(source_identifier="orders-db-1", region=REGION)
    with pytest.raises(ToolError, match="greater than"):
        server.describe_db_events(start_hours_ago=2, end_hours_ago=2, region=REGION)


def test_parameters_are_the_user_modified_ones_and_secret_looking_values_are_hidden(
    aws: Clients,
) -> None:
    aws.rds_stub.add_response(
        "describe_db_cluster_parameters",
        {
            "Parameters": [
                {
                    "ParameterName": "work_mem",
                    "ParameterValue": "65536",
                    "ApplyType": "dynamic",
                    "Source": "user",
                    "Description": "long text",
                },
                {"ParameterName": "some_secret_token", "ParameterValue": "abc", "Source": "user"},
            ]
        },
        {"DBClusterParameterGroupName": "orders-cpg", "Source": "user", "MaxRecords": 100},
    )
    answer = server.describe_modified_parameters("orders-cpg", "cluster", region=REGION)
    assert answer["parameters"] == [
        {"name": "work_mem", "apply_type": "dynamic", "value": "65536"},
        {"name": "some_secret_token", "value": curate.HIDDEN},
    ]


def test_pending_maintenance_names_the_resource_not_its_arn(aws: Clients) -> None:
    aws.rds_stub.add_response(
        "describe_pending_maintenance_actions",
        {
            "PendingMaintenanceActions": [
                {
                    "ResourceIdentifier": "arn:aws:rds:us-east-1:111122223333:db:orders-db-1",
                    "PendingMaintenanceActionDetails": [
                        {
                            "Action": "system-update",
                            "OptInStatus": "next-maintenance",
                            "Description": "New OS patch",
                        }
                    ],
                }
            ]
        },
        {"Filters": [{"Name": "db-instance-id", "Values": ["orders-db-1"]}], "MaxRecords": 100},
    )
    [resource] = server.describe_pending_maintenance("orders-db-1", region=REGION)["resources"]
    assert resource["resource_type"] == "db" and resource["resource_name"] == "orders-db-1"
    assert resource["actions"][0]["action"] == "system-update"


def test_snapshots_never_include_shared_or_public_ones_and_come_newest_first(
    aws: Clients,
) -> None:
    snapshots = [
        {
            "DBSnapshotIdentifier": f"s-{age}",
            "DBInstanceIdentifier": "orders-db-1",
            "SnapshotCreateTime": NOW - timedelta(days=age),
            "MasterUsername": "postgres",
            "KmsKeyId": "arn:aws:kms:x",
            "SnapshotType": "manual",
            "Status": "available",
        }
        for age in (3, 1, 2)
    ]
    aws.rds_stub.add_response(
        "describe_db_snapshots",
        {"DBSnapshots": snapshots},
        {
            "IncludeShared": False,
            "IncludePublic": False,
            "SnapshotType": "manual",
            "MaxRecords": 100,
        },
    )
    answer = server.describe_db_snapshots(snapshot_type="manual", max_items=2, region=REGION)
    assert [s["snapshot_identifier"] for s in answer["snapshots"]] == ["s-1", "s-2"]
    assert answer["truncated"] is True
    assert "postgres" not in repr(answer) and "kms" not in repr(answer)


def test_cluster_snapshots(aws: Clients) -> None:
    aws.rds_stub.add_response(
        "describe_db_cluster_snapshots",
        {
            "DBClusterSnapshots": [
                {
                    "DBClusterSnapshotIdentifier": "rds:orders-1",
                    "DBClusterIdentifier": "orders",
                    "StorageEncrypted": True,
                }
            ]
        },
        {
            "IncludeShared": False,
            "IncludePublic": False,
            "DBClusterIdentifier": "orders",
            "MaxRecords": 100,
        },
    )
    [snapshot] = server.describe_db_cluster_snapshots("orders", region=REGION)["snapshots"]
    assert snapshot == {
        "snapshot_identifier": "rds:orders-1",
        "db_cluster_identifier": "orders",
        "encrypted": True,
    }


# --- Performance Insights ---


def _resolve(aws: Clients, **extra: Any) -> None:
    aws.rds_stub.add_response(
        "describe_db_instances",
        {"DBInstances": [_instance(**extra)]},
        {"DBInstanceIdentifier": "orders-db-1"},
    )


def test_top_sql_is_tokenized_and_split_by_wait_event_type(aws: Clients) -> None:
    _resolve(aws)
    aws.pi_stub.add_response(
        "describe_dimension_keys",
        {
            "PartitionKeys": [
                {"Dimensions": {"db.wait_event_type.name": "CPU"}},
                {"Dimensions": {"db.wait_event_type.name": "IO"}},
            ],
            "Keys": [
                {
                    "Dimensions": {
                        "db.sql_tokenized.id": "ABC",
                        "db.sql_tokenized.statement": "SELECT * FROM t WHERE id = ?" + " " * 3000,
                        "db.sql.statement": "SELECT * FROM t WHERE secret = 'planted-sql-literal'",
                    },
                    "Total": 1.5,
                    "Partitions": [1.0, 0.5],
                }
            ],
        },
        {
            "ServiceType": "RDS",
            "Identifier": RESOURCE_ID,
            "Metric": "db.load.avg",
            "StartTime": ANY,
            "EndTime": ANY,
            "MaxResults": 10,
            "GroupBy": {
                "Group": "db.sql_tokenized",
                "Limit": 10,
                "Dimensions": [
                    "db.sql_tokenized.id",
                    "db.sql_tokenized.db_id",
                    "db.sql_tokenized.statement",
                ],
            },
            "PartitionBy": {"Group": "db.wait_event_type", "Limit": 10},
        },
    )
    answer = server.get_top_load_contributors("orders-db-1", region=REGION)
    [top] = answer["contributors"]
    # A db.sql dimension never passes, even if AWS sent one.
    assert "planted-sql-literal" not in repr(answer)
    assert top["dimensions"]["db.sql_tokenized.id"] == "ABC"
    assert len(top["dimensions"]["db.sql_tokenized.statement"]) <= server.PI_STATEMENT + 40
    assert top["load_by_wait_event_type"] == {"CPU": 1.0, "IO": 0.5}
    assert aws.regions == [REGION, REGION]


def test_db_sql_is_refused_before_any_call() -> None:
    with pytest.raises(ToolError, match="group must be one of"):
        server.get_top_load_contributors("orders-db-1", group="db.sql", region=REGION)  # type: ignore[arg-type]

    async def call() -> Any:
        return await server.mcp.call_tool(
            "get_top_load_contributors",
            {"db_instance_identifier": "orders-db-1", "group": "db.sql"},
        )

    with pytest.raises(ToolError):
        asyncio.run(call())


def test_metrics_are_never_grouped_and_the_period_keeps_points_bounded(aws: Clients) -> None:
    _resolve(aws)
    aws.pi_stub.add_response(
        "get_resource_metrics",
        {
            "MetricList": [
                {"Key": {"Metric": "db.load.avg"}, "DataPoints": [{"Timestamp": NOW, "Value": 2.0}]}
            ]
        },
        {
            "ServiceType": "RDS",
            "Identifier": RESOURCE_ID,
            "MetricQueries": [{"Metric": "db.load.avg"}, {"Metric": "os.cpuUtilization.total.avg"}],
            "StartTime": ANY,
            "EndTime": ANY,
            "PeriodInSeconds": 3600,
        },
    )
    answer = server.get_performance_metrics(
        "orders-db-1",
        ["db.load.avg", "os.cpuUtilization.total.avg", "db.load.avg"],
        start_hours_ago=168,
        region=REGION,
    )
    assert answer["period_seconds"] == 3600
    assert answer["series"] == [
        {"metric": "db.load.avg", "points": [{"time": NOW.isoformat(), "value": 2.0}]}
    ]


def test_performance_insights_off_is_said_plainly(aws: Clients) -> None:
    _resolve(aws, PerformanceInsightsEnabled=False)
    with pytest.raises(ToolError, match="not enabled"):
        server.get_performance_metrics("orders-db-1", region=REGION)


def test_available_metrics(aws: Clients) -> None:
    _resolve(aws)
    aws.pi_stub.add_response(
        "list_available_resource_metrics",
        {"Metrics": [{"Metric": "db.load.avg", "Description": "load", "Unit": "Sessions"}]},
        {
            "ServiceType": "RDS",
            "Identifier": RESOURCE_ID,
            "MetricTypes": ["os", "db"],
            "MaxResults": 500,
        },
    )
    answer = server.list_performance_metrics("orders-db-1", region=REGION)
    assert answer["metrics"] == [
        {"metric": "db.load.avg", "unit": "Sessions", "description": "load"}
    ]


# --- Database log files ---


def _listed(aws: Clients, name: str) -> None:
    aws.rds_stub.add_response(
        "describe_db_log_files",
        {"DescribeDBLogFiles": [{"LogFileName": name, "Size": 10, "LastWritten": 1}]},
        {"DBInstanceIdentifier": "orders-db-1", "FilenameContains": name, "MaxRecords": 100},
    )


def test_log_files_come_newest_first_in_a_window(aws: Clients) -> None:
    aws.rds_stub.add_response(
        "describe_db_log_files",
        {
            "DescribeDBLogFiles": [
                {"LogFileName": "error/postgresql.log.1", "Size": 10, "LastWritten": 1_000},
                {"LogFileName": "error/postgresql.log.2", "Size": 20, "LastWritten": 2_000},
            ]
        },
        {"DBInstanceIdentifier": "orders-db-1", "FileLastWritten": ANY, "MaxRecords": 100},
    )
    answer = server.list_db_log_files("orders-db-1", region=REGION)
    assert [f["name"] for f in answer["log_files"]] == [
        "error/postgresql.log.2",
        "error/postgresql.log.1",
    ]
    assert answer["log_files"][0]["last_written"] == "1970-01-01T00:00:02+00:00"


def test_tail_reads_only_a_listed_file_of_the_instance(aws: Clients) -> None:
    aws.rds_stub.add_response(
        "describe_db_log_files",
        {"DescribeDBLogFiles": [{"LogFileName": "error/postgresql.log.10"}]},
        {
            "DBInstanceIdentifier": "orders-db-1",
            "FilenameContains": "error/postgresql.log.1",
            "MaxRecords": 100,
        },
    )
    with pytest.raises(ToolError, match="is not a log file of orders-db-1"):
        server.tail_db_log_file("orders-db-1", "error/postgresql.log.1", region=REGION)


def test_tail_is_bounded_in_lines_line_size_and_bytes(aws: Clients) -> None:
    name = "error/postgresql.log.2026-11-13-10"
    _listed(aws, name)
    body = "\n".join([f"line {i} " + "é" * 3000 for i in range(250)])
    aws.rds_stub.add_response(
        "download_db_log_file_portion",
        {"LogFileData": body, "AdditionalDataPending": False},
        {"DBInstanceIdentifier": "orders-db-1", "LogFileName": name, "NumberOfLines": 200},
    )
    answer = server.tail_db_log_file("orders-db-1", name, lines=200, region=REGION)
    lines = answer["lines"]
    assert lines[-1].startswith("line 249 ")
    assert all(len(line.encode()) <= server.LOG_LINE_BYTES for line in lines)
    assert curate.size(answer) <= server.LOG_BYTES
    assert len(lines) + answer["older_lines_dropped"] == 200
    assert answer["lines_cut_to_2kb"] == len(lines)


def test_tail_of_short_lines_keeps_them_all(aws: Clients) -> None:
    name = "slowquery/mysql-slowquery.log"
    _listed(aws, name)
    aws.rds_stub.add_response(
        "download_db_log_file_portion",
        {"LogFileData": "a\nb\nc\n"},
        {"DBInstanceIdentifier": "orders-db-1", "LogFileName": name, "NumberOfLines": 2},
    )
    answer = server.tail_db_log_file("orders-db-1", name, lines=2, region=REGION)
    assert answer["lines"] == ["b", "c"]
    assert answer["older_lines_dropped"] == 0


def test_log_file_names_cannot_climb() -> None:
    async def call(name: str) -> Any:
        return await server.mcp.call_tool(
            "tail_db_log_file", {"db_instance_identifier": "orders-db-1", "log_file_name": name}
        )

    for name in ("../etc/passwd", "/abs", "a/../b", "a b"):
        with pytest.raises(ToolError):
            asyncio.run(call(name))


# --- Curation helpers ---


def test_fit_drops_items_until_the_answer_fits() -> None:
    answer = curate.fit({"items": ["x" * 1000] * 10, "truncated": False}, "items", limit=3000)
    assert curate.size(answer) <= 3000 and answer["truncated"] is True
    assert 0 < len(answer["items"]) < 10


def test_truncate_bytes_never_splits_a_character() -> None:
    text, cut = curate.truncate_bytes("é" * 10, 5)
    assert (text, cut) == ("éé", True)


def test_client_errors_are_typed() -> None:
    error = ClientError({"Error": {"Code": "Throttling", "Message": "m" * 1000}}, "DescribeEvents")
    assert len(str(server._aws_error(error))) < 400
