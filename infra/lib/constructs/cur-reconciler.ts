import { CfnResource, Duration, Stack } from "aws-cdk-lib";
import * as athena from "aws-cdk-lib/aws-athena";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as glue from "aws-cdk-lib/aws-glue";
import * as iam from "aws-cdk-lib/aws-iam";
import * as firehose from "aws-cdk-lib/aws-kinesisfirehose";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import { loadReleaseDefaults } from "../config/release.js";
import { Installation } from "../config/schema.js";
import { mangoName, roleNames } from "../names.js";
import { acknowledge, arnWildcardFinding, REASONS } from "../nag.js";
import { Alerts } from "./alerts.js";
import { CUR_EXPORT } from "./cur-export.js";
import { PythonFunction } from "./python-function.js";

/** Namespace and dimension of the metrics the function emits (embedded metric format). */
export const CUR_RECONCILER_METRICS = { namespace: "Mango/CurReconciler", dimension: "Installation" };

/**
 * Partition keys of the Budgets table the function may read (D104 (8)): the day counters of the
 * agents and the organization's. Never a person's (`USER#…`, `DAY#USER#…`). Keep in sync with
 * `mango_core.usage_days` (`AGENT_PREFIX`, `ORG_KEY`).
 */
export const CUR_RECONCILER_KEYS = ["DAY#AGENT#*", "DAY#ORG"];

/** Alarms of the function, without the `Mango-<ns>-` prefix: the Operations dashboard shows them. */
export const CUR_RECONCILER_ALARMS = { findings: "Cur-reconciler-findings", failed: "Cur-reconciler-failed" };

/** The most a query of the workgroup may read: 35 days of Bedrock of one account is far less. */
export const CUR_BYTES_SCANNED_CUTOFF = 1024 ** 3;

/** Names of the catalog and of the workgroup (rule 6: the namespace in each). */
export const curNames = {
  database: (ns: string) => `mango_${ns}_cur`,
  table: "bedrock",
  workgroup: (ns: string) => mangoName(ns, "cur"),
  scheduleGroup: (ns: string) => mangoName(ns, "cur"),
};

/**
 * The columns of the export, as the runbook's query selects them (D104 (5)), and their types in
 * the Parquet files of CUR 2.0. To be confirmed against a real export, like the product codes.
 */
export const CUR_COLUMNS: ReadonlyArray<{ name: string; type: string }> = [
  { name: "line_item_usage_start_date", type: "timestamp" },
  { name: "line_item_usage_account_id", type: "string" },
  { name: "line_item_product_code", type: "string" },
  { name: "line_item_usage_type", type: "string" },
  { name: "line_item_line_item_type", type: "string" },
  { name: "line_item_unblended_cost", type: "double" },
  { name: "pricing_public_on_demand_cost", type: "double" },
  { name: "line_item_iam_principal", type: "string" },
  { name: "tags", type: "map<string,string>" },
];

export interface CurReconcilerProps {
  readonly installation: Installation;
  /** The bucket of the export, in Core (`CurExportBucket`). */
  readonly bucket: s3.IBucket;
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
 * Daily reconciliation of Bedrock spend against the bill (D104 (6), (7); threat model
 * `cur-reconciliation-threat-model.md`): a Glue table over the export (declared here, with
 * partition projection: nothing is crawled or discovered, D25), the Athena workgroup
 * `Mango-<ns>-cur` and the function `Mango-<ns>-CurReconciler`, which once a day compares what
 * the bill charged each agent's role with Mango's day counters.
 *
 * It only reads (D41): the bill, two kinds of day counters, and nothing else. It is asynchronous
 * (EventBridge Scheduler), so it has a dead-letter queue and an alarm on it.
 */
export class CurReconciler extends Construct {
  readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: CurReconcilerProps) {
    super(scope, id);
    const cfg = props.installation;
    const ns = cfg.namespace;
    const stack = Stack.of(this);
    const { partition, region, account } = stack;
    const settings = cfg.curReconciliation ?? loadReleaseDefaults().curReconciliation;
    const bucket = props.bucket;
    const dataPrefix = `${CUR_EXPORT.prefix}/${CUR_EXPORT.exportName(ns)}/data`;
    const dataLocation = `s3://${bucket.bucketName}/${dataPrefix}`;
    const resultsLocation = `s3://${bucket.bucketName}/${CUR_EXPORT.resultsPrefix}/`;

    // --- Catalog: one database and one table, declared ------------------------------------
    const databaseName = curNames.database(ns);
    const database = new glue.CfnDatabase(this, "Database", {
      catalogId: account,
      databaseInput: { name: databaseName, description: "Mango: the CUR 2.0 export of Bedrock (D104)" },
    });
    const table = new glue.CfnTable(this, "Table", {
      catalogId: account,
      databaseName,
      tableInput: {
        name: curNames.table,
        description: "Bedrock of the installation's account, from the payer's Data Export CUR 2.0 (D104)",
        tableType: "EXTERNAL_TABLE",
        partitionKeys: [{ name: "billing_period", type: "string" }],
        parameters: {
          classification: "parquet",
          EXTERNAL: "TRUE",
          // Partition projection by billing period: no crawler, no partition to add (D104 (6)).
          "projection.enabled": "true",
          "projection.billing_period.type": "date",
          "projection.billing_period.format": "yyyy-MM",
          // CUR 2.0 has the caller's identity from April 2026 on.
          "projection.billing_period.range": "2026-04,NOW",
          "projection.billing_period.interval": "1",
          "projection.billing_period.interval.unit": "MONTHS",
          "storage.location.template": `${dataLocation}/BILLING_PERIOD=\${billing_period}`,
        },
        storageDescriptor: {
          location: `${dataLocation}/`,
          inputFormat: "org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat",
          outputFormat: "org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat",
          serdeInfo: { serializationLibrary: "org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe" },
          columns: CUR_COLUMNS.map((c) => ({ name: c.name, type: c.type })),
        },
      },
    });
    table.addDependency(database);

    // --- Workgroup: its configuration is enforced -----------------------------------------
    const workgroupName = curNames.workgroup(ns);
    new athena.CfnWorkGroup(this, "WorkGroup", {
      name: workgroupName,
      description: "Mango: the daily reconciliation of Bedrock against the bill (D104)",
      state: "ENABLED",
      // The query history goes with the stack; the results expire in the bucket anyway.
      recursiveDeleteOption: true,
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        bytesScannedCutoffPerQuery: CUR_BYTES_SCANNED_CUTOFF,
        publishCloudWatchMetricsEnabled: true,
        requesterPaysEnabled: false,
        resultConfiguration: {
          outputLocation: resultsLocation,
          expectedBucketOwner: account,
          encryptionConfiguration: { encryptionOption: "SSE_S3" },
        },
      },
    });

    // --- The function's role: read only --------------------------------------------------
    const role = new iam.Role(this, "Role", {
      roleName: roleNames.curReconciler(ns),
      description: "Reconciliation against the bill: reads the CUR export through Athena and two day counters",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    const workgroupArn = `arn:${partition}:athena:${region}:${account}:workgroup/${workgroupName}`;
    const glueArn = (resource: string) => `arn:${partition}:glue:${region}:${account}:${resource}`;
    const allow = (sid: string, actions: string[], resources: string[], conditions?: Record<string, unknown>) =>
      role.addToPolicy(new iam.PolicyStatement({ sid, actions, resources, ...(conditions ? { conditions } : {}) }));

    allow(
      "QueriesInItsWorkgroup",
      ["athena:StartQueryExecution", "athena:GetQueryExecution", "athena:GetQueryResults", "athena:StopQueryExecution"],
      [workgroupArn],
    );
    allow(
      "ReadTheCurTable",
      ["glue:GetDatabase", "glue:GetTable", "glue:GetPartition", "glue:GetPartitions"],
      [glueArn("catalog"), glueArn(`database/${databaseName}`), glueArn(`table/${databaseName}/${curNames.table}`)],
    );
    allow("ReadTheExport", ["s3:GetObject"], [bucket.arnForObjects(`${CUR_EXPORT.prefix}/*`)]);
    allow(
      "WriteAndReadQueryResults",
      ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
      [bucket.arnForObjects(`${CUR_EXPORT.resultsPrefix}/*`)],
    );
    allow("ListTheTwoPrefixes", ["s3:ListBucket"], [bucket.bucketArn], {
      StringLike: { "s3:prefix": [`${CUR_EXPORT.prefix}/*`, `${CUR_EXPORT.resultsPrefix}/*`] },
    });
    allow("LocateTheBucket", ["s3:GetBucketLocation", "s3:ListBucketMultipartUploads"], [bucket.bucketArn]);
    allow("ReadTheDayCountersOfAgentsAndOrganization", ["dynamodb:Query"], [props.budgetsTable.tableArn], {
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": CUR_RECONCILER_KEYS },
      // A request without the key would pass `ForAllValues` (finding of 2026-10-19).
      Null: { "dynamodb:LeadingKeys": "false" },
    });
    allow("WriteAuditIndex", ["dynamodb:PutItem"], [props.auditIndex.tableArn]);
    allow("WriteAuditTrail", ["firehose:PutRecord"], [props.auditStream.deliveryStreamArn]);
    allow(
      "DataKeyViaDynamoDB",
      // Reading the counters decrypts; writing the audit index encrypts.
      ["kms:Decrypt", "kms:DescribeKey", "kms:Encrypt", "kms:GenerateDataKey"],
      [props.dataKey.keyArn],
      { StringEquals: { "kms:ViaService": `dynamodb.${region}.amazonaws.com` } },
    );

    // Scheduler invokes the function asynchronously: an invocation that fails every retry
    // lands here instead of disappearing (AGENTS.md). It only holds the scheduled event.
    const deadLetters = new sqs.Queue(this, "DeadLetters", {
      queueName: mangoName(ns, "CurReconciler-dlq"),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: props.alerts.key,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });
    allow(
      "DeadLetterQueueKey",
      // Lambda sends the failed event to the encrypted queue with the function's role.
      ["kms:Decrypt", "kms:GenerateDataKey"],
      [props.alerts.key.keyArn],
      { StringEquals: { "kms:ViaService": `sqs.${region}.amazonaws.com` } },
    );

    this.function = new PythonFunction(this, "Function", {
      packageName: "mango-cur-reconciler",
      packagePath: "functions/cur-reconciler",
      retainLogs: cfg.retainData,
      handler: "mango_cur_reconciler.handler.lambda_handler",
      functionName: roleNames.curReconciler(ns),
      description: "Daily read-only reconciliation of Bedrock spend per agent against the CUR 2.0 bill",
      role,
      // One query and a few hundred small reads.
      timeout: Duration.minutes(10),
      memorySize: 512,
      deadLetterQueue: deadLetters,
      environment: {
        MANGO_NAMESPACE: ns,
        MANGO_ACCOUNT_ID: account,
        BUDGETS_TABLE: props.budgetsTable.tableName,
        AUDIT_STREAM: props.auditStream.deliveryStreamName,
        AUDIT_INDEX_TABLE: props.auditIndex.tableName,
        CUR_DATABASE: databaseName,
        CUR_TABLE: curNames.table,
        CUR_WORKGROUP: workgroupName,
        BEDROCK_PRODUCT_CODES: settings.bedrockProductCodes.join(","),
        THRESHOLD_PERCENT: String(settings.thresholdPercent),
        THRESHOLD_USD: String(settings.thresholdUsd),
      },
      environmentEncryption: props.configKey,
    }).function;

    const bucketResource = bucket.node.defaultChild as CfnResource;
    acknowledge(
      role,
      { id: "AwsSolutions-IAM5[Resource::*]", reason: REASONS.xray },
      {
        id: arnWildcardFinding(bucketResource, `/${CUR_EXPORT.prefix}/*`, "Arn", this),
        reason:
          "Read-only on the export's prefix of this installation's export bucket: Data Exports names its objects " +
          "(billing period, chunk), so no narrower ARN exists (D104 (8)).",
      },
      {
        id: arnWildcardFinding(bucketResource, `/${CUR_EXPORT.resultsPrefix}/*`, "Arn", this),
        reason:
          "Athena's query results of the function's workgroup, in their own prefix that expires in 7 days: Athena " +
          "names each result object after its query id (D104 (6)).",
      },
    );

    this.schedule(ns);
    this.alarms(props, deadLetters);
  }

  private schedule(ns: string): void {
    const { partition, region, account } = Stack.of(this);
    const groupName = curNames.scheduleGroup(ns);
    const group = new scheduler.CfnScheduleGroup(this, "ScheduleGroup", { name: groupName });
    const groupArn = `arn:${partition}:scheduler:${region}:${account}:schedule-group/${groupName}`;
    const role = new iam.Role(this, "SchedulerRole", {
      roleName: mangoName(ns, "CurScheduler"),
      description: "EventBridge Scheduler: starts the daily reconciliation against the bill, nothing else",
      // Scheduler sends the ARN of the group itself, never a schedule's (finding of 2026-10-15).
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com").withConditions({
        StringEquals: { "aws:SourceAccount": account, "aws:SourceArn": groupArn },
      }),
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "InvokeTheReconciler",
        actions: ["lambda:InvokeFunction"],
        resources: [this.function.functionArn],
      }),
    );
    const daily = new scheduler.CfnSchedule(this, "Daily", {
      name: mangoName(ns, "cur-daily"),
      groupName,
      description: "Runs the reconciliation against the bill once a day",
      // After the agent reconciliation (07:00 UTC) and the account health (06:30).
      scheduleExpression: "cron(30 7 * * ? *)",
      scheduleExpressionTimezone: "UTC",
      flexibleTimeWindow: { mode: "OFF" },
      state: "ENABLED",
      target: {
        arn: this.function.functionArn,
        roleArn: role.roleArn,
        retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 3600 },
      },
    });
    daily.addDependency(group);
    daily.node.addDependency(role);
  }

  private alarms(props: CurReconcilerProps, deadLetters: sqs.IQueue): void {
    const ns = props.installation.namespace;
    const notify = new cloudwatchActions.SnsAction(props.alerts.topic);
    // The function reports once a day; with missing data ignored the alarm keeps its state
    // until the next run reports again (a run without deviations clears it).
    new cloudwatch.Alarm(this, "FindingsAlarm", {
      alarmName: mangoName(ns, CUR_RECONCILER_ALARMS.findings),
      alarmDescription:
        "The daily reconciliation against the bill (CUR 2.0) found a day where what AWS charged an agent's role, " +
        "or all of Bedrock, differs from what Mango counted past the thresholds; or the export brings rows of " +
        "another account or of a product that is not Bedrock (the export lacks its query: nothing was compared). " +
        "See the cur.reconciled events in Audit.",
      metric: new cloudwatch.Metric({
        namespace: CUR_RECONCILER_METRICS.namespace,
        metricName: "Findings",
        dimensionsMap: { [CUR_RECONCILER_METRICS.dimension]: ns },
        statistic: cloudwatch.Stats.MAXIMUM,
        period: Duration.minutes(5),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.IGNORE,
    }).addAlarmAction(notify);
    new cloudwatch.Alarm(this, "FailedAlarm", {
      alarmName: mangoName(ns, CUR_RECONCILER_ALARMS.failed),
      alarmDescription:
        "The daily reconciliation against the bill failed after its retries (event in the dead-letter queue): " +
        `nothing was compared. Look first at the log group of the ${roleNames.curReconciler(ns)} function ` +
        "(Athena, the Glue table or the audit trail).",
      metric: deadLetters.metricApproximateNumberOfMessagesVisible({
        statistic: cloudwatch.Stats.MAXIMUM,
        period: Duration.minutes(5),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(notify);
  }
}
