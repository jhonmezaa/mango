"""The AWS Operations pack: curated views, bounds and validation, without AWS.

AWS answers come from ``botocore.stub.Stubber`` (it answers before signing). The signing test
uses a ``before-send`` handler instead, which runs after SigV4, to see which credentials a call
of the pack signs with.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import boto3
import pytest
import yaml
from botocore.awsrequest import AWSResponse
from botocore.credentials import ReadOnlyCredentials
from botocore.stub import Stubber
from mcp.server.mcpserver.exceptions import ToolError

from aws_ops import curate, server
from mango_pack_runtime import credentials
from mango_pack_runtime.identity import Caller

PACK = Path(__file__).resolve().parents[1]
NOW = datetime(2026, 11, 13, 12, 0, tzinfo=UTC)
ACCOUNT = "444455556666"
# A fake access key id, built so secret scanners do not flag the test itself.
SECRET = "AKIA" + "TESTONLY" * 2
TASK_DEFINITION = f"arn:aws:ecs:us-east-1:{ACCOUNT}:task-definition/app:7"


@pytest.fixture(autouse=True)
def _aws(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("AWS_PROFILE", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIDTEST")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "test-secret")
    monkeypatch.setenv("AWS_CONFIG_FILE", "/nonexistent")
    monkeypatch.setattr(curate, "now", lambda: NOW)


@pytest.fixture
def stubs(monkeypatch: pytest.MonkeyPatch) -> Iterator[Callable[[str], Stubber]]:
    """``stubs(service)``: the stubber of the one client the tools get for ``service``."""
    clients: dict[str, Any] = {}
    stubbers: dict[str, Stubber] = {}

    def get(service: str) -> Stubber:
        if service not in clients:
            clients[service] = boto3.client(service, region_name="us-east-1")
            stubbers[service] = Stubber(clients[service])
            stubbers[service].activate()
        return stubbers[service]

    def fake_client(service: str, region: str | None) -> Any:
        assert region in (None, "us-east-1")
        get(service)
        return clients[service]

    monkeypatch.setattr(server, "client", fake_client)
    yield get
    for stubber in stubbers.values():
        stubber.assert_no_pending_responses()
        stubber.deactivate()


def manifest() -> dict[str, Any]:
    loaded: dict[str, Any] = yaml.safe_load((PACK / "manifest.yaml").read_text())
    return loaded


def listed() -> list[Any]:
    return list(asyncio.run(server.mcp.list_tools()))


# --- The tools the model sees ---


def test_the_server_lists_exactly_the_manifest_tools_all_read_only() -> None:
    tools = listed()
    assert sorted(t.name for t in tools) == sorted(t["name"] for t in manifest()["tools"])
    assert {t["access"] for t in manifest()["tools"]} == {"read"}
    for tool in tools:
        assert tool.annotations.read_only_hint is True
        assert tool.annotations.destructive_hint is False
        assert len(tool.description or "") > 40


def test_no_tool_takes_credentials_accounts_or_endpoints() -> None:
    forbidden = {"account_id", "profile", "profile_name", "endpoint", "endpoint_url", "role_arn"}
    for tool in listed():
        properties = set(tool.input_schema["properties"])
        assert not properties & forbidden, tool.name
        assert "region" in properties, tool.name
        assert tool.input_schema["properties"]["region"].get("default") is None


def test_every_list_and_window_is_bounded() -> None:
    for tool in listed():
        for name, schema in tool.input_schema["properties"].items():
            if name == "max_items":
                assert schema["maximum"] <= 100
            if name == "hours":
                assert schema["maximum"] <= 720
            options = schema.get("anyOf", [schema])
            for option in options:
                if option.get("type") == "array":
                    assert option["maxItems"] <= 50
                    assert "pattern" in option["items"]


def test_snapshot_matches_the_manifest_tools() -> None:
    snapshot = json.loads((PACK / "tools.snapshot.json").read_text())
    assert sorted(t["name"] for t in snapshot) == sorted(t["name"] for t in manifest()["tools"])


@pytest.mark.parametrize(
    ("tool", "arguments"),
    [
        ("list_ec2_instances", {"instance_ids": ["i-1; drop"]}),
        ("list_ec2_instances", {"instance_ids": [f"i-{n:017x}" for n in range(51)]}),
        ("list_ec2_instances", {"name_contains": "*"}),
        ("list_ec2_instances", {"max_items": 500}),
        ("get_scaling_activities", {"group_name": "web", "hours": 1000}),
        ("get_target_health", {"target_group_arn": "arn:aws:s3:::bucket"}),
        ("list_ecs_services", {"cluster": "../other"}),
        ("get_cloudformation_stack_events", {"stack": "1-starts-with-a-digit"}),
        ("get_resource_config_history", {"resource_type": "EC2", "resource_id": "sg-1"}),
    ],
)
def test_invalid_arguments_are_refused_before_aws(tool: str, arguments: dict[str, Any]) -> None:
    with pytest.raises(ToolError):
        asyncio.run(server.mcp.call_tool(tool, arguments))


# --- EC2 ---


def instance(**extra: Any) -> dict[str, Any]:
    return {
        "InstanceId": "i-0123456789abcdef0",
        "InstanceType": "t3.micro",
        "State": {"Code": 16, "Name": "running"},
        "LaunchTime": NOW - timedelta(days=2),
        "Placement": {"AvailabilityZone": "us-east-1a"},
        "PrivateIpAddress": "10.0.0.10",
        "VpcId": "vpc-0123456789abcdef0",
        "SubnetId": "subnet-0123456789abcdef0",
        "ImageId": "ami-0123456789abcdef0",
        "IamInstanceProfile": {"Arn": f"arn:aws:iam::{ACCOUNT}:instance-profile/app"},
        "NetworkInterfaces": [{"NetworkInterfaceId": "eni-0123456789abcdef0"}],
        "BlockDeviceMappings": [{"DeviceName": "/dev/xvda"}],
        "MetadataOptions": {"HttpTokens": "optional"},
        "Tags": [
            {"Key": "Name", "Value": "web-1"},
            {"Key": "Environment", "Value": "prod"},
            {"Key": "db_password", "Value": "hunter2"},
            {"Key": "aws:cloudformation:stack-name", "Value": SECRET},
        ],
        **extra,
    }


def test_instances_are_a_curated_view(stubs: Callable[[str], Stubber]) -> None:
    stubs("ec2").add_response(
        "describe_instances",
        {"Reservations": [{"Instances": [instance(), instance(InstanceId="i-0123456789abcdef1")]}]},
        {
            "Filters": [
                {"Name": "instance-state-name", "Values": ["running"]},
                {"Name": "tag:Name", "Values": ["*web*"]},
            ],
            "MaxResults": 100,
        },
    )
    result = server.list_ec2_instances(state="running", name_contains="web", max_items=1)
    assert result["truncated"] is True
    [first] = result["instances"]
    assert first == {
        "instance_id": "i-0123456789abcdef0",
        "name": "web-1",
        "state": "running",
        "instance_type": "t3.micro",
        "launch_time": "2026-11-11T12:00:00+00:00",
        "availability_zone": "us-east-1a",
        "vpc_id": "vpc-0123456789abcdef0",
        "subnet_id": "subnet-0123456789abcdef0",
        "private_ip": "10.0.0.10",
        "image_id": "ami-0123456789abcdef0",
        "tags": {
            "Name": "web-1",
            "Environment": "prod",
            "aws:cloudformation:stack-name": "[redacted]",
        },
    }
    assert "hunter2" not in json.dumps(result)


def test_instance_status_keeps_only_unhealthy(stubs: Callable[[str], Stubber]) -> None:
    ok = {"Status": "ok", "Details": [{"Name": "reachability", "Status": "passed"}]}
    stubs("ec2").add_response(
        "describe_instance_status",
        {
            "InstanceStatuses": [
                {
                    "InstanceId": "i-0123456789abcdef0",
                    "InstanceState": {"Code": 16, "Name": "running"},
                    "SystemStatus": ok,
                    "InstanceStatus": ok,
                },
                {
                    "InstanceId": "i-0123456789abcdef1",
                    "InstanceState": {"Code": 16, "Name": "running"},
                    "SystemStatus": ok,
                    "InstanceStatus": {
                        "Status": "impaired",
                        "Details": [{"Name": "reachability", "Status": "failed"}],
                    },
                },
                {
                    "InstanceId": "i-0123456789abcdef2",
                    "InstanceState": {"Code": 16, "Name": "running"},
                    "SystemStatus": ok,
                    "InstanceStatus": ok,
                    "Events": [
                        {
                            "Code": "system-reboot",
                            "Description": "x" * 2000,
                            "NotBefore": NOW + timedelta(days=1),
                        }
                    ],
                },
            ]
        },
        {"IncludeAllInstances": False, "MaxResults": 200},
    )
    result = server.get_ec2_instance_status(only_unhealthy=True)
    assert [s["instance_id"] for s in result["statuses"]] == [
        "i-0123456789abcdef1",
        "i-0123456789abcdef2",
    ]
    assert result["statuses"][0]["instance_status"] == {
        "status": "impaired",
        "failing": ["reachability"],
    }
    assert len(result["statuses"][1]["scheduled_events"][0]["description"]) == curate.TEXT_LIMIT
    assert result["scanned"] == 3


# --- Auto Scaling ---


def test_groups_list_instances_without_tags_or_policies(stubs: Callable[[str], Stubber]) -> None:
    stubs("autoscaling").add_response(
        "describe_auto_scaling_groups",
        {
            "AutoScalingGroups": [
                {
                    "AutoScalingGroupName": "web",
                    "MinSize": 1,
                    "MaxSize": 4,
                    "DesiredCapacity": 2,
                    "DefaultCooldown": 300,
                    "AvailabilityZones": ["us-east-1a"],
                    "HealthCheckType": "ELB",
                    "CreatedTime": NOW,
                    "LaunchTemplate": {"LaunchTemplateName": "web", "Version": "$Latest"},
                    "TargetGroupARNs": [
                        f"arn:aws:elasticloadbalancing:us-east-1:{ACCOUNT}:targetgroup/web/0123456789abcdef"
                    ],
                    "Instances": [
                        {
                            "InstanceId": "i-0123456789abcdef0",
                            "AvailabilityZone": "us-east-1a",
                            "LifecycleState": "InService",
                            "HealthStatus": "Healthy",
                            "ProtectedFromScaleIn": False,
                        }
                    ],
                    "Tags": [{"Key": "Team", "Value": "payments"}],
                    "ServiceLinkedRoleARN": f"arn:aws:iam::{ACCOUNT}:role/x",
                }
            ]
        },
    )
    [group] = server.list_auto_scaling_groups()["groups"]
    assert group["launch_template"] == {"LaunchTemplateName": "web", "Version": "$Latest"}
    assert group["target_groups"] == ["0123456789abcdef"]
    assert group["instances"][0]["lifecycle_state"] == "InService"
    assert "tags" not in group  # Team is not on the allowlist
    assert "ServiceLinkedRoleARN" not in json.dumps(group)


def test_scaling_activities_stop_at_the_window(stubs: Callable[[str], Stubber]) -> None:
    def activity(hours_ago: int) -> dict[str, Any]:
        return {
            "ActivityId": f"a-{hours_ago}",
            "AutoScalingGroupName": "web",
            "Cause": "At 2026-11-13 a user request changed the desired capacity",
            "StartTime": NOW - timedelta(hours=hours_ago),
            "StatusCode": "Successful",
            "Details": '{"Subnet ID":"subnet-1"}',
        }

    stubs("autoscaling").add_response(
        "describe_scaling_activities",
        {"Activities": [activity(1), activity(5), activity(30)]},
        {"AutoScalingGroupName": "web", "MaxRecords": 100},
    )
    result = server.get_scaling_activities(group_name="web", hours=24)
    assert len(result["activities"]) == 2
    assert result["truncated"] is False
    assert "Details" not in json.dumps(result) and "subnet-1" not in json.dumps(result)


# --- Elastic Load Balancing ---


def test_target_health_counts_every_target(stubs: Callable[[str], Stubber]) -> None:
    arn = f"arn:aws:elasticloadbalancing:us-east-1:{ACCOUNT}:targetgroup/web/0123456789abcdef"
    stubs("elbv2").add_response(
        "describe_target_health",
        {
            "TargetHealthDescriptions": [
                {
                    "Target": {"Id": f"i-0123456789abcdef{n}", "Port": 80},
                    "TargetHealth": {
                        "State": "unhealthy" if n < 2 else "healthy",
                        "Reason": "Target.ResponseCodeMismatch" if n < 2 else None,
                    }
                    if n < 2
                    else {"State": "healthy"},
                }
                for n in range(5)
            ]
        },
        {"TargetGroupArn": arn},
    )
    result = server.get_target_health(target_group_arn=arn, max_items=3)
    assert result["counts"] == {"unhealthy": 2, "healthy": 3}
    assert len(result["targets"]) == 3 and result["truncated"] is True
    assert result["targets"][0]["reason"] == "Target.ResponseCodeMismatch"


# --- ECS ---


def test_services_are_described_ten_at_a_time(stubs: Callable[[str], Stubber]) -> None:
    ecs = stubs("ecs")
    arns = [f"arn:aws:ecs:us-east-1:{ACCOUNT}:service/main/svc-{n}" for n in range(12)]
    ecs.add_response("list_services", {"serviceArns": arns}, {"cluster": "main", "maxResults": 100})
    for batch in (arns[:10], arns[10:]):
        ecs.add_response(
            "describe_services",
            {
                "services": [
                    {
                        "serviceName": name.rsplit("/", 1)[-1],
                        "status": "ACTIVE",
                        "desiredCount": 2,
                        "runningCount": 1,
                        "taskDefinition": TASK_DEFINITION,
                        "networkConfiguration": {
                            "awsvpcConfiguration": {
                                "subnets": ["subnet-1"],
                                "securityGroups": ["sg-1"],
                            }
                        },
                        "events": [{"id": "e", "createdAt": NOW, "message": "steady"}],
                        "deployments": [
                            {
                                "id": "ecs-svc/1",
                                "status": "PRIMARY",
                                "rolloutState": "IN_PROGRESS",
                                "taskDefinition": TASK_DEFINITION,
                            }
                        ],
                    }
                    for name in batch
                ]
            },
            {"cluster": "main", "services": batch},
        )
    result = server.list_ecs_services(cluster="main", max_items=12)
    assert len(result["services"]) == 12
    first = result["services"][0]
    assert first["task_definition"] == "app:7"
    assert first["deployments"][0]["rollout_state"] == "IN_PROGRESS"
    assert "subnet-1" not in json.dumps(result) and "steady" not in json.dumps(result)


def test_service_events_inside_the_window(stubs: Callable[[str], Stubber]) -> None:
    stubs("ecs").add_response(
        "describe_services",
        {
            "services": [
                {
                    "serviceName": "api",
                    "events": [
                        {"id": "1", "createdAt": NOW - timedelta(hours=1), "message": "unhealthy"},
                        {"id": "2", "createdAt": NOW - timedelta(hours=48), "message": "old"},
                    ],
                }
            ]
        },
        {"cluster": "main", "services": ["api"]},
    )
    result = server.get_ecs_service_events(cluster="main", service="api", hours=24)
    assert result["events"] == [{"at": "2026-11-13T11:00:00+00:00", "message": "unhealthy"}]


def test_a_missing_service_says_so(stubs: Callable[[str], Stubber]) -> None:
    stubs("ecs").add_response(
        "describe_services",
        {"services": [], "failures": [{"arn": "x", "reason": "MISSING"}]},
        {"cluster": "main", "services": ["api"]},
    )
    assert server.get_ecs_service_events(cluster="main", service="api") == {
        "found": False,
        "reason": "MISSING",
    }


def test_service_deployments(stubs: Callable[[str], Stubber]) -> None:
    ecs = stubs("ecs")
    arn = f"arn:aws:ecs:us-east-1:{ACCOUNT}:service-deployment/main/api/abc123"
    ecs.add_response(
        "list_service_deployments",
        {"serviceDeployments": [{"serviceDeploymentArn": arn}]},
        {
            "cluster": "main",
            "service": "api",
            "createdAt": {"after": NOW - timedelta(hours=168)},
            "maxResults": 10,
        },
    )
    ecs.add_response(
        "describe_service_deployments",
        {
            "serviceDeployments": [
                {
                    "serviceDeploymentArn": arn,
                    "status": "ROLLBACK_SUCCESSFUL",
                    "statusReason": "circuit breaker",
                    "createdAt": NOW,
                    "targetServiceRevision": {
                        "arn": f"arn:aws:ecs:us-east-1:{ACCOUNT}:service-revision/main/api/9",
                        "requestedTaskCount": 2,
                        "runningTaskCount": 0,
                    },
                    "rollback": {"reason": "tasks failed", "startedAt": NOW},
                    "deploymentCircuitBreaker": {
                        "status": "TRIGGERED",
                        "failureCount": 3,
                        "threshold": 3,
                    },
                    "deploymentConfiguration": {"maximumPercent": 200},
                }
            ]
        },
        {"serviceDeploymentArns": [arn]},
    )
    [deployment] = server.list_ecs_service_deployments(cluster="main", service="api")["deployments"]
    assert deployment["id"] == "abc123"
    assert deployment["target_revision"] == {"revision": "9", "requested": 2, "running": 0}
    assert deployment["circuit_breaker"] == {
        "status": "TRIGGERED",
        "failureCount": 3,
        "threshold": 3,
    }
    assert "maximumPercent" not in json.dumps(deployment)


def test_stopped_tasks_never_carry_overrides_or_environment(
    stubs: Callable[[str], Stubber],
) -> None:
    ecs = stubs("ecs")
    task = f"arn:aws:ecs:us-east-1:{ACCOUNT}:task/main/0123abcd"
    ecs.add_response(
        "list_tasks",
        {"taskArns": [task]},
        {"cluster": "main", "desiredStatus": "STOPPED", "serviceName": "api", "maxResults": 100},
    )
    ecs.add_response(
        "describe_tasks",
        {
            "tasks": [
                {
                    "taskArn": task,
                    "lastStatus": "STOPPED",
                    "stopCode": "EssentialContainerExited",
                    "stoppedReason": "Essential container in task exited",
                    "stoppedAt": NOW,
                    "overrides": {
                        "containerOverrides": [
                            {
                                "name": "app",
                                "environment": [{"name": "DB_PASSWORD", "value": SECRET}],
                            }
                        ]
                    },
                    "containers": [
                        {
                            "name": "app",
                            "image": "public.ecr.aws/example/app:1.2.3",
                            "exitCode": 137,
                            "reason": "OutOfMemoryError: Container killed due to memory usage",
                            "runtimeId": "abc",
                            "networkInterfaces": [{"privateIpv4Address": "10.0.0.1"}],
                        }
                    ],
                    "attachments": [{"type": "ElasticNetworkInterface"}],
                    "tags": [{"key": "secret", "value": SECRET}],
                }
            ]
        },
        {"cluster": "main", "tasks": [task]},  # no `include`: never tags
    )
    result = server.list_stopped_ecs_tasks(cluster="main", service="api")
    [stopped] = result["tasks"]
    assert stopped["stop_code"] == "EssentialContainerExited"
    assert stopped["containers"] == [
        {
            "name": "app",
            "image": "public.ecr.aws/example/app:1.2.3",
            "exit_code": 137,
            "reason": "OutOfMemoryError: Container killed due to memory usage",
        }
    ]
    dumped = json.dumps(result)
    assert SECRET not in dumped and "DB_PASSWORD" not in dumped and "10.0.0.1" not in dumped


# --- CloudFormation ---


def test_stacks_filter_by_name_without_parameters(stubs: Callable[[str], Stubber]) -> None:
    def summary(name: str) -> dict[str, Any]:
        return {
            "StackName": name,
            "StackId": f"arn:aws:cloudformation:us-east-1:{ACCOUNT}:stack/{name}/x",
            "CreationTime": NOW,
            "StackStatus": "UPDATE_ROLLBACK_COMPLETE",
            "StackStatusReason": "y" * 900,
        }

    stubs("cloudformation").add_response(
        "list_stacks",
        {"StackSummaries": [summary("web-prod"), summary("db"), summary("web-dev")]},
        {"StackStatusFilter": server.STACK_STATUSES["failed"]},
    )
    result = server.list_cloudformation_stacks(status="failed", name_contains="WEB", max_items=1)
    assert [s["name"] for s in result["stacks"]] == ["web-prod"]
    assert result["truncated"] is True
    assert len(result["stacks"][0]["status_reason"]) == curate.TEXT_LIMIT


def test_stack_events_drop_resource_properties(stubs: Callable[[str], Stubber]) -> None:
    def event(minutes_ago: int, status: str) -> dict[str, Any]:
        return {
            "StackId": "s",
            "EventId": f"e{minutes_ago}",
            "StackName": "web",
            "LogicalResourceId": "Function",
            "ResourceType": "AWS::Lambda::Function",
            "Timestamp": NOW - timedelta(minutes=minutes_ago),
            "ResourceStatus": status,
            "ResourceStatusReason": "Resource handler returned message",
            "ResourceProperties": json.dumps({"Environment": {"Variables": {"KEY": SECRET}}}),
        }

    stubs("cloudformation").add_response(
        "describe_stack_events",
        {
            "StackEvents": [
                event(1, "UPDATE_ROLLBACK_IN_PROGRESS"),
                event(2, "UPDATE_FAILED"),
                event(60 * 30, "UPDATE_FAILED"),
            ]
        },
        {"StackName": "web"},
    )
    result = server.get_cloudformation_stack_events(stack="web", only_failures=True)
    assert [e["status"] for e in result["events"]] == ["UPDATE_FAILED"]
    assert SECRET not in json.dumps(result) and "Environment" not in json.dumps(result)


# --- AWS Config ---


def test_config_history_names_changed_fields_never_values(stubs: Callable[[str], Stubber]) -> None:
    def item(minutes_ago: int, rules: list[str], description: str) -> dict[str, Any]:
        return {
            "configurationItemCaptureTime": NOW - timedelta(minutes=minutes_ago),
            "configurationItemStatus": "OK",
            "resourceType": "AWS::EC2::SecurityGroup",
            "resourceId": "sg-0123456789abcdef0",
            "configuration": json.dumps(
                {"ipPermissions": rules, "description": description, "groupName": "web"}
            ),
            "supplementaryConfiguration": {},
            "tags": {"secret": SECRET},
            "relationships": [
                {
                    "resourceType": "AWS::EC2::VPC",
                    "resourceId": "vpc-1",
                    "relationshipName": "Is contained in Vpc",
                }
            ],
        }

    stubs("config").add_response(
        "get_resource_config_history",
        {
            "configurationItems": [
                item(1, ["0.0.0.0/0:22"], "web"),
                item(60, ["10.0.0.0/8:22"], "web"),
                item(120, ["10.0.0.0/8:22"], "old"),
            ]
        },
        {
            "resourceType": "AWS::EC2::SecurityGroup",
            "resourceId": "sg-0123456789abcdef0",
            "earlierTime": NOW - timedelta(hours=168),
            "chronologicalOrder": "Reverse",
            "limit": 3,
        },
    )
    result = server.get_resource_config_history(
        resource_type="AWS::EC2::SecurityGroup", resource_id="sg-0123456789abcdef0", max_items=2
    )
    assert [i["changed_fields"] for i in result["items"]] == [["ipPermissions"], ["description"]]
    assert result["items"][0]["relationships"] == [
        {"relationship": "Is contained in Vpc", "type": "AWS::EC2::VPC", "id": "vpc-1"}
    ]
    assert result["truncated"] is True
    dumped = json.dumps(result)
    assert "0.0.0.0/0" not in dumped and SECRET not in dumped


# --- Errors and identity ---


def test_an_aws_error_is_its_code_and_a_cut_message(stubs: Callable[[str], Stubber]) -> None:
    stubs("ecs").add_client_error(
        "list_clusters", service_error_code="AccessDeniedException", service_message="m" * 2000
    )
    with pytest.raises(ToolError) as raised:
        server.list_ecs_clusters()
    message = str(raised.value)
    assert message.startswith("ListClusters failed: AccessDeniedException: m")
    assert len(message) < curate.ERROR_LIMIT + 60


def test_a_tool_call_signs_with_the_callers_session(monkeypatch: pytest.MonkeyPatch) -> None:
    """Through the MCP SDK (a worker thread) the client signs with the call's credentials."""
    seen: list[str] = []

    def answer(request: Any, **_: Any) -> AWSResponse:
        seen.append(request.headers["Authorization"].decode())
        return AWSResponse(request.url, 200, {}, _Raw(b'{"clusterArns": []}'))

    def signing_client(service: str, region: str | None) -> Any:
        created = curate.client(service, region or "us-east-1")
        created.meta.events.register("before-send", answer)
        return created

    monkeypatch.setattr(server, "client", signing_client)
    monkeypatch.delenv("AWS_ACCESS_KEY_ID")
    monkeypatch.delenv("AWS_SECRET_ACCESS_KEY")
    caller = Caller(subject="user-1", tool="list_ecs_clusters", agent_id="sre", central=True)

    def assume(_: Caller) -> ReadOnlyCredentials:
        return ReadOnlyCredentials("ASIACALLER", "secret", "token")

    async def call() -> Any:
        with credentials.calling(caller, assume):
            return await server.mcp.call_tool("list_ecs_clusters", {"region": "us-east-1"})

    credentials.install()
    try:
        asyncio.run(call())
        with pytest.raises(ToolError):  # outside a call: nothing to sign with
            asyncio.run(server.mcp.call_tool("list_ecs_clusters", {"region": "us-east-1"}))
    finally:
        credentials.uninstall()
    assert len(seen) == 1
    assert "Credential=ASIACALLER/" in seen[0]


class _Raw:
    def __init__(self, body: bytes) -> None:
        self._body = body

    def stream(self, **_: Any) -> Iterator[bytes]:
        yield self._body

    def read(self, *_: Any) -> bytes:
        body, self._body = self._body, b""
        return body


# --- Curation helpers ---


def test_tags_keep_only_known_keys_and_hide_secret_looking_values() -> None:
    assert curate.tags(
        [
            {"Key": "Name", "Value": "api"},
            {"Key": "Owner", "Value": "nombre@empresa.com"},
            {"Key": "Environment", "Value": "token=abc"},
            {"Key": "aws:ecs:serviceName", "Value": "a" * 300},
        ]
    ) == {"Name": "api", "Environment": "[redacted]", "aws:ecs:serviceName": "[redacted]"}


def test_text_is_cut_and_single_line() -> None:
    assert curate.text("a\n b") == "a b"
    assert curate.text("x" * 10, 5) == "xxxx…"
    assert curate.text(None) is None
