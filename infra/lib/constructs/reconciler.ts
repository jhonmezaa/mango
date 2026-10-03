import { Duration, Stack } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import { Construct } from "constructs";
import { Installation } from "../config/schema.js";
import { mangoName, packNames, roleNames } from "../names.js";
import { acknowledge, REASONS } from "../nag.js";
import { AgentPlatform } from "./agent-platform.js";
import { Alerts } from "./alerts.js";
import { PythonFunction } from "./python-function.js";

/**
 * Attributes of the Agents table the reconciler may read (IAM `dynamodb:Attributes`): keys,
 * states, hashes and harness references. Never `definition`: prompts cannot reach it. Keep in
 * sync with `SCAN_ATTRIBUTES` in `functions/reconciler/src/mango_reconciler/snapshot.py`.
 */
export const RECONCILER_READABLE_ATTRIBUTES = [
  "PK",
  "SK",
  "status",
  "status_at",
  "content_hash",
  "created_by",
  "published_version",
  "open_version",
  "harness_arn",
  "harness_version",
  "provision_lock_until",
  "n",
  "submissions",
];

/** Namespace and dimension of the metrics the function emits (embedded metric format). */
export const RECONCILER_METRICS = { namespace: "Mango/Reconciler", dimension: "Installation" };

/** Provisioner executions started in one hour above which TM-M9 (quota abuse) alarms. */
export const PROVISIONER_EXECUTIONS_PER_HOUR = 30;

export interface ReconcilerProps {
  readonly installation: Installation;
  readonly platform: AgentPlatform;
  readonly agentsTable: dynamodb.ITableV2;
  /** Key of the table above. */
  readonly dataKey: kms.IKey;
  /** Key for the function's environment variables. */
  readonly configKey: kms.IKey;
  /** The agent provisioner, whose executions are watched here. */
  readonly provisioner: sfn.IStateMachine;
  /** The agent deprovisioner (D48): a removal that fails alarms at once. */
  readonly deprovisioner: sfn.IStateMachine;
  /** Where alarms notify, and the key of the dead-letter queue. */
  readonly alerts: Alerts;
  /**
   * Agent id -> content hash of the versions this release ships already approved (D34): a
   * release agent serving other content, or a release approval of anything else, is reported
   * (D42, TM-M16).
   */
  readonly releaseAgents: Record<string, string>;
}

/**
 * Daily reconciliation (spec §5, TM-M6, TM-M9): a read-only Lambda compares the Agents table
 * with the harnesses and agent roles that exist, and reports what has no definition or was
 * changed outside Mango. It also reports the runtimes of MCP packs that are not in the pack
 * network (R6, TM-E7 of the pack egress threat model). It repairs nothing.
 *
 * Also holds the alarms of the publication path: reconciliation findings, a reconciliation
 * that could not run, failed provisioner executions, an unusual number of them, and failed
 * removals of a retired agent's resources (D48).
 */
export class Reconciler extends Construct {
  readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: ReconcilerProps) {
    super(scope, id);
    const cfg = props.installation;
    const ns = cfg.namespace;
    const stack = Stack.of(this);
    const platform = props.platform;

    const role = new iam.Role(this, "Role", {
      roleName: roleNames.reconciler(ns),
      description: "Daily reconciliation: reads agent harnesses, agent roles, pack runtimes and the Agents table",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ListHarnessesAndRoles",
        // Listing has no resource scope; the function keeps only this installation's prefixes.
        // Listing is how a resource nobody defined is found at all.
        actions: ["bedrock-agentcore:ListHarnesses", "bedrock-agentcore:ListAgentRuntimes", "iam:ListRoles"],
        resources: ["*"],
      }),
    );
    // `runtime/Mango_<ns>_mcp_*`: the runtimes of MCP packs (D36). Harness runtimes are named
    // `harness_Mango_<ns>_a_*`, so neither pattern covers the other.
    const packRuntimeArns = `arn:aws:bedrock-agentcore:${stack.region}:${stack.account}:runtime/${packNames.runtimePrefix(ns)}*`;
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadPackRuntimeNetwork",
        // Which network a pack runtime runs in, and which version its `live` endpoint serves
        // (TM-E7). Reading only: the function cannot invoke, change or delete a runtime.
        actions: ["bedrock-agentcore:GetAgentRuntime", "bedrock-agentcore:GetAgentRuntimeEndpoint"],
        resources: [packRuntimeArns, `${packRuntimeArns}/runtime-endpoint/*`],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadAgentHarnesses",
        actions: ["bedrock-agentcore:GetHarness", "bedrock-agentcore:GetHarnessEndpoint"],
        resources: [platform.harnessArns, `${platform.harnessArns}/harness-endpoint/*`],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadHarnessRuntimes",
        // A harness is a managed runtime: AgentCore reads it with the caller's permissions.
        actions: ["bedrock-agentcore:GetAgentRuntime", "bedrock-agentcore:GetAgentRuntimeEndpoint"],
        resources: [platform.runtimeArns, `${platform.runtimeArns}/runtime-endpoint/*`],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadAgentRoles",
        actions: ["iam:GetRole", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies"],
        resources: [platform.agentRoleArns],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadAgentRecordsWithoutContent",
        actions: ["dynamodb:Scan"],
        resources: [props.agentsTable.tableArn],
        conditions: {
          "ForAllValues:StringEquals": { "dynamodb:Attributes": RECONCILER_READABLE_ATTRIBUTES },
          // Without this a Scan could ask for whole items (the definition).
          StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "DataKeyViaDynamoDB",
        actions: ["kms:Decrypt", "kms:DescribeKey"],
        resources: [props.dataKey.keyArn],
        conditions: { StringEquals: { "kms:ViaService": `dynamodb.${stack.region}.amazonaws.com` } },
      }),
    );

    // EventBridge invokes the function asynchronously: an event that fails every retry lands
    // here instead of disappearing (AGENTS.md). It only holds the scheduled event.
    const deadLetters = new sqs.Queue(this, "DeadLetters", {
      queueName: mangoName(ns, "Reconciler-dlq"),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: props.alerts.key,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "DeadLetterQueueKey",
        // Lambda sends the failed event to the encrypted queue with the function's role.
        actions: ["kms:Decrypt", "kms:GenerateDataKey"],
        resources: [props.alerts.key.keyArn],
        conditions: { StringEquals: { "kms:ViaService": `sqs.${stack.region}.amazonaws.com` } },
      }),
    );

    this.function = new PythonFunction(this, "Function", {
      packageName: "mango-reconciler",
      packagePath: "functions/reconciler",
      retainLogs: cfg.retainData,
      handler: "mango_reconciler.handler.lambda_handler",
      functionName: roleNames.reconciler(ns),
      description: "Daily read-only reconciliation of agent harnesses, agent roles and pack runtimes",
      role,
      timeout: Duration.minutes(10),
      memorySize: 512,
      deadLetterQueue: deadLetters,
      environment: {
        MANGO_NAMESPACE: ns,
        MANGO_ACCOUNT_ID: stack.account,
        AGENTS_TABLE: props.agentsTable.tableName,
        AGENT_BOUNDARY_ARN: platform.boundary.managedPolicyArn,
        RELEASE_AGENTS: JSON.stringify(props.releaseAgents),
      },
      environmentEncryption: props.configKey,
    }).function;

    acknowledge(
      role,
      {
        id: "AwsSolutions-IAM5[Resource::*]",
        reason: `${REASONS.xray} bedrock-agentcore:ListHarnesses, bedrock-agentcore:ListAgentRuntimes and iam:ListRoles have no resource scope either.`,
      },
      ...[
        platform.harnessArns,
        `${platform.harnessArns}/harness-endpoint/*`,
        platform.runtimeArns,
        `${platform.runtimeArns}/runtime-endpoint/*`,
        platform.agentRoleArns,
      ].map((resource) => ({
        id: `AwsSolutions-IAM5[Resource::${resource}]`,
        reason:
          "Read-only. Agent harnesses and roles are created at runtime, one per agent (D10, D32): the name " +
          "prefix of this installation is the scope.",
      })),
      ...[packRuntimeArns, `${packRuntimeArns}/runtime-endpoint/*`].map((resource) => ({
        id: `AwsSolutions-IAM5[Resource::${resource}]`,
        reason:
          "Read-only. Pack runtimes are created at runtime, one per enabled pack (D36): the name prefix of " +
          "this installation is the scope.",
      })),
    );

    new events.Rule(this, "Daily", {
      ruleName: mangoName(ns, "Reconciler-daily"),
      description: "Runs the Mango agent reconciliation once a day",
      schedule: events.Schedule.cron({ minute: "0", hour: "7" }),
      targets: [new targets.LambdaFunction(this.function, { retryAttempts: 2 })],
    });

    this.alarms(props, deadLetters);
  }

  private alarms(props: ReconcilerProps, deadLetters: sqs.IQueue): void {
    const ns = props.installation.namespace;
    const notify = new cloudwatchActions.SnsAction(props.alerts.topic);
    const alarm = (id: string, name: string, description: string, options: Omit<cloudwatch.AlarmProps, "alarmName" | "alarmDescription">) => {
      const created = new cloudwatch.Alarm(this, id, {
        alarmName: mangoName(ns, name),
        alarmDescription: description,
        ...options,
      });
      created.addAlarmAction(notify);
      return created;
    };

    // TM-M6 / TM-M9. The function reports once a day; with missing data ignored the alarm
    // keeps its state until the next run reports again (zero findings clears it).
    alarm(
      "FindingsAlarm",
      "Reconciler-findings",
      "The daily reconciliation found agent resources without a definition, changed outside Mango, a " +
        "publication that never finished, a creator over quota or a pack runtime outside the pack network. " +
        "See the reconciler.finding log lines.",
      {
        metric: new cloudwatch.Metric({
          namespace: RECONCILER_METRICS.namespace,
          metricName: "Findings",
          dimensionsMap: { [RECONCILER_METRICS.dimension]: ns },
          statistic: cloudwatch.Stats.MAXIMUM,
          period: Duration.minutes(5),
        }),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.IGNORE,
      },
    );
    alarm(
      "NotRunAlarm",
      "Reconciler-failed",
      "The daily reconciliation failed after its retries (event in the dead-letter queue): nothing was compared.",
      {
        metric: deadLetters.metricApproximateNumberOfMessagesVisible({
          statistic: cloudwatch.Stats.MAXIMUM,
          period: Duration.minutes(5),
        }),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    );

    const executionsOf = (machine: sfn.IStateMachine) => (metricName: string, period: Duration) =>
      new cloudwatch.Metric({
        namespace: "AWS/States",
        metricName,
        dimensionsMap: { StateMachineArn: machine.stateMachineArn },
        statistic: cloudwatch.Stats.SUM,
        period,
      });
    const executions = executionsOf(props.provisioner);
    const fiveMinutes = Duration.minutes(5);
    const unsuccessful = (machine: sfn.IStateMachine, label: string) => {
      const of = executionsOf(machine);
      return {
        metric: new cloudwatch.MathExpression({
          expression: "failed + timedOut + aborted",
          usingMetrics: {
            failed: of("ExecutionsFailed", fiveMinutes),
            timedOut: of("ExecutionsTimedOut", fiveMinutes),
            aborted: of("ExecutionsAborted", fiveMinutes),
          },
          label,
          period: fiveMinutes,
        }),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      };
    };
    alarm(
      "ProvisionerFailedAlarm",
      "AgentProvisioner-failed",
      "An agent provisioner execution failed, timed out or was aborted. A timed-out execution does not " +
        "compensate: the version stays approved until someone acts.",
      unsuccessful(props.provisioner, "Unsuccessful provisioner executions"),
    );
    alarm(
      "DeprovisionerFailedAlarm",
      "AgentDeprovisioner-failed",
      "Deleting the harness or the role of a retired agent failed, timed out or was aborted (D48). The agent " +
        "stays retired; what is left is reported by the daily reconciliation until an execution removes it.",
      unsuccessful(props.deprovisioner, "Unsuccessful deprovisioner executions"),
    );
    alarm(
      "ProvisionerVolumeAlarm",
      "AgentProvisioner-volume",
      "Unusually many agent publications in one hour (TM-M9: cost and AgentCore quotas).",
      {
        metric: executions("ExecutionsStarted", Duration.hours(1)),
        threshold: PROVISIONER_EXECUTIONS_PER_HOUR,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    );
  }
}
