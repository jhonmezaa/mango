import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { loadInstallation } from "../lib/config/schema.js";
import { INDEXING_PROFILE, KNOWLEDGE_ALL, KNOWLEDGE_PREFIXES, KNOWLEDGE_SIGNALS } from "../lib/constructs/knowledge.js";
import { CoreStack } from "../lib/stacks/core-stack.js";

/* The fixed resources of the knowledge bases (D88 (7), (18), (21); knowledge-bases-threat-model.md). */

const cfg = loadInstallation(resolve(import.meta.dirname, "../config/example.json"));
const ns = cfg.namespace;
const account = cfg.mangoAccountId;
const region = cfg.region;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resource = { Type: string; Properties: any; [k: string]: any };
interface Statement {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource: unknown;
  Principal?: unknown;
  Condition?: Record<string, Record<string, unknown>>;
}

const template = Template.fromStack(
  new CoreStack(new App({ context: { skipSpa: true } }), "Core", {
    installation: cfg,
    env: { account, region },
  }),
);
const resources = template.toJSON().Resources as Record<string, Resource>;
const actions = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
function only(type: string, props: Record<string, unknown>): [string, Resource] {
  const found = Object.entries(template.findResources(type, { Properties: props }));
  expect(found).toHaveLength(1);
  return found[0] as [string, Resource];
}
function ofType(type: string): [string, Resource][] {
  return Object.entries(resources).filter(([, r]) => r.Type === type);
}
function statementsOf(roleId: string): Statement[] {
  return Object.values(resources)
    .filter(
      (r) =>
        (r.Type === "AWS::IAM::Policy" || r.Type === "AWS::IAM::ManagedPolicy") &&
        (r.Properties.Roles ?? []).some((x: { Ref: string }) => x.Ref === roleId),
    )
    .flatMap((r) => r.Properties.PolicyDocument.Statement as Statement[]);
}
const bySid = (statements: Statement[]) => Object.fromEntries(statements.filter((s) => s.Sid).map((s) => [s.Sid!, s]));

const [, alias] = only("AWS::KMS::Alias", { AliasName: `alias/Mango-${ns}-knowledge` });
const keyId = (alias.Properties.TargetKeyId as { "Fn::GetAtt": string[] })["Fn::GetAtt"][0]!;
const key = resources[keyId]!;
const [bucketId, bucket] = ofType("AWS::S3::Bucket").find(([, r]) =>
  JSON.stringify(r.Properties.BucketEncryption ?? {}).includes(keyId),
)!;
const [vectorBucketId, vectorBucket] = only("AWS::S3Vectors::VectorBucket", { VectorBucketName: `mango-${ns}-knowledge` });
const [indexId, index] = only("AWS::S3Vectors::Index", { IndexName: INDEXING_PROFILE.indexName });
const [roleId, role] = only("AWS::IAM::Role", { RoleName: `Mango-${ns}-KnowledgeBase` });
const [kbId, kb] = only("AWS::Bedrock::KnowledgeBase", { Name: `Mango-${ns}-knowledge` });
const retained = cfg.retainData ? "Retain" : "Delete";

describe("knowledge bases: fixed resources in Core", () => {
  it("keeps the documents in a bucket of their own: its key, TLS only, no ACLs, no public access", () => {
    expect(key.Properties.EnableKeyRotation).toBe(true);
    const encryption = bucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0];
    expect(encryption.ServerSideEncryptionByDefault.SSEAlgorithm).toBe("aws:kms");
    expect(encryption.BucketKeyEnabled).toBe(true);
    expect(bucket.Properties.OwnershipControls.Rules).toEqual([{ ObjectOwnership: "BucketOwnerEnforced" }]);
    expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    expect(bucket.Properties.LoggingConfiguration.LogFilePrefix).toBe("knowledge/");
    // The access logs bucket takes its logs by name, never by the bucket resource: a reference
    // closes a cycle through the load balancer and the distribution (see cycles.test.ts).
    const logs = Object.values(template.findResources("AWS::S3::BucketPolicy"))
      .flatMap((p) => p.Properties.PolicyDocument.Statement as Statement[])
      .find((st) => st.Sid === "KnowledgeDocumentsAccessLogs")!;
    expect(actions(logs)).toEqual(["s3:PutObject"]);
    expect(logs.Principal).toEqual({ Service: "logging.s3.amazonaws.com" });
    expect(JSON.stringify(logs.Condition)).toContain(`mango-${ns}-knowledge-`);
    expect(JSON.stringify(logs.Condition)).not.toContain(bucketId);
    const [, policy] = only("AWS::S3::BucketPolicy", { Bucket: { Ref: bucketId } });
    expect(
      (policy.Properties.PolicyDocument.Statement as Statement[]).some(
        (s) => s.Effect === "Deny" && JSON.stringify(s.Condition).includes("aws:SecureTransport"),
      ),
    ).toBe(true);
  });

  it("forgets unsaved uploads and old versions after a day (TM-K4, TM-K5)", () => {
    expect(bucket.Properties.VersioningConfiguration.Status).toBe("Enabled");
    const rules = bucket.Properties.LifecycleConfiguration.Rules as Record<string, unknown>[];
    expect(rules).toContainEqual(
      expect.objectContaining({ Prefix: KNOWLEDGE_PREFIXES.uploads, ExpirationInDays: 1, Status: "Enabled" }),
    );
    expect(rules).toContainEqual(
      expect.objectContaining({ NoncurrentVersionExpiration: { NoncurrentDays: 1 }, Status: "Enabled" }),
    );
    // Nothing else expires: documents stay until someone deletes them.
    expect(rules.filter((r) => r.ExpirationInDays !== undefined)).toHaveLength(1);
  });

  it("encrypts the vectors with the same key, which S3 Vectors may only use for this account", () => {
    expect(vectorBucket.Properties.EncryptionConfiguration).toEqual({
      SseType: "aws:kms",
      KmsKeyArn: { "Fn::GetAtt": [keyId, "Arn"] },
    });
    const indexing = (key.Properties.KeyPolicy.Statement as Statement[]).find((s) => s.Sid === "S3VectorsIndexing")!;
    expect(indexing.Principal).toEqual({ Service: "indexing.s3vectors.amazonaws.com" });
    expect(actions(indexing)).toEqual(["kms:Decrypt"]);
    expect(indexing.Condition!.StringEquals).toEqual({ "aws:SourceAccount": account });
    expect(indexing.Condition!.ArnLike).toEqual({ "aws:SourceArn": `arn:aws:s3vectors:${region}:${account}:bucket/*` });
  });

  it("indexes with one profile: Titan v2, 1024 dimensions, cosine, metadata of Mango filterable", () => {
    expect(index.Properties).toMatchObject({
      VectorBucketArn: { "Fn::GetAtt": [vectorBucketId, "VectorBucketArn"] },
      DataType: "float32",
      Dimension: 1024,
      DistanceMetric: "cosine",
      MetadataConfiguration: { NonFilterableMetadataKeys: ["AMAZON_BEDROCK_TEXT", "AMAZON_BEDROCK_METADATA"] },
    });
    const vector = kb.Properties.KnowledgeBaseConfiguration.VectorKnowledgeBaseConfiguration;
    expect(vector.EmbeddingModelArn).toBe(`arn:aws:bedrock:${region}::foundation-model/amazon.titan-embed-text-v2:0`);
    expect(vector.EmbeddingModelConfiguration.BedrockEmbeddingModelConfiguration.Dimensions).toBe(1024);
    expect(kb.Properties.StorageConfiguration).toEqual({
      Type: "S3_VECTORS",
      S3VectorsConfiguration: { IndexArn: { "Fn::GetAtt": [indexId, "IndexArn"] } },
    });
    expect(kb.Properties.RoleArn).toEqual({ "Fn::GetAtt": [roleId, "Arn"] });
  });

  it("has one CUSTOM data source: documents are ingested directly, never by an ingestion job (D88 (23))", () => {
    const sources = ofType("AWS::Bedrock::DataSource");
    expect(sources).toHaveLength(1);
    const [, source] = sources[0]!;
    expect(source.Properties.KnowledgeBaseId).toEqual({ "Fn::GetAtt": [kbId, "KnowledgeBaseId"] });
    expect(source.Properties.DataSourceConfiguration).toEqual({ Type: "CUSTOM" });
    expect(source.Properties.VectorIngestionConfiguration).toBeUndefined();
  });

  it("lets Bedrock assume the service role only for knowledge bases of this account", () => {
    const [trust] = role.Properties.AssumeRolePolicyDocument.Statement as Statement[];
    expect(trust!.Principal).toEqual({ Service: "bedrock.amazonaws.com" });
    expect(trust!.Condition).toEqual({
      StringEquals: { "aws:SourceAccount": account },
      ArnLike: { "aws:SourceArn": `arn:aws:bedrock:${region}:${account}:knowledge-base/*` },
    });
    // The base is created after the policy that lets it read and write.
    expect(JSON.stringify(resources[kbId]!.DependsOn ?? [])).toMatch(/ServicePolicy/);
  });

  it("gives the service role kb/* of the documents, one model and one index, nothing else (TM-K7)", () => {
    const statements = statementsOf(roleId);
    const sids = bySid(statements);
    expect(Object.keys(sids).sort()).toEqual(
      ["DocumentsKey", "EmbeddingModel", "ListDocuments", "ReadDocuments", "VectorIndex", "VectorsKey"].sort(),
    );
    expect(statements).toHaveLength(6);
    expect(actions(sids.EmbeddingModel!)).toEqual(["bedrock:InvokeModel"]);
    expect(sids.EmbeddingModel!.Resource).toBe(
      `arn:aws:bedrock:${region}::foundation-model/${INDEXING_PROFILE.embeddingModel}`,
    );
    expect(actions(sids.ReadDocuments!)).toEqual(["s3:GetObject"]);
    expect(JSON.stringify(sids.ReadDocuments!.Resource)).toContain(`/${KNOWLEDGE_PREFIXES.bases}*`);
    expect(JSON.stringify(sids.ReadDocuments!.Resource)).toContain(bucketId);
    expect(sids.ListDocuments!.Condition!.StringLike).toEqual({ "s3:prefix": [`${KNOWLEDGE_PREFIXES.bases}*`] });
    expect(actions(sids.DocumentsKey!)).toEqual(["kms:Decrypt"]);
    expect(sids.DocumentsKey!.Condition!.StringEquals).toEqual({ "kms:ViaService": `s3.${region}.amazonaws.com` });
    expect(sids.VectorIndex!.Resource).toEqual({ "Fn::GetAtt": [indexId, "IndexArn"] });
    expect(actions(sids.VectorIndex!).every((a) => a.startsWith("s3vectors:") && !a.includes("*"))).toBe(true);
    expect(sids.VectorsKey!.Condition!.StringEquals).toEqual({ "kms:ViaService": `s3vectors.${region}.amazonaws.com` });
    for (const s of statements) {
      expect(JSON.stringify(s.Resource)).not.toBe('"*"');
      expect(actions(s).some((a) => a.endsWith("*"))).toBe(false);
    }
  });

  it("keeps the registry in Mango-<ns>-Knowledge, with the data key, PITR and deletion protection", () => {
    const [, table] = only("AWS::DynamoDB::GlobalTable", { TableName: `Mango-${ns}-Knowledge` });
    expect(table.Properties.SSESpecification.SSEType).toBe("KMS");
    const replica = table.Properties.Replicas[0];
    expect(replica.PointInTimeRecoverySpecification).toEqual({ PointInTimeRecoveryEnabled: true });
    expect(replica.DeletionProtectionEnabled).toBe(cfg.retainData);
    expect(table.Properties.GlobalSecondaryIndexes.map((i: { IndexName: string }) => i.IndexName)).toEqual([KNOWLEDGE_ALL]);
    // The throttling alarm every table of the stack gets (D71).
    only("AWS::CloudWatch::Alarm", { AlarmName: `Mango-${ns}-Table-Knowledge-throttled` });
  });

  it("retains documents, vectors, their key and the registry with the installation's data", () => {
    for (const id of [bucketId, vectorBucketId, indexId, keyId]) {
      expect(resources[id]!.DeletionPolicy).toBe(retained);
    }
    const [tableId] = only("AWS::DynamoDB::GlobalTable", { TableName: `Mango-${ns}-Knowledge` });
    expect(resources[tableId]!.DeletionPolicy).toBe(retained);
  });

  it("bounds the roles of existing buckets: this account only, never a bucket of Mango (TM-K2)", () => {
    const [, boundary] = only("AWS::IAM::ManagedPolicy", { ManagedPolicyName: `Mango-${ns}-kbsrc-boundary` });
    const statements = boundary.Properties.PolicyDocument.Statement as Statement[];
    const sids = bySid(statements);
    expect(statements).toHaveLength(2);
    expect(actions(sids.ReadBucketsOfThisAccount!).sort()).toEqual(["s3:GetObject", "s3:ListBucket"]);
    expect(sids.ReadBucketsOfThisAccount!.Condition).toEqual({ StringEquals: { "s3:ResourceAccount": account } });
    expect(sids.NeverMangoBuckets!.Effect).toBe("Deny");
    expect(sids.NeverMangoBuckets!.Resource).toEqual([`arn:aws:s3:::mango-${ns}-*`, `arn:aws:s3:::mango-${ns}-*/*`]);
    // Mango's own buckets are generated from the stack name, `mango-<ns>-core-…`.
    expect(`Mango-${ns}-Core`.toLowerCase().startsWith(`mango-${ns}-`)).toBe(true);
    expect(boundary.Properties.Roles).toBeUndefined();
  });

  it("alarms on Retrieve throttling and on deletions not verified in 6 hours", () => {
    for (const [name, metric] of [
      ["Knowledge-retrieve-throttled", KNOWLEDGE_SIGNALS.retrieveThrottles],
      ["Knowledge-deletion-unverified", KNOWLEDGE_SIGNALS.deletionsOverdue],
    ] as const) {
      const [, alarm] = only("AWS::CloudWatch::Alarm", { AlarmName: `Mango-${ns}-${name}` });
      expect(alarm.Properties.Namespace).toBe(`${KNOWLEDGE_SIGNALS.namespacePrefix}/${ns}`);
      expect(alarm.Properties.MetricName).toBe(metric);
      expect(alarm.Properties.TreatMissingData).toBe("notBreaching");
      expect(alarm.Properties.AlarmActions).toHaveLength(1);
      expect(alarm.Properties.AlarmDescription).toMatch(/Look first at /);
    }
  });

  it("lets mango-api use only the registry, from a managed policy of its own, never delete or scan", () => {
    const [apiRoleId] = only("AWS::IAM::Role", { RoleName: `Mango-${ns}-ApiTask` });
    const [, policy] = only("AWS::IAM::ManagedPolicy", { ManagedPolicyName: `Mango-${ns}-ApiKnowledge` });
    expect(policy.Properties.Roles).toEqual([{ Ref: apiRoleId }]);
    const [tableId] = only("AWS::DynamoDB::GlobalTable", { TableName: `Mango-${ns}-Knowledge` });
    const sids = bySid(policy.Properties.PolicyDocument.Statement as Statement[]);
    expect(Object.keys(sids).sort()).toEqual([
      "DocumentsKey",
      "KnowledgeTable",
      "KnowledgeTableKey",
      "SavedDocuments",
      "Uploads",
    ]);
    // Uploads: sign and check under uploads/ only; saved documents: only written, under kb/*/docs/.
    expect(actions(sids.Uploads!).sort()).toEqual(["s3:GetObject", "s3:PutObject"]);
    expect(JSON.stringify(sids.Uploads!.Resource)).toContain("/uploads/*");
    expect(actions(sids.SavedDocuments!)).toEqual(["s3:PutObject"]);
    expect(JSON.stringify(sids.SavedDocuments!.Resource)).toContain("/kb/*/docs/*");
    expect(sids.DocumentsKey!.Condition!.StringEquals).toEqual({ "kms:ViaService": `s3.${region}.amazonaws.com` });
    const all = (policy.Properties.PolicyDocument.Statement as Statement[]).flatMap(actions);
    for (const forbidden of ["s3:DeleteObject", "s3:ListBucket", "dynamodb:DeleteItem", "dynamodb:Scan"]) {
      expect(all).not.toContain(forbidden);
    }
    expect(actions(sids.KnowledgeTable!).sort()).toEqual([
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
    ]);
    expect(JSON.stringify(sids.KnowledgeTable!.Resource)).toContain(tableId);
    expect(JSON.stringify(sids.KnowledgeTable!.Resource)).toContain(`/index/${KNOWLEDGE_ALL}`);
    expect(sids.KnowledgeTableKey!.Condition!.StringEquals).toEqual({
      "kms:ViaService": `dynamodb.${region}.amazonaws.com`,
    });
    // Nothing of the documents, the vectors or the Bedrock base yet, and no overflow policy.
    expect(JSON.stringify(statementsOf(apiRoleId))).not.toMatch(/s3vectors|bedrock:Retrieve/);
    expect(Object.keys(resources).some((id) => id.startsWith("ApiTaskRoleOverflowPolicy"))).toBe(false);
    const [, service] = only("AWS::ECS::TaskDefinition", {});
    const env = JSON.stringify(service.Properties.ContainerDefinitions);
    expect(env).toContain("KNOWLEDGE_TABLE");
    expect(env).toContain("KNOWLEDGE_BUCKET");
    expect(ofType("AWS::Lambda::Function").some(([, r]) => /Knowledge/i.test(String(r.Properties.FunctionName)))).toBe(
      false,
    );
  });

  it("takes uploads from the SPA only, with a bucket name the CSP may name (D88 (9))", () => {
    expect(JSON.stringify(bucket.Properties.BucketName)).toContain(`mango-${ns}-knowledge-`);
    expect(JSON.stringify(bucket.Properties.BucketName)).toContain("AWS::StackId");
    const [rule] = bucket.Properties.CorsConfiguration.CorsRules;
    expect(rule.AllowedMethods).toEqual(["POST"]);
    expect(rule.AllowedOrigins).toHaveLength(1);
    expect(JSON.stringify(rule.AllowedOrigins)).toContain("Distribution");
    const [, headers] = Object.entries(template.findResources("AWS::CloudFront::ResponseHeadersPolicy"))[0] as [
      string,
      Resource,
    ];
    const csp = JSON.stringify(headers.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy);
    expect(csp).toContain(`mango-${ns}-knowledge-`);
    expect(csp).toContain(`.s3.${region}.amazonaws.com`);
    // Only connect-src: the bucket is no source of scripts, styles, frames or forms.
    expect(csp.split("connect-src")[0]).not.toContain("knowledge");
  });

  it("expires the records of uploads with their objects", () => {
    const [, table] = only("AWS::DynamoDB::GlobalTable", { TableName: `Mango-${ns}-Knowledge` });
    expect(table.Properties.TimeToLiveSpecification).toEqual({ AttributeName: "expires_at", Enabled: true });
  });
});
