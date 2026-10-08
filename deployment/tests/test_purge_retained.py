"""`deployment/purge-retained.sh`: what it deletes of an uninstalled installation, and what never.

The script runs for real, in bash, against `fake_aws.py` on the `PATH`. Nothing it does can be
undone, so the tests hold three things: it finds everything the stacks retain (a KMS key has
no alias left by then, and is found by its tag), it touches nothing of another installation or
of nobody's, and it does not end well while something it listed is still there.
"""

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

REPO = Path(__file__).parents[2]
SCRIPT = REPO / "deployment" / "purge-retained.sh"
FAKE_AWS = Path(__file__).with_name("fake_aws.py")
READS = ("list", "describe-", "get-")

OURS = "11111111-aaaa-4aaa-8aaa-111111111111"
PENDING = "22222222-bbbb-4bbb-8bbb-222222222222"
NEIGHBOUR = "33333333-cccc-4ccc-8ccc-333333333333"
UNTAGGED = "44444444-dddd-4ddd-8ddd-444444444444"
AWS_MANAGED = "55555555-eeee-4eee-8eee-555555555555"

AUDIT = "mango-ens1-core-governanceaudit71a67a9c-example"
ACCESS_LOGS = "mango-ens1-core-accesslogs8b620eca-example"
TASKS = "arn:aws:ecs:us-east-1:111122223333:task-definition"
SIGNALS = "/aws/application-signals/data"


def _versions(count: int) -> list[dict[str, str]]:
    return [{"Key": f"object-{n}", "VersionId": f"version-{n}"} for n in range(count)]


def _account() -> dict[str, Any]:
    """An account after the stacks of `ens1` are gone, next to an installation called `ens1x`."""
    return {
        "account": "111122223333",
        "region": "us-east-1",
        "stacks": {
            "Mango-ens1x-Core": "UPDATE_COMPLETE",
            "Mango-ens1x-PackNetwork": "CREATE_COMPLETE",
        },
        "tables": ["Mango-ens1-Agents", "Mango-ens1x-Agents", "Orders"],
        "pools": {"us-east-1_ours": "Mango-ens1-Users", "us-east-1_theirs": "Mango-ens1x-Users"},
        "buckets": {
            ACCESS_LOGS: {"lock": None, "objects": _versions(3)},
            AUDIT: {"lock": "GOVERNANCE", "objects": _versions(2)},
            "mango-ens1x-core-accesslogs-example": {"lock": None, "objects": _versions(1)},
            "mango-ens1-coreother": {"lock": None, "objects": _versions(1)},
        },
        "log_groups": [
            "/aws/lambda/Mango-ens1-Provisioner",
            "/mango/ens1/api",
            "/aws/lambda/Mango-ens1x-Provisioner",
            "/mango/ens1x/api",
            "aws/spans",
            SIGNALS,
        ],
        "aliases": {},
        "keys": {
            OURS: {"description": "Mango data key", "tags": _tags("ens1", "core")},
            PENDING: {"state": "PendingDeletion", "tags": _tags("ens1", "core")},
            NEIGHBOUR: {"tags": _tags("ens1x", "core")},
            UNTAGGED: {"description": "Someone else's key"},
            AWS_MANAGED: {"manager": "AWS", "tags": _tags("ens1", "core")},
        },
        "task_definitions": {
            "ACTIVE": [],
            "INACTIVE": [f"{TASKS}/Mango-ens1-api:1", f"{TASKS}/Mango-ens1-api:2"],
        },
    }


def _tags(namespace: str, component: str) -> dict[str, str]:
    return {"mango:namespace": namespace, "mango:component": component}


class Run:
    def __init__(self, tmp_path: Path, account: dict[str, Any], *arguments: str):
        tmp_path.mkdir(exist_ok=True)
        state = tmp_path / "account.json"
        state.write_text(json.dumps(account))
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        aws = bin_dir / "aws"
        aws.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{FAKE_AWS}" "$@"\n')
        aws.chmod(0o755)
        self.process = subprocess.run(  # noqa: S603
            ["/bin/bash", str(SCRIPT), *arguments],
            env={"PATH": f"{bin_dir}:/usr/bin:/bin", "FAKE_AWS_STATE": str(state)},
            capture_output=True,
            text=True,
            check=False,
        )
        self.code = self.process.returncode
        self.out = self.process.stdout
        self.err = self.process.stderr
        self.account: dict[str, Any] = json.loads(state.read_text())
        calls = tmp_path / "calls.jsonl"
        self.calls: list[dict[str, Any]] = [
            json.loads(line) for line in calls.read_text().splitlines()
        ]

    def called(self, operation: str) -> list[dict[str, Any]]:
        return [call for call in self.calls if call["operation"] == operation]


def test_without_confirm_nothing_that_deletes_is_called(tmp_path: Path) -> None:
    account = _account()
    run = Run(tmp_path, account, "ens1")

    assert run.code == 0, run.err
    assert all(call["operation"].startswith(READS) for call in run.calls), run.calls
    assert run.account == account
    assert "Nothing was deleted" in run.out


def test_the_listing_names_what_it_would_delete_and_what_it_leaves(tmp_path: Path) -> None:
    run = Run(tmp_path, _account(), "ens1")

    assert f"  {OURS} (core; Mango data key)" in run.out
    assert f"  {AUDIT} (Object Lock)\n" in run.out
    assert f"  {ACCESS_LOGS}\n" in run.out
    untouched = run.out.split("Not touched by this script\n")[1]
    assert f"KMS key {PENDING}" in untouched
    assert "already pending deletion, on 2026-10-14" in untouched
    assert "log group aws/spans: created by CloudWatch Transaction Search" in untouched
    assert f"log group {SIGNALS}: kept by CloudWatch Application Signals" in untouched
    assert "2 inactive revisions of task definition Mango-ens1-api" in untouched


def test_a_retained_key_without_alias_is_scheduled_by_its_tag(tmp_path: Path) -> None:
    run = Run(tmp_path, _account(), "ens1", "--confirm")

    assert run.code == 0, run.err
    scheduled = run.called("schedule-key-deletion")
    assert [call["key-id"] for call in scheduled] == [OURS]
    assert scheduled[0]["pending-window-in-days"] == "7"
    assert run.account["keys"][OURS]["state"] == "PendingDeletion"


def test_a_key_of_another_namespace_or_without_the_tag_is_never_scheduled(tmp_path: Path) -> None:
    run = Run(tmp_path, _account(), "ens1", "--confirm")

    for key in (NEIGHBOUR, UNTAGGED, AWS_MANAGED):
        assert "state" not in run.account["keys"][key]
        assert key not in run.out
    # The one the stack had already scheduled is said, and not scheduled again.
    assert PENDING not in [call["key-id"] for call in run.called("schedule-key-deletion")]


def test_an_alias_of_the_namespace_is_deleted_and_an_untagged_key_behind_it_stays(
    tmp_path: Path,
) -> None:
    account = _account()
    account["aliases"] = {
        "alias/Mango-ens1-data": UNTAGGED,
        "alias/Mango-ens1x-data": NEIGHBOUR,
        "alias/aws/s3": AWS_MANAGED,
    }
    run = Run(tmp_path, account, "ens1", "--confirm")

    assert run.code == 0, run.err
    assert sorted(run.account["aliases"]) == ["alias/Mango-ens1x-data", "alias/aws/s3"]
    assert "state" not in run.account["keys"][UNTAGGED]


def test_only_a_bucket_with_object_lock_is_emptied_with_the_bypass(tmp_path: Path) -> None:
    run = Run(tmp_path, _account(), "ens1", "--confirm")

    assert run.code == 0, run.err
    bypass = {
        call["bucket"]: call.get("bypass-governance-retention", False)
        for call in run.called("delete-objects")
    }
    assert bypass == {ACCESS_LOGS: False, AUDIT: True}
    assert ACCESS_LOGS not in run.account["buckets"]
    assert AUDIT not in run.account["buckets"]


def test_a_bucket_is_emptied_page_by_page(tmp_path: Path) -> None:
    account = _account()
    account["buckets"][ACCESS_LOGS]["objects"] = _versions(1201)
    run = Run(tmp_path, account, "ens1", "--confirm")

    assert run.code == 0, run.err
    emptied = [call for call in run.called("delete-objects") if call["bucket"] == ACCESS_LOGS]
    assert len(emptied) == 3
    assert ACCESS_LOGS not in run.account["buckets"]


def test_a_bucket_that_cannot_be_emptied_fails_the_run_with_the_error_of_s3(
    tmp_path: Path,
) -> None:
    account = _account()
    account["buckets"][ACCESS_LOGS]["refuses_delete"] = True
    run = Run(tmp_path, account, "ens1", "--confirm")

    assert run.code != 0
    assert "(AccessDenied) when calling the DeleteObjects operation" in run.err
    assert "COMPLIANCE" not in run.err
    assert f"Could not be deleted, and still in the account:\n  bucket {ACCESS_LOGS}\n" in run.err
    assert ACCESS_LOGS in run.account["buckets"]
    # One bucket that stays does not stop the rest of the purge.
    assert AUDIT not in run.account["buckets"]
    assert run.account["keys"][OURS]["state"] == "PendingDeletion"


def test_a_bucket_whose_object_lock_cannot_be_read_is_not_emptied_by_guessing(
    tmp_path: Path,
) -> None:
    account = _account()
    account["buckets"][ACCESS_LOGS]["denied"] = True
    listing = Run(tmp_path / "listing", account, "ens1")
    run = Run(tmp_path / "confirm", account, "ens1", "--confirm")

    assert listing.code == 0
    assert f"  {ACCESS_LOGS} (Object Lock: could not be read)\n" in listing.out
    assert run.code != 0
    assert ACCESS_LOGS not in [call["bucket"] for call in run.called("delete-objects")]
    assert f"  bucket {ACCESS_LOGS}\n" in run.err


def test_versions_under_compliance_retention_stay_and_fail_the_run(tmp_path: Path) -> None:
    account = _account()
    account["buckets"][AUDIT]["lock"] = "COMPLIANCE"
    run = Run(tmp_path, account, "ens1", "--confirm")

    assert run.code != 0
    assert "object-0: AccessDenied: Access Denied because object protected by object lock." in (
        run.err
    )
    assert "under COMPLIANCE they stay until it ends" in run.err
    assert f"  bucket {AUDIT}\n" in run.err
    assert len(run.account["buckets"][AUDIT]["objects"]) == 2
    assert AUDIT not in [call["bucket"] for call in run.called("delete-bucket")]


def test_a_key_that_cannot_be_scheduled_fails_the_run(tmp_path: Path) -> None:
    account = _account()
    account["keys"][OURS]["refuses_deletion"] = True
    run = Run(tmp_path, account, "ens1", "--confirm")

    assert run.code != 0
    assert f"  KMS key {OURS}" in run.err.split("still in the account:\n")[1]


def test_a_key_that_cannot_be_read_is_counted_and_never_scheduled(tmp_path: Path) -> None:
    account = _account()
    account["keys"][NEIGHBOUR]["unreadable"] = True
    run = Run(tmp_path, account, "ens1", "--confirm")

    assert run.code == 0, run.err
    assert "1 keys of the account could not be read" in run.err
    assert [call["key-id"] for call in run.called("schedule-key-deletion")] == [OURS]


def test_a_key_that_fails_to_read_for_another_reason_stops_the_purge(tmp_path: Path) -> None:
    account = _account()
    account["keys"][OURS]["throttled"] = True
    run = Run(tmp_path, account, "ens1", "--confirm")

    assert run.code != 0
    assert "(ThrottlingException)" in run.err
    assert not run.called("schedule-key-deletion")


def test_nothing_of_another_installation_or_of_nobody_is_deleted(tmp_path: Path) -> None:
    run = Run(tmp_path, _account(), "ens1", "--confirm")

    assert run.code == 0, run.err
    assert run.account["tables"] == ["Mango-ens1x-Agents", "Orders"]
    assert run.account["pools"] == {"us-east-1_theirs": "Mango-ens1x-Users"}
    assert sorted(run.account["buckets"]) == [
        "mango-ens1-coreother",
        "mango-ens1x-core-accesslogs-example",
    ]
    assert run.account["log_groups"] == [
        "/aws/lambda/Mango-ens1x-Provisioner",
        "/mango/ens1x/api",
        "aws/spans",
        SIGNALS,
    ]
    assert run.account["task_definitions"]["INACTIVE"] == [
        f"{TASKS}/Mango-ens1-api:1",
        f"{TASKS}/Mango-ens1-api:2",
    ]


def test_the_log_groups_of_the_whole_account_are_named_and_never_deleted(tmp_path: Path) -> None:
    """Transaction Search and Application Signals keep theirs for every workload of the account."""
    run = Run(tmp_path, _account(), "ens1", "--confirm")

    assert run.code == 0, run.err
    deleted = [call["log-group-name"] for call in run.called("delete-log-group")]
    assert deleted == ["/aws/lambda/Mango-ens1-Provisioner", "/mango/ens1/api"]
    assert "aws/spans" in run.account["log_groups"]
    assert SIGNALS in run.account["log_groups"]
    listed, untouched = run.out.split("Not touched by this script\n")
    assert SIGNALS not in listed
    assert f"  log group {SIGNALS}: " in untouched


def test_a_log_group_of_the_whole_account_is_named_only_when_it_is_there(tmp_path: Path) -> None:
    account = _account()
    account["log_groups"].remove(SIGNALS)
    account["log_groups"] += [f"{SIGNALS}-of-someone-else", "aws/spans-of-someone-else"]
    run = Run(tmp_path, account, "ens1", "--confirm")

    assert run.code == 0, run.err
    assert "application-signals" not in run.out
    assert "of-someone-else" not in run.out
    assert f"{SIGNALS}-of-someone-else" in run.account["log_groups"]
    assert "aws/spans-of-someone-else" in run.account["log_groups"]


def test_a_bucket_in_another_region_is_named_and_never_emptied(tmp_path: Path) -> None:
    """S3 lists every region; the stacks that own that bucket were never looked for."""
    account = _account()
    account["buckets"][ACCESS_LOGS]["region"] = "eu-west-1"
    run = Run(tmp_path, account, "ens1", "--confirm")

    assert run.code == 0, run.err
    assert ACCESS_LOGS in run.account["buckets"]
    assert ACCESS_LOGS not in [call["bucket"] for call in run.called("delete-objects")]
    untouched = run.out.split("Not touched by this script\n")[1]
    assert f"bucket {ACCESS_LOGS}: in eu-west-1" in untouched
    assert AUDIT not in run.account["buckets"]


def test_a_bucket_whose_region_cannot_be_read_is_not_emptied_by_guessing(tmp_path: Path) -> None:
    account = _account()
    account["buckets"][ACCESS_LOGS]["region"] = None
    run = Run(tmp_path, account, "ens1", "--confirm")

    assert run.code != 0
    assert ACCESS_LOGS not in [call["bucket"] for call in run.called("delete-objects")]
    assert f"  bucket {ACCESS_LOGS}\n" in run.err


def test_it_refuses_to_run_without_a_region(tmp_path: Path) -> None:
    account = _account()
    del account["region"]
    run = Run(tmp_path, account, "ens1", "--confirm")

    assert run.code == 1
    assert "No region is configured" in run.err
    assert run.account == account
    assert all(call["operation"].startswith(READS) for call in run.calls)


def _refused(run: Run, account: dict[str, Any]) -> None:
    """It stopped at the guard: an error, the account as it was and nothing but the query."""
    assert run.code == 1
    assert run.out == ""
    assert run.account == account
    assert {call["operation"] for call in run.calls} == {"describe-stacks"}


@pytest.mark.parametrize("arguments", [("ens1x",), ("ens1x", "--confirm")])
def test_it_refuses_to_run_while_core_exists(tmp_path: Path, arguments: tuple[str, ...]) -> None:
    account = _account()
    run = Run(tmp_path, account, *arguments)

    _refused(run, account)
    assert "Mango-ens1x-Core still exists (UPDATE_COMPLETE)" in run.err


@pytest.mark.parametrize("arguments", [("ens1x",), ("ens1x", "--confirm")])
def test_it_refuses_to_run_while_pack_network_exists_without_core(
    tmp_path: Path, arguments: tuple[str, ...]
) -> None:
    account = _account()
    del account["stacks"]["Mango-ens1x-Core"]
    run = Run(tmp_path, account, *arguments)

    _refused(run, account)
    assert "Mango-ens1x-PackNetwork still exists (CREATE_COMPLETE)" in run.err


@pytest.mark.parametrize("error", ["AccessDenied", "Throttling", "ExpiredToken"])
@pytest.mark.parametrize("arguments", [("ens1",), ("ens1", "--confirm")])
def test_it_refuses_to_run_when_it_cannot_tell_whether_the_stacks_exist(
    tmp_path: Path, arguments: tuple[str, ...], error: str
) -> None:
    account = _account()
    account["stacks_error"] = error
    run = Run(tmp_path, account, *arguments)

    _refused(run, account)
    assert "Could not check that Mango-ens1-Core is gone" in run.err
    assert f"({error})" in run.err


def test_it_runs_when_cloudformation_says_that_neither_stack_exists(tmp_path: Path) -> None:
    run = Run(tmp_path, _account(), "ens1")

    assert run.code == 0, run.err
    assert [call["stack-name"] for call in run.called("describe-stacks")] == [
        "Mango-ens1-Core",
        "Mango-ens1-PackNetwork",
    ]
