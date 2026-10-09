import { CfnResource, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as agentcoreL1 from "aws-cdk-lib/aws-bedrockagentcore";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as firehose from "aws-cdk-lib/aws-kinesisfirehose";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Construct } from "constructs";
import { Installation } from "../config/schema.js";
import { logsKeyOf } from "../logs.js";
import { mangoName, packNames, roleNames } from "../names.js";
import { acknowledge, arnWildcardFinding, REASONS } from "../nag.js";
import { AgentPlatform } from "./agent-platform.js";
import { NO_PACK_NETWORK, PackNetworkRef, provisionerSetting } from "./pack-network.js";
import { PACK_DATA_ACTIONS, PackPlatform } from "./pack-platform.js";
import { PythonFunction } from "./python-function.js";

const AGENTCORE_SERVICE = "bedrock-agentcore.amazonaws.com";

/** Partition prefix of the Settings table with pack enablements (`MCP#<pack id>`). */
export const PACK_ENABLEMENT_PARTITION = "MCP#";
/**
 * Partition prefix of the Settings table that says what is installed (`MCP_INSTALLED#<pack
 * id>`). Only the pack provisioner writes it; keep in sync with `mango_packs.enablement`.
 */
export const PACK_INSTALLED_PARTITION = "MCP_INSTALLED#";

/**
 * Attributes of an enablement item the pack provisioner may name in a write (IAM
 * `dynamodb:Attributes`, which also counts the attributes of the condition expression): its
 * state, the failure and its own lock. Never `config`, `approved_by` or anything else
 * mango-api owns. Keep in sync with `mango_packs.enablement` (`begin_item`, `enabled_items`,
 * `disabled_items`, `fail_item`, `unlock_item`).
 */
export const PACK_PROVISIONER_WRITABLE_ATTRIBUTES = [
  "PK",
  "SK",
  "status",
  "status_at",
  "failed_step",
  "failure",
  "enablement_id",
  "pack_version",
  "provision_lock",
  "provision_lock_until",
];

/** Tags every pack runtime (and its workload identity) must be created with. */
const packRequestTags = (ns: string) => ({
  StringEquals: {
    "aws:RequestTag/mango:namespace": ns,
    "aws:RequestTag/mango:component": packNames.componentTag,
  },
});

export interface PackProvisionerProps {
  readonly installation: Installation;
  readonly platform: AgentPlatform;
  readonly packs: PackPlatform;
  readonly settingsTable: dynamodb.ITableV2;
  readonly auditIndex: dynamodb.ITableV2;
  readonly auditStream: firehose.IDeliveryStream;
  /** Key of the tables above. */
  readonly dataKey: kms.IKey;
  /** Key for the function's environment variables. */
  readonly configKey: kms.IKey;
  /** The installation's tools Gateway and its Cedar policy engine (L2). */
  readonly gateway: agentcoreL1.CfnGateway;
  readonly policyEngine: agentcoreL1.CfnPolicyEngine;
  /** Gateway targets of Mango connectors: a pack never takes or touches one of them. */
  readonly connectorTargets: string[];
  /** Chain a pack over account data assumes on every call, as the user (D10, D37). */
  readonly brokerRoleArn: string;
  readonly targetRoleArn: string;
  /** Actions the role behind the broker allows: the ceiling of a `central_only` manifest. */
  readonly brokeredActions: string[];
  /**
   * Chain of a pack over member accounts (D51): the Read broker, the name of the role behind
   * it in every member account and the actions that role allows (its manifest's ceiling).
   */
  readonly memberBrokerRoleArn: string;
  readonly memberRoleName: string;
  readonly memberActions: string[];
  /** Key the interceptor signs pack callers with; the provisioner only reads its public key. */
  readonly packIdentityKey: kms.IKey;
  /** Where pack runtimes run (R6). Absent when the release ships no pack. */
  readonly network?: PackNetworkRef;
}

/**
 * Pack provisioner (spec §4.4, D19, D25, D36): a second Step Functions state machine whose
 * tasks are one Lambda that enables or disables a signed MCP pack by SDK. No CDK,
 * CloudFormation or CodeBuild at runtime, and nothing is downloaded: the zip is the one
 * CloudFormation copied to the packs bucket.
 *
 * It has its own role, apart from the agent provisioner: it creates IAM roles (only under
 * `Mango-<ns>-mcp-*`, only with the pack permissions boundary, passed only to AgentCore),
 * manages runtimes named `Mango_<ns>_mcp_*`, and writes targets and Cedar policies of the
 * installation's Gateway. It cannot touch agent harnesses or agent roles.
 */
export class PackProvisioner extends Construct {
  readonly function: lambda.Function;
  readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: PackProvisionerProps) {
    super(scope, id);
    const cfg = props.installation;
    const ns = cfg.namespace;
    const stack = Stack.of(this);
    const packs = props.packs;
    const agentcore = `arn:aws:bedrock-agentcore:${stack.region}:${stack.account}`;
    const workloadIdentities = `${agentcore}:workload-identity-directory/default`;
    const policyEngineArn = props.policyEngine.attrPolicyEngineArn;
    const packPoliciesSuffix = `/policy/${packNames.policyPrefix(ns)}*`;

    const role = new iam.Role(this, "Role", {
      roleName: roleNames.packProvisioner(ns),
      description: "Pack provisioner: creates pack roles (with boundary), runtimes, Gateway targets and policies by SDK",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });

    // --- IAM: pack roles only, always with the boundary ----------------------------------
    const withBoundary = { StringEquals: { "iam:PermissionsBoundary": packs.boundary.managedPolicyArn } };
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "CreatePackRoleWithBoundary",
        actions: ["iam:CreateRole"],
        resources: [packs.roleArns],
        conditions: withBoundary,
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "PackRolePolicyWithBoundary",
        // Every write on an existing role: IAM refuses a role under the prefix that does not
        // carry the boundary, so the provisioner cannot delete or change one it did not make.
        actions: ["iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:DeleteRole"],
        resources: [packs.roleArns],
        conditions: withBoundary,
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "PackRoleLifecycle",
        // `iam:PermissionsBoundary` is not a condition key of TagRole. It is one of GetRole,
        // which stays without it: the function reads a role to learn whether it exists and
        // to report one that lost its boundary (`role_without_boundary`); with the condition
        // IAM would answer AccessDenied to both. No Attach/Detach policy, no boundary changes
        // and no trust policy updates.
        actions: ["iam:GetRole", "iam:TagRole"],
        resources: [packs.roleArns],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "PassPackRoleToAgentCore",
        actions: ["iam:PassRole"],
        resources: [packs.roleArns],
        conditions: { StringEquals: { "iam:PassedToService": AGENTCORE_SERVICE } },
      }),
    );

    // --- AgentCore: runtimes of this installation's packs --------------------------------
    // R6: IAM itself keeps pack runtimes on the pack network. A runtime can only be created or
    // given a new version with subnets and security groups of {@link PackNetwork}; a request
    // without them (network mode `PUBLIC`) or with any other is denied, whatever the
    // provisioner's code does. Without packs in the release there is no network and no
    // permission to create or update a runtime at all.
    const onPackNetwork = props.network && {
      "ForAllValues:StringEquals": {
        "bedrock-agentcore:subnets": props.network.subnetIds,
        "bedrock-agentcore:securityGroups": Object.values(props.network.securityGroupIds),
      },
      Null: { "bedrock-agentcore:subnets": "false", "bedrock-agentcore:securityGroups": "false" },
    };
    if (onPackNetwork) {
      role.addToPolicy(
        new iam.PolicyStatement({
          sid: "CreatePackRuntime",
          // AgentCore authorizes creation on `runtime/*` (the id does not exist yet). The tags
          // are mandatory instead, and the only roles it can pass are pack roles.
          actions: ["bedrock-agentcore:CreateAgentRuntime"],
          resources: [`${agentcore}:runtime/*`],
          conditions: { ...packRequestTags(ns), ...onPackNetwork },
        }),
      );
      role.addToPolicy(
        new iam.PolicyStatement({
          sid: "UpdatePackRuntime",
          actions: ["bedrock-agentcore:UpdateAgentRuntime"],
          resources: [packs.runtimeArns],
          conditions: onPackNetwork,
        }),
      );
    }
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "TagNewPackRuntime",
        // Creating a runtime also creates its `DEFAULT` endpoint and tags both, with the
        // caller's permissions. These actions carry no network to check.
        actions: ["bedrock-agentcore:CreateAgentRuntimeEndpoint", "bedrock-agentcore:TagResource"],
        resources: [`${agentcore}:runtime/*`],
        conditions: packRequestTags(ns),
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ManagePackRuntime",
        actions: [
          "bedrock-agentcore:GetAgentRuntime",
          "bedrock-agentcore:DeleteAgentRuntime",
          "bedrock-agentcore:GetAgentRuntimeEndpoint",
          "bedrock-agentcore:CreateAgentRuntimeEndpoint",
          "bedrock-agentcore:UpdateAgentRuntimeEndpoint",
          "bedrock-agentcore:DeleteAgentRuntimeEndpoint",
          "bedrock-agentcore:TagResource",
        ],
        resources: [packs.runtimeArns, `${packs.runtimeArns}/runtime-endpoint/*`],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "AgentCoreNetworkServiceRole",
        // Pack runtimes run in VPC mode (R6). AgentCore attaches them to the pack subnets with
        // this service-linked role, and whoever creates the first such runtime of the account
        // creates the role (verified in the lab). This role and no other; no EC2 permission.
        actions: ["iam:CreateServiceLinkedRole"],
        resources: [
          `arn:aws:iam::${stack.account}:role/aws-service-role/network.bedrock-agentcore.amazonaws.com/` +
            "AWSServiceRoleForBedrockAgentCoreNetwork",
        ],
        conditions: { StringEquals: { "iam:AWSServiceName": "network.bedrock-agentcore.amazonaws.com" } },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "AgentCoreRuntimeIdentityServiceRole",
        // Whoever creates the first runtime of the account, of a pack or of an agent harness,
        // creates this service-linked role too (AWS documentation). A pack installed before any
        // agent was published must not depend on the agent provisioner. This role and no other.
        actions: ["iam:CreateServiceLinkedRole"],
        resources: [
          `arn:aws:iam::${stack.account}:role/aws-service-role/runtime-identity.bedrock-agentcore.amazonaws.com/` +
            "AWSServiceRoleForBedrockAgentCoreRuntimeIdentity",
        ],
        conditions: {
          StringEquals: { "iam:AWSServiceName": "runtime-identity.bedrock-agentcore.amazonaws.com" },
        },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ListPackTools",
        // Only to compare `tools/list` with the signed `tools_hash` before a runtime version
        // is exposed. Besides this role, only the Gateway role can invoke a pack runtime.
        actions: ["bedrock-agentcore:InvokeAgentRuntime"],
        resources: [packs.runtimeArns, `${packs.runtimeArns}/runtime-endpoint/*`],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "FindPackRuntime",
        // List operation without resource scope; names are filtered by the provisioner.
        actions: ["bedrock-agentcore:ListAgentRuntimes"],
        resources: ["*"],
      }),
    );
    // AgentCore creates and deletes the workload identity of a runtime with the caller's
    // permissions (same finding as with harnesses, D40).
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "CreatePackWorkloadIdentity",
        actions: ["bedrock-agentcore:CreateWorkloadIdentity", "bedrock-agentcore:TagResource"],
        resources: [workloadIdentities, `${workloadIdentities}/workload-identity/*`],
        conditions: packRequestTags(ns),
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "DeletePackWorkloadIdentity",
        actions: ["bedrock-agentcore:DeleteWorkloadIdentity"],
        resources: [
          workloadIdentities,
          `${workloadIdentities}/workload-identity/${packNames.runtimePrefix(ns)}*`,
        ],
      }),
    );

    // --- Gateway: targets and Cedar policies of this installation ------------------------
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "PackGatewayTargets",
        // Target ids are generated, so IAM cannot pin a pack's target by name: the
        // provisioner only ever touches the target named after the pack (never a connector's).
        actions: [
          "bedrock-agentcore:CreateGatewayTarget",
          "bedrock-agentcore:GetGatewayTarget",
          "bedrock-agentcore:UpdateGatewayTarget",
          "bedrock-agentcore:DeleteGatewayTarget",
          "bedrock-agentcore:ListGatewayTargets",
          "bedrock-agentcore:SynchronizeGatewayTargets",
        ],
        resources: [props.gateway.attrGatewayArn],
      }),
    );
    // Policy operations are authorized on the engine and, once the policy exists, on the policy
    // too (verified in the lab). So this role can create policies, but can only read, change
    // or delete those named after a pack: never the connectors' policies.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "PackPolicies",
        actions: [
          "bedrock-agentcore:CreatePolicy",
          "bedrock-agentcore:GetPolicy",
          "bedrock-agentcore:UpdatePolicy",
          "bedrock-agentcore:DeletePolicy",
          "bedrock-agentcore:ListPolicies",
        ],
        resources: [policyEngineArn],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ManagePackPolicies",
        actions: [
          "bedrock-agentcore:GetPolicy",
          "bedrock-agentcore:UpdatePolicy",
          "bedrock-agentcore:DeletePolicy",
        ],
        resources: [`${policyEngineArn}${packPoliciesSuffix}`],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ScopePackPoliciesToGateway",
        // What CreatePolicy needs besides the engine: policies scoped to this Gateway only
        // (no `ManageAdminPolicy`, so no wildcard-scoped policies), and the engine validating
        // each action against the tools of the Gateway, authorized as `InvokeGateway`. The
        // Gateway's inbound authorization is a Cognito JWT, so this does not let the role call
        // tools.
        actions: [
          "bedrock-agentcore:GetGateway",
          "bedrock-agentcore:InvokeGateway",
          "bedrock-agentcore:ManageResourceScopedPolicy",
        ],
        resources: [props.gateway.attrGatewayArn],
      }),
    );

    // --- Runtime log groups (D16) --------------------------------------------------------
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "GovernPackRuntimeLogGroups",
        actions: [
          "logs:CreateLogGroup",
          "logs:AssociateKmsKey",
          "logs:PutRetentionPolicy",
          "logs:TagResource",
          "logs:DeleteLogGroup",
        ],
        resources: [packs.runtimeLogGroupArns, `${packs.runtimeLogGroupArns}:*`],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "RuntimeLogsKey",
        // CloudWatch Logs checks that the caller can use the key it associates.
        actions: ["kms:DescribeKey"],
        resources: [props.platform.runtimeLogsKey.keyArn],
      }),
    );

    // --- Release artifacts: read only, the copies CloudFormation made (D36) ---------------
    const artifacts = packs.bucket.arnForObjects(`${packNames.artifactPrefix}*`);
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadSignedPacks",
        actions: ["s3:GetObject", "s3:GetObjectVersion"],
        resources: [artifacts],
      }),
    );

    // --- Data: read enablements, write installation state only ---------------------------
    const settings = props.settingsTable.tableArn;
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadPackEnablements",
        actions: ["dynamodb:GetItem"],
        resources: [settings],
        conditions: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [`${PACK_ENABLEMENT_PARTITION}*`, `${PACK_INSTALLED_PARTITION}*`],
          },
        },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "WriteInstallationState",
        actions: ["dynamodb:UpdateItem"],
        resources: [settings],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [`${PACK_ENABLEMENT_PARTITION}*`] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": PACK_PROVISIONER_WRITABLE_ATTRIBUTES },
          // Never get whole items back from a write.
          StringEqualsIfExists: { "dynamodb:ReturnValues": ["NONE", "UPDATED_OLD", "UPDATED_NEW"] },
        },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "WriteInstalledPointer",
        // What is installed. Only this role can write the partition; mango-api is denied.
        actions: ["dynamodb:PutItem", "dynamodb:DeleteItem"],
        resources: [settings],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [`${PACK_INSTALLED_PARTITION}*`] },
        },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "WriteAuditIndex",
        actions: ["dynamodb:PutItem"],
        resources: [props.auditIndex.tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DAY#*"] } },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "WriteAuditTrail",
        actions: ["firehose:PutRecord"],
        resources: [props.auditStream.deliveryStreamArn],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "DataKeyViaDynamoDB",
        actions: ["kms:Decrypt", "kms:DescribeKey", "kms:Encrypt", "kms:GenerateDataKey"],
        resources: [props.dataKey.keyArn],
        // Only through DynamoDB, never direct use of the shared data key.
        conditions: { StringEquals: { "kms:ViaService": `dynamodb.${stack.region}.amazonaws.com` } },
      }),
    );

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadPackIdentityPublicKey",
        // The public half only, to give it to packs over account data. Never `kms:Sign`.
        actions: ["kms:GetPublicKey"],
        resources: [props.packIdentityKey.keyArn],
      }),
    );

    this.function = new PythonFunction(this, "Function", {
      packageName: "mango-provisioner",
      packagePath: "functions/provisioner",
      retainLogs: cfg.retainData,
      handler: "mango_provisioner.packs.handler.lambda_handler",
      functionName: roleNames.packProvisioner(ns),
      description: "Pack provisioner step (invoked only by its state machine)",
      role,
      // A step may hash the pack zip (up to 250 MB) or wait for a runtime's first answer.
      timeout: Duration.seconds(180),
      memorySize: 1024,
      environment: {
        MANGO_NAMESPACE: ns,
        MANGO_ACCOUNT_ID: stack.account,
        SETTINGS_TABLE: props.settingsTable.tableName,
        AUDIT_STREAM: props.auditStream.deliveryStreamName,
        AUDIT_INDEX_TABLE: props.auditIndex.tableName,
        PACK_BOUNDARY_ARN: packs.boundary.managedPolicyArn,
        PACK_ALLOWED_ACTIONS: JSON.stringify(PACK_DATA_ACTIONS),
        PACKS_BUCKET: packs.bucket.bucketName,
        // What may be installed comes from the template only: the public key that verifies
        // signatures (not a secret) and the one signed statement per pack of this release.
        PACK_SIGNING_PUBLIC_KEY: packs.signingPublicKey,
        PACK_CATALOG: JSON.stringify(packs.catalog),
        GATEWAY_ID: props.gateway.attrGatewayIdentifier,
        POLICY_ENGINE_ID: props.policyEngine.attrPolicyEngineId,
        RUNTIME_LOGS_KEY_ARN: props.platform.runtimeLogsKey.keyArn,
        CONNECTOR_TARGETS: JSON.stringify(props.connectorTargets),
        // Packs over account data (D37): where the broker is, what the role behind it
        // allows and the key that signs their callers. Values of the stack, never of a pack.
        PACK_BROKER_ROLE_ARN: props.brokerRoleArn,
        PACK_TARGET_ROLE_ARN: props.targetRoleArn,
        PACK_BROKERED_ACTIONS: JSON.stringify(props.brokeredActions),
        PACK_IDENTITY_KEY_ARN: props.packIdentityKey.keyArn,
        // Packs of the member chain (D51): the Read broker and the role name, never an ARN:
        // the account is the one each call asks for.
        PACK_MEMBER_BROKER_ROLE_ARN: props.memberBrokerRoleArn,
        PACK_MEMBER_ROLE_NAME: props.memberRoleName,
        PACK_MEMBER_ACTIONS: JSON.stringify(props.memberActions),
        // R6: subnets of the pack VPC and the security group of each pack of the release. A
        // runtime is never created anywhere else; a pack without a group is not installed.
        PACK_NETWORK: props.network ? provisionerSetting(stack, props.network) : NO_PACK_NETWORK,
      },
      environmentEncryption: props.configKey,
    }).function;

    acknowledge(
      role,
      {
        id: "AwsSolutions-IAM5[Resource::*]",
        reason: `${REASONS.xray} bedrock-agentcore:ListAgentRuntimes has no resource scope either.`,
      },
      {
        id: `AwsSolutions-IAM5[Resource::${packs.roleArns}]`,
        reason:
          "Pack roles are created at runtime, one per enabled pack (D19): the prefix is the scope. CreateRole and " +
          "PutRolePolicy also require the pack permissions boundary; PassRole only goes to AgentCore.",
      },
      {
        id: `AwsSolutions-IAM5[Resource::${agentcore}:runtime/*]`,
        reason:
          "AgentCore authorizes CreateAgentRuntime on runtime/* because the id is generated. The mango:namespace " +
          "and mango:component request tags are required and only pack roles can be passed.",
      },
      ...[packs.runtimeArns, `${packs.runtimeArns}/runtime-endpoint/*`].map((resource) => ({
        id: `AwsSolutions-IAM5[Resource::${resource}]`,
        reason: "Pack runtimes are created at runtime, one per enabled pack (D36): the name prefix is the scope.",
      })),
      {
        id: `AwsSolutions-IAM5[Resource::${workloadIdentities}/workload-identity/*]`,
        reason: "Workload identity of a new pack runtime (generated name); the pack request tags are required.",
      },
      {
        id: `AwsSolutions-IAM5[Resource::${workloadIdentities}/workload-identity/${packNames.runtimePrefix(ns)}*]`,
        reason: "Workload identities of this installation's pack runtimes: the name prefix is the scope.",
      },
      {
        id: arnWildcardFinding(packs.bucket.node.defaultChild as CfnResource, `/${packNames.artifactPrefix}*`),
        reason: "Read-only access to the signed packs CloudFormation copied under packs/ (D36).",
      },
      {
        id: arnWildcardFinding(props.policyEngine, packPoliciesSuffix, "PolicyEngineArn"),
        reason: "Cedar policies of packs are created at runtime; the name prefix keeps the connectors' policies out of reach.",
      },
      ...[packs.runtimeLogGroupArns, `${packs.runtimeLogGroupArns}:*`].map((resource) => ({
        id: `AwsSolutions-IAM5[Resource::${resource}]`,
        reason: "AgentCore names runtime log groups after the generated runtime id; the prefix pins this installation's packs.",
      })),
    );

    this.stateMachine = this.buildStateMachine(cfg);
  }

  /** Only mango-api starts executions, with `{pack_id, pack_version, enablement_id}`. */
  grantStart(grantee: iam.IGrantable): void {
    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "StartPackProvisioner",
        actions: ["states:StartExecution"],
        resources: [this.stateMachine.stateMachineArn],
      }),
    );
  }

  private buildStateMachine(cfg: Installation): sfn.StateMachine {
    const ns = cfg.namespace;
    const name = mangoName(ns, "PackProvisioner");

    // One task per step. The state is only identifiers, hashes and flags (never a manifest);
    // the execution name comes from the context, not from the state.
    const step = (id: string, stepName: string): tasks.LambdaInvoke =>
      new tasks.LambdaInvoke(this, id, {
        lambdaFunction: this.function,
        payload: sfn.TaskInput.fromObject({
          step: stepName,
          state: sfn.JsonPath.entirePayload,
          execution: sfn.JsonPath.stringAt("$$.Execution.Name"),
        }),
        payloadResponseOnly: true,
        retryOnServiceExceptions: true,
        taskTimeout: sfn.Timeout.duration(Duration.seconds(200)),
      });
    const retryTransient = (task: tasks.LambdaInvoke, interval: number, maxAttempts: number, backoffRate: number) =>
      task.addRetry({
        errors: ["RetryableStepError"],
        interval: Duration.seconds(interval),
        maxAttempts,
        backoffRate,
      });

    const failed = new sfn.Fail(this, "PackFailed", {
      error: "PackProvisioningFailed",
      cause: "The pack was not enabled or disabled; see failed_step and failure on its enablement.",
    });
    const markFailed = step("MarkFailed", "mark_failed");
    retryTransient(markFailed, 5, 4, 2);
    markFailed.addCatch(failed, { errors: ["States.ALL"], resultPath: "$.mark_error" });
    markFailed.next(failed);

    // Deleting policies, a target and a runtime is asynchronous (minutes).
    const compensate = step("Compensate", "compensate");
    retryTransient(compensate, 20, 30, 1);
    compensate.addCatch(markFailed, { errors: ["States.ALL"], resultPath: "$.compensation_error" });
    compensate.next(markFailed);

    const forward = (id: string, stepName: string): tasks.LambdaInvoke => {
      const task = step(id, stepName);
      // A role created seconds ago may not be assumable yet; AgentCore may be busy.
      retryTransient(task, 10, 8, 1.5);
      task.addCatch(compensate, { errors: ["States.ALL"], resultPath: "$.error" });
      return task;
    };

    const isReady = sfn.Condition.booleanEquals("$.ready", true);
    /** `ensure -> wait -> check -> (ready ? next : wait)`. Returns the first state. */
    const waitFor = (id: string, check: tasks.LambdaInvoke, seconds: number, next: sfn.IChainable) => {
      const wait = new sfn.Wait(this, `Wait${id}`, { time: sfn.WaitTime.duration(Duration.seconds(seconds)) });
      wait.next(check).next(new sfn.Choice(this, `${id}Ready?`).when(isReady, next).otherwise(wait));
      return wait;
    };

    const finish = forward("Finish", "finish").next(new sfn.Succeed(this, "Enabled"));
    const policies = forward("EnsurePolicies", "ensure_policies").next(
      waitFor("Policies", forward("CheckPolicies", "check_policies"), 4, finish),
    );
    const target = forward("EnsureTarget", "ensure_target").next(
      waitFor("Target", forward("CheckTarget", "check_target"), 4, policies),
    );
    const governLogs = forward("GovernLogs", "govern_logs").next(target);
    const live = forward("PointLive", "point_live").next(
      waitFor("Live", forward("CheckLive", "check_live"), 3, governLogs),
    );
    // Nothing reaches the new runtime version until it served exactly the signed tools.
    const verifyTools = forward("VerifyTools", "verify_tools").next(live);
    const enable = forward("EnsureRole", "ensure_role")
      .next(forward("EnsureRuntime", "ensure_runtime"))
      .next(waitFor("Runtime", forward("CheckRuntime", "check_runtime"), 5, verifyTools));

    // A removal is never undone: it is retried until every resource is gone.
    const remove = step("Remove", "remove");
    retryTransient(remove, 20, 60, 1);
    remove.addCatch(markFailed, { errors: ["States.ALL"], resultPath: "$.error" });
    remove.next(new sfn.Succeed(this, "Disabled"));

    const definition = forward("Load", "load").next(
      new sfn.Choice(this, "Action?")
        .when(sfn.Condition.stringEquals("$.action", "noop"), new sfn.Succeed(this, "NothingToDo"))
        .when(sfn.Condition.stringEquals("$.action", "disable"), remove)
        .otherwise(enable),
    );

    const logGroup = new logs.LogGroup(this, "StateMachineLogs", {
      logGroupName: `/aws/vendedlogs/states/${name}`,
      retention: logs.RetentionDays.THREE_MONTHS,
      encryptionKey: logsKeyOf(this),
      removalPolicy: cfg.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    const stateMachine = new sfn.StateMachine(this, "StateMachine", {
      stateMachineName: name,
      comment: "Enables or disables a signed MCP pack (Marketplace v1)",
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      stateMachineType: sfn.StateMachineType.STANDARD,
      // Shorter than the provisioner lock (45 minutes): a running execution never loses it.
      timeout: Duration.minutes(40),
      tracingEnabled: true,
      logs: { destination: logGroup, level: sfn.LogLevel.ALL, includeExecutionData: false },
    });
    acknowledge(
      stateMachine,
      {
        id: "AwsSolutions-IAM5[Resource::*]",
        reason: `CloudWatch Logs delivery APIs (vended logs) and X-Ray have no resource scope. ${REASONS.xray}`,
      },
      {
        id: `AwsSolutions-IAM5[Resource::<${Stack.of(this).resolve(Stack.of(this).getLogicalId(this.function.node.defaultChild as lambda.CfnFunction))}.Arn>:*]`,
        reason: REASONS.cdkGrant,
      },
    );
    return stateMachine;
  }
}
