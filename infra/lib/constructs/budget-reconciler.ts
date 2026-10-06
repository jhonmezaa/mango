import { Duration, Stack } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as firehose from "aws-cdk-lib/aws-kinesisfirehose";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import { Installation } from "../config/schema.js";
import { mangoName, roleNames } from "../names.js";
import { acknowledge, REASONS } from "../nag.js";
import { Alerts } from "./alerts.js";
import { PythonFunction } from "./python-function.js";

/** Namespace and dimension of the metrics the function emits (embedded metric format). */
export const BUDGET_RECONCILER_METRICS = { namespace: "Mango/BudgetReconciler", dimension: "Installation" };

/** Log group CloudWatch Transaction Search writes the spans of the account to (D16). */
export const SPANS_LOG_GROUP = "aws/spans";

/**
 * Partition keys of the Budgets table the function may touch: the pending turns and the
 * budget items they name. Keep in sync with `mango_core.budget_turns` (`TURN_PREFIX`) and
 * `mango_api.app._budget_scopes`.
 */
export const BUDGET_RECONCILER_KEYS = { turns: "TURN#*", budgets: ["USER#*", "AGENT#*"] };

export interface BudgetReconcilerProps {
  readonly installation: Installation;
  readonly budgetsTable: dynamodb.ITableV2;
  readonly auditIndex: dynamodb.ITableV2;
  readonly auditStream: firehose.IDeliveryStream;
  /** Key of the tables above. */
  readonly dataKey: kms.IKey;
  /** Key for the function's environment variables. */
  readonly configKey: kms.IKey;
  /** Where alarms notify, and the key of the dead-letter queue. */
  readonly alerts: Alerts;
}

/**
 * Budget reconciliation (D73): every 5 minutes a Lambda closes the budget reservation of the
 * chat turns whose end mango-api never knew. It reads what each turn's runtime session spent
 * from the AgentCore traces, charges it and releases the rest; with no trace 15 minutes after
 * the turn's time limit it charges the whole reservation.
 *
 * It is not the daily `Reconciler`, which is read-only by decision (D41). This one writes the
 * budget counters and nothing else: it reads no conversation, invokes no model, and of the
 * spans of the account it may only filter one log group.
 */
export class BudgetReconciler extends Construct {
  readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: BudgetReconcilerProps) {
    super(scope, id);
    const cfg = props.installation;
    const ns = cfg.namespace;
    const stack = Stack.of(this);
    const table = props.budgetsTable.tableArn;
    const leadingKeys = (...keys: string[]) => ({
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": keys },
    });
    // IAM names a log group with the `:*` suffix for every action but tagging.
    const spans = `arn:${stack.partition}:logs:${stack.region}:${stack.account}:log-group:${SPANS_LOG_GROUP}:*`;

    const role = new iam.Role(this, "Role", {
      roleName: roleNames.budgetReconciler(ns),
      description: "Budget reconciliation: closes the reservation of chat turns from the AgentCore traces",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadAgentTraces",
        // The spans of the whole account live in this one log group: IAM cannot narrow it to
        // Mango's. The function filters by the runtime session of each turn and keeps token
        // counts only. No Logs Insights (`GetQueryResults` has no resource scope).
        actions: ["logs:FilterLogEvents"],
        resources: [spans],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "FindPendingTurns",
        // A query per partition of pending turns. No Scan anywhere.
        actions: ["dynamodb:Query"],
        resources: [table],
        conditions: leadingKeys(BUDGET_RECONCILER_KEYS.turns),
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ClosePendingTurns",
        actions: ["dynamodb:UpdateItem", "dynamodb:DeleteItem"],
        resources: [table],
        conditions: leadingKeys(BUDGET_RECONCILER_KEYS.turns),
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "SettleBudgets",
        // The counters of the scopes a pending turn names, by key, in the same transaction
        // that closes the turn.
        actions: ["dynamodb:UpdateItem"],
        resources: [table],
        conditions: leadingKeys(...BUDGET_RECONCILER_KEYS.budgets),
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "WriteAuditIndex",
        actions: ["dynamodb:PutItem"],
        resources: [props.auditIndex.tableArn],
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
        conditions: { StringEquals: { "kms:ViaService": `dynamodb.${stack.region}.amazonaws.com` } },
      }),
    );

    // EventBridge invokes the function asynchronously: an event that fails every retry lands
    // here instead of disappearing (AGENTS.md). It only holds the scheduled event.
    const deadLetters = new sqs.Queue(this, "DeadLetters", {
      queueName: mangoName(ns, "BudgetReconciler-dlq"),
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
      packageName: "mango-budget-reconciler",
      packagePath: "functions/budget-reconciler",
      retainLogs: cfg.retainData,
      handler: "mango_budget_reconciler.handler.lambda_handler",
      functionName: roleNames.budgetReconciler(ns),
      description: "Closes the budget reservation of chat turns whose end is unknown, from the AgentCore traces",
      role,
      // Shorter than the schedule: a run never overlaps the next one by its own length.
      timeout: Duration.minutes(4),
      memorySize: 512,
      deadLetterQueue: deadLetters,
      environment: {
        MANGO_NAMESPACE: ns,
        BUDGETS_TABLE: props.budgetsTable.tableName,
        AUDIT_STREAM: props.auditStream.deliveryStreamName,
        AUDIT_INDEX_TABLE: props.auditIndex.tableName,
      },
      environmentEncryption: props.configKey,
    }).function;

    acknowledge(
      role,
      { id: "AwsSolutions-IAM5[Resource::*]", reason: REASONS.xray },
      {
        id: `AwsSolutions-IAM5[Resource::${spans}]`,
        reason:
          "Not a wildcard over resources: `:*` is how IAM names one log group for logs:FilterLogEvents. " +
          "Read-only, on the single log group Transaction Search writes the spans to (D73).",
      },
    );

    new events.Rule(this, "Schedule", {
      ruleName: mangoName(ns, "BudgetReconciler-schedule"),
      description: "Runs the Mango budget reconciliation every 5 minutes",
      schedule: events.Schedule.rate(Duration.minutes(5)),
      // The next run is the retry: EventBridge only insists on delivering the event.
      targets: [new targets.LambdaFunction(this.function, { retryAttempts: 2 })],
    });

    this.alarms(props, deadLetters);
  }

  private alarms(props: BudgetReconcilerProps, deadLetters: sqs.IQueue): void {
    const ns = props.installation.namespace;
    const notify = new cloudwatchActions.SnsAction(props.alerts.topic);
    const fiveMinutes = Duration.minutes(5);
    const alarm = (id: string, name: string, description: string, metric: cloudwatch.IMetric) =>
      new cloudwatch.Alarm(this, id, {
        alarmName: mangoName(ns, name),
        alarmDescription: description,
        metric,
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(notify);

    alarm(
      "ReservationChargedAlarm",
      "BudgetReconciler-reservation-charged",
      "A chat turn whose end was unknown was charged its whole reservation: no readable AgentCore trace " +
        "15 minutes after its time limit. It should almost never happen; repeated, the traces are not arriving " +
        "or changed shape, and people are being charged more than they spent. Look first at the " +
        "budget.reconciled events in Audit (their reason), then at the aws/spans log group.",
      new cloudwatch.Metric({
        namespace: BUDGET_RECONCILER_METRICS.namespace,
        metricName: "ChargedByReservation",
        dimensionsMap: { [BUDGET_RECONCILER_METRICS.dimension]: ns },
        statistic: cloudwatch.Stats.SUM,
        period: fiveMinutes,
      }),
    );
    alarm(
      "NotRunAlarm",
      "BudgetReconciler-failed",
      "The budget reconciliation failed after its retries (event in the dead-letter queue): the reservations " +
        "of cut turns stay held and nobody gets them back. Look first at the log group of the " +
        `${roleNames.budgetReconciler(ns)} function.`,
      deadLetters.metricApproximateNumberOfMessagesVisible({
        statistic: cloudwatch.Stats.MAXIMUM,
        period: fiveMinutes,
      }),
    );
  }
}
