import { CfnResource, Duration, RemovalPolicy, Size, Stack } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";
import { Installation } from "../config/schema.js";
import { logsKeyOf } from "../logs.js";
import { mangoName } from "../names.js";
import { acknowledge, arnWildcardFinding, REASONS } from "../nag.js";
import { CHAT_FILES_PREFIXES } from "./chat-files.js";

/** Name of the function, and of its role (rule 6). */
export const renderDocumentName = (ns: string) => mangoName(ns, "RenderDocument");
/** Its alarms, by name: the operations dashboard of another nested stack lists them (D99 (4)). */
export const RENDER_DOCUMENT_ALARMS = { failing: "RenderDocument-failing", slow: "RenderDocument-slow" };
/**
 * Where it writes (`handler.py`, `KEY_OUT`): only under `renders/` of an owner's conversation,
 * so a render never replaces a file of the person.
 */
export const RENDER_OUTPUT = `${CHAT_FILES_PREFIXES.owner}*/renders/*`;
/** What a render may take: LibreOffice's 90 s, Poppler's 60 s, S3 and a cold start. */
export const RENDER_TIMEOUT = Duration.minutes(3);

export interface RenderDocumentProps {
  readonly installation: Installation;
  /** The chat files bucket of Core and its key (D116). */
  readonly chatFiles: { readonly bucket: s3.IBucket; readonly key: kms.IKey };
  /** The release image, by digest, in the repository of mango-api (D58, D117 (2)). */
  readonly image: { readonly repositoryArn: string; readonly repositoryName: string; readonly digest: string };
  /** Key of the environment of the installation's functions. */
  readonly configKey: kms.IKey;
  /** The alerts topic of Core. */
  readonly alertsTopic: sns.ITopic;
}

/**
 * `Mango-<ns>-RenderDocument` (D117; threat model `code-interpreter-threat-model.md`, TM-CI8): a
 * Lambda function from the container image of the release, with LibreOffice headless and
 * Poppler, that renders one Word, Excel or PowerPoint file of the chat to a PDF and PNG pages.
 *
 * - The image is published by the release pipeline in the provider's repository and named here
 *   by digest: nothing is built or pulled by tag in the customer account (D25, D58).
 * - Outside a VPC (agreed exception `LAMBDA_INSIDE_VPC`): no network control stops LibreOffice
 *   if a hostile file broke it, so its role holds only the chat files (residual of TM-CI8,
 *   accepted by the owner on 2026-11-07), and the profile of every conversion turns macros,
 *   link updates and LibreOffice's own web access off (`convert.py`).
 * - Its role reads objects under `owner/` (the bucket itself refuses any object its malware scan
 *   has not cleared, D116 (10)) and writes only under `owner/<sub>/<conversation>/renders/`.
 * - Invoked synchronously (by the code sandbox connector, once it exists): no dead-letter queue
 *   (agreed exception `CKV_AWS_116`). No principal is granted the invocation yet; its event
 *   contract is in `functions/render-document/src/mango_render_document/handler.py`.
 */
export class RenderDocument extends Construct {
  readonly function: lambda.DockerImageFunction;
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: RenderDocumentProps) {
    super(scope, id);
    const ns = props.installation.namespace;
    const { region } = Stack.of(this);
    const name = renderDocumentName(ns);
    const { bucket, key } = props.chatFiles;

    this.role = new iam.Role(this, "Role", {
      roleName: name,
      description: "Renders one chat file to PDF and PNG pages: reads under owner/, writes only renders (D117)",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadChatFile",
        actions: ["s3:GetObject"],
        resources: [bucket.arnForObjects(`${CHAT_FILES_PREFIXES.owner}*`)],
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "WriteRender",
        actions: ["s3:PutObject"],
        resources: [bucket.arnForObjects(RENDER_OUTPUT)],
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ChatFilesKey",
        actions: ["kms:Decrypt", "kms:GenerateDataKey"],
        resources: [key.keyArn],
        conditions: { StringEquals: { "kms:ViaService": `s3.${region}.amazonaws.com` } },
      }),
    );

    const logGroup = new logs.LogGroup(this, "Logs", {
      logGroupName: `/aws/lambda/${name}`,
      retention: logs.RetentionDays.THREE_MONTHS,
      encryptionKey: logsKeyOf(this),
      // Retained on update and delete; a create that rolls back deletes it (D58 (27)).
      removalPolicy: props.installation.retainData ? RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE : RemovalPolicy.DESTROY,
    });

    this.function = new lambda.DockerImageFunction(this, "Function", {
      functionName: name,
      description: "Renders a Word, Excel or PowerPoint file of the chat to PDF and PNG pages (D117)",
      code: lambda.DockerImageCode.fromEcr(
        ecr.Repository.fromRepositoryAttributes(this, "Image", {
          repositoryArn: props.image.repositoryArn,
          repositoryName: props.image.repositoryName,
        }),
        { tagOrDigest: props.image.digest },
      ),
      architecture: lambda.Architecture.ARM_64,
      role: this.role,
      // LibreOffice is faster with more CPU, which Lambda gives with memory.
      memorySize: 2048,
      timeout: RENDER_TIMEOUT,
      // The document, its PDF, its pages and LibreOffice's profile, deleted after each call.
      ephemeralStorageSize: Size.mebibytes(2048),
      environment: { CHAT_FILES_BUCKET: bucket.bucketName },
      environmentEncryption: props.configKey,
      logGroup,
      loggingFormat: lambda.LoggingFormat.JSON,
      tracing: lambda.Tracing.ACTIVE,
    });
    logGroup.grantWrite(this.role);
    acknowledge(this.role, { id: "AwsSolutions-IAM5[Resource::*]", reason: REASONS.xray });
    const bucketResource = bucket.node.defaultChild as CfnResource;
    acknowledge(
      this.role,
      {
        id: arnWildcardFinding(bucketResource, "/owner/*", "Arn", this),
        reason: "Chat files are created at runtime under their owner's prefix (D116 (3)); the bucket denies what the scan has not cleared.",
      },
      {
        id: arnWildcardFinding(bucketResource, "/owner/*/renders/*", "Arn", this),
        reason: "One prefix per render, created at runtime under its owner's conversation (D117).",
      },
    );

    const notify = new cloudwatchActions.SnsAction(props.alertsTopic);
    const sum = { statistic: cloudwatch.Stats.SUM, period: Duration.minutes(5) };
    new cloudwatch.Alarm(this, "FailingAlarm", {
      alarmName: mangoName(ns, RENDER_DOCUMENT_ALARMS.failing),
      alarmDescription:
        `The function ${name} failed or was throttled at least 3 times in 5 minutes: renders of Office files ` +
        "were not answered. A refused or unconvertible file is an answer, not an error: these are S3, KMS, the " +
        "image or the timeout. Look first at its log group, then at the Lambda concurrency of the account.",
      metric: new cloudwatch.MathExpression({
        expression: "FILL(errors, 0) + FILL(throttles, 0)",
        usingMetrics: { errors: this.function.metricErrors(sum), throttles: this.function.metricThrottles(sum) },
        label: `${name} errors and throttles`,
        period: Duration.minutes(5),
      }),
      threshold: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(notify);
    new cloudwatch.Alarm(this, "SlowAlarm", {
      alarmName: mangoName(ns, RENDER_DOCUMENT_ALARMS.slow),
      alarmDescription:
        `The slowest render of ${name} in 15 minutes came within 30 seconds of its timeout: the next large ` +
        "document will be cut. Look at the durations in its log group (field ms) and at the memory of the function.",
      metric: this.function.metricDuration({ statistic: cloudwatch.Stats.MAXIMUM, period: Duration.minutes(15) }),
      threshold: RENDER_TIMEOUT.minus(Duration.seconds(30)).toMilliseconds(),
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(notify);
  }
}
