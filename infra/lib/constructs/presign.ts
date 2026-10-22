import { Duration, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { mangoName } from "../names.js";
import { acknowledge } from "../nag.js";

/** Keep in sync with `mango_api.presign.SESSION_SECONDS`: the longest session mango-api asks for. */
export const PRESIGN_SESSION = Duration.minutes(30);

export interface PresignProps {
  readonly namespace: string;
  /** The task role of mango-api: the only principal that may assume the presign role. */
  readonly apiTaskRole: iam.Role;
  /** Documents of the knowledge bases: the browser posts uploads under `uploads/` (D88 (9)). */
  readonly documents: { readonly bucket: s3.IBucket; readonly key: kms.IKey; readonly prefix: string };
  /** PDFs of task runs: the browser downloads them under `owner/` (D86 (4)). */
  readonly reports: { readonly bucket: s3.IBucket; readonly key: kms.IKey; readonly prefix: string };
}

/**
 * `Mango-<ns>-Presign`: the credentials of every URL a browser uses. A presigned URL carries
 * the session of whoever signed it; signed with the task's credentials, GuardDuty reports its
 * use from a browser as `ResourceCredentialExfiltration.OutsideAWS` (seen on 2026-10-21).
 * mango-api assumes this role with STS, one session per person with `SourceIdentity` = that
 * person (rule 5), and signs only with it (`mango_api.presign`).
 *
 * It may put objects under `uploads/` of the documents bucket and get them under `owner/` of
 * the reports bucket, each with its key through S3, and nothing else. Its trust takes only the
 * task role of mango-api, and only with a source identity.
 */
export class Presign extends Construct {
  readonly role: iam.Role;
  readonly apiEnvironment: Record<string, string>;

  constructor(scope: Construct, id: string, props: PresignProps) {
    super(scope, id);
    const { region } = Stack.of(this);
    const withIdentity = { Null: { "sts:SourceIdentity": "false" } };
    this.role = new iam.Role(this, "Role", {
      roleName: mangoName(props.namespace, "Presign"),
      description: "Signs the URLs a browser uses (uploads of knowledge documents, PDFs of tasks); mango-api only",
      assumedBy: new iam.ArnPrincipal(props.apiTaskRole.roleArn).withConditions(withIdentity),
      maxSessionDuration: Duration.hours(1),
    });
    this.role.assumeRolePolicy!.addStatements(
      new iam.PolicyStatement({
        actions: ["sts:SetSourceIdentity"],
        principals: [new iam.ArnPrincipal(props.apiTaskRole.roleArn)],
        conditions: withIdentity,
      }),
    );
    const uploads = props.documents.bucket.arnForObjects(`${props.documents.prefix}*`);
    const reports = props.reports.bucket.arnForObjects(`${props.reports.prefix}*`);
    const viaS3 = { StringEquals: { "kms:ViaService": `s3.${region}.amazonaws.com` } };
    const policy = new iam.Policy(this, "Policy", {
      roles: [this.role],
      statements: [
        new iam.PolicyStatement({ sid: "UploadDocuments", actions: ["s3:PutObject"], resources: [uploads] }),
        new iam.PolicyStatement({
          sid: "DocumentsKey",
          actions: ["kms:GenerateDataKey"],
          resources: [props.documents.key.keyArn],
          conditions: viaS3,
        }),
        new iam.PolicyStatement({ sid: "DownloadReports", actions: ["s3:GetObject"], resources: [reports] }),
        new iam.PolicyStatement({
          sid: "ReportsKey",
          actions: ["kms:Decrypt"],
          resources: [props.reports.key.keyArn],
          conditions: viaS3,
        }),
      ],
    });
    const objects = (bucket: s3.IBucket, prefix: string) =>
      `AwsSolutions-IAM5[Resource::<${Stack.of(this).getLogicalId(bucket.node.defaultChild as s3.CfnBucket)}.Arn>/${prefix}*]`;
    acknowledge(
      policy,
      {
        id: objects(props.documents.bucket, props.documents.prefix),
        reason: "Uploads are keyed at runtime by caller and ULIDs (D88 (9)); the prefix uploads/ is the scope.",
      },
      {
        id: objects(props.reports.bucket, props.reports.prefix),
        reason: "One PDF per run, created at runtime under its owner's prefix (D86 (3)).",
      },
    );

    // A managed policy of its own: the inline policies of the task role share one size limit,
    // and the role is close to it.
    new iam.ManagedPolicy(this, "ApiPolicy", {
      managedPolicyName: mangoName(props.namespace, "ApiPresign"),
      description: "mango-api: assume the presign role to sign URLs a browser uses",
      roles: [props.apiTaskRole],
      statements: [
        new iam.PolicyStatement({
          sid: "AssumePresignRole",
          actions: ["sts:AssumeRole", "sts:SetSourceIdentity"],
          resources: [this.role.roleArn],
        }),
      ],
    });
    this.apiEnvironment = { PRESIGN_ROLE_ARN: this.role.roleArn };
  }
}
