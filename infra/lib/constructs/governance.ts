import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CfnResource, Duration, RemovalPolicy, Stack, Token } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as firehose from "aws-cdk-lib/aws-kinesisfirehose";
import * as kms from "aws-cdk-lib/aws-kms";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as avp from "aws-cdk-lib/aws-verifiedpermissions";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import { GUARD_EXCEPTIONS, suppressGuard } from "../guard.js";
import { logsKeyOf } from "../logs.js";
import { accessGroupRegistry } from "../config/groups.js";
import { Installation } from "../config/schema.js";
import { acknowledge, arnWildcardFinding, KMS_GRANT_ACTIONS, REASONS } from "../nag.js";
import { mangoName } from "../names.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PLATFORM_POLICIES = resolve(REPO_ROOT, "policies/cedar/platform");
/** Partition of the Settings table that holds the registry of access groups (D26). */
export const GROUPS_PARTITION = "GROUPS";

/** Index names of the Agents table; keep in sync with `mango_core.agents_table`. */
export const AGENTS_BY_STATUS = "ByStatus";
export const AGENTS_BY_CREATOR = "ByCreator";
/**
 * Partition prefix of the Agents table that says what is live (`PUBLISHED#<agent id>`). Only
 * the provisioner writes it; keep in sync with `mango_core.agents_table.PUBLISHED_PREFIX`.
 */
export const AGENTS_PUBLISHED_PARTITION = "PUBLISHED#";
/** Partition of the Settings table that holds the model catalog (rule 7). */
export const MODELS_PARTITION = "MODELS";

export interface GovernanceProps {
  /** Object Lock mode chosen at deployment (release templates, D58); overrides `audit.mode`. */
  readonly auditLockMode?: string;
  readonly installation: Installation;
  /** Only this role may assume the conversation data-access role. */
  readonly apiTaskRole: iam.IRole;
}

/**
 * Governance data plane: conversations (row-level security), budget counters,
 * L1 authorization (Verified Permissions) and the immutable audit trail.
 */
export class Governance extends Construct {
  readonly conversations: dynamodb.TableV2;
  readonly budgets: dynamodb.TableV2;
  /** 30-day index of audit events for the admin UI; the immutable copy is in S3. */
  readonly auditIndex: dynamodb.TableV2;
  /**
   * Admin-editable configuration (D17): budget limits, the versioned area -> OU mapping and
   * the registry of access groups (D26).
   * Only mango-api writes to it (plus the put-if-absent IaC seed, see `seedSettings`); the
   * connector reads the mapping partition only.
   */
  readonly settings: dynamodb.TableV2;
  /**
   * Versioned agent definitions (Marketplace v1, D18). Item layout and indexes:
   * `packages/py/mango-core/src/mango_core/agents_table.py`.
   */
  readonly agents: dynamodb.TableV2;
  /**
   * Web sessions (D63): the hash of each session id, who it belongs to and when it ends, plus
   * a mark per user that ends their sessions. Never a token: the refresh token travels
   * encrypted in the cookie.
   */
  readonly webSessions: dynamodb.TableV2;
  /**
   * Counters of the rate limits every mango-api task shares (D70): the hits of each limit and
   * caller inside its window. Each item expires shortly after its window.
   */
  readonly rateLimits: dynamodb.TableV2;
  readonly dataKey: kms.Key;
  /** Role assumed per request with a `dynamodb:LeadingKeys` session policy (RLS). */
  readonly dataAccessRole: iam.Role;
  readonly policyStore: avp.CfnPolicyStore;
  readonly auditStream: firehose.DeliveryStream;
  readonly auditBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: GovernanceProps) {
    super(scope, id);
    const cfg = props.installation;
    const removal = cfg.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const account = Stack.of(this).account;

    const key = (this.dataKey = new kms.Key(this, "DataKey", {
      alias: `alias/${mangoName(cfg.namespace, "data")}`,
      description: "Mango conversations, budgets and audit trail",
      enableKeyRotation: true,
      removalPolicy: cfg.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    }));

    const tableProps = {
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      encryption: dynamodb.TableEncryptionV2.customerManagedKey(key),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: cfg.retainData,
      removalPolicy: removal,
    };
    this.conversations = new dynamodb.TableV2(this, "Conversations", {
      ...tableProps,
      tableName: mangoName(cfg.namespace, "Conversations"),
      timeToLiveAttribute: "ttl",
    });
    this.budgets = new dynamodb.TableV2(this, "Budgets", {
      ...tableProps,
      tableName: mangoName(cfg.namespace, "Budgets"),
      timeToLiveAttribute: "ttl",
    });

    this.auditIndex = new dynamodb.TableV2(this, "AuditIndex", {
      ...tableProps,
      tableName: mangoName(cfg.namespace, "AuditIndex"),
      timeToLiveAttribute: "ttl",
    });

    this.settings = new dynamodb.TableV2(this, "Settings", {
      ...tableProps,
      tableName: mangoName(cfg.namespace, "Settings"),
      // Closed change requests expire from the table; the audit trail keeps the evidence.
      timeToLiveAttribute: "ttl",
    });
    this.webSessions = new dynamodb.TableV2(this, "WebSessions", {
      ...tableProps,
      tableName: mangoName(cfg.namespace, "WebSessions"),
      // A session expires with its limit; a revocation mark, two days later.
      timeToLiveAttribute: "ttl",
    });
    this.rateLimits = new dynamodb.TableV2(this, "RateLimits", {
      ...tableProps,
      tableName: mangoName(cfg.namespace, "RateLimits"),
      timeToLiveAttribute: "ttl",
    });
    this.seedSettings(cfg);
    this.allowModelListing(props.apiTaskRole);

    this.agents = new dynamodb.TableV2(this, "Agents", {
      ...tableProps,
      tableName: mangoName(cfg.namespace, "Agents"),
      // Only the per-creator daily submission counters expire; agents and versions never do.
      timeToLiveAttribute: "ttl",
      globalSecondaryIndexes: [
        {
          // Sparse: versions in review, approved, failed, published or retired.
          indexName: AGENTS_BY_STATUS,
          partitionKey: { name: "status_index", type: dynamodb.AttributeType.STRING },
          sortKey: { name: "status_at", type: dynamodb.AttributeType.STRING },
        },
        {
          // Sparse: versions by who created them (drafts and the per-creator limits).
          indexName: AGENTS_BY_CREATOR,
          partitionKey: { name: "creator_index", type: dynamodb.AttributeType.STRING },
          sortKey: { name: "created_at", type: dynamodb.AttributeType.STRING },
        },
      ],
    });

    this.dataAccessRole = new iam.Role(this, "DataAccessRole", {
      roleName: mangoName(cfg.namespace, "ConversationData"),
      description: "Assumed per request with a LeadingKeys session policy (row-level security)",
      assumedBy: new iam.AccountPrincipal(account).withConditions({
        ArnEquals: { "aws:PrincipalArn": props.apiTaskRole.roleArn },
      }),
      maxSessionDuration: Duration.hours(1),
    });
    this.conversations.grantReadWriteData(this.dataAccessRole);
    acknowledge(this.dataAccessRole, ...KMS_GRANT_ACTIONS);

    // --- L1 authorization: Verified Permissions --------------------------------------
    const schema = readFileSync(resolve(PLATFORM_POLICIES, "schema.cedarschema.json"), "utf8");
    this.policyStore = new avp.CfnPolicyStore(this, "PolicyStore", {
      description: `Mango ${cfg.namespace} platform authorization (L1)`,
      validationSettings: { mode: "STRICT" },
      schema: { cedarJson: JSON.stringify(JSON.parse(schema)) },
      deletionProtection: { mode: cfg.retainData ? "ENABLED" : "DISABLED" },
    });
    for (const file of readdirSync(PLATFORM_POLICIES).filter((f) => f.endsWith(".cedar"))) {
      new avp.CfnPolicy(this, `Policy-${file.replace(/\.cedar$/, "")}`, {
        policyStoreId: this.policyStore.attrPolicyStoreId,
        definition: {
          static: {
            description: file,
            statement: readFileSync(resolve(PLATFORM_POLICIES, file), "utf8"),
          },
        },
      });
    }

    // --- Audit trail: Firehose -> S3 Object Lock + KMS ------------------------------------
    const accessLogs = new s3.Bucket(this, "AccessLogs", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      removalPolicy: removal,
      autoDeleteObjects: !cfg.retainData,
      lifecycleRules: [{ expiration: Duration.days(90) }],
    });
    suppressGuard(
      accessLogs.node.defaultChild as CfnResource,
      GUARD_EXCEPTIONS.logBucketLogging,
      GUARD_EXCEPTIONS.logBucketVersioning,
    );
    // A release decides days and mode at deployment (overridden below): the construct only
    // validates literal values.
    const lockDays = Token.isUnresolved(cfg.audit.retentionDays) ? 1 : cfg.audit.retentionDays;
    const lock =
      cfg.audit.mode === "COMPLIANCE"
        ? s3.ObjectLockRetention.compliance(Duration.days(lockDays))
        : s3.ObjectLockRetention.governance(Duration.days(lockDays));
    this.auditBucket = new s3.Bucket(this, "Audit", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: key,
      bucketKeyEnabled: true,
      objectLockDefaultRetention: lock,
      serverAccessLogsBucket: accessLogs,
      serverAccessLogsPrefix: "audit/",
      // Audit evidence is never deleted with the stack.
      removalPolicy: RemovalPolicy.RETAIN,
    });
    if (props.auditLockMode !== undefined) {
      const retention = "ObjectLockConfiguration.Rule.DefaultRetention";
      const bucket = this.auditBucket.node.defaultChild as s3.CfnBucket;
      bucket.addPropertyOverride(`${retention}.Mode`, props.auditLockMode);
      bucket.addPropertyOverride(`${retention}.Days`, cfg.audit.retentionDays);
    }

    this.auditStream = new firehose.DeliveryStream(this, "AuditStream", {
      deliveryStreamName: mangoName(cfg.namespace, "Audit"),
      encryption: firehose.StreamEncryption.awsOwnedKey(),
      destination: new firehose.S3Bucket(this.auditBucket, {
        loggingConfig: new firehose.EnableLogging(
          new logs.LogGroup(this, "AuditStreamLogs", {
            retention: logs.RetentionDays.THREE_MONTHS,
            encryptionKey: logsKeyOf(this),
            removalPolicy: removal,
          }),
        ),
        dataOutputPrefix: "events/!{timestamp:yyyy/MM/dd}/",
        errorOutputPrefix: "errors/!{firehose:error-output-type}/!{timestamp:yyyy/MM/dd}/",
        bufferingInterval: Duration.seconds(60),
        encryptionKey: key,
      }),
    });
    // The Firehose delivery role is generated by CDK and scoped to the audit bucket and key.
    acknowledge(
      this.auditStream,
      ...KMS_GRANT_ACTIONS,
      ...["s3:Abort*", "s3:DeleteObject*", "s3:GetBucket*", "s3:GetObject*", "s3:List*"].map((a) => ({
        id: `AwsSolutions-IAM5[Action::${a}]`,
        reason: REASONS.cdkGrant,
      })),
      {
        id: arnWildcardFinding(this.auditBucket.node.defaultChild as CfnResource, "/*"),
        reason: REASONS.cdkGrant,
      },
    );
  }

  /**
   * Brains (D38): mango-api asks Bedrock which models the account has in this region, to
   * refresh the model catalog. Both actions only list (nothing is invoked) and neither
   * supports resource-level permissions, so `*` is the only resource IAM accepts for them.
   */
  private allowModelListing(apiTaskRole: iam.IRole): void {
    apiTaskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "ListBedrockModels",
        actions: ["bedrock:ListFoundationModels", "bedrock:ListInferenceProfiles"],
        resources: ["*"],
      }),
    );
    acknowledge(apiTaskRole, {
      id: "AwsSolutions-IAM5[Resource::*]",
      reason:
        "bedrock:ListFoundationModels and bedrock:ListInferenceProfiles do not support resource-level permissions; a test keeps them as the only `*` statement of the role.",
    });
  }

  /** mango-api reads, writes and deletes session records by key (D63): no `Query`, no `Scan`. */
  grantWebSessions(grantee: iam.IGrantable): void {
    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "WebSessionsTable",
        actions: ["dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:PutItem"],
        resources: [this.webSessions.tableArn],
      }),
    );
  }

  /**
   * mango-api counts its shared rate limits by key (D70): a consistent read and a conditional
   * put. No `UpdateItem`, `DeleteItem`, `Query` or `Scan`: nothing lists who was counted, and
   * a counter only leaves through the table TTL.
   */
  grantRateLimits(grantee: iam.IGrantable): void {
    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "RateLimitsTable",
        actions: ["dynamodb:GetItem", "dynamodb:PutItem"],
        resources: [this.rateLimits.tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["LIMIT#*"] } },
      }),
    );
  }

  /**
   * mango-api reads and writes agent definitions (D18): the table and its two indexes by
   * name, no `Scan`. Publishing belongs to the provisioner: mango-api is explicitly denied
   * writing the `PUBLISHED#` partition, which is what decides the version that is served, so
   * no path through mango-api can publish content that was not deployed by hash (TM-M2).
   */
  grantAgents(grantee: iam.IGrantable): void {
    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "AgentsTable",
        actions: [
          "dynamodb:BatchGetItem",
          "dynamodb:ConditionCheckItem",
          "dynamodb:DeleteItem",
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:Query",
          "dynamodb:UpdateItem",
        ],
        resources: [
          this.agents.tableArn,
          ...[AGENTS_BY_STATUS, AGENTS_BY_CREATOR].map((index) => `${this.agents.tableArn}/index/${index}`),
        ],
      }),
    );
    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "PublishedPointerIsProvisionerOnly",
        effect: iam.Effect.DENY,
        actions: ["dynamodb:DeleteItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
        resources: [this.agents.tableArn],
        conditions: {
          "ForAnyValue:StringLike": { "dynamodb:LeadingKeys": [`${AGENTS_PUBLISHED_PARTITION}*`] },
        },
      }),
    );
    this.dataKey.grantEncryptDecrypt(grantee);
  }

  /**
   * Accepted exception to "only mango-api writes Settings" (TM-A6, review ADM-07): these seed
   * custom resources may `PutItem` their own partition only, and the call is put-if-absent.
   * IAM cannot enforce the condition expression, so the permission lives on the CDK singleton
   * provider role, which only CloudFormation invokes.
   *
   * Seed the Settings table from the installation config **only if the items are absent**
   * (`attribute_not_exists(PK)`), on create and on every update. After the first deployment
   * the table is authoritative: later changes to `budgets`, `businessUnits` or `accessGroups`
   * in the IaC config never overwrite values edited in the app (D17). The model catalog
   * (rule 7) is seeded the same way from `models` and `modelPrices`: only the agent model
   * starts enabled.
   */
  private seedSettings(cfg: Installation): void {
    const units = Object.fromEntries(
      Object.entries(cfg.businessUnits)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([area, ous]) => [area, [...new Set(ous)].sort()]),
    );
    const models = Object.entries(cfg.modelPrices)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, price]) => ({
        id,
        name: id,
        provider: id.split(".")[1] ?? "unknown",
        enabled: id === cfg.models.agent,
        // Every model the installation schema accepts today supports tool use.
        supports_tools: true,
        input_usd: String(price.input),
        output_usd: String(price.output),
        cache_read_usd: String(price.cacheRead),
        cache_write_usd: String(price.cacheWrite),
      }));
    const items: Record<string, Record<string, unknown>> = {
      SeedBudgetDefaults: {
        PK: { S: "BUDGETS" },
        SK: { S: "DEFAULTS" },
        user_monthly_usd: { N: String(cfg.budgets.userMonthlyUsd) },
        agent_monthly_usd: { N: String(cfg.budgets.agentMonthlyUsd) },
        version: { N: "1" },
        updated_by: { S: "iac-seed" },
      },
      SeedBusinessUnits: {
        PK: { S: "BU_MAPPING" },
        SK: { S: "CURRENT" },
        units: { S: JSON.stringify(units) },
        version: { N: "1" },
        updated_by: { S: "iac-seed" },
      },
      SeedModelCatalog: {
        PK: { S: MODELS_PARTITION },
        SK: { S: "CATALOG" },
        models: { S: JSON.stringify(models) },
        version: { N: "1" },
        updated_by: { S: "iac-seed" },
      },
    };
    const calls: Record<string, { partition: string; call: Omit<cr.AwsSdkCall, "physicalResourceId"> }> =
      {};
    for (const [id, item] of Object.entries(items)) {
      calls[id] = {
        partition: (item.PK as { S: string }).S,
        call: {
          service: "DynamoDB",
          action: "putItem",
          parameters: {
            TableName: this.settings.tableName,
            Item: item,
            ConditionExpression: "attribute_not_exists(PK)",
          },
          // The item already exists: keep the value edited in the app.
          ignoreErrorCodesMatching: "ConditionalCheckFailedException",
        },
      };
    }
    // Access group registry (D26): one item per group, all in one transaction. Any group that
    // already exists cancels it, so the registry is seeded only while it is empty; afterwards
    // groups are created and changed in the app, with dual approval.
    calls.SeedGroups = {
      partition: GROUPS_PARTITION,
      call: {
        service: "DynamoDB",
        action: "transactWriteItems",
        parameters: {
          TransactItems: accessGroupRegistry(cfg).map((group) => ({
            Put: {
              TableName: this.settings.tableName,
              Item: {
                PK: { S: GROUPS_PARTITION },
                SK: { S: group.id },
                type: { S: group.type },
                ...(group.area ? { area: { S: group.area } } : {}),
                description: { S: group.description },
                updated_by: { S: "iac-seed" },
              },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          })),
        },
        ignoreErrorCodesMatching: "TransactionCanceledException",
      },
    };
    for (const [id, { partition, call }] of Object.entries(calls)) {
      const putIfAbsent: cr.AwsSdkCall = {
        ...call,
        physicalResourceId: cr.PhysicalResourceId.of(`settings-seed-${partition}`),
      };
      const seed = new cr.AwsCustomResource(this, id, {
        onCreate: putIfAbsent,
        onUpdate: putIfAbsent,
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ["dynamodb:PutItem"],
            resources: [this.settings.tableArn],
            conditions: { "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [partition] } },
          }),
          new iam.PolicyStatement({
            actions: ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"],
            resources: [this.dataKey.keyArn],
            // Only through DynamoDB, never direct use of the shared data key.
            conditions: {
              StringEquals: { "kms:ViaService": `dynamodb.${Stack.of(this).region}.amazonaws.com` },
            },
          }),
        ]),
        installLatestAwsSdk: false,
      });
      seed.node.addDependency(this.settings);
    }
  }
}
