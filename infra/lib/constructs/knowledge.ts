import { Aws, Duration, Fn, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as firehose from "aws-cdk-lib/aws-kinesisfirehose";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3vectors from "aws-cdk-lib/aws-s3vectors";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as sfnTasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Construct } from "constructs";
import { Installation } from "../config/schema.js";
import { logsKeyOf } from "../logs.js";
import { mangoName } from "../names.js";
import { acknowledge, arnWildcardFinding, REASONS } from "../nag.js";
import { Alerts } from "./alerts.js";
import { PythonFunction } from "./python-function.js";

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

/** Where the server access logs of the documents bucket go, in the shared access logs bucket. */
const ACCESS_LOG_PREFIX = "knowledge/";

/** Index names of the Knowledge table; keep in sync with `mango_api.knowledge_store`. */
export const KNOWLEDGE_ALL = "All";

/** What the synchronization may do on the Bedrock knowledge base: the five of direct ingestion. */
export const DIRECT_INGESTION_ACTIONS = [
  "bedrock:DeleteKnowledgeBaseDocuments",
  "bedrock:GetKnowledgeBaseDocuments",
  "bedrock:IngestKnowledgeBaseDocuments",
  "bedrock:ListKnowledgeBaseDocuments",
  "bedrock:StartIngestionJob",
];

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
  /** The origin of the SPA: the only one that may post uploads to the documents bucket. */
  readonly appOrigin: string;
  /** Budgets of the people who synchronize (D88 (24)), the audit trail, and their keys. */
  readonly budgetsTable: dynamodb.ITableV2;
  readonly auditIndex: dynamodb.ITableV2;
  readonly auditStream: firehose.IDeliveryStream;
  /** Key of the environment of the installation's functions. */
  readonly configKey: kms.IKey;
  /** USD per million input tokens of the embedding model of the profile (rule 7). */
  readonly embeddingPrice: number;
  /** The shared rate limits (D70): the searches of each person (D88 (14)). */
  readonly rateLimitsTable: dynamodb.ITableV2;
  /** Who may call the knowledge search: access tokens of these clients of the user pool. */
  readonly issuer: string;
  readonly webClientId: string;
  /** The tasks client (D78): a task run searches as its owner. */
  readonly tasksClientId: string;
}

/** Keep in sync with `mango_knowledge_retrieve.handler.LIMIT_NAME`. */
export const RETRIEVE_LIMIT = "kb.retrieve";

/** Keep in sync with `functions/knowledge-sync` (`handler.LOCK_SECONDS`): the lock lasts as long. */
export const SYNC_TIMEOUT = Duration.hours(2);
/** The hourly sweep (D88 (16)): deletions not verified in 6 hours alarm. */
export const SWEEP_RATE = Duration.hours(1);

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
  /** `<bucket>.s3.<region>.amazonaws.com`, without referring to the bucket resource. */
  private readonly bucketRegionalDomain: string;
  readonly vectorBucket: s3vectors.CfnVectorBucket;
  readonly index: s3vectors.CfnIndex;
  readonly serviceRole: iam.Role;
  readonly knowledgeBase: bedrock.CfnKnowledgeBase;
  readonly dataSource: bedrock.CfnDataSource;
  readonly table: dynamodb.TableV2;
  readonly sourceBoundary: iam.ManagedPolicy;
  /** `Mango-<ns>-KnowledgeSync`: ingests, deletes and verifies (D88 (11), (16)). */
  readonly syncMachine: sfn.StateMachine;
  readonly syncFunction: lambda.Function;
  /** The `knowledge-retrieve` tool (D88 (14)): a Lambda target of the Gateway. */
  readonly retrieveFunction: lambda.Function;
  /** `Mango-<ns>-KnowledgeSources`: creates and deletes the roles of the sources (D88 (10)). */
  readonly sourcesFunction: lambda.Function;
  /** `Mango-<ns>-kbsrc-*`: the roles of the sources, created at runtime with `sourceBoundary`. */
  readonly sourceRoleArns: string;
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
    // A name of its own, `mango-<ns>-knowledge-<8 hex of the stack id>`: the CSP of the SPA
    // names this bucket and the bucket's CORS names the SPA, so neither may refer to the other
    // as a resource. Unique per installation: a bucket retained by a removed installation
    // never blocks a new one.
    const stackSuffix = Fn.select(0, Fn.split("-", Fn.select(2, Fn.split("/", Aws.STACK_ID))));
    const bucketName = Fn.join("", [`mango-${ns}-knowledge-`, stackSuffix]);
    this.bucketRegionalDomain = Fn.join("", [bucketName, `.s3.${region}.amazonaws.com`]);
    this.bucket = new s3.Bucket(this, "Documents", {
      bucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.key,
      bucketKeyEnabled: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      // A deleted or replaced document leaves no copy after a day (TM-K5).
      versioned: true,
      lifecycleRules: [
        // An upload that was never saved (TM-K4).
        { prefix: KNOWLEDGE_PREFIXES.uploads, expiration: Duration.days(1) },
        { noncurrentVersionExpiration: Duration.days(1), abortIncompleteMultipartUploadAfter: Duration.days(1) },
        { expiredObjectDeleteMarker: true },
      ],
      // The browser posts each upload straight to S3 with a presigned POST (D88 (9)); only from
      // the SPA. Nothing is read from the browser (no download of the original, D88 (17)).
      cors: [
        {
          allowedOrigins: [props.appOrigin],
          allowedMethods: [s3.HttpMethods.POST],
          allowedHeaders: [],
          maxAge: 600,
        },
      ],
      removalPolicy,
      autoDeleteObjects: !cfg.retainData,
    });
    // Server access logs, written by hand. CDK's `serverAccessLogsBucket` would make the policy
    // of the shared access logs bucket name this bucket as a resource; the load balancer
    // depends on that policy, the distribution on the load balancer, and this bucket (its
    // CORS) on the distribution: a cycle CloudFormation refuses. The policy names this bucket
    // by its ARN, built from its name, which depends on no resource.
    (this.bucket.node.defaultChild as s3.CfnBucket).loggingConfiguration = {
      destinationBucketName: props.accessLogs.bucketName,
      logFilePrefix: ACCESS_LOG_PREFIX,
    };
    props.accessLogs.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "KnowledgeDocumentsAccessLogs",
        principals: [new iam.ServicePrincipal("logging.s3.amazonaws.com")],
        actions: ["s3:PutObject"],
        resources: [props.accessLogs.arnForObjects(`${ACCESS_LOG_PREFIX}*`)],
        conditions: {
          ArnLike: { "aws:SourceArn": Fn.join("", ["arn:aws:s3:::", bucketName]) },
          StringEquals: { "aws:SourceAccount": account },
        },
      }),
    );

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
      // Records of presigned uploads go with their objects (D88 (9)); nothing else expires.
      timeToLiveAttribute: "expires_at",
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

    const sync = this.buildSync(props, bucketName);
    this.syncFunction = sync.fn;
    this.syncMachine = sync.machine;
    this.retrieveFunction = this.buildRetrieve(props);
    this.sourceRoleArns = `arn:aws:iam::${account}:role/${mangoName(ns, "kbsrc-")}*`;
    this.sourcesFunction = this.buildSources(props);

    this.apiEnvironment = {
      KNOWLEDGE_TABLE: this.table.tableName,
      KNOWLEDGE_BUCKET: this.bucket.bucketName,
      KNOWLEDGE_SYNC_STATE_MACHINE_ARN: this.syncMachine.stateMachineArn,
      // What a search of an agent adds to its turn (D88 (14), rule 7).
      KNOWLEDGE_EMBEDDING_PRICE: String(props.embeddingPrice),
      // «Probar búsqueda» (D88 (12)).
      KNOWLEDGE_BASE_ID: this.knowledgeBase.attrKnowledgeBaseId,
      // The only account whose buckets may be sources (D88 (10)), and their roles.
      ACCOUNT_ID: Stack.of(this).account,
      KNOWLEDGE_SOURCES_FUNCTION: this.sourcesFunction.functionName,
    };
  }

  /**
   * The synchronization (D88 (11), (16), (24)): a function with one step per state, run by a
   * standard state machine that mango-api starts, and every hour by a rule for the sweep. Its
   * role reads and writes the registry, reserves and settles budgets of people (`USER#…`),
   * ingests, reads the status of, deletes and searches the documents of the one Bedrock base,
   * deletes only under `kb/*\/docs/`, and writes the audit trail.
   */
  private buildSync(props: KnowledgeProps, bucketName: string): { fn: lambda.Function; machine: sfn.StateMachine } {
    const cfg = props.installation;
    const ns = this.namespace;
    const { account, region } = Stack.of(this);
    const machineName = mangoName(ns, "KnowledgeSync");
    // By name: the function starts the machine that invokes it, so neither may refer to the
    // other as a resource.
    const machineArn = `arn:aws:states:${region}:${account}:stateMachine:${machineName}`;
    const documents = `${this.bucket.bucketArn}/${KNOWLEDGE_PREFIXES.bases}*/docs/*`;
    const role = new iam.Role(this, "SyncRole", {
      roleName: mangoName(ns, "KnowledgeSync"),
      description: "Knowledge sync: ingests, verifies and deletes the documents of the knowledge bases",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    const policy = new iam.Policy(this, "SyncPolicy", {
      roles: [role],
      statements: [
        new iam.PolicyStatement({
          sid: "Registry",
          actions: [
            "dynamodb:DeleteItem",
            "dynamodb:GetItem",
            "dynamodb:PutItem",
            "dynamodb:Query",
            "dynamodb:UpdateItem",
          ],
          resources: [this.table.tableArn, `${this.table.tableArn}/index/${KNOWLEDGE_ALL}`],
        }),
        new iam.PolicyStatement({
          sid: "ReserveAndSettleBudgets",
          // Only the budget of a person: the one who synchronizes (D88 (24)).
          actions: ["dynamodb:UpdateItem"],
          resources: [props.budgetsTable.tableArn],
          conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["USER#*"] } },
        }),
        new iam.PolicyStatement({
          sid: "DataKeyViaDynamoDB",
          actions: ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"],
          resources: [props.dataKey.keyArn],
          conditions: { StringEquals: { "kms:ViaService": `dynamodb.${region}.amazonaws.com` } },
        }),
        new iam.PolicyStatement({
          sid: "DirectIngestion",
          // The five AWS asks for direct ingestion ("Prerequisites for direct ingestion"):
          // without StartIngestionJob and ListKnowledgeBaseDocuments, Bedrock refuses
          // DeleteKnowledgeBaseDocuments with AccessDenied (seen in an installation on
          // 2026-10-22, D88 (34)). No ingestion job is ever started (D88 (23)).
          actions: DIRECT_INGESTION_ACTIONS,
          resources: [this.knowledgeBase.attrKnowledgeBaseArn],
        }),
        new iam.PolicyStatement({
          sid: "VerifyDeletion",
          // Only to verify a deletion: a search filtered by kb_id and the documents.
          actions: ["bedrock:Retrieve"],
          resources: [this.knowledgeBase.attrKnowledgeBaseArn],
        }),
        new iam.PolicyStatement({
          sid: "SavedDocuments",
          // Reading is the S3 location of an ingestion; deleting, a verified deletion; writing,
          // the copy of a document of a source (D88 (19)).
          actions: ["s3:DeleteObject", "s3:GetObject", "s3:PutObject"],
          resources: [documents],
        }),
        new iam.PolicyStatement({
          sid: "DocumentsKey",
          actions: ["kms:Decrypt", "kms:GenerateDataKey"],
          resources: [this.key.keyArn],
          conditions: { StringEquals: { "kms:ViaService": `s3.${region}.amazonaws.com` } },
        }),
        new iam.PolicyStatement({
          sid: "ReadSourcesAsWhoeverSynchronizes",
          // The role of each approved source (D88 (39)), always with the SourceIdentity of who
          // synchronizes (rule 5): the roles require it too.
          actions: ["sts:AssumeRole", "sts:SetSourceIdentity"],
          resources: [`arn:aws:iam::${account}:role/${mangoName(ns, "kbsrc-")}*`],
        }),
        new iam.PolicyStatement({
          sid: "AskForSourceRoles",
          // A source approved without a role, or removed with one, asks again (D88 (39)).
          actions: ["lambda:InvokeFunction"],
          resources: [`arn:aws:lambda:${region}:${account}:function:${mangoName(ns, "KnowledgeSources")}`],
        }),
        new iam.PolicyStatement({
          sid: "StartNextSync",
          actions: ["states:StartExecution"],
          resources: [machineArn],
        }),
        new iam.PolicyStatement({
          sid: "WriteAuditIndex",
          actions: ["dynamodb:PutItem"],
          resources: [props.auditIndex.tableArn],
        }),
        new iam.PolicyStatement({
          sid: "WriteAuditTrail",
          actions: ["firehose:PutRecord"],
          resources: [props.auditStream.deliveryStreamArn],
        }),
      ],
    });
    const bucketId = Stack.of(this).getLogicalId(this.bucket.node.defaultChild as s3.CfnBucket);
    acknowledge(role, { id: "AwsSolutions-IAM5[Resource::*]", reason: REASONS.xray });
    acknowledge(
      policy,
      {
        id: `AwsSolutions-IAM5[Resource::<${bucketId}.Arn>/${KNOWLEDGE_PREFIXES.bases}*/docs/*]`,
        reason: "Saved documents are keyed at runtime by ULIDs under kb/<kb_id>/docs/ (D88 (9)).",
      },
      {
        id: `AwsSolutions-IAM5[Resource::arn:aws:iam::<AWS::AccountId>:role/${mangoName(ns, "kbsrc-")}*]`,
        reason:
          "The roles of the sources are created at runtime, one per approved source (D88 (39)); each one trusts " +
          "only this role, with a SourceIdentity.",
      },
    );

    const fn = new PythonFunction(this, "Sync", {
      packageName: "mango-knowledge-sync",
      packagePath: "functions/knowledge-sync",
      retainLogs: cfg.retainData,
      handler: "mango_knowledge_sync.handler.lambda_handler",
      functionName: mangoName(ns, "KnowledgeSync"),
      description: "Steps of the knowledge sync: ingests, verifies and deletes documents (D88)",
      role,
      // A step is at most 25 documents, the deletions of one verification, or 3 minutes of
      // copying from a source (documents of up to 50 MB, held in memory while copied).
      timeout: Duration.minutes(5),
      memorySize: 1024,
      environment: {
        MANGO_NAMESPACE: ns,
        KNOWLEDGE_TABLE: this.table.tableName,
        KNOWLEDGE_BUCKET: bucketName,
        KNOWLEDGE_BASE_ID: this.knowledgeBase.attrKnowledgeBaseId,
        DATA_SOURCE_ID: this.dataSource.attrDataSourceId,
        ACCOUNT_ID: account,
        STATE_MACHINE_ARN: machineArn,
        BUDGETS_TABLE: props.budgetsTable.tableName,
        AUDIT_STREAM: props.auditStream.deliveryStreamName,
        AUDIT_INDEX_TABLE: props.auditIndex.tableName,
        EMBEDDING_PRICE: String(props.embeddingPrice),
        SOURCES_FUNCTION: mangoName(ns, "KnowledgeSources"),
      },
      environmentEncryption: props.configKey,
    }).function;
    fn.node.addDependency(policy);

    // --- The state machine ----------------------------------------------------------------
    const step = (id: string, stepName: string): sfnTasks.LambdaInvoke => {
      const task = new sfnTasks.LambdaInvoke(this, id, {
        lambdaFunction: fn,
        payload: sfn.TaskInput.fromObject({ step: stepName, state: sfn.JsonPath.entirePayload }),
        payloadResponseOnly: true,
        retryOnServiceExceptions: true,
        taskTimeout: sfn.Timeout.duration(Duration.minutes(6)),
      });
      // Throttled by Bedrock, or a table busy: the same step, later.
      task.addRetry({
        errors: ["RetryableStepError"],
        interval: Duration.seconds(10),
        maxAttempts: 8,
        backoffRate: 2,
      });
      return task;
    };
    const failed = new sfn.Fail(this, "SyncFailed", {
      error: "KnowledgeSyncFailed",
      cause: "The synchronization failed; its reservation and the lock were released. See the kb.sync event.",
    });
    const finish = step("Finish", "finish");
    finish.addCatch(failed, { errors: ["States.ALL"], resultPath: "$.finish_error" });
    const after = new sfn.Choice(this, "Failed?")
      .when(sfn.Condition.isPresent("$.error"), failed)
      .otherwise(new sfn.Succeed(this, "Synchronized"));
    finish.next(after);
    const forward = (id: string, stepName: string) => {
      const task = step(id, stepName);
      // Whatever fails after its retries ends in `finish`, which releases what was taken.
      task.addCatch(finish, { errors: ["States.ALL"], resultPath: "$.error" });
      return task;
    };
    const acquire = forward("Acquire", "acquire");
    const copy = forward("Copy", "copy");
    const plan = forward("Plan", "plan");
    const ingest = forward("Ingest", "ingest");
    const poll = forward("Poll", "poll");
    const remove = forward("Delete", "delete");
    const verify = forward("Verify", "verify");
    const sweep = step("Sweep", "sweep");
    const waitLock = new sfn.Wait(this, "WaitLock", { time: sfn.WaitTime.duration(Duration.seconds(30)) });
    const waitIndex = new sfn.Wait(this, "WaitIndex", { time: sfn.WaitTime.duration(Duration.seconds(10)) });
    const waitVerify = new sfn.Wait(this, "WaitVerify", { time: sfn.WaitTime.duration(Duration.seconds(20)) });

    const verifying = new sfn.Choice(this, "Verifying?")
      .when(
        sfn.Condition.isPresent("$.verifying[0]"),
        waitVerify.next(verify).next(
          new sfn.Choice(this, "Verified?").when(sfn.Condition.booleanEquals("$.verified", true), finish).otherwise(waitVerify),
        ),
      )
      .otherwise(finish);
    const deleting = new sfn.Choice(this, "Deleting?");
    deleting.when(sfn.Condition.isPresent("$.delete[0]"), remove.next(deleting)).otherwise(verifying);
    const indexing = new sfn.Choice(this, "Indexing?")
      .when(
        sfn.Condition.isPresent("$.indexing[0]"),
        waitIndex.next(poll).next(
          new sfn.Choice(this, "Polled?").when(sfn.Condition.booleanEquals("$.polled", true), deleting).otherwise(waitIndex),
        ),
      )
      .otherwise(deleting);
    const ingesting = new sfn.Choice(this, "Ingesting?");
    ingesting.when(sfn.Condition.isPresent("$.ingest[0]"), ingest.next(ingesting)).otherwise(indexing);
    const definition = new sfn.Choice(this, "Sweep?")
      .when(sfn.Condition.stringEquals("$.mode", "sweep"), sweep.next(new sfn.Succeed(this, "Swept")))
      .otherwise(
        acquire.next(
          new sfn.Choice(this, "Locked?")
            .when(
              sfn.Condition.booleanEquals("$.locked", true),
              copy.next(
                new sfn.Choice(this, "Copying?")
                  .when(sfn.Condition.booleanEquals("$.copy_more", true), copy)
                  .otherwise(plan.next(ingesting)),
              ),
            )
            .when(sfn.Condition.booleanEquals("$.gave_up", true), finish)
            .otherwise(waitLock.next(acquire)),
        ),
      );

    const logGroup = new logs.LogGroup(this, "SyncLogs", {
      logGroupName: `/aws/vendedlogs/states/${machineName}`,
      retention: logs.RetentionDays.THREE_MONTHS,
      encryptionKey: logsKeyOf(this),
      removalPolicy: cfg.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    const machine = new sfn.StateMachine(this, "SyncMachine", {
      stateMachineName: machineName,
      comment: "Synchronizes one knowledge base, or sweeps unfinished deletions (D88)",
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      stateMachineType: sfn.StateMachineType.STANDARD,
      timeout: SYNC_TIMEOUT,
      tracingEnabled: true,
      // The state is ids and counters; it is still not logged (D88 (12)).
      logs: { destination: logGroup, level: sfn.LogLevel.ALL, includeExecutionData: false },
    });
    acknowledge(
      machine,
      {
        id: "AwsSolutions-IAM5[Resource::*]",
        reason: `CloudWatch Logs delivery APIs (vended logs) and X-Ray have no resource scope. ${REASONS.xray}`,
      },
      {
        id: `AwsSolutions-IAM5[Resource::<${Stack.of(this).resolve(Stack.of(this).getLogicalId(fn.node.defaultChild as lambda.CfnFunction))}.Arn>:*]`,
        reason: REASONS.cdkGrant,
      },
    );

    new events.Rule(this, "SweepSchedule", {
      ruleName: mangoName(ns, "KnowledgeSync-sweep"),
      description: "Every hour: unfinished deletions of knowledge bases and dead synchronizations (D88 (16))",
      schedule: events.Schedule.rate(SWEEP_RATE),
      targets: [
        new targets.SfnStateMachine(machine, {
          input: events.RuleTargetInput.fromObject({ mode: "sweep" }),
          retryAttempts: 2,
        }),
      ],
    });

    const failures = new cloudwatch.MathExpression({
      expression: "FILL(failed, 0) + FILL(timedOut, 0)",
      usingMetrics: {
        failed: machine.metricFailed({ statistic: cloudwatch.Stats.SUM, period: Duration.minutes(5) }),
        timedOut: machine.metricTimedOut({ statistic: cloudwatch.Stats.SUM, period: Duration.minutes(5) }),
      },
      period: Duration.minutes(5),
    });
    const alarm = new cloudwatch.Alarm(this, "SyncFailedAlarm", {
      alarmName: mangoName(ns, "KnowledgeSync-failed"),
      alarmDescription:
        "A knowledge base synchronization failed or ran out of time: its documents may be neither indexed nor " +
        "deleted, and its status is «Error». Its reservation and the lock were released. Look first at the " +
        `executions of the ${machineName} state machine, then at the log group of the function of the same name.`,
      metric: failures,
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarm.addAlarmAction(new cloudwatchActions.SnsAction(props.alerts.topic));
    this.alarms.push(alarm);
    return { fn, machine };
  }

  /**
   * The `knowledge-retrieve` tool (D88 (14)). Its role reads the registry by key (the records
   * of the bases and the names of documents), searches the one Bedrock base, keeps the limit of
   * each person in the shared table (only its own items), and writes the audit trail. It reads
   * no document, ingests nothing and deletes nothing.
   */
  private buildRetrieve(props: KnowledgeProps): lambda.Function {
    const cfg = props.installation;
    const ns = this.namespace;
    const { region } = Stack.of(this);
    const role = new iam.Role(this, "RetrieveRole", {
      roleName: mangoName(ns, "KnowledgeRetrieve"),
      description: "Knowledge search tool: searches the knowledge bases the asker may use",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    const policy = new iam.Policy(this, "RetrievePolicy", {
      roles: [role],
      statements: [
        new iam.PolicyStatement({
          sid: "ReadRegistry",
          actions: ["dynamodb:BatchGetItem"],
          resources: [this.table.tableArn],
        }),
        new iam.PolicyStatement({
          sid: "DataKeyViaDynamoDB",
          actions: ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"],
          resources: [this.dataKey.keyArn],
          conditions: { StringEquals: { "kms:ViaService": `dynamodb.${region}.amazonaws.com` } },
        }),
        new iam.PolicyStatement({
          sid: "Search",
          actions: ["bedrock:Retrieve"],
          resources: [this.knowledgeBase.attrKnowledgeBaseArn],
        }),
        new iam.PolicyStatement({
          sid: "LimitPerPerson",
          // Only the items of this limit (`LIMIT#kb.retrieve#<sub>`), never another's.
          actions: ["dynamodb:GetItem", "dynamodb:PutItem"],
          resources: [props.rateLimitsTable.tableArn],
          conditions: {
            "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [`LIMIT#${RETRIEVE_LIMIT}#*`] },
          },
        }),
        new iam.PolicyStatement({
          sid: "WriteAuditIndex",
          actions: ["dynamodb:PutItem"],
          resources: [props.auditIndex.tableArn],
        }),
        new iam.PolicyStatement({
          sid: "WriteAuditTrail",
          actions: ["firehose:PutRecord"],
          resources: [props.auditStream.deliveryStreamArn],
        }),
      ],
    });
    acknowledge(role, { id: "AwsSolutions-IAM5[Resource::*]", reason: REASONS.xray });

    const fn = new PythonFunction(this, "Retrieve", {
      packageName: "mango-knowledge-retrieve",
      packagePath: "connectors/knowledge-retrieve",
      retainLogs: cfg.retainData,
      handler: "mango_knowledge_retrieve.handler.lambda_handler",
      functionName: mangoName(ns, "KnowledgeRetrieve"),
      description: "knowledge-retrieve tool: searches the knowledge bases the asker may use (D88)",
      role,
      timeout: Duration.seconds(30),
      memorySize: 512,
      environment: {
        MANGO_NAMESPACE: ns,
        COGNITO_ISSUER: props.issuer,
        COGNITO_CLIENT_ID: props.webClientId,
        TASKS_CLIENT_ID: props.tasksClientId,
        KNOWLEDGE_TABLE: this.table.tableName,
        KNOWLEDGE_BASE_ID: this.knowledgeBase.attrKnowledgeBaseId,
        RATE_LIMITS_TABLE: props.rateLimitsTable.tableName,
        AUDIT_STREAM: props.auditStream.deliveryStreamName,
        AUDIT_INDEX_TABLE: props.auditIndex.tableName,
      },
      environmentEncryption: props.configKey,
    }).function;
    fn.node.addDependency(policy);
    return fn;
  }

  /**
   * «Probar búsqueda» runs in mango-api, which publishes no metric of its own: each search
   * Bedrock refuses for its quota leaves a line in its log (`SEARCH_THROTTLED_LOG` of
   * `mango_api.knowledge`), and this filter adds it to `RetrieveThrottles`, the metric of the
   * tool, so the one alarm counts both. The words are read by their place in the line (the
   * format of `app.main`), like the filter of the rate limits (D71 (18)).
   */
  countApiThrottles(logGroup: logs.ILogGroup): void {
    new logs.MetricFilter(this, "ApiRetrieveThrottles", {
      logGroup,
      filterName: mangoName(this.namespace, "Api-knowledge-search-throttled"),
      filterPattern: logs.FilterPattern.spaceDelimited(
        "date",
        "time",
        "level",
        "logger",
        "word1",
        "word2",
        "word3",
        "...",
      )
        .whereString("level", "=", "WARNING")
        .whereString("logger", "=", "mango_api.knowledge")
        .whereString("word1", "=", "knowledge")
        .whereString("word2", "=", "search")
        .whereString("word3", "=", "throttled;"),
      metricNamespace: `${KNOWLEDGE_SIGNALS.namespacePrefix}/${this.namespace}`,
      metricName: KNOWLEDGE_SIGNALS.retrieveThrottles,
      metricValue: "1",
      unit: cloudwatch.Unit.COUNT,
    });
  }

  /**
   * `Mango-<ns>-KnowledgeSources` (D88 (10), (20)): the role of each approved source, created by
   * SDK and deleted when the source is removed, invoked only by mango-api with ids. Its own
   * role may only write roles under `Mango-<ns>-kbsrc-*` that carry `Mango-<ns>-kbsrc-boundary`:
   * IAM refuses any other, so a bug here cannot make a wider role nor touch one it did not make
   * (the pattern of the pack provisioner, and of D48 (7) for deleting). It reads the source from
   * the registry, never from the event.
   */
  private buildSources(props: KnowledgeProps): lambda.Function {
    const cfg = props.installation;
    const ns = this.namespace;
    const { account, region } = Stack.of(this);
    const withBoundary = { StringEquals: { "iam:PermissionsBoundary": this.sourceBoundary.managedPolicyArn } };
    const role = new iam.Role(this, "SourcesRole", {
      roleName: mangoName(ns, "KnowledgeSources"),
      description: "Creates and deletes the roles that read the approved sources of the knowledge bases",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    const policy = new iam.Policy(this, "SourcesPolicy", {
      roles: [role],
      statements: [
        new iam.PolicyStatement({
          sid: "CreateSourceRoleWithBoundary",
          actions: ["iam:CreateRole"],
          resources: [this.sourceRoleArns],
          conditions: withBoundary,
        }),
        new iam.PolicyStatement({
          sid: "SourceRolePolicyWithBoundary",
          // Every write on an existing role: IAM refuses it on a role without the boundary.
          actions: ["iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:DeleteRole"],
          resources: [this.sourceRoleArns],
          conditions: withBoundary,
        }),
        new iam.PolicyStatement({
          sid: "SourceRoleLifecycle",
          // `iam:PermissionsBoundary` is not a condition key of TagRole; GetRole stays without
          // it to report a role that lost its boundary. No Attach/Detach, no boundary changes,
          // no trust updates, no PassRole.
          actions: ["iam:GetRole", "iam:TagRole"],
          resources: [this.sourceRoleArns],
        }),
        new iam.PolicyStatement({
          sid: "ReadAndMarkSources",
          actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
          resources: [this.table.tableArn],
        }),
        new iam.PolicyStatement({
          sid: "DataKeyViaDynamoDB",
          actions: ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"],
          resources: [props.dataKey.keyArn],
          conditions: { StringEquals: { "kms:ViaService": `dynamodb.${region}.amazonaws.com` } },
        }),
      ],
    });
    acknowledge(role, { id: "AwsSolutions-IAM5[Resource::*]", reason: REASONS.xray });
    acknowledge(policy, {
      id: `AwsSolutions-IAM5[Resource::arn:aws:iam::<AWS::AccountId>:role/${mangoName(ns, "kbsrc-")}*]`,
      reason:
        "Roles of the sources are created at runtime, one per approved source (D88 (10)): the name prefix and " +
        "the condition on their permissions boundary are the scope.",
    });
    const fn = new PythonFunction(this, "Sources", {
      packageName: "mango-knowledge-sources",
      packagePath: "functions/knowledge-sources",
      retainLogs: cfg.retainData,
      handler: "mango_knowledge_sources.handler.lambda_handler",
      functionName: mangoName(ns, "KnowledgeSources"),
      description: "Creates and deletes the role of each approved source of a knowledge base (D88)",
      role,
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: {
        MANGO_NAMESPACE: ns,
        ACCOUNT_ID: account,
        KNOWLEDGE_TABLE: this.table.tableName,
        SOURCE_BOUNDARY_ARN: this.sourceBoundary.managedPolicyArn,
        // By name: the synchronization's role is the only principal a source role trusts.
        SYNC_ROLE_ARN: `arn:aws:iam::${account}:role/${mangoName(ns, "KnowledgeSync")}`,
      },
      environmentEncryption: props.configKey,
    }).function;
    fn.node.addDependency(policy);
    return fn;
  }

  /** Where the browser posts uploads: the bucket's regional host, for the CSP of the SPA. */
  get uploadOrigin(): string {
    return `https://${this.bucketRegionalDomain}`;
  }

  /**
   * mango-api: the registry of the knowledge bases (D88 (12)), and their documents (D88 (9)):
   * signing uploads under `uploads/`, checking them, and copying them to `kb/<kb_id>/docs/`. A managed policy of its own: the
   * inline policies of its role share one size limit, and the role is close to it. No
   * `DeleteItem` nor `Scan`: deleting is a status, and the synchronization removes the records
   * once it verified that no vector is left (D88 (16)).
   */
  grantApi(role: iam.Role): void {
    const { region } = Stack.of(this);
    const uploads = `${this.bucket.bucketArn}/${KNOWLEDGE_PREFIXES.uploads}*`;
    const savedDocuments = `${this.bucket.bucketArn}/${KNOWLEDGE_PREFIXES.bases}*/docs/*`;
    const policy = new iam.ManagedPolicy(this, "ApiPolicy", {
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
        // Reading is `HeadObject` and two ranges to check a document, and the copy's source.
        // Uploads are signed by `Mango-<ns>-Presign`, never with this role (`presign.ts`).
        new iam.PolicyStatement({
          sid: "Uploads",
          actions: ["s3:GetObject"],
          resources: [uploads],
        }),
        // The copy's destination; mango-api never reads nor deletes under `kb/`.
        new iam.PolicyStatement({
          sid: "SavedDocuments",
          actions: ["s3:PutObject"],
          resources: [savedDocuments],
        }),
        new iam.PolicyStatement({
          sid: "DocumentsKey",
          actions: ["kms:Decrypt", "kms:GenerateDataKey"],
          resources: [this.key.keyArn],
          conditions: { StringEquals: { "kms:ViaService": `s3.${region}.amazonaws.com` } },
        }),
        // «Probar búsqueda» (D88 (12)): one knowledge base at a time, with the tool's filter.
        new iam.PolicyStatement({
          sid: "SearchKnowledgeBase",
          actions: ["bedrock:Retrieve"],
          resources: [this.knowledgeBase.attrKnowledgeBaseArn],
        }),
        // A source on an existing bucket (D88 (10)): its encryption, asked with the expected
        // owner, says it is a bucket of this account. No listing, no reading of objects.
        new iam.PolicyStatement({
          sid: "CheckSourceBuckets",
          actions: ["s3:GetEncryptionConfiguration"],
          resources: ["arn:aws:s3:::*"],
          conditions: { StringEquals: { "s3:ResourceAccount": Stack.of(this).account } },
        }),
        // The roles of the sources, by ids (D88 (10)).
        new iam.PolicyStatement({
          sid: "SourceRoles",
          actions: ["lambda:InvokeFunction"],
          resources: [this.sourcesFunction.functionArn],
        }),
        // After saving, deleting a document or a base, or «Sincronizar ahora» (D88 (11)).
        new iam.PolicyStatement({
          sid: "StartSync",
          actions: ["states:StartExecution"],
          resources: [this.syncMachine.stateMachineArn],
        }),
      ],
    });
    const bucketId = Stack.of(this).getLogicalId(this.bucket.node.defaultChild as s3.CfnBucket);
    acknowledge(
      policy,
      {
        id: `AwsSolutions-IAM5[Resource::<${bucketId}.Arn>/${KNOWLEDGE_PREFIXES.uploads}*]`,
        reason: "Uploads are keyed at runtime by caller and ULIDs (D88 (9)); the prefix uploads/ is the scope.",
      },
      {
        id: `AwsSolutions-IAM5[Resource::<${bucketId}.Arn>/${KNOWLEDGE_PREFIXES.bases}*/docs/*]`,
        reason: "Saved documents are keyed at runtime by ULIDs under kb/<kb_id>/docs/ (D88 (9)).",
      },
      {
        id: "AwsSolutions-IAM5[Resource::arn:aws:s3:::*]",
        reason:
          "Sources name buckets of the installation's account at runtime (D88 (10)): only their encryption " +
          "configuration is read, and only of buckets of this account (s3:ResourceAccount).",
      },
    );
  }
}
