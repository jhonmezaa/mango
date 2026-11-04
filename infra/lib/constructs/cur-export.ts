import { Duration, RemovalPolicy } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { Installation } from "../config/schema.js";

/**
 * Where the payer's Data Export CUR 2.0 writes, and the export's name (D104 (5)): the runbook's
 * manual step creates it with these, and the Glue table reads them. Data Exports writes
 * `<prefix>/<export name>/data/BILLING_PERIOD=<yyyy-mm>/…` and `…/metadata/…`.
 */
export const CUR_EXPORT = {
  prefix: "cur",
  exportName: (ns: string) => `mango-${ns}-bedrock`,
  /** Athena's query results, in a prefix of their own that expires (D104 (6)). */
  resultsPrefix: "athena-results",
  /** Prefix of the bucket's server access logs in the shared access logs bucket. */
  accessLogsPrefix: "cur-export/",
} as const;

/** Data Exports lives in us-east-1 whatever the Region of the installation (D104 (5)). */
export const DATA_EXPORTS_REGION = "us-east-1";
export const DATA_EXPORTS_SERVICE = "bcm-data-exports.amazonaws.com";

/** The ARNs of the exports of `account` (the payer): the only `aws:SourceArn` that may write. */
export function dataExportsSourceArn(account: string): string {
  return `arn:aws:bcm-data-exports:${DATA_EXPORTS_REGION}:${account}:export/*`;
}

export interface CurExportBucketProps {
  readonly installation: Installation;
  readonly accessLogs: s3.IBucket;
}

/**
 * The bucket the payer's Data Export CUR 2.0, cut down to Bedrock of this account, writes to
 * (D104 (5); threat model `cur-reconciliation-threat-model.md`). It holds billing data, so it
 * lives in Core and is retained like the other data buckets (D58, D99 (2)); the purge deletes it
 * (`mango-<ns>-core-…`).
 *
 * - Only the service of Data Exports writes, on behalf of the payer of the configuration
 *   (`aws:SourceAccount`, `aws:SourceArn`). Nobody else may put an object in the export's prefix,
 *   not even a role of this account (TM-CUR2). The service reads and deletes nothing.
 * - Encrypted with S3's keys (SSE-S3): Data Exports writes with SSE-S3 and cannot write with a
 *   KMS key; AWS says to encrypt with KMS after delivery (`cur/latest/userguide/data-protection`,
 *   checked on 2026-11-04). D104 (5) foresaw it.
 * - Objects expire after 400 days (13 months of history); Athena's results after 7.
 */
export class CurExportBucket extends Construct {
  readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: CurExportBucketProps) {
    super(scope, id);
    const cfg = props.installation;
    const payer = cfg.managementAccountId;

    this.bucket = new s3.Bucket(this, "Bucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      // No ACLs: what the service writes belongs to the bucket.
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      // Every refresh overwrites the files of the month: the versions are what it overwrote.
      versioned: true,
      serverAccessLogsBucket: props.accessLogs,
      serverAccessLogsPrefix: CUR_EXPORT.accessLogsPrefix,
      lifecycleRules: [
        { prefix: `${CUR_EXPORT.resultsPrefix}/`, expiration: Duration.days(7) },
        {
          expiration: Duration.days(400),
          noncurrentVersionExpiration: Duration.days(30),
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
        { expiredObjectDeleteMarker: true },
      ],
      removalPolicy: cfg.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !cfg.retainData,
    });

    const sourceArn = dataExportsSourceArn(payer);
    this.bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "EnableAWSDataExportsToWriteToS3",
        // The policy AWS asks for, as is (cur/latest/userguide/dataexports-s3-bucket).
        principals: [new iam.ServicePrincipal(DATA_EXPORTS_SERVICE)],
        actions: ["s3:PutObject"],
        resources: [this.bucket.arnForObjects("*")],
        conditions: {
          ArnLike: { "aws:SourceArn": sourceArn },
          StringEquals: { "aws:SourceAccount": payer },
        },
      }),
    );
    this.bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "OnlyDataExportsWritesTheExport",
        // A request of an IAM principal carries no `aws:SourceArn`: denied, whoever it is.
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["s3:PutObject"],
        resources: [this.bucket.arnForObjects(`${CUR_EXPORT.prefix}/*`)],
        conditions: { ArnNotLike: { "aws:SourceArn": sourceArn } },
      }),
    );
  }
}
