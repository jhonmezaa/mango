"""End-to-end test of the restricted egress of MCP pack Runtimes (R6, D54), in a lab account.

It runs a **probe Runtime** (a zip with this file's ``PROBE`` server and boto3, nothing else)
on a network and asks it, from the inside, what it can reach:

* ``--network temp`` (default) builds a throwaway copy of the pack network: a VPC without
  internet gateway or NAT, two subnets in Availability Zones AgentCore supports, the S3
  gateway endpoint, interface endpoints for CloudWatch Logs, STS and the AWS Price List API
  with the same endpoint policies as the stack, one security group for the probe and the
  Route 53 Resolver DNS Firewall allowlist. It needs no Mango installation.
* ``--network stack`` uses the pack network of a deployed installation (``--namespace``): the
  subnets and the security group of one pack of the release (``--pack``, ``aws-pricing`` by
  default), read from the stack outputs. Nothing of the installation is changed.

What it checks (``probe`` step):

1. the Runtime starts and answers without any route to the internet (code from S3 through the
   gateway endpoint, logs through the interface endpoint);
2. a public host and a public IP address are unreachable, and a name outside the allowlist
   does not resolve;
3. the AWS endpoints the security group allows answer, with the Runtime's own role, the
   Runtime's logs arrive and the DNS Firewall of the VPC fails closed;
4. the permissions of the pack provisioner (the caller role mirrors them) cannot create or
   update a Runtime on the PUBLIC network or with another security group;
5. (``temp`` only) an endpoint policy that names another organization refuses that same call,
   and removing the security group rule of one endpoint makes it unreachable.

It **creates real resources**, all tagged ``mango:e2e=pack-egress`` and named after the run id:
an IAM role for the probe and one for the caller (the permissions the pack provisioner has to
create a Runtime in VPC mode), an S3 bucket with the zip, the Runtime and, with ``temp``, the
network. ``cleanup`` deletes them by SDK. AgentCore keeps the network interfaces of a deleted
Runtime for up to 8 hours: until they go, the subnets, the security groups and the VPC cannot
be deleted. ``cleanup`` says what is left; run it again later with the same ``--state`` file.

Run:
  uv run --no-project --with boto3 python tests/e2e/pack_egress.py \
    --profile mango-sandbox --state <path>.json [--network temp|stack] [--namespace <ns>] \
    [--steps create,probe,cleanup]
"""

from __future__ import annotations

import argparse
import io
import json
import secrets
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

TAG = {"Key": "mango:e2e", "Value": "pack-egress"}
AGENTCORE_SERVICE = "bedrock-agentcore.amazonaws.com"
NETWORK_SLR = (
    "arn:aws:iam::{account}:role/aws-service-role/network.bedrock-agentcore.amazonaws.com/"
    "AWSServiceRoleForBedrockAgentCoreNetwork"
)
# Availability Zone ids AgentCore supports for VPC mode (us-east-1). Other regions: --az-ids.
DEFAULT_AZ_IDS = ("use1-az1", "use1-az2")
TEMP_CIDR = "10.250.0.0/24"
TEMP_SUBNETS = ("10.250.0.0/27", "10.250.0.32/27")
INTERFACE_SERVICES = ("logs", "sts", "pricing.api")
PUBLIC_HOST = "example.com"
PUBLIC_IP = "1.1.1.1"

# The probe server: AgentCore Runtime HTTP contract (0.0.0.0:8080, /ping and /invocations).
PROBE = r"""
import json
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

FAST = Config(retries={"total_max_attempts": 1}, connect_timeout=4, read_timeout=8)


def dns(name):
    try:
        answers = socket.getaddrinfo(name, 443, type=socket.SOCK_STREAM)
        found = sorted({item[4][0] for item in answers})
        return {"outcome": "resolved", "addresses": found[:4]}
    except OSError as exc:
        return {"outcome": "unresolved", "error": type(exc).__name__}


def tcp(host, port):
    try:
        with socket.create_connection((host, port), timeout=4):
            return {"outcome": "open"}
    except socket.gaierror:
        return {"outcome": "unresolved"}
    except OSError as exc:
        return {"outcome": "closed", "error": type(exc).__name__}


def aws(service, region):
    try:
        if service == "sts":
            arn = boto3.client("sts", region_name=region, config=FAST).get_caller_identity()["Arn"]
            return {"outcome": "ok", "arn": arn}
        if service == "pricing":
            client = boto3.client("pricing", region_name=region, config=FAST)
            found = client.describe_services(ServiceCode="AmazonEC2", MaxResults=1)["Services"]
            return {"outcome": "ok", "services": len(found)}
        return {"outcome": "unknown_service"}
    except ClientError as exc:
        return {"outcome": "denied", "code": exc.response["Error"]["Code"]}
    except BotoCoreError as exc:
        return {"outcome": "unreachable", "error": type(exc).__name__}


def run(check):
    kind = check.get("kind")
    if kind == "dns":
        return dns(str(check["name"]))
    if kind == "tcp":
        return tcp(str(check["host"]), int(check["port"]))
    if kind == "aws":
        return aws(str(check["service"]), str(check["region"]))
    return {"outcome": "unknown_check"}


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, body):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        self._send(200 if self.path == "/ping" else 404, {"status": "Healthy"})

    def do_POST(self):
        if self.path != "/invocations":
            return self._send(404, {})
        try:
            request = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            checks = list(request["checks"])[:20]
        except (ValueError, KeyError, TypeError):
            return self._send(400, {"error": "bad_request"})
        self._send(200, {"results": [{**check, **run(check)} for check in checks]})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print("mango egress probe: listening", flush=True)
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
"""


class CheckFailedError(Exception):
    pass


class Report:
    def __init__(self) -> None:
        self.failed = 0

    def check(self, ok: bool, what: str, detail: object = "") -> None:
        self.failed += 0 if ok else 1
        print(
            f"  [{'ok' if ok else 'FAIL'}] {what}" + (f" — {detail}" if detail and not ok else "")
        )

    def note(self, text: str) -> None:
        print(f"  [--] {text}")


_NOT_FOUND = "ResourceNotFoundException"


def _https_to(group: str) -> dict[str, Any]:
    """Security group rule: HTTPS to (egress) or from (ingress) another group."""
    return {
        "IpProtocol": "tcp",
        "FromPort": 443,
        "ToPort": 443,
        "UserIdGroupPairs": [{"GroupId": group}],
    }


def code_of(exc: ClientError) -> str:
    return str(exc.response.get("Error", {}).get("Code", ""))


class State:
    """Identifiers of what the run created, saved after every change so cleanup can resume."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.data: dict[str, Any] = json.loads(path.read_text()) if path.exists() else {}

    def __getitem__(self, key: str) -> Any:
        return self.data[key]

    def get(self, key: str, default: Any = None) -> Any:
        return self.data.get(key, default)

    def set(self, **values: Any) -> None:
        self.data.update(values)
        self.path.write_text(json.dumps(self.data, indent=2, sort_keys=True))

    def drop(self, *keys: str) -> None:
        for key in keys:
            self.data.pop(key, None)
        self.path.write_text(json.dumps(self.data, indent=2, sort_keys=True))


# --- Endpoint policies: keep in sync with infra/lib/constructs/pack-network.ts ---------------


def org_policy(org_id: str) -> dict[str, Any]:
    """Only principals of the organization: credentials of anyone else are refused."""
    return {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Principal": "*",
                "Action": "*",
                "Resource": "*",
                "Condition": {"StringEquals": {"aws:PrincipalOrgID": org_id}},
            }
        ],
    }


def code_bucket_policy(region: str) -> dict[str, Any]:
    """S3 gateway endpoint: only AgentCore reading its own code artifact buckets."""
    return {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Principal": "*",
                "Action": "s3:GetObject",
                "Resource": [
                    f"arn:aws:s3:::acr-code-*-{region}-an",
                    f"arn:aws:s3:::acr-code-*-{region}-an/*",
                ],
                "Condition": {"StringEquals": {"aws:PrincipalServiceName": AGENTCORE_SERVICE}},
            }
        ],
    }


def allowed_domains(region: str) -> list[str]:
    """DNS Firewall allowlist of the temp network: the endpoints above and S3.

    AgentCore reads the code of a Runtime from its own bucket by the global S3 name
    (``<bucket>.s3.amazonaws.com``) and writes platform logs by the regional one.
    """
    return [
        f"logs.{region}.amazonaws.com.",
        f"sts.{region}.amazonaws.com.",
        f"api.pricing.{region}.amazonaws.com.",
        "*.s3.amazonaws.com.",
        f"s3.{region}.amazonaws.com.",
        f"*.s3.{region}.amazonaws.com.",
    ]


# --- Probe artifact and roles ----------------------------------------------------------------


def build_zip() -> bytes:
    """entrypoint.py plus boto3 (pure Python wheels, so any platform installs the same)."""
    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / "site"
        command = ["uv", "pip", "install", "--quiet", "--target", str(target)]
        command += ["--python-version", "3.13", "boto3"]
        subprocess.run(command, check=True)  # noqa: S603
        (target / "entrypoint.py").write_text(PROBE)
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(target.rglob("*")):
                if path.is_file() and "__pycache__" not in path.parts:
                    archive.write(path, path.relative_to(target).as_posix())
        return buffer.getvalue()


def probe_role_documents(
    account: str, region: str, runtime_name: str
) -> tuple[dict[str, Any], dict[str, Any]]:
    runtime = f"arn:aws:bedrock-agentcore:{region}:{account}:runtime/{runtime_name}-*"
    logs = (
        f"arn:aws:logs:{region}:{account}:log-group:"
        f"/aws/bedrock-agentcore/runtimes/{runtime_name}-*"
    )
    trust = {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Principal": {"Service": AGENTCORE_SERVICE},
                "Action": "sts:AssumeRole",
                "Condition": {
                    "StringEquals": {"aws:SourceAccount": account},
                    "ArnLike": {"aws:SourceArn": runtime},
                },
            }
        ],
    }
    policy = {
        "Version": "2012-10-17",
        "Statement": [
            {"Effect": "Allow", "Action": "pricing:DescribeServices", "Resource": "*"},
            {
                "Effect": "Allow",
                "Action": [
                    "logs:CreateLogGroup",
                    "logs:CreateLogStream",
                    "logs:PutLogEvents",
                    "logs:DescribeLogStreams",
                ],
                "Resource": [logs, f"{logs}:log-stream:*"],
            },
        ],
    }
    return trust, policy


def caller_policy(
    account: str,
    region: str,
    *,
    runtime_name: str,
    role_arn: str,
    bucket: str,
    subnets: list[str],
    security_group: str,
) -> dict[str, Any]:
    """What the pack provisioner may do to create a Runtime (pack-provisioner.ts): only on the
    pack network. A request without subnets (network mode PUBLIC) or with others is denied."""
    agentcore = f"arn:aws:bedrock-agentcore:{region}:{account}"
    identities = f"{agentcore}:workload-identity-directory/default"
    on_pack_network = {
        "ForAllValues:StringEquals": {
            "bedrock-agentcore:subnets": subnets,
            "bedrock-agentcore:securityGroups": [security_group],
        },
        "Null": {"bedrock-agentcore:subnets": "false", "bedrock-agentcore:securityGroups": "false"},
    }
    return {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Action": "bedrock-agentcore:CreateAgentRuntime",
                "Resource": f"{agentcore}:runtime/*",
                "Condition": on_pack_network,
            },
            {
                "Effect": "Allow",
                "Action": "bedrock-agentcore:UpdateAgentRuntime",
                "Resource": f"{agentcore}:runtime/{runtime_name}-*",
                "Condition": on_pack_network,
            },
            {
                "Effect": "Allow",
                "Action": [
                    "bedrock-agentcore:CreateAgentRuntimeEndpoint",
                    "bedrock-agentcore:TagResource",
                ],
                "Resource": f"{agentcore}:runtime/*",
            },
            {
                "Effect": "Allow",
                "Action": [
                    "bedrock-agentcore:GetAgentRuntime",
                    "bedrock-agentcore:DeleteAgentRuntime",
                    "bedrock-agentcore:GetAgentRuntimeEndpoint",
                    "bedrock-agentcore:InvokeAgentRuntime",
                ],
                "Resource": [
                    f"{agentcore}:runtime/{runtime_name}-*",
                    f"{agentcore}:runtime/{runtime_name}-*/runtime-endpoint/*",
                ],
            },
            {
                "Effect": "Allow",
                "Action": [
                    "bedrock-agentcore:CreateWorkloadIdentity",
                    "bedrock-agentcore:DeleteWorkloadIdentity",
                    "bedrock-agentcore:TagResource",
                ],
                "Resource": [identities, f"{identities}/workload-identity/*"],
            },
            {
                "Effect": "Allow",
                "Action": "iam:PassRole",
                "Resource": role_arn,
                "Condition": {"StringEquals": {"iam:PassedToService": AGENTCORE_SERVICE}},
            },
            {
                "Effect": "Allow",
                "Action": ["s3:GetObject", "s3:GetObjectVersion"],
                "Resource": f"arn:aws:s3:::{bucket}/*",
            },
            {
                "Effect": "Allow",
                "Action": "iam:CreateServiceLinkedRole",
                "Resource": NETWORK_SLR.format(account=account),
                "Condition": {
                    "StringEquals": {
                        "iam:AWSServiceName": "network.bedrock-agentcore.amazonaws.com"
                    }
                },
            },
        ],
    }


class Run:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.session = boto3.Session(profile_name=args.profile, region_name=args.region)
        self.region = self.session.region_name
        self.state = State(Path(args.state))
        self.report = Report()
        self.ec2 = self.session.client("ec2")
        self.iam = self.session.client("iam")
        self.s3 = self.session.client("s3")
        self.r53 = self.session.client("route53resolver")
        identity = self.session.client("sts").get_caller_identity()
        self.account = identity["Account"]
        self.operator_arn = identity["Arn"]
        if not self.state.get("run_id"):
            self.state.set(run_id=secrets.token_hex(4), network=args.network)
        self.run_id: str = self.state["run_id"]
        self.runtime_name = f"Mango_e2e_egress_{self.run_id}"
        self.role_name = f"Mango-e2e-egress-{self.run_id}"
        self.caller_name = f"Mango-e2e-egress-caller-{self.run_id}"
        self.bucket = f"mango-e2e-egress-{self.account}-{self.run_id}"

    def tags(self, kind: str, name: str = "") -> list[dict[str, Any]]:
        tags = [TAG, {"Key": "Name", "Value": name or f"mango-e2e-egress-{self.run_id}"}]
        return [{"ResourceType": kind, "Tags": tags}]

    # --- Network --------------------------------------------------------------------------

    def create_temp_network(self) -> None:
        state, ec2 = self.state, self.ec2
        if not state.get("vpc"):
            vpc = ec2.create_vpc(CidrBlock=TEMP_CIDR, TagSpecifications=self.tags("vpc"))["Vpc"][
                "VpcId"
            ]
            state.set(vpc=vpc)
            ec2.get_waiter("vpc_available").wait(VpcIds=[vpc])
            ec2.modify_vpc_attribute(VpcId=vpc, EnableDnsSupport={"Value": True})
            ec2.modify_vpc_attribute(VpcId=vpc, EnableDnsHostnames={"Value": True})
        vpc = state["vpc"]
        if not state.get("subnets"):
            subnets = [
                ec2.create_subnet(
                    VpcId=vpc,
                    CidrBlock=cidr,
                    AvailabilityZoneId=az,
                    TagSpecifications=self.tags("subnet"),
                )["Subnet"]["SubnetId"]
                for cidr, az in zip(TEMP_SUBNETS, self.args.az_ids, strict=True)
            ]
            state.set(subnets=subnets)
        if not state.get("probe_sg"):
            groups = {}
            for key, description in (
                ("probe_sg", "Mango e2e: probe Runtime, egress only to its endpoints"),
                ("endpoint_sg", "Mango e2e: interface endpoints, HTTPS from the probe only"),
            ):
                groups[key] = ec2.create_security_group(
                    GroupName=f"mango-e2e-egress-{self.run_id}-{key}",
                    Description=description,
                    VpcId=vpc,
                    TagSpecifications=self.tags("security-group"),
                )["GroupId"]
            state.set(**groups)
            probe, endpoint = groups["probe_sg"], groups["endpoint_sg"]
            for group in (probe, endpoint):
                ec2.revoke_security_group_egress(
                    GroupId=group,
                    IpPermissions=[{"IpProtocol": "-1", "IpRanges": [{"CidrIp": "0.0.0.0/0"}]}],
                )
            https_from_probe = {
                "IpProtocol": "tcp",
                "FromPort": 443,
                "ToPort": 443,
                "UserIdGroupPairs": [{"GroupId": probe}],
            }
            ec2.authorize_security_group_ingress(GroupId=endpoint, IpPermissions=[https_from_probe])
            s3_prefix = ec2.describe_managed_prefix_lists(
                Filters=[
                    {"Name": "prefix-list-name", "Values": [f"com.amazonaws.{self.region}.s3"]}
                ]
            )["PrefixLists"][0]["PrefixListId"]
            ec2.authorize_security_group_egress(
                GroupId=probe,
                IpPermissions=[
                    {
                        "IpProtocol": "tcp",
                        "FromPort": 443,
                        "ToPort": 443,
                        "UserIdGroupPairs": [{"GroupId": endpoint}],
                    },
                    {
                        "IpProtocol": "tcp",
                        "FromPort": 443,
                        "ToPort": 443,
                        "PrefixListIds": [{"PrefixListId": s3_prefix}],
                    },
                ],
            )
        if not state.get("endpoints"):
            route_table = ec2.describe_route_tables(Filters=[{"Name": "vpc-id", "Values": [vpc]}])[
                "RouteTables"
            ][0]
            endpoints = {
                "s3": ec2.create_vpc_endpoint(
                    VpcId=vpc,
                    VpcEndpointType="Gateway",
                    ServiceName=f"com.amazonaws.{self.region}.s3",
                    RouteTableIds=[route_table["RouteTableId"]],
                    PolicyDocument=json.dumps(code_bucket_policy(self.region)),
                    TagSpecifications=self.tags("vpc-endpoint"),
                )["VpcEndpoint"]["VpcEndpointId"]
            }
            for service in INTERFACE_SERVICES:
                endpoints[service] = ec2.create_vpc_endpoint(
                    VpcId=vpc,
                    VpcEndpointType="Interface",
                    ServiceName=f"com.amazonaws.{self.region}.{service}",
                    SubnetIds=state["subnets"],
                    SecurityGroupIds=[state["endpoint_sg"]],
                    PrivateDnsEnabled=True,
                    PolicyDocument=json.dumps(org_policy(self.args.org_id)),
                    TagSpecifications=self.tags("vpc-endpoint"),
                )["VpcEndpoint"]["VpcEndpointId"]
            state.set(endpoints=endpoints)
        self._wait_endpoints()
        if not state.get("dns_association"):
            token = f"mango-e2e-{self.run_id}"
            tags = [TAG]
            domains = self.r53.create_firewall_domain_list(
                CreatorRequestId=token, Name=token, Tags=tags
            )["FirewallDomainList"]["Id"]
            state.set(dns_allow_list=domains)
            self.r53.update_firewall_domains(
                FirewallDomainListId=domains, Operation="ADD", Domains=allowed_domains(self.region)
            )
            everything = self.r53.create_firewall_domain_list(
                CreatorRequestId=f"{token}-all", Name=f"{token}-all", Tags=tags
            )["FirewallDomainList"]["Id"]
            state.set(dns_block_list=everything)
            self.r53.update_firewall_domains(
                FirewallDomainListId=everything, Operation="ADD", Domains=["*."]
            )
            self._wait_domain_lists(domains, everything)
            group = self.r53.create_firewall_rule_group(
                CreatorRequestId=token, Name=token, Tags=tags
            )["FirewallRuleGroup"]["Id"]
            state.set(dns_rule_group=group)
            self.r53.create_firewall_rule(
                CreatorRequestId=f"{token}-allow",
                FirewallRuleGroupId=group,
                FirewallDomainListId=domains,
                Priority=100,
                Action="ALLOW",
                # S3 names are CNAME chains: the allowlist decides on the name that was asked.
                FirewallDomainRedirectionAction="TRUST_REDIRECTION_DOMAIN",
                Name="allow-endpoints",
            )
            self.r53.create_firewall_rule(
                CreatorRequestId=f"{token}-block",
                FirewallRuleGroupId=group,
                FirewallDomainListId=everything,
                Priority=200,
                Action="BLOCK",
                BlockResponse="NXDOMAIN",
                Name="block-everything-else",
            )
            association = self.r53.associate_firewall_rule_group(
                CreatorRequestId=token,
                FirewallRuleGroupId=group,
                VpcId=vpc,
                Priority=101,
                Name=token,
                Tags=tags,
            )["FirewallRuleGroupAssociation"]["Id"]
            state.set(dns_association=association)
        print(f"  network: {vpc} subnets {state['subnets']} probe sg {state['probe_sg']}")

    def _wait_domain_lists(self, *ids: str) -> None:
        for _ in range(60):
            statuses = [
                self.r53.get_firewall_domain_list(FirewallDomainListId=i)["FirewallDomainList"][
                    "Status"
                ]
                for i in ids
            ]
            if all(status == "COMPLETE" for status in statuses):
                return
            time.sleep(2)
        raise CheckFailedError("DNS Firewall domain lists did not complete")

    def _wait_endpoints(self) -> None:
        ids = list(self.state["endpoints"].values())
        for _ in range(90):
            found = self.ec2.describe_vpc_endpoints(VpcEndpointIds=ids)["VpcEndpoints"]
            if all(endpoint["State"] == "available" for endpoint in found):
                return
            time.sleep(5)
        raise CheckFailedError("VPC endpoints did not become available")

    def use_stack_network(self) -> None:
        """Subnets and the security group of one release pack, from the exports of the
        ``Mango-<ns>-PackNetwork`` stack (the ones the Core stack imports)."""
        prefix = f"Mango-{self.args.namespace}-PackNetwork-"
        exports = {
            export["Name"].removeprefix(prefix): export["Value"]
            for page in self.session.client("cloudformation")
            .get_paginator("list_exports")
            .paginate()
            for export in page["Exports"]
            if export["Name"].startswith(prefix)
        }
        subnets = [exports[name] for name in sorted(exports) if name.startswith("Subnet")]
        group = exports.get(f"SecurityGroup-{self.args.pack}")
        if not subnets:
            raise CheckFailedError(f"no exports named {prefix}Subnet<n>: is the stack installed?")
        if group is None:
            raise CheckFailedError(f"the release has no pack {self.args.pack!r}")
        self.state.set(subnets=subnets, probe_sg=group)
        print(f"  network of {prefix[:-1]}: subnets {subnets} pack sg {group}")

    # --- Probe Runtime --------------------------------------------------------------------

    def create_probe(self) -> None:
        state = self.state
        if not state.get("bucket"):
            if self.region == "us-east-1":
                self.s3.create_bucket(Bucket=self.bucket)
            else:
                self.s3.create_bucket(
                    Bucket=self.bucket,
                    CreateBucketConfiguration={"LocationConstraint": self.region},
                )
            state.set(bucket=self.bucket)
            self.s3.put_public_access_block(
                Bucket=self.bucket,
                PublicAccessBlockConfiguration={
                    "BlockPublicAcls": True,
                    "IgnorePublicAcls": True,
                    "BlockPublicPolicy": True,
                    "RestrictPublicBuckets": True,
                },
            )
            self.s3.put_bucket_versioning(
                Bucket=self.bucket, VersioningConfiguration={"Status": "Enabled"}
            )
            self.s3.put_bucket_tagging(Bucket=self.bucket, Tagging={"TagSet": [TAG]})
        if not state.get("artifact_version"):
            put = self.s3.put_object(Bucket=self.bucket, Key="probe/probe.zip", Body=build_zip())
            state.set(artifact_version=put["VersionId"])
        role_arn = f"arn:aws:iam::{self.account}:role/{self.role_name}"
        if not state.get("role"):
            trust, policy = probe_role_documents(self.account, self.region, self.runtime_name)
            self.iam.create_role(
                RoleName=self.role_name, AssumeRolePolicyDocument=json.dumps(trust), Tags=[TAG]
            )
            state.set(role=self.role_name)
            self.iam.put_role_policy(
                RoleName=self.role_name, PolicyName="probe", PolicyDocument=json.dumps(policy)
            )
        if not state.get("caller"):
            trust = {
                "Version": "2012-10-17",
                "Statement": [
                    {
                        "Effect": "Allow",
                        "Principal": {"AWS": f"arn:aws:iam::{self.account}:root"},
                        "Action": "sts:AssumeRole",
                        "Condition": {"ArnEquals": {"aws:PrincipalArn": self._operator_role_arn()}},
                    }
                ],
            }
            self.iam.create_role(
                RoleName=self.caller_name, AssumeRolePolicyDocument=json.dumps(trust), Tags=[TAG]
            )
            state.set(caller=self.caller_name)
            self.iam.put_role_policy(
                RoleName=self.caller_name,
                PolicyName="create-runtime",
                PolicyDocument=json.dumps(
                    caller_policy(
                        self.account,
                        self.region,
                        runtime_name=self.runtime_name,
                        role_arn=role_arn,
                        bucket=self.bucket,
                        subnets=state["subnets"],
                        security_group=state["probe_sg"],
                    )
                ),
            )
            time.sleep(12)  # IAM is eventually consistent
        if not state.get("runtime_id"):
            control = self._caller_session().client("bedrock-agentcore-control")
            request = {
                "agentRuntimeName": self.runtime_name,
                "tags": {TAG["Key"]: TAG["Value"]},
                **self._runtime_configuration(),
            }
            for attempt in range(8):
                try:
                    created = control.create_agent_runtime(**request)
                    break
                except ClientError as exc:
                    message = str(exc.response["Error"].get("Message", ""))
                    if (
                        code_of(exc) == "ValidationException"
                        and "Role validation failed" in message
                        and attempt < 7
                    ):
                        time.sleep(10)
                        continue
                    raise
            state.set(runtime_id=created["agentRuntimeId"], runtime_arn=created["agentRuntimeArn"])
        self._wait_runtime()

    def _runtime_configuration(self, network: dict[str, Any] | None = None) -> dict[str, Any]:
        """Configuration of the probe Runtime, on its network unless another one is given."""
        state = self.state
        return {
            "agentRuntimeArtifact": {
                "codeConfiguration": {
                    "code": {
                        "s3": {
                            "bucket": self.bucket,
                            "prefix": "probe/probe.zip",
                            "versionId": state["artifact_version"],
                        }
                    },
                    "runtime": "PYTHON_3_13",
                    "entryPoint": ["entrypoint.py"],
                }
            },
            "roleArn": f"arn:aws:iam::{self.account}:role/{self.role_name}",
            "networkConfiguration": network
            or {
                "networkMode": "VPC",
                "networkModeConfig": {
                    "subnets": state["subnets"],
                    "securityGroups": [state["probe_sg"]],
                },
            },
            "protocolConfiguration": {"serverProtocol": "HTTP"},
            "lifecycleConfiguration": {"idleRuntimeSessionTimeout": 60, "maxLifetime": 3600},
            "description": "Mango e2e: egress probe (temporary)",
        }

    def _operator_role_arn(self) -> str:
        """IAM role behind the operator's session (an assumed-role ARN names the session)."""
        arn = self.operator_arn
        if ":assumed-role/" not in arn:
            return arn
        role = arn.split(":assumed-role/")[1].split("/")[0]
        return str(self.iam.get_role(RoleName=role)["Role"]["Arn"])

    def _caller_session(self) -> boto3.Session:
        credentials = self.session.client("sts").assume_role(
            RoleArn=f"arn:aws:iam::{self.account}:role/{self.caller_name}",
            RoleSessionName="pack-egress-e2e",
        )["Credentials"]
        return boto3.Session(
            aws_access_key_id=credentials["AccessKeyId"],
            aws_secret_access_key=credentials["SecretAccessKey"],
            aws_session_token=credentials["SessionToken"],
            region_name=self.region,
        )

    def _wait_runtime(self) -> None:
        control = self.session.client("bedrock-agentcore-control")
        for _ in range(120):
            runtime = control.get_agent_runtime(agentRuntimeId=self.state["runtime_id"])
            if runtime["status"] == "READY":
                print(f"  runtime {self.state['runtime_id']} READY")
                return
            if runtime["status"].endswith("FAILED"):
                raise CheckFailedError(
                    f"runtime {runtime['status']}: {runtime.get('failureReason')}"
                )
            time.sleep(5)
        raise CheckFailedError("the probe runtime did not become READY")

    def ask(self, checks: list[dict[str, Any]], *, fresh: bool = False) -> list[dict[str, Any]]:
        """Run ``checks`` inside the Runtime. ``fresh`` starts a new microVM (new session)."""
        if fresh or not self.state.get("session"):
            self.state.set(session=f"pack-egress-{self.run_id}-{secrets.token_hex(12)}")
        data = self.session.client(
            "bedrock-agentcore", config=Config(read_timeout=180, retries={"total_max_attempts": 1})
        )
        last: Exception | None = None
        for _ in range(12):
            try:
                response = data.invoke_agent_runtime(
                    agentRuntimeArn=self.state["runtime_arn"],
                    qualifier="DEFAULT",
                    runtimeSessionId=self.state["session"],
                    contentType="application/json",
                    accept="application/json",
                    payload=json.dumps({"checks": checks}).encode(),
                )
                return list(json.loads(response["response"].read())["results"])
            except ClientError as exc:
                last = exc
                if code_of(exc) not in {
                    "RuntimeClientError",
                    "ServiceQuotaExceededException",
                    "ThrottlingException",
                }:
                    raise
                time.sleep(10)
        raise CheckFailedError(f"the probe did not answer: {last}")

    # --- Checks ---------------------------------------------------------------------------

    def probe(self) -> None:
        region, report = self.region, self.report
        temp = self.state["network"] == "temp"
        pricing_host = f"api.pricing.{region}.amazonaws.com"
        results = self.ask(
            [
                {"kind": "dns", "name": PUBLIC_HOST},
                {"kind": "tcp", "host": PUBLIC_HOST, "port": 443},
                {"kind": "tcp", "host": PUBLIC_IP, "port": 443},
                {"kind": "tcp", "host": "10.0.0.10", "port": 443},
                {"kind": "dns", "name": pricing_host},
                {"kind": "tcp", "host": pricing_host, "port": 443},
                {"kind": "aws", "service": "pricing", "region": region},
                {"kind": "aws", "service": "sts", "region": region},
            ],
            fresh=True,
        )
        print(json.dumps(results, indent=2))
        dns_public, tcp_public, tcp_ip, tcp_private, dns_pricing, tcp_pricing, pricing, sts = (
            results
        )
        report.check(True, "the Runtime starts and answers with no route to the internet")
        report.check(
            dns_public["outcome"] == "unresolved",
            "a name outside the allowlist does not resolve",
            dns_public,
        )
        report.check(tcp_public["outcome"] != "open", "a public host is unreachable", tcp_public)
        report.check(tcp_ip["outcome"] == "closed", "a public IP address is unreachable", tcp_ip)
        report.check(
            tcp_private["outcome"] == "closed",
            "a private address outside the endpoints is unreachable",
            tcp_private,
        )
        private = dns_pricing.get("addresses", [])
        report.check(
            dns_pricing["outcome"] == "resolved" and all(a.startswith("10.") for a in private),
            "the Price List API resolves to the interface endpoint",
            dns_pricing,
        )
        report.check(
            tcp_pricing["outcome"] == "open", "the Price List endpoint is reachable", tcp_pricing
        )
        report.check(
            pricing["outcome"] == "ok",
            "pricing:DescribeServices answers through the endpoint",
            pricing,
        )
        if self.args.pack == "aws-pricing" or temp:
            expected = "ok" if temp else "unreachable"
            report.check(
                sts["outcome"] == expected,
                "STS answers through its endpoint"
                if temp
                else "STS is unreachable for a pack that does not declare it",
                sts,
            )
        self._probe_dns_failure_mode()
        self._probe_logs()
        self._probe_iam_network_pins()
        if temp:
            self._probe_endpoint_policy()
            self._probe_security_group()

    def _probe_iam_network_pins(self) -> None:
        """With the provisioner's permissions, a Runtime cannot leave the pack network."""
        control = self._caller_session().client("bedrock-agentcore-control")
        operator = self.session.client("bedrock-agentcore-control")
        elsewhere: list[tuple[str, dict[str, Any]]] = [
            ("the PUBLIC network", {"networkMode": "PUBLIC"})
        ]
        if self.state.get("endpoint_sg"):
            other = {
                "subnets": self.state["subnets"],
                "securityGroups": [self.state["endpoint_sg"]],
            }
            elsewhere.append(
                ("another security group", {"networkMode": "VPC", "networkModeConfig": other})
            )
        for label, network in elsewhere:
            configuration = self._runtime_configuration(network)
            for action, call in (
                (
                    "create",
                    lambda c=configuration: control.create_agent_runtime(
                        agentRuntimeName=f"{self.runtime_name}_x",
                        tags={TAG["Key"]: TAG["Value"]},
                        **c,
                    ),
                ),
                (
                    "update",
                    lambda c=configuration: control.update_agent_runtime(
                        agentRuntimeId=self.state["runtime_id"], **c
                    ),
                ),
            ):
                denied = False
                try:
                    made = call()
                    if action == "create":  # it should not exist: remove it at once
                        operator.delete_agent_runtime(agentRuntimeId=made["agentRuntimeId"])
                except ClientError as exc:
                    denied = code_of(exc) == "AccessDeniedException"
                    if not denied:
                        raise
                self.report.check(
                    denied, f"the provisioner's permissions cannot {action} a Runtime on {label}"
                )

    def _probe_dns_failure_mode(self) -> None:
        """If the DNS Firewall cannot answer, queries must fail, not pass unfiltered."""
        vpc = self.ec2.describe_subnets(SubnetIds=self.state["subnets"][:1])["Subnets"][0]["VpcId"]
        config = self.r53.get_firewall_config(ResourceId=vpc)["FirewallConfig"]
        self.report.check(
            config["FirewallFailOpen"] == "DISABLED",
            "the DNS Firewall of the VPC fails closed",
            config["FirewallFailOpen"],
        )

    def _probe_logs(self) -> None:
        """What the server prints reaches its log group through the CloudWatch Logs endpoint."""
        logs = self.session.client("logs")
        group = f"/aws/bedrock-agentcore/runtimes/{self.state['runtime_id']}-DEFAULT"
        found = 0
        for _ in range(18):
            try:
                found = len(
                    logs.filter_log_events(
                        logGroupName=group, filterPattern='"mango egress probe"', limit=5
                    )["events"]
                )
            except ClientError as exc:
                if code_of(exc) != _NOT_FOUND:
                    raise
            if found:
                break
            time.sleep(10)
        self.report.check(found > 0, "the Runtime writes its logs through the Logs endpoint", group)

    def _probe_endpoint_policy(self) -> None:
        """The Price List endpoint, because ``sts:GetCallerIdentity`` cannot be denied by policy."""
        endpoint = self.state["endpoints"]["pricing.api"]
        self.ec2.modify_vpc_endpoint(
            VpcEndpointId=endpoint, PolicyDocument=json.dumps(org_policy("o-notthisorg0"))
        )
        try:
            denied = self._until("pricing", lambda r: r["outcome"] == "denied")
            self.report.check(
                denied["outcome"] == "denied",
                "an endpoint policy for another organization refuses the Runtime's own call",
                denied,
            )
        finally:
            self.ec2.modify_vpc_endpoint(
                VpcEndpointId=endpoint, PolicyDocument=json.dumps(org_policy(self.args.org_id))
            )
        allowed = self._until("pricing", lambda r: r["outcome"] == "ok")
        self.report.check(
            allowed["outcome"] == "ok",
            "with the organization's policy the call is allowed again",
            allowed,
        )

    def _until(self, service: str, done: Any) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for _ in range(40):  # an endpoint policy took between 1 and 6 minutes to apply in the lab
            result = self.ask([{"kind": "aws", "service": service, "region": self.region}])[0]
            if done(result):
                break
            time.sleep(15)
        return result

    def _probe_security_group(self) -> None:
        """Without the rule towards the endpoints, the same Runtime no longer reaches them."""
        probe, endpoint = self.state["probe_sg"], self.state["endpoint_sg"]
        rule = [
            {
                "IpProtocol": "tcp",
                "FromPort": 443,
                "ToPort": 443,
                "UserIdGroupPairs": [{"GroupId": endpoint}],
            }
        ]
        host = f"api.pricing.{self.region}.amazonaws.com"
        self.ec2.revoke_security_group_egress(GroupId=probe, IpPermissions=rule)
        try:
            time.sleep(5)
            closed = self.ask([{"kind": "tcp", "host": host, "port": 443}])[0]
            self.report.check(
                closed["outcome"] == "closed",
                "without its security group rule the endpoint is unreachable",
                closed,
            )
        finally:
            self.ec2.authorize_security_group_egress(GroupId=probe, IpPermissions=rule)

    # --- Cleanup --------------------------------------------------------------------------

    def cleanup(self) -> None:
        self._cleanup_probe()
        if self.state.get("network") != "temp":
            self.state.drop("subnets", "probe_sg")
            print("  cleanup complete (the installation's network is untouched)")
            return
        self._cleanup_dns_firewall()
        self._cleanup_endpoints()
        # Nothing billed is left. The rest waits for AgentCore to release its interfaces.
        if self._cleanup_vpc():
            print("  cleanup complete: nothing is left")

    def _cleanup_probe(self) -> None:
        state = self.state
        control = self.session.client("bedrock-agentcore-control")
        if state.get("runtime_id"):
            runtime_id = state["runtime_id"]
            self._ignore(_NOT_FOUND, control.delete_agent_runtime, agentRuntimeId=runtime_id)
            self._until_gone(lambda: control.get_agent_runtime(agentRuntimeId=runtime_id), 5)
            self._delete_log_groups(runtime_id)
            state.drop("runtime_id", "runtime_arn", "session")
        for key, policy in (("role", "probe"), ("caller", "create-runtime")):
            if state.get(key):
                role = state[key]
                self._ignore(
                    "NoSuchEntity", self.iam.delete_role_policy, RoleName=role, PolicyName=policy
                )
                self._ignore("NoSuchEntity", self.iam.delete_role, RoleName=role)
                state.drop(key)
        if state.get("bucket"):
            bucket = state["bucket"]
            versions = self.s3.list_object_versions(Bucket=bucket)
            for item in versions.get("Versions", []) + versions.get("DeleteMarkers", []):
                self.s3.delete_object(Bucket=bucket, Key=item["Key"], VersionId=item["VersionId"])
            self._ignore("NoSuchBucket", self.s3.delete_bucket, Bucket=bucket)
            state.drop("bucket", "artifact_version")

    def _cleanup_dns_firewall(self) -> None:
        state, r53 = self.state, self.r53
        if state.get("dns_association"):
            association = state["dns_association"]
            self._ignore(
                _NOT_FOUND,
                r53.disassociate_firewall_rule_group,
                FirewallRuleGroupAssociationId=association,
            )
            self._until_gone(
                lambda: r53.get_firewall_rule_group_association(
                    FirewallRuleGroupAssociationId=association
                ),
                3,
            )
            state.drop("dns_association")
        lists = [state[key] for key in ("dns_allow_list", "dns_block_list") if state.get(key)]
        if state.get("dns_rule_group"):
            group = state["dns_rule_group"]
            for domain_list in lists:
                self._ignore(
                    _NOT_FOUND,
                    r53.delete_firewall_rule,
                    FirewallRuleGroupId=group,
                    FirewallDomainListId=domain_list,
                )
            self._ignore(_NOT_FOUND, r53.delete_firewall_rule_group, FirewallRuleGroupId=group)
            state.drop("dns_rule_group")
        for domain_list in lists:
            self._ignore(
                _NOT_FOUND, r53.delete_firewall_domain_list, FirewallDomainListId=domain_list
            )
        state.drop("dns_allow_list", "dns_block_list")

    def _cleanup_endpoints(self) -> None:
        state = self.state
        if not state.get("endpoints"):
            return
        self.ec2.delete_vpc_endpoints(VpcEndpointIds=list(state["endpoints"].values()))
        in_vpc = [{"Name": "vpc-id", "Values": [state["vpc"]]}]
        for _ in range(60):
            if not self.ec2.describe_vpc_endpoints(Filters=in_vpc)["VpcEndpoints"]:
                break
            time.sleep(5)
        state.drop("endpoints")

    def _cleanup_vpc(self) -> bool:
        """Security groups, subnets and the VPC. False while AgentCore's interfaces remain."""
        state, ec2 = self.state, self.ec2
        if not state.get("vpc"):
            return True
        interfaces = ec2.describe_network_interfaces(
            Filters=[{"Name": "vpc-id", "Values": [state["vpc"]]}]
        )["NetworkInterfaces"]
        if interfaces:
            kinds = sorted({str(item.get("InterfaceType")) for item in interfaces})
            print(
                f"  LEFT: {state['vpc']} still has {len(interfaces)} network interface(s) {kinds}."
            )
            print("        AgentCore releases them within 8 hours; run cleanup again later.")
            return False
        probe, endpoint = state.get("probe_sg"), state.get("endpoint_sg")
        try:
            if probe and endpoint:
                # The two groups name each other: the rules go first.
                missing = "InvalidPermission.NotFound"
                self._ignore(
                    missing,
                    ec2.revoke_security_group_egress,
                    GroupId=probe,
                    IpPermissions=[_https_to(endpoint)],
                )
                self._ignore(
                    missing,
                    ec2.revoke_security_group_ingress,
                    GroupId=endpoint,
                    IpPermissions=[_https_to(probe)],
                )
            for key in ("probe_sg", "endpoint_sg"):
                if state.get(key):
                    self._ignore(
                        "InvalidGroup.NotFound", ec2.delete_security_group, GroupId=state[key]
                    )
                    state.drop(key)
            for subnet in state.get("subnets", []):
                self._ignore("InvalidSubnetID.NotFound", ec2.delete_subnet, SubnetId=subnet)
            state.drop("subnets")
            self._ignore("InvalidVpcID.NotFound", ec2.delete_vpc, VpcId=state["vpc"])
            state.drop("vpc")
        except ClientError as exc:
            if code_of(exc) != "DependencyViolation":
                raise
            print(f"  LEFT: {exc.response['Error']['Message']} Run cleanup again later.")
            return False
        return True

    @staticmethod
    def _until_gone(get: Any, seconds: int) -> None:
        for _ in range(60):
            try:
                get()
            except ClientError as exc:
                if code_of(exc) == _NOT_FOUND:
                    return
                raise
            time.sleep(seconds)

    def _delete_log_groups(self, runtime_id: str) -> None:
        logs = self.session.client("logs")
        prefix = f"/aws/bedrock-agentcore/runtimes/{runtime_id}"
        for group in logs.describe_log_groups(logGroupNamePrefix=prefix)["logGroups"]:
            logs.delete_log_group(logGroupName=group["logGroupName"])

    @staticmethod
    def _ignore(code: str, call: Any, **kwargs: Any) -> None:
        try:
            call(**kwargs)
        except ClientError as exc:
            if code_of(exc) != code:
                raise


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--profile", required=True)
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument(
        "--state", required=True, help="JSON file with the ids of what the run created"
    )
    parser.add_argument("--network", choices=("temp", "stack"), default="temp")
    parser.add_argument(
        "--namespace", help="installation namespace (required with --network stack)"
    )
    parser.add_argument(
        "--pack", default="aws-pricing", help="release pack whose security group is used (stack)"
    )
    parser.add_argument(
        "--org-id", help="organization id of the endpoint policies (temp; default: this account's)"
    )
    parser.add_argument(
        "--az-ids", default=",".join(DEFAULT_AZ_IDS), help="two AZ ids AgentCore supports (temp)"
    )
    parser.add_argument("--steps", default="create,probe,cleanup")
    args = parser.parse_args()
    args.az_ids = [item.strip() for item in args.az_ids.split(",") if item.strip()]
    steps = [item.strip() for item in args.steps.split(",") if item.strip()]
    unknown = set(steps) - {"create", "probe", "cleanup"}
    if unknown or len(args.az_ids) != len(TEMP_SUBNETS):
        parser.error("unknown --steps or --az-ids is not two ids")
    if args.network == "stack" and not args.namespace:
        parser.error("--network stack needs --namespace")

    run = Run(args)
    if run.state["network"] != args.network:
        parser.error(f"the state file belongs to a run with --network {run.state['network']}")
    if args.network == "temp" and not args.org_id:
        args.org_id = run.session.client("organizations").describe_organization()["Organization"][
            "Id"
        ]
    print(f"run {run.run_id} in {run.account} {run.region} (network: {args.network})")
    try:
        if "create" in steps:
            print("create")
            if args.network == "temp":
                run.create_temp_network()
            else:
                run.use_stack_network()
            run.create_probe()
        if "probe" in steps:
            print("probe")
            run.probe()
    except (CheckFailedError, ClientError) as exc:
        run.report.check(False, "the run could not finish", exc)
    finally:
        if "cleanup" in steps:
            print("cleanup")
            run.cleanup()
    print("FAILED" if run.report.failed else "PASSED")
    return 1 if run.report.failed else 0


if __name__ == "__main__":
    sys.exit(main())
