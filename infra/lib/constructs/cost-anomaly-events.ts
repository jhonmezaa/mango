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
import { costAnomalyNames, mangoName, roleArn, roleNames } from "../names.js";
import { costAnomalyPattern } from "../stacks/payer-stack.js";
import { acknowledge, REASONS } from "../nag.js";
import { Alerts } from "./alerts.js";
import { PythonFunction } from "./python-function.js";

/** Namespace and dimension of the metrics the consumer emits (embedded metric format). */
export const COST_ANOMALY_METRICS = { namespace: "Mango/CostAnomalies", dimension: "Installation" };

export interface CostAnomalyEventsProps {
  readonly installation: Installation;
  readonly auditIndex: dynamodb.ITableV2;
  readonly auditStream: firehose.IDeliveryStream;
  /** Key of the audit index table. */
  readonly dataKey: kms.IKey;
  /** Key for the function's environment variables. */
  readonly configKey: kms.IKey;
  /** Where alarms notify, and the key of the dead-letter queue. */
  readonly alerts: Alerts;
  /** Queue of task runs (D78): the consumer leaves one message per anomaly in it. */
  readonly runQueue: sqs.IQueue;
}

/**
 * Cost anomalies of the organization (D79). The payer account forwards each AWS Cost Anomaly
 * Detection event to the bus `Mango-<ns>-CostAnomalies`; a rule on it invokes the consumer,
 * which validates the event and leaves one message in the queue of task runs (D78). mango-api
 * starts one run of each automation subscribed to cost anomalies, as its owner (D26).
 *
 * The bus only takes events from the forwarding role of the payer account, inside the
 * organization. The consumer reads no billing data and invokes no model: it holds no
 * credential of the payer account. What it may write is the audit trail and that message; the
 * stack grants the second (`TaskPlatform.grantEnqueueEvents`).
 */
export class CostAnomalyEvents extends Construct {
  readonly bus: events.EventBus;
  readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: CostAnomalyEventsProps) {
    super(scope, id);
    const cfg = props.installation;
    const ns = cfg.namespace;
    const stack = Stack.of(this);

    this.bus = new events.EventBus(this, "Bus", {
      eventBusName: costAnomalyNames.bus(ns),
      description: "AWS Cost Anomaly Detection events forwarded by the payer account (D79)",
    });
    // An account principal restricted by condition to the forwarding role, as the trusts of the
    // payer roles do: the policy does not depend on the role existing yet. Written as the
    // resource itself (the L2 helper reads a deprecated property).
    new events.CfnEventBusPolicy(this, "BusPolicy", {
      eventBusName: this.bus.eventBusName,
      statementId: "FromThePayerForwarder",
      statement: new iam.PolicyStatement({
        sid: "FromThePayerForwarder",
        principals: [new iam.AccountPrincipal(cfg.managementAccountId)],
        actions: ["events:PutEvents"],
        resources: [this.bus.eventBusArn],
        conditions: {
          ArnEquals: {
            "aws:PrincipalArn": roleArn(cfg.managementAccountId, roleNames.costAnomalyForwarder(ns)),
          },
          StringEquals: { "aws:PrincipalOrgID": cfg.organizationId },
        },
      }).toStatementJson(),
    });

    const role = new iam.Role(this, "Role", {
      roleName: roleNames.costAnomalyConsumer(ns),
      description: "Cost anomaly consumer: validates the event and starts the runs subscribed to it",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
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

    // EventBridge invokes the function asynchronously: an event that fails every retry (task
    // engine or audit unreachable) lands here instead of disappearing (AGENTS.md).
    const deadLetters = new sqs.Queue(this, "DeadLetters", {
      queueName: mangoName(ns, "CostAnomalyConsumer-dlq"),
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
      packageName: "mango-cost-anomaly-consumer",
      packagePath: "functions/cost-anomaly-consumer",
      retainLogs: cfg.retainData,
      handler: "mango_cost_anomaly_consumer.handler.lambda_handler",
      functionName: roleNames.costAnomalyConsumer(ns),
      description: "Validates AWS Cost Anomaly Detection events and starts the runs of the automations subscribed",
      role,
      timeout: Duration.minutes(1),
      memorySize: 256,
      deadLetterQueue: deadLetters,
      environment: {
        MANGO_NAMESPACE: ns,
        MANAGEMENT_ACCOUNT_ID: cfg.managementAccountId,
        AUDIT_STREAM: props.auditStream.deliveryStreamName,
        AUDIT_INDEX_TABLE: props.auditIndex.tableName,
        TASK_RUNS_QUEUE_URL: props.runQueue.queueUrl,
      },
      environmentEncryption: props.configKey,
    }).function;
    acknowledge(role, { id: "AwsSolutions-IAM5[Resource::*]", reason: REASONS.xray });

    new events.Rule(this, "Rule", {
      ruleName: mangoName(ns, "CostAnomalies-consume"),
      description: "Starts the investigation of each cost anomaly forwarded by the payer account (D79)",
      eventBus: this.bus,
      eventPattern: costAnomalyPattern(cfg.managementAccountId),
      // Each run is started with the anomaly's idempotency key: a retry never starts it twice.
      targets: [
        new targets.LambdaFunction(this.function, { retryAttempts: 2, maxEventAge: Duration.hours(6) }),
      ],
    });

    this.alarms(ns, props.alerts, deadLetters);
  }

  private alarms(ns: string, alerts: Alerts, deadLetters: sqs.IQueue): void {
    const notify = new cloudwatchActions.SnsAction(alerts.topic);
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
      "RejectedAlarm",
      "CostAnomalies-rejected",
      "An event reached the cost anomaly bus and is not an AWS Cost Anomaly Detection event of the payer " +
        "account (TM-CA1). Nothing was started. Look first at the cost_anomaly.rejected events in Audit " +
        "(their reason), then at CloudTrail PutEvents on the bus.",
      new cloudwatch.Metric({
        namespace: COST_ANOMALY_METRICS.namespace,
        metricName: "Rejected",
        dimensionsMap: { [COST_ANOMALY_METRICS.dimension]: ns },
        statistic: cloudwatch.Stats.SUM,
        period: fiveMinutes,
      }),
    );
    alarm(
      "FailedAlarm",
      "CostAnomalyConsumer-failed",
      "A cost anomaly could not be processed after its retries (event in the dead-letter queue): its " +
        "investigations did not start. Look first at the log group of the " +
        `${roleNames.costAnomalyConsumer(ns)} function.`,
      deadLetters.metricApproximateNumberOfMessagesVisible({
        statistic: cloudwatch.Stats.MAXIMUM,
        period: fiveMinutes,
      }),
    );
  }
}
