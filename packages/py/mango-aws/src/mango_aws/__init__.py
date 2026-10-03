"""Cross-account access for Mango through broker roles (decision D10)."""

from mango_aws.broker import (
    CallerIdentity,
    CrossAccountSessions,
    RoleChain,
    build_session_policy,
)

__all__ = ["CallerIdentity", "CrossAccountSessions", "RoleChain", "build_session_policy"]
