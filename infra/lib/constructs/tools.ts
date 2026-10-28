import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CfnResource, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { Installation } from "../config/schema.js";
import { mangoName, packNames, roleArn, roleNames, SESSION_TAG_KEYS } from "../names.js";
import { acknowledge, arnWildcardFinding, REASONS } from "../nag.js";
import { accountHealthRoleArn, NOT_THE_SYSTEM_IDENTITY, trustAccountHealth } from "./account-health.js";
import { PythonFunction } from "./python-function.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TARGET_NAME = "finops";
/** Gateway target of Mango's write tools, served by the approval executor (D27). */
export const OPS_TARGET_NAME = "ops";
/**
 * Gateway target of the knowledge search (D88 (14)); keep in sync with
 * `mango_core.harness_tools.KNOWLEDGE_TARGET`.
 */
export const KNOWLEDGE_TARGET_NAME = "knowledge";
/**
 * Partitions of the Settings table of remote MCP servers (D98 (12)); keep in sync with
 * `mango_core.remote_mcp`. The REQUEST interceptor reads the approved catalog; the RESPONSE
 * interceptor is the only writer of the pending consents.
 */
export const REMOTE_APPROVED_PARTITION = "MCP_REMOTE#*";
export const REMOTE_CONSENT_PARTITION = "MCP_CONSENT#*";
/** Attributes of a pending consent (`PendingConsent.to_item`): the RESPONSE interceptor writes no other. */
export const REMOTE_CONSENT_ATTRIBUTES = [
  "PK",
  "SK",
  "authorization_url",
  "source",
  "created_at",
  "expires_at",
  "ttl",
  "session_sha256",
];
/** FinOps roles of the pre token claim `mango_role` (D13). */
const CENTRAL_ROLE = "finops-central";
const AREA_ROLE = "bu-lead";

interface ConnectorManifest {
  tools: { name: string; audience: "all" | "central" }[];
}

/**
 * Tools of the Cost Explorer connector that answer for the whole organization: only central
 * FinOps may call them. Read from the connector manifest (`audience: central`), the same
 * release data mango-api uses for the submit rules (D35).
 */
export function orgWideTools(): string[] {
  const manifest = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "connectors/cost-explorer/manifest.json"), "utf8"),
  ) as ConnectorManifest;
  return manifest.tools.filter((t) => t.audience === "central").map((t) => t.name);
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: agentcore.CfnGatewayTarget.SchemaDefinitionProperty;
}

export interface ToolsProps {
  readonly installation: Installation;
  readonly issuer: string;
  readonly discoveryUrl: string;
  readonly webClientId: string;
  /** Settings table (D17): the connector reads the area -> OU mapping item only. */
  readonly settingsTable: dynamodb.ITableV2;
  /** Key encrypting the Settings table. */
  readonly dataKey: kms.IKey;
  /**
   * Packs of the release that read account data as the calling user (`central_only`, D37):
   * their roles (created later by the pack provisioner) may use the Billing broker, and the
   * interceptor signs who is calling their tools.
   */
  readonly accountDataPacks: string[];
  /**
   * Of those, the packs of the payer chain: the only pack roles the Billing broker trusts.
   * A pack of the member chain uses the Read broker instead (D51) and is not named here.
   */
  readonly payerChainPacks: string[];
  /**
   * Pack id -> the tools its signed manifest classifies `read` (D84), for every pack of the
   * release. The interceptor refuses any other tool of a pack target, and any unknown target.
   */
  readonly packReadTools: Record<string, string[]>;
}

/**
 * Lifetime of a Gateway MCP session (D47), counted from its `initialize`: AgentCore's minimum.
 * The harness opens one MCP connection per invocation, because mango-api sends new headers
 * with each one, and an invocation lasts at most 600 s (`AgentLimits.timeout_seconds`), with a
 * signature that expires 60 s later. A session never has to outlive that.
 */
export const GATEWAY_SESSION_SECONDS = 900;

/**
 * MCP versions the Gateway accepts. Left out, the Gateway does not take `2025-11-25`, the first
 * one with URL elicitation, so a remote MCP target without the person's token answers a generic
 * error instead of the consent URL (seen in an installation on 2026-10-28). The earlier ones
 * stay for the clients that ask for them (the harness, the packs). `2026-07-28` is left out: it
 * requires `_meta`, which the REQUEST interceptor removes on remote targets (D98 (15)).
 */
export const GATEWAY_MCP_VERSIONS = ["2025-03-26", "2025-06-18", "2025-11-25"];

/** Partition of the Settings table that holds only the current area -> OU mapping. */
export const MAPPING_PARTITION = "BU_MAPPING";

/**
 * Tools plane (rule 3): AgentCore Gateway with Cognito JWT inbound auth, a REQUEST interceptor
 * that injects the caller token (D13), Cedar policies (default deny) and the Cost Explorer
 * connector reaching the payer through the billing broker (D10).
 */
export class Tools extends Construct {
  readonly gateway: agentcore.CfnGateway;
  private readonly costExplorer: PythonFunction;
  private readonly discoveryUrl: string;
  private readonly webClientId: string;
  private readonly namespace: string;
  /** Cedar policy engine of the Gateway (L2, default deny). */
  readonly policyEngine: agentcore.CfnPolicyEngine;
  /**
   * Gateway targets of Mango connectors: the only ones that receive the caller's token. The
   * knowledge search also gets the knowledge bases mango-api signed for the agent (D88 (14)).
   */
  readonly connectorTargets = [TARGET_NAME, OPS_TARGET_NAME, KNOWLEDGE_TARGET_NAME];
  /** REQUEST interceptor of the Gateway; `WriteTools` adds the approval check to it (D27). */
  readonly interceptor: lambda.Function;
  /**
   * RESPONSE interceptor (D98 (16)): turns the consent error of a remote MCP target into
   * `consent_required` without the URL, keeps the URL as the person's pending consent, and
   * cuts the results of remote servers.
   */
  readonly responseInterceptor: lambda.Function;
  /**
   * Signs the approved catalog of remote MCP targets, `alias/Mango-<ns>-remote-mcp` (D93 (9)).
   * Only the remote provisioner may sign; the interceptor and mango-api read the public key.
   */
  readonly remoteMcpKey: kms.Key;
  /** SSM parameter with the Gateway id: the interceptor, which the Gateway names, reads it by name. */
  readonly gatewayIdParameterName: string;
  /** Role the Gateway invokes its Lambda targets with. */
  readonly gatewayRole: iam.Role;
  /** Key shared by mango-api (signs) and the interceptor (verifies) — audit finding F1. */
  readonly invocationKey: secretsmanager.Secret;
  /** Read-only AdminProbe (D17); only mango-api may invoke it. */
  readonly adminProbe: lambda.Function;
  /** Customer-managed key of the functions' configuration (environment variables). */
  readonly configKey: kms.Key;
  /**
   * Signs the caller assertion of packs over account data (D37). Only the interceptor can
   * sign with it; packs get the public key from the pack provisioner.
   */
  readonly packIdentityKey: kms.Key;
  /** Billing broker and the payer role behind it (D10): the chain account-data packs use. */
  readonly billingBrokerArn: string;
  readonly billingReaderArn: string;

  constructor(scope: Construct, id: string, props: ToolsProps) {
    super(scope, id);
    const cfg = props.installation;
    const ns = (this.namespace = cfg.namespace);
    const account = Stack.of(this).account;

    // Customer-managed key for the functions' configuration and the invocation key secret.
    const configKey = (this.configKey = new kms.Key(this, "ConfigKey", {
      alias: `alias/${mangoName(ns, "tools-config")}`,
      description: "Encrypts Mango tools function environment variables and the invocation key",
      enableKeyRotation: true,
      removalPolicy: cfg.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    }));

    // --- Connector and broker (D10) ---------------------------------------------------
    const connectorRole = new iam.Role(this, "ConnectorRole", {
      roleName: roleNames.costExplorerConnector(ns),
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });

    // AdminProbe (D17, TM-A7): read-only checks with the administrator's SourceIdentity.
    const probeRole = new iam.Role(this, "AdminProbeRole", {
      roleName: roleNames.adminProbe(ns),
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    // Exactly these roles may use the broker (no wildcards): the connector, the probe and
    // the role of each pack of the release that reads account data as the user (D37). A pack
    // role does not exist until an administrator enables the pack; it is named here by its
    // exact ARN, in a condition, so the trust does not depend on it existing.
    const packRoles = props.payerChainPacks.map((id) => roleArn(account, `${packNames.rolePrefix(ns)}${id}`));
    const brokerCallers = [connectorRole.roleArn, probeRole.roleArn, ...packRoles];

    const broker = new iam.Role(this, "BillingBroker", {
      roleName: roleNames.billingBroker(ns),
      description:
        "Broker to the payer BillingReader; only the Cost Explorer connector, AdminProbe and account-data MCP packs may use it",
      // AssumeRole itself requires a SourceIdentity (AGENTS.md, review ADM-04): every call
      // through the broker is attributable to a person, and none of these callers may name
      // the system identity of the daily account health (D84), which has its own statement.
      assumedBy: new iam.AccountPrincipal(account).withConditions({
        ArnEquals: { "aws:PrincipalArn": brokerCallers },
        Null: { "sts:SourceIdentity": "false" },
        ...NOT_THE_SYSTEM_IDENTITY,
      }),
      maxSessionDuration: Duration.hours(1),
    });
    broker.assumeRolePolicy?.addStatements(
      new iam.PolicyStatement({
        actions: ["sts:SetSourceIdentity"],
        principals: [new iam.AccountPrincipal(account)],
        conditions: {
          ArnEquals: { "aws:PrincipalArn": brokerCallers },
          StringLike: { "sts:SourceIdentity": "*" },
          ...NOT_THE_SYSTEM_IDENTITY,
        },
      }),
      new iam.PolicyStatement({
        actions: ["sts:TagSession"],
        principals: [new iam.AccountPrincipal(account)],
        conditions: {
          ArnEquals: { "aws:PrincipalArn": brokerCallers },
          "ForAllValues:StringEquals": { "aws:TagKeys": SESSION_TAG_KEYS },
        },
      }),
    );
    // The daily account health lists the member accounts through this chain, only as
    // `mango-health` (D84).
    trustAccountHealth(broker, new iam.AccountPrincipal(account), accountHealthRoleArn(account, ns));
    const readerArn = roleArn(cfg.managementAccountId, roleNames.billingReader(ns));
    this.billingBrokerArn = roleArn(account, roleNames.billingBroker(ns));
    this.billingReaderArn = readerArn;
    broker.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole", "sts:SetSourceIdentity", "sts:TagSession"],
        resources: [readerArn],
      }),
    );
    for (const role of [connectorRole, probeRole]) {
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ["sts:AssumeRole", "sts:SetSourceIdentity", "sts:TagSession"],
          resources: [broker.roleArn],
        }),
      );
    }
    // The connector reads only the mapping partition of the Settings table (TM-A6).
    connectorRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadAreaMapping",
        actions: ["dynamodb:GetItem"],
        resources: [props.settingsTable.tableArn],
        conditions: { "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [MAPPING_PARTITION] } },
      }),
    );
    connectorRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "DecryptSettingsViaDynamoDB",
        actions: ["kms:Decrypt"],
        resources: [props.dataKey.keyArn],
        conditions: {
          StringEquals: { "kms:ViaService": `dynamodb.${Stack.of(this).region}.amazonaws.com` },
        },
      }),
    );

    const connector = new PythonFunction(this, "CostExplorer", {
      packageName: "mango-cost-explorer",
      packagePath: "connectors/cost-explorer",
      retainLogs: cfg.retainData,
      handler: "mango_cost_explorer.handler.lambda_handler",
      functionName: mangoName(ns, "CostExplorerConnector"),
      description: "FinOps Cost Explorer tools (AgentCore Gateway target)",
      role: connectorRole,
      timeout: Duration.seconds(60),
      memorySize: 1024,
      environment: {
        COGNITO_ISSUER: props.issuer,
        COGNITO_CLIENT_ID: props.webClientId,
        BILLING_BROKER_ROLE_ARN: broker.roleArn,
        BILLING_READER_ROLE_ARN: readerArn,
        SETTINGS_TABLE: props.settingsTable.tableName,
      },
      environmentEncryption: configKey,
    });
    this.costExplorer = connector;
    this.discoveryUrl = props.discoveryUrl;
    this.webClientId = props.webClientId;

    this.adminProbe = new PythonFunction(this, "AdminProbe", {
      packageName: "mango-admin-probe",
      packagePath: "functions/admin-probe",
      retainLogs: cfg.retainData,
      handler: "mango_admin_probe.handler.lambda_handler",
      functionName: roleNames.adminProbe(ns),
      description: "Read-only organization listing and connectivity check for Mango admins",
      role: probeRole,
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: {
        BILLING_BROKER_ROLE_ARN: broker.roleArn,
        BILLING_READER_ROLE_ARN: readerArn,
        // Where the member roles are deployed (D51): the accounts the probe checks. Empty
        // without `orgAccess`.
        ORG_ACCESS_TARGETS: (cfg.orgAccess?.targets ?? []).join(","),
        ORG_ACCESS_EXCLUDED_ACCOUNT_IDS: (cfg.orgAccess?.excludedAccountIds ?? []).join(","),
      },
      environmentEncryption: configKey,
    }).function;
    // No resource-based policy: only mango-api's task role may invoke it (identity policy).

    this.invocationKey = new secretsmanager.Secret(this, "InvocationKey", {
      secretName: mangoName(ns, "gateway-invocation-key"),
      description: "Signs mango-api harness invocations so the Gateway rejects direct calls",
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
      encryptionKey: configKey,
    });
    acknowledge(this.invocationKey, {
      id: "AwsSolutions-SMG4",
      reason:
        "Rotation needs a dual-key window in mango-api and the interceptor; planned before " +
        "production. The key only binds requests to mango-api and grants no data access.",
    });

    // Identity of the caller for packs over account data (D37, TM-M14). A pack is third-party
    // code and never gets the user's token; the interceptor signs who is calling instead. The
    // key is asymmetric so that a pack (which only holds the public key) cannot sign.
    this.packIdentityKey = new kms.Key(this, "PackIdentityKey", {
      alias: `alias/${mangoName(ns, "pack-identity")}`,
      description: "Signs the caller identity the Gateway interceptor hands to MCP packs over account data",
      keySpec: kms.KeySpec.ECC_NIST_P256,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      // No data is encrypted with it: a new key only needs the packs' runtimes updated.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Approved catalog of remote MCP targets (D93 (9), D98 (13), TM-012). Asymmetric: whoever
    // verifies (the interceptor, mango-api, the agent provisioner) cannot sign.
    this.remoteMcpKey = new kms.Key(this, "RemoteMcpKey", {
      alias: `alias/${mangoName(ns, "remote-mcp")}`,
      description: "Signs the approved catalog of remote MCP servers; only the remote MCP provisioner signs",
      keySpec: kms.KeySpec.ECC_NIST_P256,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      // No data is encrypted with it: a new key only needs the catalog items signed again.
      removalPolicy: RemovalPolicy.DESTROY,
    });
    // By name, so that the role (created by the remote provisioner) need not exist yet. Denied
    // in the key policy to everyone else: no identity policy nor grant can let another principal
    // vouch for a remote tool.
    const remoteSigner = roleArn(account, roleNames.remoteMcpProvisioner(ns));
    this.remoteMcpKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "OnlyTheRemoteProvisionerSigns",
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["kms:Sign"],
        resources: ["*"],
        conditions: { ArnNotEquals: { "aws:PrincipalArn": remoteSigner } },
      }),
    );
    const gatewayIdParameterName = (this.gatewayIdParameterName = `/${mangoName(ns, "tools")}/gateway-id`);
    const region = Stack.of(this).region;
    const gatewayIdParameterArn = `arn:aws:ssm:${region}:${account}:parameter${gatewayIdParameterName}`;
    const viaDynamoDb = { StringEquals: { "kms:ViaService": `dynamodb.${region}.amazonaws.com` } };

    const interceptor = new PythonFunction(this, "Interceptor", {
      packageName: "mango-gateway-interceptor",
      packagePath: "functions/gateway-interceptor",
      retainLogs: cfg.retainData,
      handler: "mango_gateway_interceptor.handler.lambda_handler",
      functionName: mangoName(ns, "GatewayInterceptor"),
      description: "Injects the verified caller token into tool calls",
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: {
        INVOCATION_KEY_SECRET_ARN: this.invocationKey.secretArn,
        // The caller's token is injected only into calls to these targets, never to a pack.
        CONTEXT_TARGETS: JSON.stringify(this.connectorTargets),
        // Packs over account data get a signed assertion of who is calling, never the token.
        IDENTITY_TARGETS: JSON.stringify(props.accountDataPacks),
        // The only pack tools that go through (D84): the ones each signed manifest calls read.
        PACK_TOOLS: JSON.stringify(props.packReadTools),
        PACK_IDENTITY_KEY_ARN: this.packIdentityKey.keyArn,
        // Remote MCP targets (D98 (13)): the approved catalog and the key that verifies it.
        SETTINGS_TABLE: props.settingsTable.tableName,
        REMOTE_MCP_KEY_ARN: this.remoteMcpKey.keyArn,
        GATEWAY_ID_PARAMETER: gatewayIdParameterName,
      },
      environmentEncryption: configKey,
    });
    this.interceptor = interceptor.function;
    // Reads only the approved catalog of remote targets, and verifies it (TM-012).
    this.interceptor.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "ReadRemoteCatalog",
        actions: ["dynamodb:GetItem"],
        resources: [props.settingsTable.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [REMOTE_APPROVED_PARTITION] },
          Null: { "dynamodb:LeadingKeys": "false" },
        },
      }),
    );
    this.interceptor.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "DecryptSettingsViaDynamoDB",
        actions: ["kms:Decrypt"],
        resources: [props.dataKey.keyArn],
        conditions: viaDynamoDb,
      }),
    );
    this.interceptor.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "VerifyRemoteCatalog",
        actions: ["kms:GetPublicKey"],
        resources: [this.remoteMcpKey.keyArn],
      }),
    );
    this.interceptor.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "GatewayId",
        actions: ["ssm:GetParameter"],
        resources: [gatewayIdParameterArn],
      }),
    );

    // RESPONSE interceptor (D98 (16)): its own function and role. The only writer of the
    // pending consents, and only of their attributes (TM-017).
    const responseInterceptor = new PythonFunction(this, "ResponseInterceptor", {
      packageName: "mango-gateway-interceptor",
      packagePath: "functions/gateway-interceptor",
      retainLogs: cfg.retainData,
      handler: "mango_gateway_interceptor.response.lambda_handler",
      functionName: mangoName(ns, "GatewayResponseInterceptor"),
      description: "Keeps consent URLs of remote MCP servers away from the model and cuts their results",
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: {
        INVOCATION_KEY_SECRET_ARN: this.invocationKey.secretArn,
        SETTINGS_TABLE: props.settingsTable.tableName,
      },
      environmentEncryption: configKey,
    });
    this.responseInterceptor = responseInterceptor.function;
    this.invocationKey.grantRead(this.responseInterceptor);
    this.responseInterceptor.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "WritePendingConsents",
        actions: ["dynamodb:PutItem"],
        resources: [props.settingsTable.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [REMOTE_CONSENT_PARTITION] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": REMOTE_CONSENT_ATTRIBUTES },
          // A set operator is true for a key the request does not carry: require both.
          Null: { "dynamodb:LeadingKeys": "false", "dynamodb:Attributes": "false" },
        },
      }),
    );
    this.responseInterceptor.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "EncryptSettingsViaDynamoDB",
        actions: ["kms:Decrypt", "kms:GenerateDataKey"],
        resources: [props.dataKey.keyArn],
        conditions: viaDynamoDb,
      }),
    );
    this.invocationKey.grantRead(interceptor.function);
    // The only principal that can sign with the key: granted to the interceptor, and denied
    // in the key policy to everyone else, so no identity policy of the account (nor a grant)
    // lets another principal name a caller to a pack (TM-I3).
    this.packIdentityKey.grant(interceptor.function, "kms:Sign");
    this.packIdentityKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "OnlyTheInterceptorSigns",
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["kms:Sign"],
        resources: ["*"],
        conditions: { ArnNotEquals: { "aws:PrincipalArn": interceptor.function.role!.roleArn } },
      }),
    );

    // --- Gateway -------------------------------------------------------------------------
    const gatewayRole = (this.gatewayRole = new iam.Role(this, "GatewayRole", {
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": account },
          ArnLike: {
            "aws:SourceArn": `arn:aws:bedrock-agentcore:${Stack.of(this).region}:${account}:*`,
          },
        },
      }),
    }));
    connector.function.grantInvoke(gatewayRole);
    interceptor.function.grantInvoke(gatewayRole);
    responseInterceptor.function.grantInvoke(gatewayRole);
    acknowledge(
      gatewayRole,
      ...[connector, interceptor, responseInterceptor].map((f) => ({
        id: arnWildcardFinding(f.function.node.defaultChild as CfnResource, ":*"),
        reason: REASONS.cdkGrant,
      })),
    );
    acknowledge(connectorRole, { id: "AwsSolutions-IAM5[Resource::*]", reason: REASONS.xray });
    acknowledge(probeRole, { id: "AwsSolutions-IAM5[Resource::*]", reason: REASONS.xray });

    const policyEngine = (this.policyEngine = new agentcore.CfnPolicyEngine(this, "PolicyEngine", {
      name: `Mango_${ns}_Tools`,
      description: "Cedar authorization for Mango tools (default deny)",
    }));

    // Policy evaluation by the Gateway (AuthorizeAction / PartiallyAuthorizeActions need both the
    // engine and the gateway ARN). The gateway id derives from its name, which avoids a cycle.
    const gatewayName = mangoName(ns, "Tools");
    const gatewayArnPattern = `arn:aws:bedrock-agentcore:${region}:${account}:gateway/mango-${ns}-tools-*`;
    gatewayRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "PolicyEngineConfiguration",
        actions: ["bedrock-agentcore:GetPolicyEngine"],
        resources: [policyEngine.attrPolicyEngineArn],
      }),
    );
    gatewayRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "PolicyEngineAuthorization",
        actions: [
          "bedrock-agentcore:AuthorizeAction",
          "bedrock-agentcore:PartiallyAuthorizeActions",
        ],
        resources: [policyEngine.attrPolicyEngineArn, gatewayArnPattern],
      }),
    );
    acknowledge(gatewayRole, {
      id: `AwsSolutions-IAM5[Resource::${gatewayArnPattern}]`,
      reason: "The gateway id is generated from its name; the pattern pins this installation's gateway.",
    });

    // MCP packs (D36): the Gateway reaches a pack's runtime with SigV4 of this role. Runtimes
    // are created by the pack provisioner, so the name prefix is the scope.
    const packRuntimes = `arn:aws:bedrock-agentcore:${region}:${account}:runtime/${packNames.runtimePrefix(ns)}*`;
    gatewayRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "InvokePackRuntimes",
        actions: ["bedrock-agentcore:InvokeAgentRuntime"],
        resources: [packRuntimes, `${packRuntimes}/runtime-endpoint/*`],
      }),
    );
    acknowledge(
      gatewayRole,
      ...[packRuntimes, `${packRuntimes}/runtime-endpoint/*`].map((resource) => ({
        id: `AwsSolutions-IAM5[Resource::${resource}]`,
        reason: "Pack runtimes are created at runtime by the pack provisioner (D36): the name prefix is the scope.",
      })),
    );

    this.gateway = new agentcore.CfnGateway(this, "Gateway", {
      name: gatewayName,
      description: "Mango tools gateway",
      roleArn: gatewayRole.roleArn,
      protocolType: "MCP",
      authorizerType: "CUSTOM_JWT",
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl: props.discoveryUrl,
          allowedClients: [props.webClientId],
        },
      },
      interceptorConfigurations: [
        {
          interceptor: { lambda: { arn: interceptor.function.functionArn } },
          interceptionPoints: ["REQUEST"],
          inputConfiguration: { passRequestHeaders: true },
        },
        // With the headers: it verifies the invocation signature before it writes a consent.
        {
          interceptor: { lambda: { arn: responseInterceptor.function.functionArn } },
          interceptionPoints: ["RESPONSE"],
          inputConfiguration: { passRequestHeaders: true },
        },
      ],
      policyEngineConfiguration: { arn: policyEngine.attrPolicyEngineArn, mode: "ENFORCE" },
      // D47: with a session, the Gateway keeps the session of each MCP server target and
      // reuses it for the next call, so a pack runtime answers from the same microVM. The
      // Gateway binds the session to the `sub` of the caller's token, and every request
      // still passes inbound auth, the interceptor and Cedar.
      protocolConfiguration: {
        mcp: {
          supportedVersions: GATEWAY_MCP_VERSIONS,
          ...(cfg.gateway.mcpSessions && {
            sessionConfiguration: { sessionTimeoutInSeconds: GATEWAY_SESSION_SECONDS },
          }),
        },
      },
    });
    this.gateway.node.addDependency(gatewayRole);

    new ssm.StringParameter(this, "GatewayIdParameter", {
      parameterName: gatewayIdParameterName,
      // A path (it starts with `/`): the namespace may be a parameter of the release.
      simpleName: false,
      description: "Id of the tools Gateway, read by its interceptor (the signed remote MCP catalog names it)",
      stringValue: this.gateway.attrGatewayIdentifier,
    });

    // Remote MCP targets with 3LO (D94 (3)): the Gateway reads each person's token from the
    // vault, through the Identity providers of remote MCPs only (`Mango-<ns>-remote-*`), with
    // its own workload identity. AgentCore names that identity after the Gateway id, which
    // derives from its name (as `gatewayArnPattern`): CloudFormation does not return its ARN
    // as a string attribute.
    const identityBase = `arn:aws:bedrock-agentcore:${region}:${account}`;
    const remoteProviders = `${identityBase}:token-vault/default/oauth2credentialprovider/${mangoName(ns, "remote-")}*`;
    const gatewayIdentity = `${identityBase}:workload-identity-directory/default/workload-identity/mango-${ns}-tools-*`;
    const remoteSecrets = `arn:aws:secretsmanager:${region}:${account}:secret:bedrock-agentcore-identity!default/oauth2/${mangoName(ns, "remote-")}*`;
    gatewayRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "RemoteMcpTokens",
        actions: ["bedrock-agentcore:GetResourceOauth2Token"],
        resources: [
          remoteProviders,
          `${identityBase}:token-vault/default`,
          `${identityBase}:workload-identity-directory/default`,
          gatewayIdentity,
        ],
      }),
    );
    // Before it reads a person's token, the Gateway exchanges the caller's JWT for a token of
    // its own workload identity. Without these two actions AgentCore answers a generic tool
    // error, not AccessDenied, and never the consent URL (seen in an installation on 2026-10-28;
    // the lab role had them).
    gatewayRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "RemoteMcpWorkloadIdentity",
        actions: ["bedrock-agentcore:GetWorkloadAccessToken", "bedrock-agentcore:GetWorkloadAccessTokenForJWT"],
        resources: [`${identityBase}:workload-identity-directory/default`, gatewayIdentity],
      }),
    );
    gatewayRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "RemoteMcpClientSecrets",
        actions: ["secretsmanager:GetSecretValue"],
        resources: [remoteSecrets],
      }),
    );
    acknowledge(
      gatewayRole,
      ...[remoteProviders, remoteSecrets].map((resource) => ({
        id: `AwsSolutions-IAM5[Resource::${resource}]`,
        reason:
          "Identity providers of remote MCP servers are created at runtime by mango-api (D93 (7)): the name prefix is the scope.",
      })),
      {
        id: `AwsSolutions-IAM5[Resource::${gatewayIdentity}]`,
        reason: "The workload identity of the Gateway is named after its generated id; the pattern pins this installation's gateway.",
      },
    );

    const tools = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "connectors/cost-explorer/tool-schema.json"), "utf8"),
    ) as ToolDefinition[];
    const target = new agentcore.CfnGatewayTarget(this, "FinOpsTarget", {
      gatewayIdentifier: this.gateway.attrGatewayIdentifier,
      name: TARGET_NAME,
      description: "Cost Explorer connector",
      credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
      targetConfiguration: {
        mcp: {
          lambda: {
            lambdaArn: connector.function.functionArn,
            toolSchema: { inlinePayload: tools },
          },
        },
      },
    });

    // --- Cedar policies (L2) -------------------------------------------------------------
    // Each restriction is written twice. The `permit` grants the tools to the FinOps roles
    // (default deny). The `forbid … unless` states the same limit as a prohibition (the form
    // of the AgentCore Policy guide, "Common policy patterns"): Cedar evaluates `forbid` over
    // any `permit`, so a policy added to this engine later (the pack provisioner creates
    // policies, B2) cannot open these tools to anyone else.
    const action = (tool: string) => `AgentCore::Action::"${TARGET_NAME}___${tool}"`;
    const resource = `AgentCore::Gateway::"${this.gateway.attrGatewayArn}"`;
    const orgWide = orgWideTools();
    const toolNames = tools.map((t) => t.name);
    for (const tool of orgWide) {
      if (!toolNames.includes(tool)) throw new Error(`manifest tool ${tool} is not in the tool schema`);
    }
    const generalTools = toolNames.filter((n) => !orgWide.includes(n));
    const hasRole = (roles: string[]) =>
      `principal.hasTag("mango_role") && (${roles
        .map((r) => `principal.getTag("mango_role") == "${r}"`)
        .join(" || ")})`;
    const head = (effect: "permit" | "forbid", toolList: string[]) => [
      `${effect} (`,
      "  principal is AgentCore::OAuthUser,",
      `  action in [${toolList.map(action).join(", ")}],`,
      `  resource == ${resource}`,
    ];
    const policies: Record<string, { statement: string[]; description: string }> = {
      FinopsRead: {
        statement: [...head("permit", generalTools), `) when { ${hasRole([CENTRAL_ROLE, AREA_ROLE])} };`],
        description: "FinOps users may call scoped read tools",
      },
      FinopsOrgWide: {
        statement: [...head("permit", orgWide), `) when { ${hasRole([CENTRAL_ROLE])} };`],
        description: "Only central FinOps may call organization-wide tools",
      },
      FinopsReadForbidOthers: {
        statement: [...head("forbid", generalTools), `) unless { ${hasRole([CENTRAL_ROLE, AREA_ROLE])} };`],
        description: "No added policy can open the scoped read tools to users without a FinOps role",
      },
      FinopsOrgWideForbidOthers: {
        statement: [...head("forbid", orgWide), `) unless { ${hasRole([CENTRAL_ROLE])} };`],
        description: "No added policy can open organization-wide tools to anyone but central FinOps",
      },
    };
    for (const [name, p] of Object.entries(policies)) {
      const policy = new agentcore.CfnPolicy(this, `Policy${name}`, {
        name: `Mango_${ns}_${name}`,
        description: p.description,
        policyEngineId: policyEngine.attrPolicyEngineId,
        definition: { cedar: { statement: p.statement.join("\n") } },
      });
      policy.addResourceDependency(target);
    }
  }

  /**
   * The knowledge search (D88 (14)): its Lambda as a target of the Gateway, and its Cedar
   * policy (L2). Like a public pack, any signed-in user on an invocation mango-api signed may
   * call it (D33): which knowledge bases answer is decided by the tool, from the bases signed
   * for the agent, the registry and the person's groups.
   */
  addKnowledgeTarget(fn: lambda.IFunction): void {
    fn.grantInvoke(this.gatewayRole);
    acknowledge(this.gatewayRole, {
      id: arnWildcardFinding(fn.node.defaultChild as CfnResource, ":*"),
      reason: REASONS.cdkGrant,
    });
    const tools = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "connectors/knowledge-retrieve/tool-schema.json"), "utf8"),
    ) as ToolDefinition[];
    const target = new agentcore.CfnGatewayTarget(this, "KnowledgeTarget", {
      gatewayIdentifier: this.gateway.attrGatewayIdentifier,
      name: KNOWLEDGE_TARGET_NAME,
      description: "Knowledge search of Mango's agents",
      credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
      targetConfiguration: {
        mcp: { lambda: { lambdaArn: fn.functionArn, toolSchema: { inlinePayload: tools } } },
      },
    });
    const actions = tools.map((t) => `AgentCore::Action::"${KNOWLEDGE_TARGET_NAME}___${t.name}"`);
    const policy = new agentcore.CfnPolicy(this, "PolicyKnowledgeRetrieve", {
      name: `Mango_${this.namespace}_KnowledgeRetrieve`,
      description: "Signed-in users may search the knowledge bases of their agents; the tool decides which answer",
      policyEngineId: this.policyEngine.attrPolicyEngineId,
      definition: {
        cedar: {
          statement: [
            "permit (",
            "  principal is AgentCore::OAuthUser,",
            `  action in [${actions.join(", ")}],`,
            `  resource == AgentCore::Gateway::"${this.gateway.attrGatewayArn}"`,
            ");",
          ].join("\n"),
        },
      },
    });
    policy.addResourceDependency(target);
  }

  get gatewayUrl(): string {
    return this.gateway.attrGatewayUrl;
  }

  /**
   * Task runs (D78): the Gateway also takes the access tokens of the tasks client, which only
   * a run gets, as its owner; and so does the Cost Explorer connector, which only reads. The
   * write target never does: the approval executor keeps verifying the web client alone (A3).
   */
  allowTasksClient(clientId: string): void {
    this.gateway.authorizerConfiguration = {
      customJwtAuthorizer: { discoveryUrl: this.discoveryUrl, allowedClients: [this.webClientId, clientId] },
    };
    this.costExplorer.function.addEnvironment("TASKS_CLIENT_ID", clientId);
    // A consent asked by a run is marked as coming from a task (D98 (3)).
    this.responseInterceptor.addEnvironment("TASKS_CLIENT_ID", clientId);
  }
}
