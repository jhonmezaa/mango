import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { Installation } from "../config/schema.js";
import { mangoName, roleNames } from "../names.js";

/** Life of a chat file (D116 (1)): what a person uploads and what the sandbox generates. */
export const CHAT_FILES_RETENTION = Duration.days(90);
/** Longest life of a download link (D116 (5)): the bucket refuses older signatures. */
export const CHAT_FILES_LINK_MS = 5 * 60 * 1000;
/** Prefixes of the bucket (D116 (3), (4)). Keys are made of ids only, never of file names (TM-CF8). */
export const CHAT_FILES_PREFIXES = {
  /** What the browser posts with a presigned POST; gone after a day if never saved. */
  uploads: "uploads/",
  /** `owner/<sub>/<conversation>/<file>`: what a person may download, scanned and clean. */
  owner: "owner/",
} as const;

/**
 * The tag GuardDuty Malware Protection for S3 leaves on every object it scans (D116 (2)), and
 * the only value that opens it.
 */
export const SCAN_TAG = "GuardDutyMalwareScanStatus";
export const SCAN_CLEAN = "NO_THREATS_FOUND";
/** What the scanner writes to check that it can, at the root of the bucket. */
export const SCAN_VALIDATION_OBJECT = "malware-protection-resource-validation-object";

export interface ChatFilesProps {
  readonly installation: Installation;
  readonly accessLogs: s3.IBucket;
}

/**
 * Files of the chat (D116; threat model `chat-files-threat-model.md`): what a person attaches
 * and what the code sandbox generates (D114). It holds data, so it stays in Core (D99 (2));
 * the malware scan plan and its role, which hold none, are in the sandbox stack nested in Core.
 *
 * - A key of its own (`alias/Mango-<ns>-chat-files`), TLS only, objects owned by the bucket,
 *   retained with the key, versioned with old versions gone the next day.
 * - `uploads/` lives a day; everything else 90 days; an object the scan found infected, a day.
 * - Read by tag (TBAC, TM-CF3): no principal but the scanner reads an object, or a version of
 *   it, whose scan tag is not `NO_THREATS_FOUND`, the absence of the tag included. Nobody but the
 *   scanner sets, changes or removes that tag, nor uploads an object that brings it.
 * - Download links live 5 minutes: the bucket refuses older signatures (TM-CF5).
 */
export class ChatFiles extends Construct {
  readonly bucket: s3.Bucket;
  readonly key: kms.Key;
  /** ARN of the scanner's role, by its fixed name: the role is in a nested stack (D99). */
  readonly scannerRoleArn: string;

  constructor(scope: Construct, id: string, props: ChatFilesProps) {
    super(scope, id);
    const cfg = props.installation;
    const ns = cfg.namespace;
    const stack = Stack.of(this);
    // Retained on update and delete; a create that rolls back deletes them, so that a retry does
    // not find them in its way (D58 (27)).
    const removalPolicy = cfg.retainData ? RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE : RemovalPolicy.DESTROY;
    this.scannerRoleArn = stack.formatArn({
      service: "iam",
      region: "",
      resource: "role",
      resourceName: roleNames.chatFilesScanner(ns),
    });

    this.key = new kms.Key(this, "Key", {
      alias: `alias/${mangoName(ns, "chat-files")}`,
      description: "Encrypts the files of the chat: uploads and what the code sandbox generates (D116)",
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
      serverAccessLogsPrefix: "chat-files/",
      versioned: true,
      // The scan plan turns the bucket's EventBridge notifications on by itself (its role may);
      // nothing in this template sets the bucket's notifications, so no update turns them off.
      lifecycleRules: [
        { prefix: CHAT_FILES_PREFIXES.uploads, expiration: Duration.days(1) },
        // TM-CF3: an infected object is never delivered and goes the next day.
        { tagFilters: { [SCAN_TAG]: "THREATS_FOUND" }, expiration: Duration.days(1) },
        {
          expiration: CHAT_FILES_RETENTION,
          noncurrentVersionExpiration: Duration.days(1),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
        { expiredObjectDeleteMarker: true },
      ],
      removalPolicy,
      autoDeleteObjects: !cfg.retainData,
    });

    const objects = this.bucket.arnForObjects("*");
    const notScanner = { ArnNotEquals: { "aws:PrincipalArn": this.scannerRoleArn } };
    // TM-CF3: nothing reaches a person or the sandbox before its scan says it is clean.
    // `StringNotEquals` also matches an object without the tag.
    this.bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "ReadOnlyWhatTheScanCleared",
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["s3:GetObject", "s3:GetObjectVersion"],
        resources: [objects],
        conditions: { StringNotEquals: { [`s3:ExistingObjectTag/${SCAN_TAG}`]: SCAN_CLEAN }, ...notScanner },
      }),
    );
    // The tag is the scanner's word: nobody else may forge it, nor remove it.
    this.bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "OnlyTheScannerTags",
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: [
          "s3:PutObjectTagging",
          "s3:PutObjectVersionTagging",
          "s3:DeleteObjectTagging",
          "s3:DeleteObjectVersionTagging",
        ],
        resources: [objects],
        conditions: notScanner,
      }),
    );
    this.bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "NoUploadBringsTheScanTag",
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["s3:PutObject"],
        resources: [objects],
        conditions: { "ForAnyValue:StringEquals": { "s3:RequestObjectTagKeys": [SCAN_TAG] }, ...notScanner },
      }),
    );
    // TM-CF5: a download link is a bearer for its 5 minutes, whatever the life of the
    // credentials that made it.
    this.bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "LinksLiveFiveMinutes",
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["s3:GetObject"],
        resources: [objects],
        conditions: { NumericGreaterThan: { "s3:signatureAge": CHAT_FILES_LINK_MS } },
      }),
    );
  }
}
