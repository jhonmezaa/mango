"""The logs of a public repository are public (D59): what the workflows may read, and from where.

GitHub Actions prints repository variables as they are and masks only secrets. A value that
carries an account id, an ARN or a bucket name is therefore an environment secret, never a
variable.
"""

import json
import re
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


def _jobs(workflow: Path) -> dict[str, dict[str, Any]]:
    jobs: dict[str, dict[str, Any]] = yaml.safe_load(workflow.read_text())["jobs"]
    return jobs


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


def test_packs_are_signed_with_the_alias_of_the_key() -> None:
    # The envelope records the key id and is uploaded as an artifact, which nothing masks.
    packs = next(path for path in WORKFLOWS if path.name == "packs.yml")
    steps = _jobs(packs)["sign"]["steps"]
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
