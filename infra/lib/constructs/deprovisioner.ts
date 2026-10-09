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
import { AgentPlatform } from "./agent-platform.js";
import { AGENTS_PUBLISHED_PARTITION } from "./governance.js";
import { PythonFunction } from "./python-function.js";

/**
 * Attributes of the Agents table the deprovisioner may read (IAM `dynamodb:Attributes`): the
 * state of the agent, of the version it served and of its lock. Never `definition`: prompts
 * cannot reach it. Keep in sync with `READ_ATTRIBUTES` in
 * `functions/provisioner/src/mango_provisioner/deprovision/store.py`.
 */
export const DEPROVISIONER_READABLE_ATTRIBUTES = ["PK", "SK", "status", "provision_lock", "n", "harness_arn"];

/**
 * Attributes it may name in a write: only the lock it shares with the agent provisioner
 * (`lock_item` and `unlock_item` of `mango_core.agents_table`). It changes no state.
 */
export const DEPROVISIONER_WRITABLE_ATTRIBUTES = ["PK", "SK", "provision_lock", "provision_lock_until"];

export interface DeprovisionerProps {
  readonly installation: Installation;
  readonly platform: AgentPlatform;
  readonly agentsTable: dynamodb.ITableV2;
  readonly auditIndex: dynamodb.ITableV2;
  readonly auditStream: firehose.IDeliveryStream;
  /** Key of the tables above. */
  readonly dataKey: kms.IKey;
  /** Key for the function's environment variables. */
  readonly configKey: kms.IKey;
  /** Agent id -> content hash of the agents this release ships (D34): never deprovisioned. */
  readonly releaseAgents: Record<string, string>;
}

/**
 * Agent deprovisioner (D48, D25): a Step Functions state machine whose tasks are one Lambda
 * that deletes, by SDK, the harness and the role of an agent that was retired. No CDK,
 * CloudFormation or CodeBuild at runtime.
 *
 * It has its own role, apart from the provisioner's: it can only delete, and only what is
 * named `Mango_<ns>_a_*` (harnesses) or `Mango-<ns>-agent-*` (roles), with an explicit deny on
 * the agents of the release. It cannot create, update, pass or invoke anything, cannot read a
 * harness or an agent definition, and writes nothing in the Agents table but the provisioner
 * lock.
 */
export class Deprovisioner extends Construct {
  readonly function: lambda.Function;
  readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: DeprovisionerProps) {
    super(scope, id);
    const cfg = props.installation;
    const ns = cfg.namespace;
    const stack = Stack.of(this);
    const platform = props.platform;
    const agentcore = `arn:aws:bedrock-agentcore:${stack.region}:${stack.account}`;
    const workloadIdentities = `${agentcore}:workload-identity-directory/default`;

    const role = new iam.Role(this, "Role", {
      roleName: roleNames.deprovisioner(ns),
      description: "Agent deprovisioner: deletes the harness and the role of a retired agent by SDK",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });

    // --- AgentCore: delete harnesses of this installation's agents ------------------------
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "FindAgentHarness",
        // List operation without resource scope; names are filtered by the deprovisioner.
        actions: ["bedrock-agentcore:ListHarnesses"],
        resources: ["*"],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "DeleteAgentHarness",
        // No GetHarness: a harness stores the agent's prompt and nothing here needs it.
        actions: [
          "bedrock-agentcore:ListHarnessEndpoints",
          "bedrock-agentcore:DeleteHarnessEndpoint",
          "bedrock-agentcore:DeleteHarness",
        ],
        resources: [platform.harnessArns, `${platform.harnessArns}/harness-endpoint/*`],
      }),
    );
    // A harness is a managed runtime: AgentCore reads and deletes that runtime, its endpoints
    // and its workload identity with the caller's permissions (the calls CloudTrail showed
    // when a harness was deleted in the lab; nothing else is granted).
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "DeleteHarnessRuntime",
        actions: [
          "bedrock-agentcore:GetAgentRuntime",
          "bedrock-agentcore:GetAgentRuntimeEndpoint",
          "bedrock-agentcore:DeleteAgentRuntime",
          "bedrock-agentcore:DeleteAgentRuntimeEndpoint",
        ],
        resources: [platform.runtimeArns, `${platform.runtimeArns}/runtime-endpoint/*`],
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

    // --- IAM: delete agent roles only ----------------------------------------------------
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadAgentRole",
        actions: ["iam:GetRole", "iam:ListRolePolicies"],
        resources: [platform.agentRoleArns],
      }),
    );
    // Only on roles that carry the agent boundary: the ones the provisioner created. IAM
    // refuses any other role under the prefix, whatever the function does; the function
    // checks the boundary too, to report it (`role_without_boundary`).
    const withBoundary = { StringEquals: { "iam:PermissionsBoundary": platform.boundary.managedPolicyArn } };
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "DeleteAgentRolePolicyWithBoundary",
        actions: ["iam:DeleteRolePolicy"],
        resources: [platform.agentRoleArns],
        conditions: withBoundary,
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "DeleteAgentRoleWithBoundary",
        // No Detach: a role with managed policies was changed outside Mango and is left for
        // a person (D48).
        actions: ["iam:DeleteRole"],
        resources: [platform.agentRoleArns],
        conditions: withBoundary,
      }),
    );

    // --- The agents of the release are out of reach ---------------------------------------
    // The function refuses them too, but IAM cannot tell a retired agent from a published
    // one: for these ids the answer does not depend on the code or on the table. Agent ids
    // have no hyphen, so `<id>-*` only matches the generated suffix of that agent.
    const shipped = Object.keys(props.releaseAgents).sort();
    if (shipped.length > 0) {
      role.addToPolicy(
        new iam.PolicyStatement({
          sid: "NeverTheAgentsOfTheRelease",
          effect: iam.Effect.DENY,
          actions: [
            "bedrock-agentcore:DeleteHarness",
            "bedrock-agentcore:DeleteHarnessEndpoint",
            "bedrock-agentcore:DeleteAgentRuntime",
            "bedrock-agentcore:DeleteAgentRuntimeEndpoint",
            "bedrock-agentcore:DeleteWorkloadIdentity",
            "iam:DeleteRole",
            "iam:DeleteRolePolicy",
          ],
          resources: shipped.flatMap((agentId) => [
            `arn:aws:iam::${stack.account}:role/${agentNames.rolePrefix(ns)}${agentId}`,
            `${agentcore}:harness/${agentNames.harnessPrefix(ns)}${agentId}-*`,
            `${agentcore}:runtime/${agentNames.runtimePrefix(ns)}${agentId}-*`,
            `${workloadIdentities}/workload-identity/${agentNames.runtimePrefix(ns)}${agentId}-*`,
          ]),
        }),
      );
    }

    // --- Data: read the state of the agent, hold its lock, audit --------------------------
    const agents = props.agentsTable.tableArn;
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadAgentStateWithoutContent",
        actions: ["dynamodb:GetItem"],
        resources: [agents],
        conditions: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": ["AGENT#*", `${AGENTS_PUBLISHED_PARTITION}*`],
          },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": DEPROVISIONER_READABLE_ATTRIBUTES },
          // A read must name its attributes: whole items (the definition) are never returned.
          StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "HoldAgentLock",
        actions: ["dynamodb:UpdateItem"],
        resources: [agents],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["AGENT#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": DEPROVISIONER_WRITABLE_ATTRIBUTES },
          StringEqualsIfExists: { "dynamodb:ReturnValues": ["NONE", "UPDATED_OLD", "UPDATED_NEW"] },
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
      handler: "mango_provisioner.deprovision.handler.lambda_handler",
      functionName: roleNames.deprovisioner(ns),
      description: "Agent deprovisioner step (invoked only by its state machine)",
      role,
      timeout: Duration.seconds(60),
      memorySize: 512,
      environment: {
        MANGO_NAMESPACE: ns,
        MANGO_ACCOUNT_ID: stack.account,
        AGENTS_TABLE: props.agentsTable.tableName,
        AUDIT_STREAM: props.auditStream.deliveryStreamName,
        AUDIT_INDEX_TABLE: props.auditIndex.tableName,
        AGENT_BOUNDARY_ARN: platform.boundary.managedPolicyArn,
        RELEASE_AGENTS: JSON.stringify(props.releaseAgents),
      },
      environmentEncryption: props.configKey,
    }).function;

    acknowledge(
      role,
      { id: "AwsSolutions-IAM5[Resource::*]", reason: `${REASONS.xray} bedrock-agentcore:ListHarnesses has no resource scope either.` },
      {
        id: `AwsSolutions-IAM5[Resource::${platform.agentRoleArns}]`,
        reason:
          "Agent roles are created at runtime, one per agent (D10): the prefix is the scope. Delete-only, and " +
          "DeleteRolePolicy and DeleteRole also require the agent permissions boundary.",
      },
      ...[platform.harnessArns, `${platform.harnessArns}/harness-endpoint/*`].map((resource) => ({
        id: `AwsSolutions-IAM5[Resource::${resource}]`,
        reason: "Harnesses are created at runtime, one per agent (D32): the name prefix is the scope. Delete-only.",
      })),
      ...[platform.runtimeArns, `${platform.runtimeArns}/runtime-endpoint/*`].map((resource) => ({
        id: `AwsSolutions-IAM5[Resource::${resource}]`,
        reason: "Managed runtimes of this installation's agent harnesses: the name prefix is the scope.",
      })),
      {
        id: `AwsSolutions-IAM5[Resource::${workloadIdentities}/workload-identity/${agentNames.runtimePrefix(ns)}*]`,
        reason: "Workload identities of this installation's agent harnesses: the name prefix is the scope.",
      },
    );

    this.stateMachine = this.buildStateMachine(cfg);
  }

  /** Only mango-api starts executions, with `{agent_id}`, when an agent is retired. */
  grantStart(grantee: iam.IGrantable): void {
    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "StartAgentDeprovisioner",
        actions: ["states:StartExecution"],
        resources: [this.stateMachine.stateMachineArn],
      }),
    );
  }

  /**
   * mango-api tells administrators whether the removal of a retired agent is running or failed:
   * it lists the executions of this state machine (names and statuses). It cannot describe them
   * (input, output, error), stop them or read their history.
   */
  grantListExecutions(grantee: iam.IGrantable): void {
    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "ListAgentDeprovisions",
        actions: ["states:ListExecutions"],
        resources: [this.stateMachine.stateMachineArn],
      }),
    );
  }

  private buildStateMachine(cfg: Installation): sfn.StateMachine {
    const ns = cfg.namespace;
    const name = mangoName(ns, "AgentDeprovisioner");

    // One task per step. The state is only the agent id and flags; the execution name comes
    // from the context, not from the state.
    const failed = new sfn.Fail(this, "DeprovisionFailed", {
      error: "DeprovisionFailed",
      cause: "The agent's harness or role was not deleted; see the agent.deprovision audit event.",
    });
    const invoke = (id: string, stepName: string): tasks.LambdaInvoke =>
      new tasks.LambdaInvoke(this, id, {
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
    const retryTransient = (task: tasks.LambdaInvoke, interval: number, maxAttempts: number, backoffRate: number) =>
      task.addRetry({
        errors: ["RetryableStepError"],
        interval: Duration.seconds(interval),
        maxAttempts,
        backoffRate,
      });

    // Nothing is undone: a failed removal is audited and the reconciliation reports what is left.
    const markFailed = invoke("MarkFailed", "mark_failed");
    retryTransient(markFailed, 5, 4, 2);
    markFailed.addCatch(failed, { errors: ["States.ALL"], resultPath: "$.mark_error" });
    markFailed.next(failed);

    const step = (id: string, stepName: string): tasks.LambdaInvoke => {
      const task = invoke(id, stepName);
      retryTransient(task, 10, 8, 1.5);
      task.addCatch(markFailed, { errors: ["States.ALL"], resultPath: "$.error" });
      return task;
    };

    // A publication of the same agent may still hold it: it fails on the retired agent and
    // lets go within its own timeout (25 minutes), so this waits up to 30.
    const load = invoke("Load", "load");
    retryTransient(load, 30, 60, 1);
    load.addCatch(markFailed, { errors: ["States.ALL"], resultPath: "$.error" });

    const isReady = sfn.Condition.booleanEquals("$.ready", true);
    /** `step -> (ready ? next : wait -> step)`: deletions in AgentCore take minutes. */
    const until = (id: string, task: tasks.LambdaInvoke, next: sfn.IChainable): tasks.LambdaInvoke => {
      const wait = new sfn.Wait(this, `Wait${id}`, { time: sfn.WaitTime.duration(Duration.seconds(10)) });
      wait.next(task);
      task.next(new sfn.Choice(this, `${id}Gone?`).when(isReady, next).otherwise(wait));
      return task;
    };

    const deleteRole = step("DeleteRole", "delete_role");
    deleteRole.next(step("Finish", "finish")).next(new sfn.Succeed(this, "Deprovisioned"));
    // The role goes last: a harness cannot be deleted while it has endpoints other than
    // DEFAULT, and must be gone before the role it runs with.
    const deleteHarness = until("Harness", step("DeleteHarness", "delete_harness"), deleteRole);
    const deleteEndpoints = until("Endpoints", step("DeleteEndpoints", "delete_endpoints"), deleteHarness);

    const definition = load.next(
      new sfn.Choice(this, "Action?")
        .when(sfn.Condition.stringEquals("$.action", "deprovision"), deleteEndpoints)
        // Already gone, or an agent of the release (which keeps its resources).
        .otherwise(new sfn.Succeed(this, "NothingToDo")),
    );

    const logGroup = new logs.LogGroup(this, "StateMachineLogs", {
      logGroupName: `/aws/vendedlogs/states/${name}`,
      retention: logs.RetentionDays.THREE_MONTHS,
      encryptionKey: logsKeyOf(this),
      removalPolicy: cfg.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    const stateMachine = new sfn.StateMachine(this, "StateMachine", {
      stateMachineName: name,
      comment: "Deletes the harness and the role of a retired agent (D48)",
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      stateMachineType: sfn.StateMachineType.STANDARD,
      // Waiting for a publication (30 minutes) plus two deletions (up to 18 minutes each).
      // Every step extends the provisioner lock, so a running execution never loses it.
      timeout: Duration.minutes(80),
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
