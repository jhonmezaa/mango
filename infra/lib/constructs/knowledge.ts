import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3vectors from "aws-cdk-lib/aws-s3vectors";
import { Construct } from "constructs";
import { Installation } from "../config/schema.js";
import { mangoName } from "../names.js";
import { acknowledge, arnWildcardFinding } from "../nag.js";
import { Alerts } from "./alerts.js";

/**
 * The one indexing profile of v1 (D88 (7)): the embedding model and the shape of the index are
 * one thing. Another model means another index and another base, never a setting.
 */
export const INDEXING_PROFILE = {
  embeddingModel: "amazon.titan-embed-text-v2:0",
  dimensions: 1024,
  /** Name of the vector index (S3 Vectors asks for at least 3 characters, D88 (27)). */
  indexName: "titan-v2-1024",
} as const;

/** Index names of the Knowledge table; keep in sync with `mango_api.knowledge_store`. */
export const KNOWLEDGE_ALL = "All";

/** Prefixes of the documents bucket (D88 (9)). */
export const KNOWLEDGE_PREFIXES = {
  /** What the browser uploads with a presigned POST; gone after a day if never saved. */
  uploads: "uploads/",
  /** `kb/<kb_id>/docs/<doc_id>`: the only prefix Bedrock reads. */
  bases: "kb/",
} as const;

/**
 * Metrics the knowledge functions publish (PR 4 and 5 of D88): the namespace carries the name
 * of the installation, as the other metrics without dimensions.
 */
export const KNOWLEDGE_SIGNALS = {
  namespacePrefix: "Mango/Knowledge",
  /** `Retrieve` calls Bedrock refused for the quota of the account (20 per second). */
  retrieveThrottles: "RetrieveThrottles",
  /** Deletions of documents, sources or bases still not verified 6 hours later (D88 (16)). */
  deletionsOverdue: "DeletionsOverdue",
} as const;

export interface KnowledgeProps {
  readonly installation: Installation;
  /** Key of the tables with customer data: the registry is one of them (D88 (21)). */
  readonly dataKey: kms.IKey;
  readonly accessLogs: s3.IBucket;
  readonly alerts: Alerts;
}

/**
 * Knowledge bases (D88; threat model `knowledge-bases-threat-model.md`): the fixed resources,
 * born with `Core` (D88 (18)). A knowledge base of Mango creates no AWS resource: it is a record
 * of the `Knowledge` table and a prefix `kb/<kb_id>/` of the documents bucket.
 *
 * - Documents bucket: its own key, TLS only, no ACLs, no public access; `uploads/` lasts a day
 *   and old versions too.
 * - A vector bucket and one index of S3 Vectors, with the same key, behind one Bedrock knowledge
 *   base with a `CUSTOM` data source: documents are ingested directly, with their metadata
 *   inline (D88 (23)), never with an ingestion job.
 * - The service role of that base: reads only `kb/*` of the documents bucket, invokes only the
 *   embedding model and writes only that index (TM-K7).
 * - `Mango-<ns>-kbsrc-boundary`: the ceiling of the roles that read an existing bucket of the
 *   installation's account (D88 (10)); they are created by SDK after an approval (PR 7).
 * - Alarms on what the functions of PR 4 and 5 publish: `Retrieve` throttled, and deletions not
 *   verified in 6 hours.
 */
export class Knowledge extends Construct {
  readonly key: kms.Key;
  readonly bucket: s3.Bucket;
  readonly vectorBucket: s3vectors.CfnVectorBucket;
  readonly index: s3vectors.CfnIndex;
  readonly serviceRole: iam.Role;
  readonly knowledgeBase: bedrock.CfnKnowledgeBase;
  readonly dataSource: bedrock.CfnDataSource;
  readonly table: dynamodb.TableV2;
  readonly sourceBoundary: iam.ManagedPolicy;
  readonly alarms: cloudwatch.Alarm[];
  /** Environment mango-api needs for the knowledge bases. */
  readonly apiEnvironment: Record<string, string>;
  private readonly namespace: string;
  private readonly dataKey: kms.IKey;

  constructor(scope: Construct, id: string, props: KnowledgeProps) {
    super(scope, id);
    const cfg = props.installation;
    const ns = (this.namespace = cfg.namespace);
    this.dataKey = props.dataKey;
    const { account, region } = Stack.of(this);
    const removalPolicy = cfg.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    // --- Key ------------------------------------------------------------------------------
    // Documents and vectors (the text of every chunk lives in the vector index too) share it.
    // Retained with them: a retained document must stay readable.
    this.key = new kms.Key(this, "Key", {
      alias: `alias/${mangoName(ns, "knowledge")}`,
      description: "Encrypts the documents and the vectors of the knowledge bases (D88)",
      enableKeyRotation: true,
      removalPolicy,
    });
    // S3 Vectors maintains the index in the background with its own principal; only for the
    // vector buckets of this account and only to decrypt what S3 Vectors encrypted.
    this.key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "S3VectorsIndexing",
        principals: [new iam.ServicePrincipal("indexing.s3vectors.amazonaws.com")],
        actions: ["kms:Decrypt"],
        resources: ["*"],
        conditions: {
          StringEquals: { "aws:SourceAccount": account },
          ArnLike: { "aws:SourceArn": `arn:aws:s3vectors:${region}:${account}:bucket/*` },
          "ForAnyValue:StringEquals": { "kms:EncryptionContextKeys": ["aws:s3vectors:arn", "aws:s3vectors:resource-id"] },
        },
      }),
    );

    // --- Documents ------------------------------------------------------------------------
    this.bucket = new s3.Bucket(this, "Documents", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.key,
      bucketKeyEnabled: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      serverAccessLogsBucket: props.accessLogs,
      serverAccessLogsPrefix: "knowledge/",
      // A deleted or replaced document leaves no copy after a day (TM-K5).
      versioned: true,
      lifecycleRules: [
        // An upload that was never saved (TM-K4).
        { prefix: KNOWLEDGE_PREFIXES.uploads, expiration: Duration.days(1) },
        { noncurrentVersionExpiration: Duration.days(1), abortIncompleteMultipartUploadAfter: Duration.days(1) },
        { expiredObjectDeleteMarker: true },
      ],
      removalPolicy,
      autoDeleteObjects: !cfg.retainData,
    });

    // --- Vectors --------------------------------------------------------------------------
    this.vectorBucket = new s3vectors.CfnVectorBucket(this, "VectorBucket", {
      vectorBucketName: `mango-${ns}-knowledge`,
      encryptionConfiguration: { sseType: "aws:kms", kmsKeyArn: this.key.keyArn },
    });
    this.vectorBucket.applyRemovalPolicy(removalPolicy);
    this.index = new s3vectors.CfnIndex(this, "Index", {
      vectorBucketArn: this.vectorBucket.attrVectorBucketArn,
      indexName: INDEXING_PROFILE.indexName,
      dataType: "float32",
      dimension: INDEXING_PROFILE.dimensions,
      distanceMetric: "cosine",
      // What Bedrock stores and nobody filters on (D88 (27)). `kb_id`, `business_unit`,
      // `doc_id`, `acl_groups` and `classification` stay filterable.
      metadataConfiguration: { nonFilterableMetadataKeys: ["AMAZON_BEDROCK_TEXT", "AMAZON_BEDROCK_METADATA"] },
    });
    this.index.applyRemovalPolicy(removalPolicy);

    // --- The Bedrock knowledge base -------------------------------------------------------
    const embeddingModelArn = `arn:aws:bedrock:${region}::foundation-model/${INDEXING_PROFILE.embeddingModel}`;
    this.serviceRole = new iam.Role(this, "ServiceRole", {
      roleName: mangoName(ns, "KnowledgeBase"),
      description: "Bedrock knowledge base: reads kb/* of the documents bucket, embeds, writes one vector index",
      // Only knowledge bases of this account (confused deputy).
      assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com").withConditions({
        StringEquals: { "aws:SourceAccount": account },
        ArnLike: { "aws:SourceArn": `arn:aws:bedrock:${region}:${account}:knowledge-base/*` },
      }),
    });
    const documents = `${this.bucket.bucketArn}/${KNOWLEDGE_PREFIXES.bases}*`;
    const service = new iam.Policy(this, "ServicePolicy", {
      roles: [this.serviceRole],
      statements: [
        new iam.PolicyStatement({
          sid: "EmbeddingModel",
          actions: ["bedrock:InvokeModel"],
          resources: [embeddingModelArn],
        }),
        new iam.PolicyStatement({
          sid: "ReadDocuments",
          actions: ["s3:GetObject"],
          resources: [documents],
          conditions: { StringEquals: { "aws:ResourceAccount": account } },
        }),
        new iam.PolicyStatement({
          sid: "ListDocuments",
          actions: ["s3:ListBucket"],
          resources: [this.bucket.bucketArn],
          conditions: {
            StringEquals: { "aws:ResourceAccount": account },
            StringLike: { "s3:prefix": [`${KNOWLEDGE_PREFIXES.bases}*`] },
          },
        }),
        new iam.PolicyStatement({
          sid: "DocumentsKey",
          actions: ["kms:Decrypt"],
          resources: [this.key.keyArn],
          conditions: { StringEquals: { "kms:ViaService": `s3.${region}.amazonaws.com` } },
        }),
        new iam.PolicyStatement({
          sid: "VectorIndex",
          actions: [
            "s3vectors:DeleteVectors",
            "s3vectors:GetIndex",
            "s3vectors:GetVectors",
            "s3vectors:PutVectors",
            "s3vectors:QueryVectors",
          ],
          resources: [this.index.attrIndexArn],
        }),
        new iam.PolicyStatement({
          sid: "VectorsKey",
          actions: ["kms:Decrypt", "kms:GenerateDataKey"],
          resources: [this.key.keyArn],
          conditions: {
            StringEquals: { "kms:ViaService": `s3vectors.${region}.amazonaws.com` },
            "ForAnyValue:StringEquals": { "kms:EncryptionContextKeys": ["aws:s3vectors:arn", "aws:s3vectors:resource-id"] },
          },
        }),
      ],
    });
    this.knowledgeBase = new bedrock.CfnKnowledgeBase(this, "KnowledgeBase", {
      name: mangoName(ns, "knowledge"),
      description: "Every knowledge base of Mango: one prefix and one kb_id each, filtered by Mango (D88)",
      roleArn: this.serviceRole.roleArn,
      knowledgeBaseConfiguration: {
        type: "VECTOR",
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn,
          embeddingModelConfiguration: {
            bedrockEmbeddingModelConfiguration: { dimensions: INDEXING_PROFILE.dimensions, embeddingDataType: "FLOAT32" },
          },
        },
      },
      storageConfiguration: { type: "S3_VECTORS", s3VectorsConfiguration: { indexArn: this.index.attrIndexArn } },
    });
    acknowledge(service, {
      id: arnWildcardFinding(this.bucket.node.defaultChild as s3.CfnBucket, `/${KNOWLEDGE_PREFIXES.bases}*`),
      reason: "Documents are written at runtime under kb/<kb_id>/docs/ (D88 (9)): the prefix kb/ is the scope.",
    });
    // Bedrock checks the role when the base is created: its policy has to be there first.
    this.knowledgeBase.node.addDependency(service);
    this.dataSource = new bedrock.CfnDataSource(this, "DataSource", {
      knowledgeBaseId: this.knowledgeBase.attrKnowledgeBaseId,
      name: mangoName(ns, "documents"),
      description: "Documents ingested directly with their metadata inline (D88 (23))",
      // Default chunking and parser (D88 (7)).
      dataSourceConfiguration: { type: "CUSTOM" },
      // Removing the stack of a retained installation leaves the vectors with their bucket.
      dataDeletionPolicy: cfg.retainData ? "RETAIN" : "DELETE",
    });

    // --- Registry -------------------------------------------------------------------------
    // Bases, sources, documents and syncs (D88 (8)). Its id names its throttling alarm (D71).
    this.table = new dynamodb.TableV2(this, "Knowledge", {
      tableName: mangoName(ns, "Knowledge"),
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      encryption: dynamodb.TableEncryptionV2.customerManagedKey(props.dataKey),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: cfg.retainData,
      removalPolicy,
      globalSecondaryIndexes: [
        {
          indexName: KNOWLEDGE_ALL,
          partitionKey: { name: "all_pk", type: dynamodb.AttributeType.STRING },
          sortKey: { name: "created_at", type: dynamodb.AttributeType.STRING },
        },
      ],
    });

    // --- Ceiling of the roles of existing buckets (D88 (10), TM-K2) -----------------------
    // The provisioner may only create `Mango-<ns>-kbsrc-*` with this boundary (PR 7); the
    // policy of each role names one bucket and one prefix. Whatever that policy says, the role
    // reads objects of this account only, and never a bucket of Mango.
    const mangoBuckets = `arn:aws:s3:::mango-${ns}-*`;
    this.sourceBoundary = new iam.ManagedPolicy(this, "SourceBoundary", {
      managedPolicyName: mangoName(ns, "kbsrc-boundary"),
      description: "Permissions boundary of the roles that read an existing bucket for a knowledge base",
      statements: [
        new iam.PolicyStatement({
          sid: "ReadBucketsOfThisAccount",
          actions: ["s3:GetObject", "s3:ListBucket"],
          resources: [`arn:aws:s3:::*`],
          conditions: { StringEquals: { "s3:ResourceAccount": account } },
        }),
        new iam.PolicyStatement({
          sid: "NeverMangoBuckets",
          effect: iam.Effect.DENY,
          actions: ["s3:*"],
          resources: [mangoBuckets, `${mangoBuckets}/*`],
        }),
      ],
    });
    acknowledge(this.sourceBoundary, {
      id: `AwsSolutions-IAM5[Resource::arn:aws:s3:::*]`,
      reason:
        "A permissions boundary: the ceiling, not a grant. Buckets are named at runtime by an approved source " +
        "(D88 (10), (20)); the role's own policy names that bucket, and the boundary keeps it to this account.",
    });

    // --- Alarms ---------------------------------------------------------------------------
    const metrics = `${KNOWLEDGE_SIGNALS.namespacePrefix}/${ns}`;
    const alarm = (alarmId: string, name: string, description: string, metricName: string, statistic: string) => {
      const created = new cloudwatch.Alarm(this, alarmId, {
        alarmName: mangoName(ns, name),
        alarmDescription: description,
        metric: new cloudwatch.Metric({ namespace: metrics, metricName, statistic, period: Duration.minutes(5) }),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        // A metric that only exists when something happened (D71).
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      created.addAlarmAction(new cloudwatchActions.SnsAction(props.alerts.topic));
      return created;
    };
    this.alarms = [
      alarm(
        "RetrieveThrottledAlarm",
        "Knowledge-retrieve-throttled",
        "Bedrock refused knowledge base searches (Retrieve) for the quota of the account, 20 per second for " +
          "every knowledge base of the account, Mango's or not: people got «la búsqueda está ocupada» from agents " +
          "and from «Probar búsqueda». Look first at the log group of the knowledge-retrieve tool, then at " +
          "the Retrieve quota of Bedrock in Service Quotas.",
        KNOWLEDGE_SIGNALS.retrieveThrottles,
        cloudwatch.Stats.SUM,
      ),
      alarm(
        "DeletionsOverdueAlarm",
        "Knowledge-deletion-unverified",
        "A deleted document, source or knowledge base still has vectors 6 hours later (D88 (16)): it stays " +
          "«Borrando» and agents may still quote it. Look first at the executions of the KnowledgeSync state " +
          "machine, then at the documents of the base in Bedrock (GetKnowledgeBaseDocuments).",
        KNOWLEDGE_SIGNALS.deletionsOverdue,
        cloudwatch.Stats.MAXIMUM,
      ),
    ];

    this.apiEnvironment = { KNOWLEDGE_TABLE: this.table.tableName };
  }

  /**
   * mango-api: the registry of the knowledge bases (D88 (12)). A managed policy of its own: the
   * inline policies of its role share one size limit, and the role is close to it. No
   * `DeleteItem` nor `Scan`: deleting is a status, and the synchronization removes the records
   * once it verified that no vector is left (D88 (16)).
   */
  grantApi(role: iam.Role): void {
    const { region } = Stack.of(this);
    new iam.ManagedPolicy(this, "ApiPolicy", {
      managedPolicyName: mangoName(this.namespace, "ApiKnowledge"),
      description: "mango-api: the registry of the knowledge bases (D88)",
      roles: [role],
      statements: [
        new iam.PolicyStatement({
          sid: "KnowledgeTable",
          actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem"],
          resources: [this.table.tableArn, `${this.table.tableArn}/index/${KNOWLEDGE_ALL}`],
        }),
        new iam.PolicyStatement({
          sid: "KnowledgeTableKey",
          actions: ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"],
          resources: [this.dataKey.keyArn],
          conditions: { StringEquals: { "kms:ViaService": `dynamodb.${region}.amazonaws.com` } },
        }),
      ],
    });
  }
}
