import { CfnResource, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import { Installation } from "../config/schema.js";
import { mangoName, roleNames } from "../names.js";
import { acknowledge, arnWildcardFinding, REASONS } from "../nag.js";
import { CHAT_FILES_PREFIXES } from "./chat-files.js";
import { PythonFunction } from "./python-function.js";

/** Namespace and dimension of the metric the function emits (embedded metric format). */
export const CHAT_FILES_METRICS = { namespace: "Mango/ChatFiles", dimension: "Installation" };
/** Its alarms, by name: the dashboard of Core names them (each nested stack is a leaf, D99 (4)). */
export const CHAT_FILES_ALARMS = { blocked: "ChatFiles-blocked", failed: "ChatFilesScanResults-failed" };
/** What the scan event of each object is called on the default bus (GuardDuty documentation). */
export const SCAN_RESULT_DETAIL_TYPE = "GuardDuty Malware Protection Object Scan Result";
/**
 * The only attributes the function writes (`functions/chat-files-scan`): the key of the item and
 * what the scan said. Anything else of the Conversations table is out of its reach.
 */
export const SCAN_RECORD_ATTRIBUTES = ["PK", "SK", "scan_result", "scanned_at", "scan_etag", "scan_version", "ttl"];

export interface ChatFilesScanResultsProps {
  readonly installation: Installation;
  /** The chat files bucket of Core (D116). */
  readonly bucket: s3.IBucket;
  /** The Conversations table: the scan of a file is recorded in its owner's partition. */
  readonly conversations: { readonly tableName: string; readonly tableArn: string };
  /** Key of the Conversations table. */
  readonly dataKey: kms.IKey;
  /** Key for the function's environment variables. */
  readonly configKey: kms.IKey;
  /** Where alarms notify, and the key of the dead-letter queue. */
  readonly alerts: { readonly topic: sns.ITopic; readonly key: kms.IKey };
}

/**
 * What the malware scan said of each chat file (D116 (2), (10)). GuardDuty Malware Protection
 * for S3 sends one event per scanned object to the default bus; a rule on the chat files bucket
 * invokes `Mango-<ns>-ChatFilesScanResults` asynchronously, which writes the result in the
 * owner's partition of the Conversations table (`CSCAN#<key>`). mango-api reads it to check,
 * copy and deliver a file (`apps/api/src/mango_api/chat_files.py`); it never reads an object
 * before (TBAC). Holds no data (D99 (2)): it lives in the sandbox stack nested in Core.
 *
 * The role reads nothing: it may only update the scan attributes of items of a person's
 * partition. Retries and the dead-letter queue are the function's (AGENTS.md); an event that
 * fails every retry leaves the file «Revisando el archivo» until its time is up, never open.
 */
export class ChatFilesScanResults extends Construct {
  readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: ChatFilesScanResultsProps) {
    super(scope, id);
    const cfg = props.installation;
    const ns = cfg.namespace;
    const stack = Stack.of(this);
    const name = roleNames.chatFilesScanResults(ns);

    const role = new iam.Role(this, "Role", {
      roleName: name,
      description: "Records what the malware scan said of each chat file (D116); reads nothing",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "RecordScanResults",
        actions: ["dynamodb:UpdateItem"],
        resources: [props.conversations.tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["USER#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": SCAN_RECORD_ATTRIBUTES },
          StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES", "dynamodb:ReturnValues": "NONE" },
        },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "DataKeyViaDynamoDB",
        actions: ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"],
        resources: [props.dataKey.keyArn],
        conditions: { StringEquals: { "kms:ViaService": `dynamodb.${stack.region}.amazonaws.com` } },
      }),
    );

    const deadLetters = new sqs.Queue(this, "DeadLetters", {
      queueName: mangoName(ns, "ChatFilesScanResults-dlq"),
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
      packageName: "mango-chat-files-scan",
      packagePath: "functions/chat-files-scan",
      retainLogs: cfg.retainData,
      logsRemovalPolicy: cfg.retainData ? RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE : RemovalPolicy.DESTROY,
      handler: "mango_chat_files_scan.handler.lambda_handler",
      functionName: name,
      description: "Records the GuardDuty malware scan of each chat file for mango-api (D116)",
      role,
      timeout: Duration.seconds(30),
      memorySize: 256,
      deadLetterQueue: deadLetters,
      environment: {
        MANGO_NAMESPACE: ns,
        CHAT_FILES_BUCKET: props.bucket.bucketName,
        CONVERSATIONS_TABLE: props.conversations.tableName,
      },
      environmentEncryption: props.configKey,
    }).function;
    acknowledge(role, { id: "AwsSolutions-IAM5[Resource::*]", reason: REASONS.xray });

    new events.Rule(this, "Rule", {
      ruleName: mangoName(ns, "ChatFiles-scan-results"),
      description: "Records the malware scan of each object of the chat files bucket (D116)",
      eventPattern: {
        source: ["aws.guardduty"],
        detailType: [SCAN_RESULT_DETAIL_TYPE],
        detail: {
          s3ObjectDetails: {
            bucketName: [props.bucket.bucketName],
            objectKey: [{ prefix: CHAT_FILES_PREFIXES.uploads }, { prefix: CHAT_FILES_PREFIXES.owner }],
          },
        },
      },
      // Recording a scan is idempotent (the newest one wins): a retry never changes a result.
      targets: [new targets.LambdaFunction(this.function, { retryAttempts: 2, maxEventAge: Duration.hours(6) })],
    });

    this.alarms(ns, props.alerts.topic, deadLetters);
  }

  private alarms(ns: string, topic: sns.ITopic, deadLetters: sqs.IQueue): void {
    const notify = new cloudwatchActions.SnsAction(topic);
    const fiveMinutes = Duration.minutes(5);
    const alarm = (id: string, alarmName: string, description: string, metric: cloudwatch.IMetric) =>
      new cloudwatch.Alarm(this, id, {
        alarmName: mangoName(ns, alarmName),
        alarmDescription: description,
        metric,
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(notify);

    alarm(
      "BlockedAlarm",
      CHAT_FILES_ALARMS.blocked,
      "The malware scan did not clear a chat file (THREATS_FOUND, or a scan that failed or could not read it): " +
        "it is never delivered (TM-CF3). Look first at the chat.file_upload events with outcome rejected in " +
        `Audit, then at the log group of the ${roleNames.chatFilesScanResults(ns)} function (ids only).`,
      new cloudwatch.Metric({
        namespace: CHAT_FILES_METRICS.namespace,
        metricName: "Blocked",
        dimensionsMap: { [CHAT_FILES_METRICS.dimension]: ns },
        statistic: cloudwatch.Stats.SUM,
        period: fiveMinutes,
      }),
    );
    alarm(
      "FailedAlarm",
      CHAT_FILES_ALARMS.failed,
      "A malware scan of a chat file could not be recorded after its retries (event in the dead-letter queue " +
        `${mangoName(ns, "ChatFilesScanResults-dlq")}): its file stays «Revisando el archivo» and then fails, never ` +
        `open. Look first at the log group of the ${roleNames.chatFilesScanResults(ns)} function.`,
      deadLetters.metricApproximateNumberOfMessagesVisible({
        statistic: cloudwatch.Stats.MAXIMUM,
        period: fiveMinutes,
      }),
    );
  }
}

export interface ChatFilesApiProps {
  readonly namespace: string;
  readonly apiTaskRole: iam.IRole;
  readonly bucket: s3.IBucket;
  readonly key: kms.IKey;
}

/**
 * mango-api on the chat files bucket (D116), with its own credentials: check an upload (its size
 * and first bytes) and copy it under `owner/`, read the images of the chat, and delete the files
 * of a conversation. Every URL a browser uses is signed by `Mango-<ns>-Presign`, never with this
 * role (`presign.ts`). The bucket lets no principal read an object its scan did not clear (TBAC),
 * whatever this policy says. A managed policy of its own, in a stack nested in Core (D99): the
 * role is close to its limit of inline policies and Core to its limit of resources.
 */
export function grantChatFilesApi(scope: Construct, props: ChatFilesApiProps): iam.ManagedPolicy {
  const region = Stack.of(scope).region;
  const uploads = props.bucket.arnForObjects(`${CHAT_FILES_PREFIXES.uploads}*`);
  const files = props.bucket.arnForObjects(`${CHAT_FILES_PREFIXES.owner}*`);
  const policy = new iam.ManagedPolicy(scope, "ApiChatFilesPolicy", {
    managedPolicyName: mangoName(props.namespace, "ApiChatFiles"),
    description: "mango-api: the files of the chat (D116)",
    roles: [props.apiTaskRole],
    statements: [
      // `HeadObject` and two ranges of an upload, the copy's source, the images of the chat.
      new iam.PolicyStatement({ sid: "ReadChatFiles", actions: ["s3:GetObject"], resources: [uploads, files] }),
      // The copy's destination; no tags (only the scanner tags, D116 (10)).
      new iam.PolicyStatement({ sid: "CopyChatUploads", actions: ["s3:PutObject"], resources: [files] }),
      // D116 (9): the files of a deleted conversation. Older versions go the next day (lifecycle).
      new iam.PolicyStatement({ sid: "DeleteChatFiles", actions: ["s3:DeleteObject"], resources: [uploads, files] }),
      new iam.PolicyStatement({
        sid: "ChatFilesKey",
        actions: ["kms:Decrypt", "kms:GenerateDataKey"],
        resources: [props.key.keyArn],
        conditions: { StringEquals: { "kms:ViaService": `s3.${region}.amazonaws.com` } },
      }),
    ],
  });
  const bucket = props.bucket.node.defaultChild as CfnResource;
  acknowledge(
    policy,
    {
      id: arnWildcardFinding(bucket, `/${CHAT_FILES_PREFIXES.uploads}*`, "Arn", policy),
      reason: "Chat uploads are keyed at runtime by caller and ULIDs (D116 (4)); the prefix uploads/ is the scope.",
    },
    {
      id: arnWildcardFinding(bucket, `/${CHAT_FILES_PREFIXES.owner}*`, "Arn", policy),
      reason: "Chat files are created at runtime under their owner's prefix (D116 (3)); owner/ is the scope.",
    },
  );
  return policy;
}
