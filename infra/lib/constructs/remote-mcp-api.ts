import { Stack } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { acknowledge } from "../nag.js";
import { mangoName } from "../names.js";
import { RemoteRelease } from "./remote-release.js";

/** Partition of the pending consents: only the RESPONSE interceptor writes it (D98 (3), TM-017). */
export const CONSENT_PARTITION = "MCP_CONSENT#";
/** Partition of the signed approved catalogs: only the remote provisioner writes it (D98 (13)). */
export const APPROVED_REMOTE_PARTITION = "MCP_REMOTE#";
/** The remote provisioner's state machine (PR-4 of the remote MCP build, D98). */
export const remoteProvisionerName = (ns: string) => mangoName(ns, "RemoteMcpProvisioner");
/** The key that signs the approved catalogs (D93 (9)); only the remote provisioner signs. */
export const remoteMcpKeyAlias = (ns: string) => `alias/Mango-${ns}-remote-mcp`;
/** Prefix of the Identity providers of remote registrations (`mango_core.remote_mcp`). */
export const remoteProviderPrefix = (ns: string) => `Mango-${ns}-remote-`;

export interface RemoteMcpApiProps {
  readonly namespace: string;
  /**
   * The namespace as Core names it, for what mango-api reads (its environment), when this
   * construct lives in a stack nested in Core with a namespace parameter of its own (D99).
   */
  readonly coreNamespace?: string;
  readonly role: iam.Role;
  readonly settingsTable: dynamodb.ITable;
  readonly release: RemoteRelease;
}

/**
 * What mango-api needs for remote MCP registrations (D93, D98 (17)), in a managed policy of its
 * own (`Mango-<ns>-ApiRemoteMcp`): the inline policy of the role is full (finding of
 * 2026-10-25), and these permissions are of one domain.
 *
 * - The Identity providers `Mango-<ns>-remote-*`: created with the app's secret when an
 *   administrator asks, updated when the secret is rotated, deleted when a request is rejected
 *   or withdrawn. Identity keeps the secret in a Secrets Manager secret of its own, which the
 *   caller may need permissions on (to be confirmed live, V-1 of the plan).
 * - Closing a person's consent with their own access token (`CompleteResourceTokenAuth`, D98 (1)) on
 *   the Gateway's workload identity: «Mis conexiones» and its return view.
 * - The public half of the key that signs the approved catalogs, by alias: never `kms:Sign`.
 * - Starting the remote provisioner, and reading the signed profiles of the release.
 * - The stack's tags, copied to the providers (D76).
 * - A deny of writes to the pending consents, which mango-api only reads and deletes.
 *
 * The state machine and the key are named, not referenced: other changes create them.
 */
export class RemoteMcpApi extends Construct {
  readonly policy: iam.ManagedPolicy;
  readonly environment: Record<string, string>;

  constructor(scope: Construct, id: string, props: RemoteMcpApiProps) {
    super(scope, id);
    // Core, also from the stack nested in it where this construct lives (D99): mango-api reads
    // the tags of Core, and every name here is Core's.
    let stack = Stack.of(this);
    while (stack.nestedStackParent) stack = stack.nestedStackParent;
    const { partition, region, account } = stack;
    const ns = props.namespace;
    const vault = `arn:${partition}:bedrock-agentcore:${region}:${account}:token-vault/default`;
    const providers = `${vault}/oauth2credentialprovider/${remoteProviderPrefix(ns)}*`;
    const secrets =
      `arn:${partition}:secretsmanager:${region}:${account}:secret:` +
      `bedrock-agentcore-identity!default/oauth2/${remoteProviderPrefix(ns)}*`;
    const keys = `arn:${partition}:kms:${region}:${account}:key/*`;
    // The workload identity AgentCore creates for the Gateway (named as in `tools.ts`).
    const directory = `arn:${partition}:bedrock-agentcore:${region}:${account}:workload-identity-directory/default`;
    const gatewayIdentity = `${directory}/workload-identity/mango-${ns}-tools-*`;
    const stateMachine = `arn:${partition}:states:${region}:${account}:stateMachine:${remoteProvisionerName(ns)}`;

    const statements = [
      // Creating a provider also authorizes `CreateTokenVault` on the default vault, even when
      // it exists (AccessDenied seen in an installation on 2026-10-28).
      new iam.PolicyStatement({
        sid: "RemoteMcpProviders",
        actions: [
          "bedrock-agentcore:CreateOauth2CredentialProvider",
          "bedrock-agentcore:CreateTokenVault",
          "bedrock-agentcore:DeleteOauth2CredentialProvider",
          "bedrock-agentcore:GetOauth2CredentialProvider",
          "bedrock-agentcore:TagResource",
          "bedrock-agentcore:UpdateOauth2CredentialProvider",
        ],
        resources: [vault, providers],
      }),
      new iam.PolicyStatement({
        sid: "RemoteMcpProviderSecrets",
        actions: [
          "secretsmanager:CreateSecret",
          "secretsmanager:DeleteSecret",
          "secretsmanager:PutSecretValue",
          "secretsmanager:TagResource",
        ],
        resources: [secrets],
      }),
      // The person's consent, closed with the person's own access token (D98 (1)): Identity
      // checks that the session is theirs. Not the Gateway's credentials (finding of 2026-10-26).
      new iam.PolicyStatement({
        sid: "CompleteRemoteConsent",
        actions: ["bedrock-agentcore:CompleteResourceTokenAuth"],
        resources: [directory, gatewayIdentity],
      }),
      new iam.PolicyStatement({
        sid: "RemoteMcpPublicKey",
        actions: ["kms:GetPublicKey"],
        resources: [keys],
        conditions: { StringEquals: { "kms:RequestAlias": remoteMcpKeyAlias(ns) } },
      }),
      new iam.PolicyStatement({
        sid: "StartRemoteProvisioner",
        actions: ["states:StartExecution"],
        resources: [stateMachine],
      }),
      new iam.PolicyStatement({
        sid: "ReadInstallationStackTags",
        actions: ["cloudformation:DescribeStacks"],
        resources: [stack.stackId],
      }),
      // The consent the Gateway hands out is written under the verified `sub` only by the
      // RESPONSE interceptor; mango-api reads and deletes it (D98 (12), TM-017).
      new iam.PolicyStatement({
        sid: "ConsentsAreTheInterceptors",
        effect: iam.Effect.DENY,
        actions: ["dynamodb:BatchWriteItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
        resources: [props.settingsTable.tableArn],
        conditions: { "ForAnyValue:StringLike": { "dynamodb:LeadingKeys": [`${CONSENT_PARTITION}*`] } },
      }),
    ];
    const profiles = props.release.objectArns();
    if (profiles.length > 0) {
      statements.push(
        new iam.PolicyStatement({ sid: "ReadReleaseRemoteProfiles", actions: ["s3:GetObject"], resources: profiles }),
      );
    }
    this.policy = new iam.ManagedPolicy(this, "Policy", {
      managedPolicyName: mangoName(ns, "ApiRemoteMcp"),
      description: "mango-api: remote MCP registrations (D93, D98)",
      roles: [props.role],
      statements,
    });
    acknowledge(
      this.policy,
      {
        id: `AwsSolutions-IAM5[Resource::${providers}]`,
        reason:
          "One Identity provider per registration and generation is created at runtime (D98 (11)): the " +
          "name prefix Mango-<ns>-remote- is the scope.",
      },
      {
        id: `AwsSolutions-IAM5[Resource::${secrets}]`,
        reason: "The secret AgentCore Identity keeps for each of those providers, under the same prefix.",
      },
      {
        id: `AwsSolutions-IAM5[Resource::${gatewayIdentity}]`,
        reason:
          "The workload identity AgentCore creates for the Gateway mango-<ns>-tools-<suffix>: its suffix is " +
          "AgentCore's and CloudFormation does not return its ARN (finding of 2026-10-27).",
      },
      {
        id: `AwsSolutions-IAM5[Resource::${keys}]`,
        reason:
          "Only GetPublicKey, and only through the alias alias/Mango-<ns>-remote-mcp (kms:RequestAlias): the " +
          "key is created by another construct and named here.",
      },
    );
    const coreNs = props.coreNamespace ?? ns;
    this.environment = {
      REMOTE_PROVISIONER_STATE_MACHINE_ARN: `arn:${partition}:states:${region}:${account}:stateMachine:${remoteProvisionerName(coreNs)}`,
      REMOTE_MCP_KEY_ID: remoteMcpKeyAlias(coreNs),
      MANGO_STACK_ID: stack.stackId,
      ...props.release.environment,
    };
  }
}
