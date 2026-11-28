"""Where the clients of the AWS Application Signals pack go (`packs/aws-application-signals/
entrypoint.py`), and the names botocore uses for every service of the pack network.

The private DNS of the VPC endpoint of Application Signals publishes only the dual-stack name
(`application-signals.<region>.api.aws`), while botocore builds the client with
`amazonaws.com`: the entry point points that client, and only that one, at the dual-stack name
(seen in the installation of the client on 2026-11-27). The upstream server is not installed
in the workspace: a fake one builds its clients the way `aws_clients` 0.2.1 does, with the real
boto3 and botocore, reading the same `MCP_*_ENDPOINT` variables.
"""

from __future__ import annotations

import importlib.util
import os
import re
import sys
from collections.abc import Callable, Iterator
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

import boto3
import pytest
from botocore.client import BaseClient
from botocore.config import Config

import mango_pack_runtime.server
from mango_packs.manifest import AwsEndpoint

REPO = Path(__file__).resolve().parents[2]
ENTRYPOINT = REPO / "packs" / "aws-application-signals" / "entrypoint.py"
PACK_NETWORK = REPO / "infra" / "lib" / "constructs" / "pack-network.ts"
UPSTREAM = "awslabs.cloudwatch_applicationsignals_mcp_server"

# The clients upstream builds (aws_clients.py 0.2.1): name, service, endpoint variable.
UPSTREAM_CLIENTS = (
    ("logs_client", "logs", "MCP_LOGS_ENDPOINT"),
    ("applicationsignals_client", "application-signals", "MCP_APPLICATIONSIGNALS_ENDPOINT"),
    ("cloudwatch_client", "cloudwatch", "MCP_CLOUDWATCH_ENDPOINT"),
    ("xray_client", "xray", "MCP_XRAY_ENDPOINT"),
    ("synthetics_client", "synthetics", "MCP_SYNTHETICS_ENDPOINT"),
    ("rum_client", "rum", "MCP_RUM_ENDPOINT"),
    ("s3_client", "s3", None),
    ("iam_client", "iam", None),
    ("lambda_client", "lambda", None),
    ("sts_client", "sts", None),
)

FAKE_AWS_CLIENTS = """
import os
import boto3
from botocore.config import Config

AWS_REGION = os.environ.get("AWS_REGION") or "us-east-1"
for _name, _service, _variable in {clients!r}:
    globals()[_name] = boto3.client(
        _service,
        region_name=AWS_REGION,
        config=Config(user_agent_extra="fake-upstream"),
        endpoint_url=os.environ.get(_variable) if _variable else None,
    )
"""
FAKE_SERVER = """
class _Mcp:
    async def list_tools(self):
        return []

mcp = _Mcp()
"""
FAKE_LOGURU = """
class _Logger:
    def remove(self, *args):
        pass

logger = _Logger()
"""


@pytest.fixture
def load_entrypoint(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> Iterator[Callable[..., ModuleType]]:
    """Runs the entry point as the Runtime does, with the upstream server and loguru faked:
    a package on disk that upstream's import of ``aws_clients`` finds at the same moment."""
    saved_environ = dict(os.environ)
    saved_session = boto3.DEFAULT_SESSION
    for variable in [name for name in os.environ if name.startswith(("AWS_", "MCP_"))]:
        monkeypatch.delenv(variable)
    monkeypatch.setattr(
        mango_pack_runtime.server, "load", lambda **_: SimpleNamespace(serve=lambda _: None)
    )
    monkeypatch.syspath_prepend(str(tmp_path))

    def load(
        environment: dict[str, str], clients: tuple[Any, ...] = UPSTREAM_CLIENTS
    ) -> ModuleType:
        upstream = tmp_path / "awslabs" / "cloudwatch_applicationsignals_mcp_server"
        upstream.mkdir(parents=True, exist_ok=True)
        (tmp_path / "awslabs" / "__init__.py").write_text("")
        (upstream / "__init__.py").write_text("")
        (upstream / "aws_clients.py").write_text(FAKE_AWS_CLIENTS.format(clients=clients))
        (upstream / "server.py").write_text(FAKE_SERVER)
        (tmp_path / "loguru.py").write_text(FAKE_LOGURU)
        os.environ.update({"AWS_ACCESS_KEY_ID": "AKIDEXAMPLE", "AWS_SECRET_ACCESS_KEY": "example"})
        os.environ.update(environment)
        spec = importlib.util.spec_from_file_location("aws_appsig_entrypoint", ENTRYPOINT)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    try:
        yield load
    finally:
        for name in [m for m in sys.modules if m.split(".")[0] in ("awslabs", "loguru")]:
            del sys.modules[name]
        os.environ.clear()
        os.environ.update(saved_environ)
        boto3.DEFAULT_SESSION = saved_session


def _clients(module: ModuleType) -> dict[str, str]:
    return {
        value.meta.service_model.service_name: value.meta.endpoint_url
        for value in vars(module.aws_clients).values()
        if isinstance(value, BaseClient)
    }


# --- The entry point --------------------------------------------------------------------------


def test_application_signals_goes_to_the_dual_stack_name_of_the_installation(
    load_entrypoint: Any,
) -> None:
    module = load_entrypoint({"MANGO_PACK_REGION": "eu-west-1", "AWS_REGION": "us-east-1"})
    clients = _clients(module)
    assert clients["application-signals"] == "https://application-signals.eu-west-1.api.aws"
    # Every other client keeps botocore's own name, the one its endpoint publishes.
    assert clients["cloudwatch"] == "https://monitoring.eu-west-1.amazonaws.com"
    assert clients["xray"] == "https://xray.eu-west-1.amazonaws.com"
    assert clients["synthetics"] == "https://synthetics.eu-west-1.amazonaws.com"
    assert clients["sts"] == "https://sts.eu-west-1.amazonaws.com"
    assert clients["logs"] == "https://logs.eu-west-1.amazonaws.com"
    assert [s for s, url in clients.items() if url.endswith(".api.aws")] == ["application-signals"]


def test_no_endpoint_of_the_environment_reaches_the_server(load_entrypoint: Any) -> None:
    module = load_entrypoint(
        {
            "MANGO_PACK_REGION": "us-east-1",
            "MCP_APPLICATIONSIGNALS_ENDPOINT": "https://attacker.example",
            "MCP_CLOUDWATCH_ENDPOINT": "https://attacker.example",
        }
    )
    clients = _clients(module)
    assert clients["application-signals"] == "https://application-signals.us-east-1.api.aws"
    assert clients["cloudwatch"] == "https://monitoring.us-east-1.amazonaws.com"
    assert os.environ.get("MCP_CLOUDWATCH_ENDPOINT") is None


@pytest.mark.parametrize(
    "region",
    [None, "", "us-east-1.evil.example", "cn-north-1", "us-gov-west-1", "US-EAST-1", "us-east-1/"],
)
def test_without_a_region_of_the_aws_partition_the_pack_does_not_start(
    load_entrypoint: Any, region: str | None
) -> None:
    environment = {} if region is None else {"MANGO_PACK_REGION": region, "AWS_REGION": region}
    with pytest.raises(SystemExit, match="MANGO_PACK_REGION"):
        load_entrypoint(environment)


def test_an_upstream_that_ignores_the_override_stops_the_pack(load_entrypoint: Any) -> None:
    ignoring = tuple(
        (n, s, None if s == "application-signals" else v) for n, s, v in UPSTREAM_CLIENTS
    )
    with pytest.raises(SystemExit, match="no longer goes to"):
        load_entrypoint({"MANGO_PACK_REGION": "us-east-1"}, ignoring)


def test_an_upstream_that_turns_dual_stack_on_for_every_client_stops_the_pack(
    load_entrypoint: Any,
) -> None:
    with pytest.raises(SystemExit, match="dual-stack name"):
        load_entrypoint({"MANGO_PACK_REGION": "us-east-1", "AWS_USE_DUALSTACK_ENDPOINT": "true"})


# --- Names of the pack network ----------------------------------------------------------------

# botocore client of each AWS API of the pack network (`PACK_EGRESS_SERVICES`).
BOTOCORE_CLIENT = {"elasticloadbalancing": "elbv2"}
# Served by their dual-stack name: the private DNS of their endpoint publishes no other.
DUAL_STACK = {"application-signals"}
REGION = "us-east-1"


def _network_names() -> dict[str, list[str]]:
    """``names(region)`` of every entry of ``PACK_EGRESS_SERVICES``, for :data:`REGION`."""
    source = PACK_NETWORK.read_text()
    body = source.split("export const PACK_EGRESS_SERVICES", 1)[1].split("\n};", 1)[0]
    entries = re.findall(
        r'^  "?([a-z][a-z0-9-]*)"?: \{\s*endpoint: "[^"]+",(?:\s*//[^\n]*)*\s*'
        r"names: \(\w*\) => \[([^\]]*)\]",
        body,
        re.MULTILINE,
    )
    return {
        service: [
            name.replace("${region}", REGION) for name in re.findall(r"[`\"]([^`\"]+)[`\"]", names)
        ]
        for service, names in entries
    }


def test_every_service_of_the_pack_network_is_read() -> None:
    assert sorted(_network_names()) == sorted(endpoint.value for endpoint in AwsEndpoint)


@pytest.mark.parametrize("service", sorted(_network_names()))
def test_the_network_resolves_the_name_the_client_of_each_service_uses(service: str) -> None:
    session = boto3.Session(
        aws_access_key_id="AKIDEXAMPLE", aws_secret_access_key="example", region_name=REGION
    )
    client = BOTOCORE_CLIENT.get(service, service)
    default = session.client(client).meta.endpoint_url  # type: ignore[call-overload]
    dual_stack = session.client(  # type: ignore[call-overload]
        client, config=Config(use_dualstack_endpoint=True)
    ).meta.endpoint_url
    names = [f"https://{name}" for name in _network_names()[service]]
    if service in DUAL_STACK:
        # What botocore would ask for resolves only to the public endpoint: no route there.
        assert default not in names
        assert names == [dual_stack]
    else:
        assert default in names
