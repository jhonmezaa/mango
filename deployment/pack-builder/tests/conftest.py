import json
from pathlib import Path
from typing import Any

import pytest
import yaml

from mango_packs.tools import normalize_tools, tools_hash

# A stand-in for an upstream MCP server: the standard library only, so the tests need
# neither the network nor the real package. It serves the tools listed in tools.json and
# keeps only the ones pack.json allows, as the real entry points do.
FAKE_ENTRYPOINT = """
import json, os
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HERE = Path(__file__).parent
ALLOWED = set(json.loads((HERE / "pack.json").read_text())["tools"])
TOOLS = [t for t in json.loads((HERE / "tools.json").read_text()) if t["name"] in ALLOWED]


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        result = {"tools": TOOLS} if request["method"] == "tools/list" else {"capabilities": {}}
        body = json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result})
        if os.environ.get("FAKE_SSE"):
            body, kind = f"event: message\\ndata: {body}\\n\\n", "text/event-stream"
        else:
            kind = "application/json"
        self.send_response(200 if self.path == "/mcp" else 404)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body.encode())))
        self.end_headers()
        self.wfile.write(body.encode())

    def log_message(self, *args):
        pass


ADDRESS = (os.environ["MANGO_PACK_HOST"], int(os.environ["MANGO_PACK_PORT"]))
HTTPServer(ADDRESS, Handler).serve_forever()
"""

TOOLS: list[dict[str, Any]] = [
    {"name": "get_thing", "description": "Get a thing.", "inputSchema": {"type": "object"}},
    {"name": "read_file", "description": "Read a file.", "inputSchema": {"type": "object"}},
]
WHEEL_SHA256 = "a" * 64
LOCK = f"""\
fake-mcp-server==1.0.0 \\
    --hash=sha256:{WHEEL_SHA256} \\
    --hash=sha256:{"b" * 64}
dep==2.0 ; sys_platform != 'win32' \\
    --hash=sha256:{"c" * 64}
"""


def manifest_for(served: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "id": "fake-pack",
        "version": "1.0.0-1",
        "name": "Fake",
        "description": "Fake pack for tests.",
        "source": {
            "package": "fake-mcp-server",
            "version": "1.0.0",
            "sha256": WHEEL_SHA256,
            "exclude_newer": "2026-01-01T00:00:00Z",
        },
        "data_tier": "public",
        "identity_mode": "service",
        "iam": [],
        "egress": {"aws": []},
        "tools": [{"name": tool["name"], "access": "read"} for tool in served],
        "tools_hash": tools_hash(normalize_tools(served)),
    }


def write_manifest(directory: Path, manifest: dict[str, Any]) -> None:
    (directory / "manifest.yaml").write_text(yaml.safe_dump(manifest))


@pytest.fixture
def pack_dir(tmp_path: Path) -> Path:
    """A pack that allows only `get_thing` out of the two tools upstream registers."""
    directory = tmp_path / "packs" / "fake-pack"
    directory.mkdir(parents=True)
    write_manifest(directory, manifest_for(TOOLS[:1]))
    (directory / "requirements.in").write_text("fake-mcp-server==1.0.0\n")
    (directory / "requirements.lock").write_text(LOCK)
    (directory / "entrypoint.py").write_text(FAKE_ENTRYPOINT)
    return directory


@pytest.fixture
def staging(tmp_path: Path) -> Path:
    """What `uv pip install --target` leaves behind, including the parts that vary by machine."""
    root = tmp_path / "staging"
    (root / "dep").mkdir(parents=True)
    (root / "dep" / "__init__.py").write_text("VALUE = 1\n")
    (root / "dep" / "__pycache__").mkdir()
    (root / "dep" / "__pycache__" / "__init__.cpython-313.pyc").write_bytes(b"\x00")
    native = root / "dep" / "_native.so"
    native.write_bytes(b"\x7fELF")
    native.chmod(0o755)
    (root / "dep-2.0.dist-info").mkdir()
    (root / "dep-2.0.dist-info" / "METADATA").write_text("Name: dep\n")
    (root / "dep-2.0.dist-info" / "RECORD").write_text("../../bin/dep,sha256=x,1\n")
    (root / "dep-2.0.dist-info" / "INSTALLER").write_text("uv\n")
    (root / "bin").mkdir()
    (root / "bin" / "dep").write_text("#!/some/local/python\n")
    (root / "tools.json").write_text(json.dumps(TOOLS))
    return root
