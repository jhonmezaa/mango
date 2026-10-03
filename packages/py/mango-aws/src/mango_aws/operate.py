"""Write access through the operate broker (D10, §4.10): the write capability of ``mango-aws``.

Only ``functions/approval-executor`` may import this module (AGENTS.md): a connector never
writes. A write session always names the approval it runs under, next to the person who asked
for the action: the session tag ``mango_approval`` and the ``SourceIdentity`` reach CloudTrail
in the target account, so every change there points back to one approved request.
"""

from __future__ import annotations

import re

from mango_aws.broker import CallerIdentity

APPROVAL_TAG = "mango_approval"
_APPROVAL_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_AGENT_ID_RE = re.compile(r"^[a-z0-9]{2,16}$")


def write_caller(*, user_id: str, agent_id: str, approval_id: str) -> CallerIdentity:
    """Identity of one approved write: the person who asked, the agent and the approval.

    All three come from verified tokens (the user's access token and the approval token),
    never from tool arguments.
    """
    if not _APPROVAL_ID_RE.fullmatch(approval_id) or not _AGENT_ID_RE.fullmatch(agent_id):
        raise ValueError("a write session needs the approval and the agent it runs under")
    return CallerIdentity(
        source_identity=user_id,
        tags={"mango_user": user_id, "mango_agent": agent_id, APPROVAL_TAG: approval_id},
    )
