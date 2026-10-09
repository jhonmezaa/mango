import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
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
import { agentNames, mangoName, roleNames } from "../names.js";
import { acknowledge, REASONS } from "../nag.js";
import { AgentPlatform, SESSION_IDLE_SECONDS, SESSION_MAX_SECONDS } from "./agent-platform.js";
import { AGENTS_PUBLISHED_PARTITION, MODELS_PARTITION } from "./governance.js";
import { PACK_INSTALLED_PARTITION } from "./pack-provisioner.js";
import { PythonFunction } from "./python-function.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const AGENTCORE_SERVICE = "bedrock-agentcore.amazonaws.com";

/**
 * Attributes of the Agents table the provisioner may name in a write (IAM
 * `dynamodb:Attributes`, which also counts the attributes of the condition expression):
 * publication state, the harness references and its own lock. Never `definition`,
 * `approved_by` or anything else mango-api owns. Keep in sync with
 * `mango_core.agents_table` (`publish_items`, `fail_item`, `lock_item`, `unlock_item`).
 */
export const PROVISIONER_WRITABLE_ATTRIBUTES = [
  "PK",
  "SK",
  "status",
  "status_index",
  "status_at",
  "published_at",
  "failed_step",
  "failure",
  "content_hash",
  "published_version",
  "harness_arn",
  "harness_version",
  "updated_at",
  "version",
  "open_version",
  "provision_lock",
  "provision_lock_until",
];

/** Tags every harness (and the runtime AgentCore derives from it) must be created with. */
const agentRequestTags = (ns: string) => ({
  StringEquals: {
    "aws:RequestTag/mango:namespace": ns,
    "aws:RequestTag/mango:component": "agent",
  },
});

interface ConnectorManifest {
  id: string;
  gateway_target: string;
  tools: { name: string; access: string }[];
}

/** Connector tools of the release (`connectors/<id>/manifest.json`), as the provisioner reads them. */
export function connectorCatalog(): Record<string, { target: string; tools: Record<string, string> }> {
  const root = resolve(REPO_ROOT, "connectors");
  const catalog: Record<string, { target: string; tools: Record<string, string> }> = {};
  for (const dir of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    let manifest: ConnectorManifest;
    try {
      manifest = JSON.parse(readFileSync(resolve(root, dir.name, "manifest.json"), "utf8")) as ConnectorManifest;
    } catch {
      continue; // Not a connector with a manifest.
    }
    catalog[manifest.id] = {
      target: manifest.gateway_target,
      tools: Object.fromEntries(manifest.tools.map((t) => [t.name, t.access])),
    };
  }
  return catalog;
}

export interface ProvisionerProps {
  readonly installation: Installation;
  readonly platform: AgentPlatform;
  readonly agentsTable: dynamodb.ITableV2;
  readonly settingsTable: dynamodb.ITableV2;
  readonly auditIndex: dynamodb.ITableV2;
  readonly auditStream: firehose.IDeliveryStream;
  /** Key of the tables above. */
  readonly dataKey: kms.IKey;
  /** Key for the function's environment variables. */
  readonly configKey: kms.IKey;
  readonly gatewayUrl: string;
  /**
   * Agent id -> content hash of the versions this release ships already approved (D34). The
   * provisioner publishes a release approval only for exactly these (TM-M16).
   */
  readonly releaseAgents: Record<string, string>;
}

/**
 * Agent provisioner (spec §5, D18, D25, D32): a Step Functions state machine whose tasks are
 * one Lambda that publishes an approved agent version by SDK. No CDK, CloudFormation or
 * CodeBuild at runtime.
 *
 * Its role is the most sensitive of the installation (TM-M1): it creates IAM roles. It can
 * only create them under `Mango-<ns>-agent-*` and only with the agent permissions boundary,
 * pass them only to AgentCore, and manage only harnesses named `Mango_<ns>_a_*`. The one
 * role outside that prefix is AgentCore's own runtime identity service-linked role, which it
 * can only create. It cannot invoke a harness (TM-M11) and writes only publication state in
 * the Agents table.
 */
export class Provisioner extends Construct {
  readonly function: lambda.Function;
  readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: ProvisionerProps) {
    super(scope, id);
    const cfg = props.installation;
    const ns = cfg.namespace;
    const stack = Stack.of(this);
    const platform = props.platform;
    const agentcore = `arn:aws:bedrock-agentcore:${stack.region}:${stack.account}`;
    const workloadIdentities = `${agentcore}:workload-identity-directory/default`;

    const role = new iam.Role(this, "Role", {
      roleName: roleNames.provisioner(ns),
      description: "Agent provisioner: creates agent roles (with boundary) and harnesses by SDK",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });

    // --- IAM: agent roles only, always with the boundary ---------------------------------
    const withBoundary = { StringEquals: { "iam:PermissionsBoundary": platform.boundary.managedPolicyArn } };
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "CreateAgentRoleWithBoundary",
        actions: ["iam:CreateRole"],
        resources: [platform.agentRoleArns],
        conditions: withBoundary,
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "AgentRolePolicyWithBoundary",
        // Every write on an existing role: IAM refuses a role under the prefix that does not
        // carry the boundary, so the provisioner cannot delete or change one it did not make.
        actions: ["iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:DeleteRole"],
        resources: [platform.agentRoleArns],
        conditions: withBoundary,
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "AgentRoleLifecycle",
        // `iam:PermissionsBoundary` is not a condition key of TagRole. It is one of GetRole,
        // which stays without it: the function reads a role to learn whether it exists and
        // to report one that lost its boundary (`role_without_boundary`); with the condition
        // IAM would answer AccessDenied to both. No Attach/Detach policy, no boundary changes
        // and no trust policy updates.
        actions: ["iam:GetRole", "iam:TagRole"],
        resources: [platform.agentRoleArns],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "PassAgentRoleToAgentCore",
        actions: ["iam:PassRole"],
        resources: [platform.agentRoleArns],
        conditions: { StringEquals: { "iam:PassedToService": AGENTCORE_SERVICE } },
      }),
    );

    // --- AgentCore: harnesses of this installation's agents ------------------------------
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "CreateAgentHarness",
        // AgentCore authorizes creation on `harness/*` (the id does not exist yet). The tags
        // are mandatory instead, and the only roles it can pass are agent roles.
        actions: ["bedrock-agentcore:CreateHarness", "bedrock-agentcore:TagResource"],
        resources: [`${agentcore}:harness/*`],
        conditions: agentRequestTags(ns),
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ManageAgentHarness",
        actions: [
          "bedrock-agentcore:GetHarness",
          "bedrock-agentcore:UpdateHarness",
          "bedrock-agentcore:DeleteHarness",
          "bedrock-agentcore:GetHarnessEndpoint",
          "bedrock-agentcore:CreateHarnessEndpoint",
          "bedrock-agentcore:UpdateHarnessEndpoint",
          "bedrock-agentcore:DeleteHarnessEndpoint",
          "bedrock-agentcore:TagResource",
        ],
        resources: [platform.harnessArns, `${platform.harnessArns}/harness-endpoint/*`],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "FindAgentHarness",
        // List operation without resource scope; names are filtered by the provisioner.
        actions: ["bedrock-agentcore:ListHarnesses"],
        resources: ["*"],
      }),
    );
    // A harness is a managed runtime: AgentCore creates, updates and deletes that runtime and
    // its workload identity with the caller's permissions (the calls seen in CloudTrail when
    // the provisioner ran in the lab; nothing else is granted).
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "CreateHarnessRuntime",
        actions: [
          "bedrock-agentcore:CreateAgentRuntime",
          "bedrock-agentcore:CreateAgentRuntimeEndpoint",
          "bedrock-agentcore:TagResource",
        ],
        resources: [`${agentcore}:runtime/*`],
        conditions: agentRequestTags(ns),
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ManageHarnessRuntime",
        actions: [
          "bedrock-agentcore:GetAgentRuntime",
          "bedrock-agentcore:UpdateAgentRuntime",
          "bedrock-agentcore:DeleteAgentRuntime",
          "bedrock-agentcore:GetAgentRuntimeEndpoint",
          "bedrock-agentcore:UpdateAgentRuntimeEndpoint",
          "bedrock-agentcore:DeleteAgentRuntimeEndpoint",
        ],
        resources: [platform.runtimeArns, `${platform.runtimeArns}/runtime-endpoint/*`],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "CreateHarnessWorkloadIdentity",
        actions: ["bedrock-agentcore:CreateWorkloadIdentity", "bedrock-agentcore:TagResource"],
        resources: [workloadIdentities, `${workloadIdentities}/workload-identity/*`],
        conditions: agentRequestTags(ns),
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "DeleteHarnessWorkloadIdentity",
        actions: ["bedrock-agentcore:DeleteWorkloadIdentity"],
        resources: [
          workloadIdentities,
          `${workloadIdentities}/workload-identity/${agentNames.runtimePrefix(ns)}*`,
        ],
      }),
    );

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "AgentCoreRuntimeIdentityServiceRole",
        // Whoever creates the first runtime of the account creates this service-linked role,
        // with the caller's permissions: without it the first harness of a new account fails
        // (seen in a first installation; the lab account already had the role). This role and
        // no other: only AgentCore's runtime identity service can assume it.
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

    // --- Runtime log groups (D16) --------------------------------------------------------
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "GovernRuntimeLogGroups",
        actions: [
          "logs:CreateLogGroup",
          "logs:AssociateKmsKey",
          "logs:PutRetentionPolicy",
          "logs:TagResource",
          "logs:DeleteLogGroup",
        ],
        resources: [platform.runtimeLogGroupArns, `${platform.runtimeLogGroupArns}:*`],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "RuntimeLogsKey",
        // CloudWatch Logs checks that the caller can use the key it associates.
        actions: ["kms:DescribeKey"],
        resources: [platform.runtimeLogsKey.keyArn],
      }),
    );

    // --- Data: read versions and the model catalog, write publication state only -------------
    const agents = props.agentsTable.tableArn;
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadAgentVersions",
        actions: ["dynamodb:GetItem"],
        resources: [agents],
        conditions: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": ["AGENT#*", `${AGENTS_PUBLISHED_PARTITION}*`],
          },
        },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "WritePublicationState",
        actions: ["dynamodb:UpdateItem"],
        resources: [agents],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["AGENT#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": PROVISIONER_WRITABLE_ATTRIBUTES },
          // Never get whole items (the definition) back from a write.
          StringEqualsIfExists: { "dynamodb:ReturnValues": ["NONE", "UPDATED_OLD", "UPDATED_NEW"] },
        },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "WritePublishedPointer",
        // What is live. Only this role can write the partition; mango-api is denied.
        actions: ["dynamodb:PutItem"],
        resources: [agents],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [`${AGENTS_PUBLISHED_PARTITION}*`] },
        },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadModelCatalog",
        actions: ["dynamodb:GetItem"],
        resources: [props.settingsTable.tableArn],
        conditions: { "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [MODELS_PARTITION] } },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadInstalledPacks",
        // Which tools an installed MCP pack serves, from the pointer only the pack provisioner
        // writes: an agent may only get tools of packs that are installed (D19).
        actions: ["dynamodb:GetItem"],
        resources: [props.settingsTable.tableArn],
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

    this.function = new PythonFunction(this, "Function", {
      packageName: "mango-provisioner",
      packagePath: "functions/provisioner",
      retainLogs: cfg.retainData,
      handler: "mango_provisioner.handler.lambda_handler",
      functionName: roleNames.provisioner(ns),
      description: "Agent provisioner step (invoked only by its state machine)",
      role,
      timeout: Duration.seconds(60),
      memorySize: 512,
      environment: {
        MANGO_NAMESPACE: ns,
        MANGO_ACCOUNT_ID: stack.account,
        AGENTS_TABLE: props.agentsTable.tableName,
        SETTINGS_TABLE: props.settingsTable.tableName,
        AUDIT_STREAM: props.auditStream.deliveryStreamName,
        AUDIT_INDEX_TABLE: props.auditIndex.tableName,
        AGENT_BOUNDARY_ARN: platform.boundary.managedPolicyArn,
        GATEWAY_URL: props.gatewayUrl,
        GUARDRAIL_ID: platform.guardrail.attrGuardrailId,
        GUARDRAIL_VERSION: platform.guardrailVersion.attrVersion,
        RUNTIME_LOGS_KEY_ARN: platform.runtimeLogsKey.keyArn,
        CONNECTOR_CATALOG: JSON.stringify(connectorCatalog()),
        RELEASE_AGENTS: JSON.stringify(props.releaseAgents),
        // D39: the session lifecycle mango-api assumes when it reuses a runtime session.
        AGENT_SESSION_IDLE_SECONDS: String(SESSION_IDLE_SECONDS),
        AGENT_SESSION_MAX_SECONDS: String(SESSION_MAX_SECONDS),
      },
      environmentEncryption: props.configKey,
    }).function;

    acknowledge(
      role,
      { id: "AwsSolutions-IAM5[Resource::*]", reason: `${REASONS.xray} bedrock-agentcore:ListHarnesses has no resource scope either.` },
      {
        id: `AwsSolutions-IAM5[Resource::${platform.agentRoleArns}]`,
        reason:
          "Agent roles are created at runtime, one per agent (D10): the prefix is the scope. CreateRole and " +
          "PutRolePolicy also require the agent permissions boundary; PassRole only goes to AgentCore.",
      },
      {
        id: `AwsSolutions-IAM5[Resource::${agentcore}:harness/*]`,
        reason:
          "AgentCore authorizes CreateHarness on harness/* because the id is generated. The mango:namespace and " +
          "mango:component request tags are required and only agent roles can be passed (verified in the lab).",
      },
      ...[platform.harnessArns, `${platform.harnessArns}/harness-endpoint/*`].map((resource) => ({
        id: `AwsSolutions-IAM5[Resource::${resource}]`,
        reason: "Harnesses are created at runtime, one per agent (D32): the name prefix is the scope.",
      })),
      {
        id: `AwsSolutions-IAM5[Resource::${agentcore}:runtime/*]`,
        reason:
          "AgentCore creates the managed runtime of a harness with the caller's permissions and authorizes it on " +
          "runtime/*. The request tags of this installation's agents are required.",
      },
      ...[platform.runtimeArns, `${platform.runtimeArns}/runtime-endpoint/*`].map((resource) => ({
        id: `AwsSolutions-IAM5[Resource::${resource}]`,
        reason: "Managed runtimes of this installation's agent harnesses: the name prefix is the scope.",
      })),
      {
        id: `AwsSolutions-IAM5[Resource::${workloadIdentities}/workload-identity/*]`,
        reason: "Workload identity of a new harness runtime (generated name); the agent request tags are required.",
      },
      {
        id: `AwsSolutions-IAM5[Resource::${workloadIdentities}/workload-identity/${agentNames.runtimePrefix(ns)}*]`,
        reason: "Workload identities of this installation's agent harnesses: the name prefix is the scope.",
      },
      ...[platform.runtimeLogGroupArns, `${platform.runtimeLogGroupArns}:*`].map((resource) => ({
        id: `AwsSolutions-IAM5[Resource::${resource}]`,
        reason: "AgentCore names runtime log groups after the generated runtime id; the prefix pins this installation's agents.",
      })),
    );

    this.stateMachine = this.buildStateMachine(cfg);
  }

  /** Only mango-api starts executions, with `{agent_id, version, content_hash}` (TM-M1, TM-M2). */
  grantStart(grantee: iam.IGrantable): void {
    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "StartAgentProvisioner",
        actions: ["states:StartExecution"],
        resources: [this.stateMachine.stateMachineArn],
      }),
    );
  }

  private buildStateMachine(cfg: Installation): sfn.StateMachine {
    const ns = cfg.namespace;
    const name = mangoName(ns, "AgentProvisioner");

    // One task per step. The state is only identifiers, hashes and flags (never a definition);
    // the execution name comes from the context, not from the state.
    const step = (id: string, stepName: string): tasks.LambdaInvoke => {
      const task = new tasks.LambdaInvoke(this, id, {
        lambdaFunction: this.function,
        payload: sfn.TaskInput.fromObject({
          step: stepName,
          state: sfn.JsonPath.entirePayload,
          execution: sfn.JsonPath.stringAt("$$.Execution.Name"),
        }),
        payloadResponseOnly: true,
        retryOnServiceExceptions: true,
        taskTimeout: sfn.Timeout.duration(Duration.seconds(90)),
      });
      return task;
    };
    const retryTransient = (task: tasks.LambdaInvoke, interval: number, maxAttempts: number, backoffRate: number) =>
      task.addRetry({
        errors: ["RetryableStepError"],
        interval: Duration.seconds(interval),
        maxAttempts,
        backoffRate,
      });

    const failed = new sfn.Fail(this, "PublicationFailed", {
      error: "PublicationFailed",
      cause: "The version was not published; see failed_step and failure on the agent version.",
    });
    const markFailed = step("MarkFailed", "mark_failed");
    retryTransient(markFailed, 5, 4, 2);
    markFailed.addCatch(failed, { errors: ["States.ALL"], resultPath: "$.mark_error" });
    markFailed.next(failed);

    // Deleting a harness that was never published is asynchronous (minutes).
    const compensate = step("Compensate", "compensate");
    retryTransient(compensate, 20, 20, 1);
    compensate.addCatch(markFailed, { errors: ["States.ALL"], resultPath: "$.compensation_error" });
    compensate.next(markFailed);

    const forward = (id: string, stepName: string): tasks.LambdaInvoke => {
      const task = step(id, stepName);
      // A role created seconds ago may not be assumable yet; AgentCore may be busy.
      retryTransient(task, 10, 8, 1.5);
      task.addCatch(compensate, { errors: ["States.ALL"], resultPath: "$.error" });
      return task;
    };

    const load = forward("Load", "load");
    const ensureRole = forward("EnsureRole", "ensure_role");
    const ensureHarness = forward("EnsureHarness", "ensure_harness");
    const checkHarness = forward("CheckHarness", "check_harness");
    const pointLive = forward("PointLive", "point_live");
    const checkLive = forward("CheckLive", "check_live");
    const governLogs = forward("GovernLogs", "govern_logs");
    const publish = forward("Publish", "publish");

    const waitHarness = new sfn.Wait(this, "WaitHarness", { time: sfn.WaitTime.duration(Duration.seconds(5)) });
    const waitLive = new sfn.Wait(this, "WaitLive", { time: sfn.WaitTime.duration(Duration.seconds(3)) });
    const isReady = sfn.Condition.booleanEquals("$.ready", true);

    const definition = load.next(
      new sfn.Choice(this, "AlreadyPublished?")
        .when(sfn.Condition.stringEquals("$.action", "noop"), new sfn.Succeed(this, "NothingToDo"))
        .otherwise(
          ensureRole
            .next(ensureHarness)
            .next(waitHarness)
            .next(checkHarness)
            .next(
              new sfn.Choice(this, "HarnessReady?")
                .when(
                  isReady,
                  pointLive
                    .next(waitLive)
                    .next(checkLive)
                    .next(
                      new sfn.Choice(this, "LiveReady?")
                        .when(isReady, governLogs.next(publish).next(new sfn.Succeed(this, "Published")))
                        .otherwise(waitLive),
                    ),
                )
                .otherwise(waitHarness),
            ),
        ),
    );

    const logGroup = new logs.LogGroup(this, "StateMachineLogs", {
      logGroupName: `/aws/vendedlogs/states/${name}`,
      retention: logs.RetentionDays.THREE_MONTHS,
      encryptionKey: logsKeyOf(this),
      removalPolicy: cfg.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    const stateMachine = new sfn.StateMachine(this, "StateMachine", {
      stateMachineName: name,
      comment: "Publishes an approved agent version (Marketplace v1)",
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      stateMachineType: sfn.StateMachineType.STANDARD,
      // Shorter than the provisioner lock (30 minutes): a running execution never loses it.
      timeout: Duration.minutes(25),
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
