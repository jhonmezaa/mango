"""The logs of a public repository are public (D59): what the workflows may read, and from where.

GitHub Actions prints repository variables as they are and masks only secrets. A value that
carries an account id, an ARN or a bucket name is therefore an environment secret, never a
variable.

Also here: what starts the packs workflow. A push to main waits for the owner to approve one
signature per pack, so it starts for what can change a pack and for nothing else.
"""

import json
import re
import tomllib
from fnmatch import fnmatchcase
from pathlib import Path
from typing import Any

import pytest
import yaml

REPO = Path(__file__).parents[3]
WORKFLOWS = sorted((REPO / ".github" / "workflows").glob("*.y*ml"))

# `vars.X` and `vars['X']`, for a name that says it holds an ARN, a bucket or an account id.
SENSITIVE_VARIABLE = re.compile(
    r"\bvars\s*(?:\.\s*|\[\s*['\"])(\w*(?:_ARN|_BUCKET|_ACCOUNT_ID))\b", re.IGNORECASE
)
# The token of the run is a secret of every job, not of an environment.
ENVIRONMENT_SECRET = re.compile(r"\bsecrets\s*(?:\.\s*|\[\s*['\"])(?!GITHUB_TOKEN\b)\w+")
ANY_SECRET = re.compile(r"\bsecrets\s*[.\[]")


# Everything a pack's zip or its signed statement is made from, and what makes them.
PACK_PATHS = [
    "packs/**",
    # Remote MCP profiles (D98 (14)): signed with the same key, in the same workflow.
    "remotes/**",
    "deployment/build-pack.sh",
    "deployment/pack-builder/**",
    "packages/py/mango-packs/**",
    "packages/py/mango-pack-runtime/**",
    "packages/py/mango-aws/**",
    ".github/workflows/packs.yml",
]
# Only their versions of Python, uv and of what writes the statement reach a pack, and
# `toolchain.toml` records those (test_toolchain.py).
TOOLCHAIN_SOURCES = ["mise.toml", "uv.lock"]


def _jobs(workflow: Path) -> dict[str, dict[str, Any]]:
    jobs: dict[str, dict[str, Any]] = yaml.safe_load(workflow.read_text())["jobs"]
    return jobs


def _packs_triggers() -> dict[str, dict[str, Any]]:
    packs = next(path for path in WORKFLOWS if path.name == "packs.yml")
    # YAML 1.1 reads the key `on` as the boolean true.
    triggers: dict[str, dict[str, Any]] = yaml.safe_load(packs.read_text())[True]
    return triggers


def test_there_are_workflows_to_check() -> None:
    assert {path.name for path in WORKFLOWS} >= {"ci.yml", "packs.yml", "release.yml"}


@pytest.mark.parametrize(
    "expression",
    [
        "${{ vars.PACK_SIGNING_ROLE_ARN }}",
        "vars.RELEASE_BUCKET != ''",
        "${{ vars.PROVIDER_ACCOUNT_ID }}",
        "${{ vars['PACK_SIGNING_KEY_ARN'] }}",
        "${{ vars.release_bucket }}",
    ],
)
def test_the_check_sees_a_sensitive_variable(expression: str) -> None:
    assert SENSITIVE_VARIABLE.search(expression)


@pytest.mark.parametrize(
    "expression",
    [
        "vars.PACK_SIGNING_ENABLED == 'true'",
        "${{ vars.RELEASE_REGION || 'us-east-1' }}",
        "${{ secrets.PACK_SIGNING_ROLE_ARN }}",
    ],
)
def test_the_check_allows_what_carries_no_data(expression: str) -> None:
    assert not SENSITIVE_VARIABLE.search(expression)


@pytest.mark.parametrize("workflow", WORKFLOWS, ids=lambda path: path.name)
def test_no_arn_bucket_or_account_id_comes_from_a_variable(workflow: Path) -> None:
    found = sorted({match.group(1) for match in SENSITIVE_VARIABLE.finditer(workflow.read_text())})
    assert not found, f"{workflow.name} reads {found} from `vars`: use environment secrets (D59)"


@pytest.mark.parametrize("job", ["sign", "remote-sign"])
def test_packs_are_signed_with_the_alias_of_the_key(job: str) -> None:
    # The envelope records the key id and is uploaded as an artifact, which nothing masks.
    packs = next(path for path in WORKFLOWS if path.name == "packs.yml")
    steps = _jobs(packs)[job]["steps"]
    sign = next(step for step in steps if step.get("name") == "Sign and verify")
    assert sign["env"]["PACK_SIGNING_KEY"].startswith("alias/")
    assert '--key-id "$PACK_SIGNING_KEY"' in sign["run"]


@pytest.mark.parametrize("workflow", WORKFLOWS, ids=lambda path: path.name)
def test_a_job_that_reads_environment_secrets_declares_its_environment(workflow: Path) -> None:
    for name, job in _jobs(workflow).items():
        if ENVIRONMENT_SECRET.search(json.dumps(job)):
            assert job.get("environment"), f"{workflow.name}: job `{name}` has no environment"


@pytest.mark.parametrize("workflow", WORKFLOWS, ids=lambda path: path.name)
def test_no_condition_or_name_reads_a_secret(workflow: Path) -> None:
    # A job `if:` cannot read secrets (it is evaluated before the environment is granted), and
    # a name is shown outside the log of the step.
    for name, job in _jobs(workflow).items():
        for holder in [job, *job.get("steps", [])]:
            for key in ("if", "name"):
                assert not ANY_SECRET.search(str(holder.get(key, ""))), (
                    f"{workflow.name}: job `{name}` reads a secret in `{key}`"
                )


def test_a_push_starts_the_packs_workflow_only_for_what_can_change_a_pack() -> None:
    push = _packs_triggers()["push"]
    assert push["branches"] == ["main"]
    assert push["paths"] == PACK_PATHS


def test_a_pull_request_also_builds_the_packs_when_the_toolchain_files_change() -> None:
    triggers = _packs_triggers()
    # Nothing else starts it: no `pull_request_target`, no run by hand.
    assert set(triggers) == {"pull_request", "push"}
    assert triggers["pull_request"]["paths"] == PACK_PATHS + TOOLCHAIN_SOURCES


def test_a_push_starts_the_packs_workflow_for_every_source_of_the_builder() -> None:
    paths = _packs_triggers()["push"]["paths"]
    builder = REPO / "deployment" / "pack-builder"
    sources = tomllib.loads((builder / "pyproject.toml").read_text())["tool"]["uv"]["sources"]
    assert sources, "the builder no longer says which packages of the repository it uses"
    for name, source in sources.items():
        assert source == {"workspace": True}
        assert f"packages/py/{name}/**" in paths, f"a change to {name} would not be signed"
    for changed in (
        "deployment/pack-builder/toolchain.toml",
        "deployment/pack-builder/src/mango_pack_builder/build.py",
        "packs/aws-pricing/requirements.lock",
        "packs/signing-key.pub",
        "remotes/azure-devops/tool-schema.json",
    ):
        # `**` also crosses `/` for fnmatch, as it does in a workflow path filter.
        assert any(fnmatchcase(changed, pattern) for pattern in paths), changed


@pytest.mark.parametrize(("job", "needs"), [("sign", "build"), ("remote-sign", "remote-build")])
def test_packs_are_signed_only_from_a_push_to_main_in_the_protected_environment(
    job: str, needs: str
) -> None:
    packs = next(path for path in WORKFLOWS if path.name == "packs.yml")
    sign = _jobs(packs)[job]
    assert sign["environment"] == "pack-signing"
    assert sign["needs"] == needs
    assert "github.event_name == 'push' && github.ref == 'refs/heads/main'" in sign["if"]


def test_only_the_signing_jobs_can_get_credentials() -> None:
    packs = next(path for path in WORKFLOWS if path.name == "packs.yml")
    for name, job in _jobs(packs).items():
        writes_token = job.get("permissions", {}).get("id-token") == "write"
        assert writes_token == (name in {"sign", "remote-sign"}), name
        if name in {"build", "remote-build"}:
            assert "environment" not in job
            assert not ANY_SECRET.search(json.dumps(job))


def test_a_remote_profile_is_signed_only_as_it_was_checked() -> None:
    packs = next(path for path in WORKFLOWS if path.name == "packs.yml")
    jobs = _jobs(packs)
    assert jobs["remote-build"]["strategy"]["matrix"] == jobs["remote-sign"]["strategy"]["matrix"]
    remotes = sorted(path.name for path in (REPO / "remotes").iterdir() if path.is_dir())
    assert jobs["remote-build"]["strategy"]["matrix"]["remote"] == remotes
    steps = jobs["remote-sign"]["steps"]
    names = [step.get("name") or step.get("uses", "") for step in steps]
    compare = names.index("Rewrite and compare with the checked statement")
    credentials = next(i for i, name in enumerate(names) if "configure-aws-credentials" in name)
    assert compare < credentials < names.index("Sign and verify")
    assert "cmp " in steps[compare]["run"]


def test_the_release_ships_the_signed_remote_profiles() -> None:
    release = next(path for path in WORKFLOWS if path.name == "release.yml")
    steps = _jobs(release)["publish"]["steps"]
    download = next(step for step in steps if step.get("name") == "Signed packs of main")
    assert "--pattern 'remote-*-signed'" in download["run"]
    assert "dist/remotes" in download["run"]
