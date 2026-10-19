import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import { Installation } from "../config/schema.js";
import { mangoName } from "../names.js";
import { acknowledge, REASONS } from "../nag.js";
import { Alerts } from "./alerts.js";
import { PythonFunction } from "./python-function.js";

/** Life of a PDF, as the run it belongs to (D78 (6), D86 (3)). */
export const REPORT_RETENTION = Duration.days(90);
/** Longest life of a download link (D86 (4)): the bucket refuses older signatures. */
export const REPORT_LINK_MS = 5 * 60 * 1000;
/** The attributes of a run the function reads; keep in sync with `mango_task_report.handler`. */
export const REPORT_READS = [
  "PK",
  "SK",
  "run_id",
  "report_status",
  "report_meta",
  "report_data",
  "steps",
  "anomaly_id",
  "anomaly_start",
  "anomaly_end",
];
/** The attributes of a run the function may change: its report's status, nothing else. */
export const REPORT_WRITES = ["PK", "SK", "report_status", "report_reason", "report_pages", "report_bytes"];

export interface TaskReportsProps {
  readonly installation: Installation;
  readonly tasksTable: dynamodb.ITableV2;
  /** Key of the tasks table (the data of each report lives in its run). */
  readonly dataKey: kms.IKey;
  /** Key of the environment of the installation's functions. */
  readonly configKey: kms.IKey;
  readonly accessLogs: s3.IBucket;
  readonly alerts: Alerts;
}

/**
 * Downloadable reports of task runs (D86, D87; threat model `task-reports-threat-model.md`).
 *
 * - Bucket: one PDF per run, under `owner/<sub>/…`, encrypted with a key of its own, TLS only,
 *   deleted after 90 days. Download links live 5 minutes: the bucket refuses older signatures.
 * - Function `Mango-<ns>-TaskReport`: draws the PDF with the engine and fonts of its zip (D25,
 *   D87 (2)). mango-api invokes it asynchronously; what fails every retry goes to its
 *   dead-letter queue and its alarm. Its role reads the tasks table, changes only the
 *   `report_*` attributes of a run and writes only under `owner/`.
 */
export class TaskReports extends Construct {
  readonly bucket: s3.Bucket;
  readonly key: kms.Key;
  readonly function: lambda.Function;
  readonly deadLetters: sqs.Queue;
  /** Environment mango-api needs for reports. */
  readonly apiEnvironment: Record<string, string>;
  private readonly namespace: string;

  constructor(scope: Construct, id: string, props: TaskReportsProps) {
    super(scope, id);
    const cfg = props.installation;
    const ns = (this.namespace = cfg.namespace);
    const { region } = Stack.of(this);
    const removalPolicy = cfg.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    // A key of its own: only the function encrypts with it and only mango-api decrypts (by
    // signing download links). Retained with the bucket: a retained PDF must stay readable.
    this.key = new kms.Key(this, "Key", {
      alias: `alias/${mangoName(ns, "task-reports")}`,
      description: "Encrypts the PDFs of task runs (D86)",
      enableKeyRotation: true,
      removalPolicy,
    });

    this.bucket = new s3.Bucket(this, "Bucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.key,
      bucketKeyEnabled: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      serverAccessLogsBucket: props.accessLogs,
      serverAccessLogsPrefix: "task-reports/",
      // «Generar de nuevo» overwrites the PDF: the old version goes the next day.
      versioned: true,
      lifecycleRules: [
        {
          expiration: REPORT_RETENTION,
          noncurrentVersionExpiration: Duration.days(1),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
        { expiredObjectDeleteMarker: true },
      ],
      removalPolicy,
      autoDeleteObjects: !cfg.retainData,
    });
    // A download link is a bearer for its 5 minutes (TM-R3): a signature older than that is
    // refused, whatever the life of the credentials that made it.
    this.bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "LinksLiveFiveMinutes",
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["s3:GetObject"],
        resources: [this.bucket.arnForObjects("*")],
        conditions: { NumericGreaterThan: { "s3:signatureAge": REPORT_LINK_MS } },
      }),
    );

    const role = new iam.Role(this, "Role", {
      roleName: mangoName(ns, "TaskReport"),
      description: "Task reports: reads one run, draws its PDF, writes it under its owner and marks it",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadRunReport",
        actions: ["dynamodb:GetItem"],
        resources: [props.tasksTable.tableArn],
        // Never the result of a run nor the instruction of a task (TM-R5). `ForAllValues` is
        // true when the request names no attribute (a GetItem without a projection reads the
        // whole item): `Null: false` requires the projection.
        conditions: {
          "ForAllValues:StringEquals": { "dynamodb:Attributes": REPORT_READS },
          Null: { "dynamodb:Attributes": "false" },
          StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "MarkRunReport",
        actions: ["dynamodb:UpdateItem"],
        resources: [props.tasksTable.tableArn],
        conditions: {
          "ForAllValues:StringEquals": { "dynamodb:Attributes": REPORT_WRITES },
          Null: { "dynamodb:Attributes": "false" },
          StringEqualsIfExists: { "dynamodb:ReturnValues": ["NONE", "UPDATED_NEW"] },
        },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "TasksTableKey",
        actions: ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"],
        resources: [props.dataKey.keyArn],
        conditions: { StringEquals: { "kms:ViaService": `dynamodb.${region}.amazonaws.com` } },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "WritePdf",
        actions: ["s3:PutObject"],
        resources: [this.bucket.arnForObjects("owner/*")],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReportsKey",
        actions: ["kms:GenerateDataKey"],
        resources: [this.key.keyArn],
        conditions: { StringEquals: { "kms:ViaService": `s3.${region}.amazonaws.com` } },
      }),
    );

    // mango-api invokes it asynchronously: an invocation that fails every retry (DynamoDB or S3
    // unreachable) lands here instead of disappearing (AGENTS.md).
    this.deadLetters = new sqs.Queue(this, "DeadLetters", {
      queueName: mangoName(ns, "TaskReport-dlq"),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: props.alerts.key,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "DeadLetterQueueKey",
        actions: ["kms:Decrypt", "kms:GenerateDataKey"],
        resources: [props.alerts.key.keyArn],
        conditions: { StringEquals: { "kms:ViaService": `sqs.${region}.amazonaws.com` } },
      }),
    );

    this.function = new PythonFunction(this, "Function", {
      packageName: "mango-task-report",
      packagePath: "functions/task-report",
      // Pillow, a dependency of ReportLab, only publishes manylinux_2_28 wheels for arm64.
      manylinux: "manylinux_2_28",
      retainLogs: cfg.retainData,
      handler: "mango_task_report.handler.lambda_handler",
      functionName: mangoName(ns, "TaskReport"),
      description: "Draws the PDF of a task run from the data its agent handed over (D86)",
      role,
      // A PDF of a few pages takes a second or two; the memory is for the fonts and the drawing.
      timeout: Duration.minutes(2),
      memorySize: 1024,
      deadLetterQueue: this.deadLetters,
      environment: {
        TASKS_TABLE: props.tasksTable.tableName,
        REPORTS_BUCKET: this.bucket.bucketName,
        REPORTS_KEY_ARN: this.key.keyArn,
      },
      environmentEncryption: props.configKey,
    }).function;
    this.function.configureAsyncInvoke({ retryAttempts: 2, maxEventAge: Duration.hours(1) });
    acknowledge(role, { id: "AwsSolutions-IAM5[Resource::*]", reason: REASONS.xray });
    acknowledge(role, {
      id: `AwsSolutions-IAM5[Resource::<${Stack.of(this).getLogicalId(this.bucket.node.defaultChild as s3.CfnBucket)}.Arn>/owner/*]`,
      reason: "One object per run, created at runtime under its owner's prefix (D86 (3)).",
    });

    new cloudwatch.Alarm(this, "FailedAlarm", {
      alarmName: mangoName(ns, "TaskReport-failed"),
      alarmDescription:
        "The PDF of a task run could not be drawn after its retries (invocation in the dead-letter queue " +
        `${mangoName(ns, "TaskReport-dlq")}): its owner sees «No se pudo armar el PDF» after 15 minutes and may ` +
        `generate it again. Look first at the log group of the ${mangoName(ns, "TaskReport")} function.`,
      metric: this.deadLetters.metricApproximateNumberOfMessagesVisible({
        statistic: cloudwatch.Stats.MAXIMUM,
        period: Duration.minutes(5),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(props.alerts.topic));

    this.apiEnvironment = {
      TASK_REPORT_FUNCTION: this.function.functionName,
      TASK_REPORTS_BUCKET: this.bucket.bucketName,
    };
  }

  /**
   * mango-api: invoke the function, and sign download links (GetObject under `owner/`, and the
   * key to decrypt through S3). A managed policy of its own: the role is close to its limit of
   * inline policies.
   */
  grantApi(role: iam.Role): void {
    const { region } = Stack.of(this);
    const policy = new iam.ManagedPolicy(this, "ApiPolicy", {
      managedPolicyName: mangoName(this.namespace, "ApiTaskReports"),
      description: "mango-api: the PDFs of task runs (D86)",
      roles: [role],
    });
    policy.addStatements(
      new iam.PolicyStatement({
        sid: "DrawReport",
        actions: ["lambda:InvokeFunction"],
        resources: [this.function.functionArn],
      }),
      new iam.PolicyStatement({
        sid: "SignReportLinks",
        actions: ["s3:GetObject"],
        resources: [this.bucket.arnForObjects("owner/*")],
      }),
      new iam.PolicyStatement({
        sid: "ReportsKeyViaS3",
        actions: ["kms:Decrypt"],
        resources: [this.key.keyArn],
        conditions: { StringEquals: { "kms:ViaService": `s3.${region}.amazonaws.com` } },
      }),
    );
    acknowledge(policy, {
      id: `AwsSolutions-IAM5[Resource::<${Stack.of(this).getLogicalId(this.bucket.node.defaultChild as s3.CfnBucket)}.Arn>/owner/*]`,
      reason: "Download links of PDFs created at runtime, one per run, under their owner's prefix (D86 (4)).",
    });
  }
}
