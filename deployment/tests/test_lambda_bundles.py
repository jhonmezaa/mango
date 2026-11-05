"""Every Python Lambda imports its handler from its own bundle, with nothing else installed.

The workspace venv holds every package of the monorepo, so a unit test passes even when a
function does not declare what it imports (or what a `mango_core` module it imports needs):
`mango-cur-reconciler` shipped without pydantic and failed at import in the account. Here
each `PythonFunction` of `infra/lib` is bundled by `deployment/bundle-python.sh`, the script
the release runs, and its handler is imported by an isolated interpreter (`-I -S`: no site
packages, no environment) whose path is the bundle plus what the Lambda runtime brings (boto3).

The bundle is built for the machine running the test (`MANGO_BUNDLE_HOST_PLATFORM=1`), not
Linux arm64, so that its compiled wheels import here: the dependency set is the same.
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Iterator
from dataclasses import dataclass
from importlib import metadata
from pathlib import Path

import pytest

REPO = Path(__file__).parents[2]
BUNDLE = REPO / "deployment" / "bundle-python.sh"
CONSTRUCTS = REPO / "infra" / "lib"

# What the Lambda Python runtime has besides the standard library: boto3 and its dependencies.
RUNTIME_PACKAGES = ("boto3",)

pytestmark = pytest.mark.skipif(shutil.which("uv") is None, reason="needs uv")


@dataclass(frozen=True)
class Function:
    package: str
    handler: str
    manylinux: str | None
    source: str


def _field(block: str, name: str) -> str | None:
    match = re.search(rf'\b{name}:\s*"([^"]+)"', block)
    return match.group(1) if match else None


def _functions() -> list[Function]:
    """Every `new PythonFunction(...)` of the CDK app, with its package and handler."""
    found = []
    for path in sorted(CONSTRUCTS.rglob("*.ts")):
        text = path.read_text()
        for match in re.finditer(r"new PythonFunction\(", text):
            # The props object ends at the first `});` after the call.
            end = text.find("});", match.end())
            block = text[match.end() : end]
            package, handler = _field(block, "packageName"), _field(block, "handler")
            source = f"{path.relative_to(REPO)}:{text.count(chr(10), 0, match.start()) + 1}"
            assert package and handler, f"{source}: packageName and handler must be literals"
            found.append(Function(package, handler, _field(block, "manylinux"), source))
    return found


FUNCTIONS = _functions()


def test_every_python_function_is_found() -> None:
    # A construct that builds its props another way would leave its function untested.
    calls = sum(path.read_text().count("new PythonFunction(") for path in CONSTRUCTS.rglob("*.ts"))
    assert calls == len(FUNCTIONS) > 0


@pytest.fixture(scope="session")
def bundles() -> Iterator[dict[tuple[str, str | None], Path]]:
    """One bundle per package and wheel tag, deleted when the session ends."""
    with tempfile.TemporaryDirectory(prefix="mango-lambda-bundles-") as tmp:
        yield _build_bundles(Path(tmp))


def _build_bundles(root: Path) -> dict[tuple[str, str | None], Path]:
    built: dict[tuple[str, str | None], Path] = {}
    env = {**os.environ, "MANGO_BUNDLE_HOST_PLATFORM": "1"}
    for function in FUNCTIONS:
        key = (function.package, function.manylinux)
        if key in built:
            continue
        out = root / f"{function.package}-{function.manylinux or 'default'}"
        args = [str(BUNDLE), function.package, str(out)]
        if function.manylinux:
            args.append(function.manylinux)
        subprocess.run(args, check=True, cwd=REPO, env=env)  # noqa: S603  (repo script, literal args)
        built[key] = out
    return built


@pytest.fixture(scope="session")
def runtime() -> Iterator[Path]:
    """The packages the Lambda runtime provides, at the version of the workspace."""
    pins = [f"{name}=={metadata.version(name)}" for name in RUNTIME_PACKAGES]
    with tempfile.TemporaryDirectory(prefix="mango-lambda-runtime-") as out:
        subprocess.run(  # noqa: S603
            ["uv", "pip", "install", "--quiet", "--target", out, "--python", sys.executable, *pins],  # noqa: S607
            check=True,
            cwd=REPO,
        )
        yield Path(out)


@pytest.mark.parametrize("function", FUNCTIONS, ids=lambda f: f.handler)
def test_handler_imports_from_its_bundle(
    function: Function, bundles: dict[tuple[str, str | None], Path], runtime: Path
) -> None:
    bundle = bundles[(function.package, function.manylinux)]
    module, _, attribute = function.handler.rpartition(".")
    code = (
        "import importlib, sys\n"
        f"sys.path[:0] = [{str(bundle)!r}, {str(runtime)!r}]\n"
        f"handler = getattr(importlib.import_module({module!r}), {attribute!r})\n"
        "assert callable(handler)\n"
    )
    # A region and no credentials: clients built at import time need the first, never the second.
    env = {"AWS_DEFAULT_REGION": "us-east-1", "AWS_REGION": "us-east-1", "PATH": os.defpath}
    result = subprocess.run(  # noqa: S603
        [sys.executable, "-I", "-S", "-c", code],
        check=False,
        capture_output=True,
        text=True,
        cwd=bundle,
        env=env,
    )
    assert result.returncode == 0, (
        f"{function.source}: {function.handler} does not import from its bundle "
        f"({function.package}):\n{result.stderr}"
    )
