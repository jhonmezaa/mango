from typing import Any

import pytest


@pytest.fixture
def manifest_data() -> dict[str, Any]:
    return {
        "schema_version": 1,
        "id": "aws-pricing",
        "version": "1.1.1-1",
        "name": "AWS Pricing",
        "description": "Public AWS list prices.",
        "source": {
            "package": "awslabs.aws-pricing-mcp-server",
            "version": "1.1.1",
            "sha256": "a" * 64,
            "exclude_newer": "2026-09-24T00:00:00Z",
        },
        "data_tier": "public",
        "identity_mode": "service",
        "iam": [
            {
                "actions": ["pricing:GetProducts", "pricing:DescribeServices"],
                "resources": ["*"],
                "reason": "The Price List API does not accept ARNs.",
            }
        ],
        "egress": {"aws": ["pricing"]},
        "tools": [{"name": "get_pricing", "access": "read"}],
        "tools_hash": "sha256:" + "b" * 64,
        "config": [
            {"key": "region", "allowed": ["us-east-1", "eu-central-1"], "default": "us-east-1"}
        ],
    }
