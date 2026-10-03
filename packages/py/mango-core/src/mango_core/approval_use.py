"""Single use of an approval at one enforcement point (D27, TM-W3, TM-W7).

A verified approval token already proves that mango-api decided to run exactly this call now:
it is signed with a key only mango-api can use, names the request, the person, the tool and
the hash of the arguments, and lives two minutes. What is left is to spend it once. Both the
Gateway interceptor and the approval executor claim their own mark on the request item with
one conditional update.

The condition names **only the key and the marks**. IAM's ``dynamodb:Attributes`` does not
tell reading an attribute in a condition from writing it, so anything named here could also be
rewritten by a compromised enforcement point. With only the marks allowed, the worst it can do
is burn an approval (which then cannot run); it can never change the status, the signatures,
the arguments or who asked, which are what mango-api decides with.

Item layout: ``mango_api.approvals_store``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

from botocore.exceptions import ClientError

from mango_core.approval import Approval

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient

GATEWAY_MARK: Final = "gateway_used_at"
"""Set by the Gateway interceptor."""
EXECUTOR_MARK: Final = "executor_used_at"
"""Set by the approval executor, only after the Gateway's."""


class ApprovalUsedError(Exception):
    """The approval is not the one being run, was already used here, or expired."""


def claim(
    dynamodb: DynamoDBClient,
    table: str,
    approval: Approval,
    *,
    mark: str,
    after: str | None = None,
    now: int,
) -> None:
    """Spend ``approval`` at one enforcement point; raises ``ApprovalUsedError`` if it cannot.

    ``after`` names a mark that must already exist (the executor only runs what the Gateway
    let through). Errors other than the failed condition propagate: callers fail closed.
    """
    # The request must exist (an update never creates one) and this mark must be new.
    condition = "attribute_exists(PK) AND attribute_not_exists(#mark)"
    names = {"#mark": mark}
    if after is not None:
        condition += " AND attribute_exists(#after)"
        names["#after"] = after
    try:
        dynamodb.update_item(
            TableName=table,
            Key={"PK": {"S": f"APPROVAL#{approval.approval_id}"}, "SK": {"S": "META"}},
            UpdateExpression="SET #mark = :now",
            ConditionExpression=condition,
            ExpressionAttributeNames=names,
            ExpressionAttributeValues={":now": {"N": str(now)}},
            ReturnValues="NONE",
        )
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            raise ApprovalUsedError from None
        raise
