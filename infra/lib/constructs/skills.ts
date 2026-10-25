import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { Installation } from "../config/schema.js";
import { mangoName } from "../names.js";
import { acknowledge } from "../nag.js";

/** Where the `SKILL.md` of every approved version lives: `skills/<id>/v<N>/<id>/SKILL.md`. */
export const SKILLS_PREFIX = "skills/";

export interface SkillsProps {
  readonly installation: Installation;
  /** Key of the installation's tables. */
  readonly dataKey: kms.IKey;
  readonly accessLogs: s3.IBucket;
}

/**
 * Skills of instructions only (D92; threat model `skills-threat-model.md`).
 *
 * - Table `Mango-<ns>-Skills`: the catalog, the approved versions, the requests waiting for an
 *   administrator and the daily activations. Only mango-api writes it.
 * - Bucket: the `SKILL.md` of each approved version, written once by mango-api, with a key of
 *   its own. The AgentCore harness fetches them with the role of each agent, whose policy
 *   (written by the provisioner) names only the versions of that agent; the agent boundary is
 *   the ceiling: read this bucket and decrypt with its key, through S3, nothing else.
 */
export class Skills extends Construct {
  readonly table: dynamodb.TableV2;
  readonly bucket: s3.Bucket;
  readonly key: kms.Key;
  /** Environment mango-api needs. */
  readonly apiEnvironment: Record<string, string>;
  private readonly namespace: string;
  private readonly dataKey: kms.IKey;

  constructor(scope: Construct, id: string, props: SkillsProps) {
    super(scope, id);
    const cfg = props.installation;
    const ns = (this.namespace = cfg.namespace);
    this.dataKey = props.dataKey;
    const removalPolicy = cfg.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    // A key of its own: agent roles decrypt with it, and with no other key of the installation.
    // Retained with the bucket: an agent that names a version must always be able to read it.
    this.key = new kms.Key(this, "Key", {
      alias: `alias/${mangoName(ns, "skills")}`,
      description: "Encrypts the SKILL.md of approved skill versions (D92)",
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
      serverAccessLogsPrefix: "skills/",
      // A version is written once and never changed (`If-None-Match`); versioning keeps it if a
      // write ever went wrong.
      versioned: true,
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: Duration.days(1) }],
      removalPolicy,
      autoDeleteObjects: !cfg.retainData,
    });

    // Its id names its throttling alarm (D71).
    this.table = new dynamodb.TableV2(this, "Skills", {
      tableName: mangoName(ns, "Skills"),
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      encryption: dynamodb.TableEncryptionV2.customerManagedKey(props.dataKey),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: cfg.retainData,
      removalPolicy,
      // Closed requests (90 days) and daily activations (31 days); skills and versions never.
      timeToLiveAttribute: "ttl",
    });

    this.apiEnvironment = {
      SKILLS_TABLE: this.table.tableName,
      SKILLS_BUCKET: this.bucket.bucketName,
    };
  }

  /** mango-api: the table, and writing (once) and reading the `SKILL.md` of a version. */
  grantApi(role: iam.Role): void {
    const { region } = Stack.of(this);
    const objects = this.bucket.arnForObjects(`${SKILLS_PREFIX}*`);
    const policy = new iam.ManagedPolicy(this, "ApiPolicy", {
      managedPolicyName: mangoName(this.namespace, "ApiSkills"),
      description: "mango-api: skills and their approved versions (D92)",
      roles: [role],
      statements: [
        new iam.PolicyStatement({
          sid: "SkillsTable",
          actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem"],
          resources: [this.table.tableArn],
        }),
        new iam.PolicyStatement({
          sid: "SkillsTableKey",
          actions: ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"],
          resources: [this.dataKey.keyArn],
          conditions: { StringEquals: { "kms:ViaService": `dynamodb.${region}.amazonaws.com` } },
        }),
        // `GetObject` only to compare a retried approval with what is there.
        new iam.PolicyStatement({
          sid: "SkillFiles",
          actions: ["s3:GetObject", "s3:PutObject"],
          resources: [objects],
        }),
        new iam.PolicyStatement({
          sid: "SkillFilesKey",
          actions: ["kms:Decrypt", "kms:GenerateDataKey"],
          resources: [this.key.keyArn],
          conditions: { StringEquals: { "kms:ViaService": `s3.${region}.amazonaws.com` } },
        }),
      ],
    });
    acknowledge(policy, {
      id: `AwsSolutions-IAM5[Resource::<${Stack.of(this).getLogicalId(this.bucket.node.defaultChild as s3.CfnBucket)}.Arn>/${SKILLS_PREFIX}*]`,
      reason: "Each approved version is written at runtime under skills/<id>/v<N>/ (D92): the prefix is the scope.",
    });
  }

  /**
   * The ceiling of agent roles (TM-M1): read this bucket and decrypt with its key, through S3.
   * Which versions each agent reads is in its own role, written by the provisioner.
   */
  allowAgents(boundary: iam.ManagedPolicy): void {
    const { region } = Stack.of(this);
    boundary.addStatements(
      new iam.PolicyStatement({
        sid: "ReadSkills",
        actions: ["s3:GetObject"],
        resources: [this.bucket.arnForObjects(`${SKILLS_PREFIX}*`)],
      }),
      new iam.PolicyStatement({
        sid: "ListSkills",
        actions: ["s3:ListBucket"],
        resources: [this.bucket.bucketArn],
      }),
      new iam.PolicyStatement({
        sid: "SkillsKey",
        actions: ["kms:Decrypt"],
        resources: [this.key.keyArn],
        conditions: { StringEquals: { "kms:ViaService": `s3.${region}.amazonaws.com` } },
      }),
    );
    acknowledge(boundary, {
      id: `AwsSolutions-IAM5[Resource::<${Stack.of(this).getLogicalId(this.bucket.node.defaultChild as s3.CfnBucket)}.Arn>/${SKILLS_PREFIX}*]`,
      reason: "A boundary is a ceiling, not a grant: each agent role names only the skill versions of its approved version (D92).",
    });
  }
}
