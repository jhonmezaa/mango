"""Runtime configuration, injected by the Core stack as environment variables."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from decimal import Decimal


@dataclass(frozen=True)
class ModelPrice:
    """USD per 1M tokens."""

    input: Decimal
    output: Decimal
    cache_read: Decimal
    cache_write: Decimal


@dataclass(frozen=True)
class Settings:
    namespace: str
    region: str
    cognito_issuer: str
    cognito_client_id: str
    gateway_url: str
    agent_id: str
    """Agent that ships with the release (FinOps): the default of a chat that names none and
    the agent of conversations stored before agents were data."""
    agent_model: str
    """Default model of the installation (the release agent runs on it)."""
    auxiliary_model: str
    model_prices: dict[str, ModelPrice]
    policy_store_id: str
    conversations_table: str
    conversations_table_arn: str
    data_key_arn: str
    data_access_role_arn: str
    budgets_table: str
    audit_stream: str
    audit_index_table: str
    user_monthly_budget: Decimal
    """Initial value seeded by IaC; the Settings table is authoritative (D17)."""
    agent_monthly_budget: Decimal
    allowed_hosts: frozenset[str]
    invocation_key_secret_arn: str = ""
    settings_table: str = ""
    agents_table: str = ""
    mcp_catalog_dir: str = ""
    """Folder with the connector manifests of the release (set by the image)."""
    provisioner_state_machine_arn: str = ""
    """State machine that publishes approved agents; empty until the provisioner is deployed."""
    deprovisioner_state_machine_arn: str = ""
    """State machine that deletes the harness and the role of a retired agent (D48)."""
    pack_provisioner_state_machine_arn: str = ""
    """State machine that enables and disables approved MCP packs (D19)."""
    packs_bucket: str = ""
    """Bucket CloudFormation fills with the signed packs of the release (D36)."""
    packs_bucket_owner: str = ""
    pack_catalog: str = ""
    """JSON ``{pack id: {version, statement_sha256}}``: the one statement per pack this
    release installs."""
    pack_signing_public_key: str = ""
    """PEM that verifies pack statements; empty while signing is not set up (no packs)."""
    admin_probe_function: str = ""
    cognito_user_pool_id: str = ""
    guardrail_id: str = ""
    guardrail_version: str = ""
    model_capabilities_file: str = ""
    """``models/capabilities.json`` of the release (set by the image)."""
    agent_session_idle_seconds: int = 0
    """Idle timeout of the harness runtime sessions (IaC). 0 disables session reuse (D39)."""
    agent_session_max_seconds: int = 0
    """Maximum lifetime of a runtime session (IaC)."""
    approvals_table: str = ""
    """Requests to confirm write tool calls (D27); empty until write tools are deployed."""
    approval_key_arn: str = ""
    """KMS key that signs approval tokens; only mango-api can sign with it."""
    sign_up_domains: str = ""
    """Company email domains of the installation, comma separated: who may be invited."""
    version: str = ""
    release: str = ""
    """Version of the installed release (``release.yaml``)."""
    organization_id: str = ""
    management_account_id: str = ""
    alerts_email: str = ""
    first_admin_emails: str = ""
    """Administrators named by the installation, comma separated (display only)."""
    app_origin: str = ""
    """Public origin of the application (``https://host``); the web session needs it (D63)."""
    web_sessions_table: str = ""
    session_hours: int = 0
    """Maximum length of a web session: the refresh token validity of the web client."""

    @staticmethod
    def from_env() -> Settings:
        env = os.environ
        prices = {
            model: ModelPrice(
                input=Decimal(str(p["input"])),
                output=Decimal(str(p["output"])),
                cache_read=Decimal(str(p["cacheRead"])),
                cache_write=Decimal(str(p["cacheWrite"])),
            )
            for model, p in json.loads(env["MODEL_PRICES"]).items()
        }
        return Settings(
            namespace=env["MANGO_NAMESPACE"],
            region=env.get("AWS_REGION", env.get("AWS_DEFAULT_REGION", "us-east-1")),
            cognito_issuer=env["COGNITO_ISSUER"],
            cognito_client_id=env["COGNITO_CLIENT_ID"],
            gateway_url=env["GATEWAY_URL"],
            agent_id=env["AGENT_ID"],
            agent_model=env["AGENT_MODEL"],
            auxiliary_model=env["AUXILIARY_MODEL"],
            model_prices=prices,
            policy_store_id=env["POLICY_STORE_ID"],
            conversations_table=env["CONVERSATIONS_TABLE"],
            conversations_table_arn=env["CONVERSATIONS_TABLE_ARN"],
            data_key_arn=env["DATA_KEY_ARN"],
            data_access_role_arn=env["DATA_ACCESS_ROLE_ARN"],
            budgets_table=env["BUDGETS_TABLE"],
            audit_stream=env["AUDIT_STREAM"],
            audit_index_table=env["AUDIT_INDEX_TABLE"],
            user_monthly_budget=Decimal(env["USER_MONTHLY_BUDGET_USD"]),
            agent_monthly_budget=Decimal(env["AGENT_MONTHLY_BUDGET_USD"]),
            invocation_key_secret_arn=env["INVOCATION_KEY_SECRET_ARN"],
            settings_table=env["SETTINGS_TABLE"],
            agents_table=env["AGENTS_TABLE"],
            mcp_catalog_dir=env.get("MANGO_MCP_CATALOG_DIR", ""),
            model_capabilities_file=env.get("MANGO_MODEL_CAPABILITIES", ""),
            provisioner_state_machine_arn=env.get("PROVISIONER_STATE_MACHINE_ARN", ""),
            deprovisioner_state_machine_arn=env.get("DEPROVISIONER_STATE_MACHINE_ARN", ""),
            pack_provisioner_state_machine_arn=env.get("PACK_PROVISIONER_STATE_MACHINE_ARN", ""),
            packs_bucket=env.get("PACKS_BUCKET", ""),
            packs_bucket_owner=env.get("PACKS_BUCKET_OWNER", ""),
            pack_catalog=env.get("PACK_CATALOG", ""),
            pack_signing_public_key=env.get("PACK_SIGNING_PUBLIC_KEY", ""),
            admin_probe_function=env["ADMIN_PROBE_FUNCTION"],
            cognito_user_pool_id=env["COGNITO_USER_POOL_ID"],
            guardrail_id=env["GUARDRAIL_ID"],
            guardrail_version=env["GUARDRAIL_VERSION"],
            agent_session_idle_seconds=int(env.get("AGENT_SESSION_IDLE_SECONDS", "0")),
            agent_session_max_seconds=int(env.get("AGENT_SESSION_MAX_SECONDS", "0")),
            approvals_table=env.get("APPROVALS_TABLE", ""),
            approval_key_arn=env.get("APPROVAL_KEY_ARN", ""),
            sign_up_domains=env.get("SIGN_UP_DOMAINS", ""),
            version=env.get("MANGO_VERSION", ""),
            release=env.get("MANGO_RELEASE", ""),
            organization_id=env.get("ORGANIZATION_ID", ""),
            management_account_id=env.get("MANAGEMENT_ACCOUNT_ID", ""),
            alerts_email=env.get("ALERTS_EMAIL", ""),
            first_admin_emails=env.get("FIRST_ADMIN_EMAILS", ""),
            app_origin=env.get("APP_ORIGIN", ""),
            web_sessions_table=env.get("WEB_SESSIONS_TABLE", ""),
            session_hours=int(env.get("SESSION_HOURS", "0")),
            allowed_hosts=frozenset(
                h.strip().lower() for h in env["ALLOWED_HOSTS"].split(",") if h
            ),
        )
