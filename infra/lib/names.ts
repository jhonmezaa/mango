/** Global names always carry the installation namespace (rule 6): `Mango-<ns>-<suffix>`. */
export function mangoName(namespace: string, suffix: string): string {
  return `Mango-${namespace}-${suffix}`;
}

/**
 * Topic the installation's alarms notify (`Alerts`). The name is fixed so that an alarm of
 * `Mango-<ns>-PackNetwork`, a stack installed before the one that owns the topic, can name it.
 */
export const alertsTopicName = (ns: string) => mangoName(ns, "Alerts");

/** Deterministic role names so stacks in different accounts never read each other (D10). */
export const roleNames = {
  billingBroker: (ns: string) => mangoName(ns, "BillingBroker"),
  billingReader: (ns: string) => mangoName(ns, "BillingReader"),
  costExplorerConnector: (ns: string) => mangoName(ns, "CostExplorerConnector"),
  adminProbe: (ns: string) => mangoName(ns, "AdminProbe"),
  provisioner: (ns: string) => mangoName(ns, "Provisioner"),
  deprovisioner: (ns: string) => mangoName(ns, "Deprovisioner"),
  reconciler: (ns: string) => mangoName(ns, "Reconciler"),
  packProvisioner: (ns: string) => mangoName(ns, "PackProvisioner"),
  /** Broker to the member accounts, in the Mango account (§4.10). */
  readBroker: (ns: string) => mangoName(ns, "ReadBroker"),
  /** Spoke role of every member account, shared by all read tools (D10). */
  memberReadOnly: (ns: string) => mangoName(ns, "ReadOnly"),
  /** Custom resource function that removes agents and packs when the stack is deleted (D58). */
  uninstallGuard: (ns: string) => mangoName(ns, "UninstallGuard"),
  /** Lambda behind the Gateway that runs approved write tools (D27). */
  approvalExecutor: (ns: string) => mangoName(ns, "ApprovalExecutor"),
  /** Broker to the write roles; only the approval executor may assume it (§4.10). */
  operateBroker: (ns: string) => mangoName(ns, "OperateBroker"),
  /** Write role of the payer account for the first write tool: its own budgets only. */
  budgetsOperator: (ns: string) => mangoName(ns, "BudgetsOperator"),
};

/** Every resource a write tool creates is named with the installation prefix (rule 6). */
export const writeResourcePrefix = (ns: string) => mangoName(ns, "");

/** StackSet that deploys the spoke template to the member accounts (and its stack instances). */
export const memberStackSetName = (ns: string) => mangoName(ns, "Member");

/**
 * Names of what the provisioner creates per agent (spec §5.2, D32). They derive only from the
 * namespace and the agent id, so IAM can pin them by prefix. Keep in sync with
 * `functions/provisioner/src/mango_provisioner/config.py`.
 */
export const agentNames = {
  /** Execution roles: `Mango-<ns>-agent-<id>`. */
  rolePrefix: (ns: string) => mangoName(ns, "agent-"),
  /** Permissions boundary every agent role must carry. */
  boundary: (ns: string) => mangoName(ns, "agent-boundary"),
  /** Harness names: `Mango_<ns>_a_<id>` (AgentCore allows no hyphens, 40 characters). */
  harnessPrefix: (ns: string) => `Mango_${ns}_a_`,
  /** AgentCore names the runtime of a harness `harness_<harness name>`. */
  runtimePrefix: (ns: string) => `harness_Mango_${ns}_a_`,
  /** Harness endpoint mango-api invokes; the provisioner moves it to the published version. */
  liveEndpoint: "live",
};

/**
 * Names of what the pack provisioner creates per MCP pack (spec §5.2, D32, D36). They derive
 * only from the namespace and the pack id, so IAM can pin them by prefix. Keep in sync with
 * `functions/provisioner/src/mango_provisioner/packs/config.py`.
 */
export const packNames = {
  /** Execution roles: `Mango-<ns>-mcp-<pack id>`. */
  rolePrefix: (ns: string) => mangoName(ns, "mcp-"),
  /** Permissions boundary every pack role must carry. */
  boundary: (ns: string) => mangoName(ns, "mcp-boundary"),
  /** Runtime names: `Mango_<ns>_mcp_<pack id>` (hyphens as `_`; 48 characters). */
  runtimePrefix: (ns: string) => `Mango_${ns}_mcp_`,
  /** Cedar policies of a pack: `Mango_<ns>_mcp_<pack id>_<n>`. */
  policyPrefix: (ns: string) => `Mango_${ns}_mcp_`,
  /** Runtime endpoint the Gateway target invokes; moved only to a verified version. */
  liveEndpoint: "live",
  /** `mango:component` tag of everything created for a pack. */
  componentTag: "mcp-pack",
  /** Prefix of the packs bucket where CloudFormation copies the release's packs. */
  artifactPrefix: "packs/",
};

export function roleArn(accountId: string, roleName: string): string {
  return `arn:aws:iam::${accountId}:role/${roleName}`;
}

/** Session tag keys Mango sets on cross-account sessions (D10); trusts only accept these. */
export const SESSION_TAG_KEYS = ["mango_user", "mango_agent", "mango_bu"];

/** Session tag that names the approval a write runs under (D27). */
export const APPROVAL_SESSION_TAG = "mango_approval";
/** Session tag keys of a write session: who asked, through which agent, under which approval. */
export const OPERATE_SESSION_TAG_KEYS = ["mango_user", "mango_agent", APPROVAL_SESSION_TAG];
