"""`aws`, as `deployment/purge-retained.sh` calls it: an account kept in a JSON file.

`test_purge_retained.py` puts it on the `PATH`. It answers with the shape of the real
responses and applies `--query` itself, so the queries of the script are the ones tested. It
refuses what S3 refuses (the governance bypass on a bucket without Object Lock, deleting a
locked version) and writes every call next to the account, for the tests to read.
"""

import json
import os
import sys
from pathlib import Path
from typing import Any, NoReturn

import jmespath

STATE = Path(os.environ["FAKE_AWS_STATE"])
CALLS = STATE.with_name("calls.jsonl")
DELETION_DATE = "2026-10-14T12:00:00+00:00"


def _fail(code: str, operation: str, message: str) -> NoReturn:
    sys.stderr.write(
        f"\naws: [ERROR]: An error occurred ({code}) when calling the {operation} operation: "
        f"{message}\n"
    )
    sys.exit(254)


def _options(tokens: list[str]) -> dict[str, Any]:
    options: dict[str, Any] = {}
    index = 0
    while index < len(tokens):
        name = tokens[index].removeprefix("--")
        if index + 1 < len(tokens) and not tokens[index + 1].startswith("--"):
            options[name] = tokens[index + 1]
            index += 2
        else:
            options[name] = True
            index += 1
    return options


def _text(value: Any) -> str:
    if isinstance(value, list):
        return "\t".join(_text(item) for item in value)
    return "None" if value is None else str(value)


def _delete_objects(bucket: dict[str, Any], options: dict[str, Any]) -> Any:
    bypass = options.get("bypass-governance-retention") is True
    if bypass and bucket.get("lock") is None:
        _fail(
            "InvalidArgument",
            "DeleteObjects",
            "x-amz-bypass-governance-retention is only applicable to Object Lock enabled buckets.",
        )
    if bucket.get("refuses_delete"):
        _fail("AccessDenied", "DeleteObjects", "Access Denied")
    asked = json.loads(options["delete"])["Objects"]
    locked = bucket.get("lock") == "COMPLIANCE" or (
        bucket.get("lock") == "GOVERNANCE" and not bypass
    )
    if locked:
        error = {
            "Code": "AccessDenied",
            "Message": "Access Denied because object protected by object lock.",
        }
        return {"Errors": [{**item, **error} for item in asked]}
    bucket["objects"] = [item for item in bucket["objects"] if item not in asked]
    return {"Deleted": asked}


def _s3api(account: dict[str, Any], operation: str, options: dict[str, Any]) -> Any:
    buckets: dict[str, Any] = account["buckets"]
    if operation == "list-buckets":
        return {"Buckets": [{"Name": name} for name in buckets]}
    bucket = buckets[options["bucket"]]
    if operation == "get-bucket-location":
        region = bucket.get("region", "us-east-1")
        if region is None:
            _fail("AccessDenied", "GetBucketLocation", "Access Denied")
        return {"LocationConstraint": None if region == "us-east-1" else region}
    if bucket.get("denied"):
        _fail("AccessDenied", operation, "Access Denied")
    if operation == "get-object-lock-configuration":
        if bucket.get("lock") is None:
            _fail(
                "ObjectLockConfigurationNotFoundError",
                "GetObjectLockConfiguration",
                "Object Lock configuration does not exist for this bucket",
            )
        return {"ObjectLockConfiguration": {"ObjectLockEnabled": "Enabled"}}
    if operation == "list-object-versions":
        page = bucket["objects"][: int(options["max-items"])]
        return {"Versions": page} if page else {}
    if operation == "delete-objects":
        return _delete_objects(bucket, options)
    if operation == "delete-bucket":
        if bucket["objects"]:
            _fail("BucketNotEmpty", "DeleteBucket", "The bucket you tried to delete is not empty")
        del buckets[options["bucket"]]
        return {}
    raise NotImplementedError(operation)


def _kms(account: dict[str, Any], operation: str, options: dict[str, Any]) -> Any:
    keys: dict[str, Any] = account["keys"]
    if operation == "list-aliases":
        return {
            "Aliases": [
                {"AliasName": name, "TargetKeyId": target}
                for name, target in account["aliases"].items()
            ]
        }
    if operation == "list-keys":
        return {"Keys": [{"KeyId": key_id} for key_id in keys]}
    if operation == "delete-alias":
        del account["aliases"][options["alias-name"]]
        return {}
    key = keys[options["key-id"]]
    if operation in ("describe-key", "list-resource-tags") and key.get("unreadable"):
        _fail("AccessDeniedException", operation, "User is not authorized to read this key")
    if operation == "describe-key" and key.get("throttled"):
        _fail("ThrottlingException", "DescribeKey", "Rate exceeded")
    if operation == "describe-key":
        metadata = {
            "KeyId": options["key-id"],
            "KeyManager": key.get("manager", "CUSTOMER"),
            "KeyState": key.get("state", "Enabled"),
            "Description": key.get("description", ""),
        }
        if metadata["KeyState"] == "PendingDeletion":
            metadata["DeletionDate"] = DELETION_DATE
        return {"KeyMetadata": metadata}
    if operation == "list-resource-tags":
        tags = key.get("tags", {})
        return {"Tags": [{"TagKey": name, "TagValue": value} for name, value in tags.items()]}
    if operation == "schedule-key-deletion":
        if key.get("refuses_deletion"):
            _fail("AccessDeniedException", "ScheduleKeyDeletion", "User is not authorized")
        key["state"] = "PendingDeletion"
        return {"KeyId": options["key-id"], "DeletionDate": DELETION_DATE}
    raise NotImplementedError(operation)


def _other(account: dict[str, Any], service: str, operation: str, options: dict[str, Any]) -> Any:  # noqa: PLR0911, PLR0912
    match (service, operation):
        case ("cloudformation", "describe-stacks"):
            name = options["stack-name"]
            if account.get("stacks_error"):
                _fail(account["stacks_error"], "DescribeStacks", "The query was refused")
            if name not in account["stacks"]:
                _fail("ValidationError", "DescribeStacks", f"Stack with id {name} does not exist")
            return {"Stacks": [{"StackName": name, "StackStatus": account["stacks"][name]}]}
        case ("sts", "get-caller-identity"):
            return {"Account": account["account"]}
        case ("dynamodb", "list-tables"):
            return {"TableNames": account["tables"]}
        case ("dynamodb", "update-table"):
            return {}
        case ("dynamodb", "delete-table"):
            account["tables"].remove(options["table-name"])
            return {"TableDescription": {"TableStatus": "DELETING"}}
        case ("cognito-idp", "list-user-pools"):
            return {"UserPools": [{"Id": i, "Name": name} for i, name in account["pools"].items()]}
        case ("cognito-idp", "describe-user-pool"):
            return {"UserPool": {"Id": options["user-pool-id"]}}
        case ("cognito-idp", "update-user-pool"):
            return {}
        case ("cognito-idp", "delete-user-pool"):
            del account["pools"][options["user-pool-id"]]
            return {}
        case ("logs", "describe-log-groups"):
            prefix = options["log-group-name-prefix"]
            groups = [name for name in account["log_groups"] if name.startswith(prefix)]
            return {"logGroups": [{"logGroupName": name} for name in groups]}
        case ("logs", "delete-log-group"):
            account["log_groups"].remove(options["log-group-name"])
            return {}
        case ("ecs", "list-task-definitions"):
            family = f":task-definition/{options['family-prefix']}"
            definitions = account["task_definitions"][options["status"]]
            return {"taskDefinitionArns": [arn for arn in definitions if family in arn]}
        case ("ecs", "deregister-task-definition"):
            account["task_definitions"]["ACTIVE"].remove(options["task-definition"])
            account["task_definitions"]["INACTIVE"].append(options["task-definition"])
            return {"taskDefinition": {"status": "INACTIVE"}}
    raise NotImplementedError(f"{service} {operation}")


def main() -> None:
    service, operation, *rest = sys.argv[1:]
    options = _options(rest)
    with CALLS.open("a") as calls:
        calls.write(json.dumps({"service": service, "operation": operation, **options}) + "\n")
    account = json.loads(STATE.read_text())
    if service == "configure":  # `aws configure list`: a table, not an API response
        print("NAME       : VALUE                    : TYPE             : LOCATION")
        print(f"region     : {account.get('region', '<not set>'):<24} : config-file      : ~")
        return
    if service == "s3api":
        response = _s3api(account, operation, options)
    elif service == "kms":
        response = _kms(account, operation, options)
    else:
        response = _other(account, service, operation, options)
    STATE.write_text(json.dumps(account))
    if isinstance(options.get("query"), str):
        response = jmespath.search(options["query"], response)
    if response == {}:
        return  # the real one prints nothing for an empty response
    print(_text(response) if options.get("output") == "text" else json.dumps(response))


if __name__ == "__main__":
    main()
