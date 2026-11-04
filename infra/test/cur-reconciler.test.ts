import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CHECKOV_EXCEPTIONS } from "../lib/checkov.js";
import { loadReleaseDefaults } from "../lib/config/release.js";
import { loadInstallation } from "../lib/config/schema.js";
import { CUR_EXPORT, dataExportsSourceArn } from "../lib/constructs/cur-export.js";
import {
  CUR_BYTES_SCANNED_CUTOFF,
  CUR_COLUMNS,
  CUR_LAKE_FORMATION_PERMISSIONS,
  CUR_RECONCILER_ALARMS,
  CUR_RECONCILER_KEYS,
  CUR_RECONCILER_METRICS,
} from "../lib/constructs/cur-reconciler.js";
import { CoreStack } from "../lib/stacks/core-stack.js";
import { fromCore, nestedStacks, nestedTemplate } from "./nested.js";

const cfg = loadInstallation(resolve(import.meta.dirname, "../config/example.json"));
const ns = cfg.namespace;
const account = cfg.mangoAccountId;
const region = cfg.region;
const payer = cfg.managementAccountId;

type Resource = { Type: string; Properties: any; [k: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const core = new CoreStack(new App({ context: { skipSpa: true } }), "Core", { installation: cfg, env: { account, region } });
const own = Template.fromStack(core).toJSON().Resources as Record<string, Resource>;
const template = fromCore(core);
const resources = template.toJSON().Resources as Record<string, Resource>;

interface Statement {
  Sid?: string;
  Effect: string;
  Principal?: unknown;
  Action: string | string[];
  Resource: unknown;
  Condition?: Record<string, Record<string, unknown>>;
}

function logicalId(type: string, props: Record<string, unknown>): string {
  const ids = Object.keys(template.findResources(type, { Properties: props }));
  expect(ids, JSON.stringify(props)).toHaveLength(1);
  return ids[0]!;
}
const actions = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
const python = (path: string) => readFileSync(resolve(import.meta.dirname, "../..", path), "utf8");

const name = `Mango-${ns}-CurReconciler`;
const roleId = logicalId("AWS::IAM::Role", { RoleName: name });
const functionId = logicalId("AWS::Lambda::Function", { FunctionName: name });
const queueId = logicalId("AWS::SQS::Queue", { QueueName: `${name}-dlq` });
const budgetsId = logicalId("AWS::DynamoDB::GlobalTable", { TableName: `Mango-${ns}-Budgets` });
const statements = Object.values(resources)
  .filter((r) => r.Type === "AWS::IAM::Policy" && r.Properties.Roles.some((x: { Ref: string }) => x.Ref === roleId))
  .flatMap((r) => r.Properties.PolicyDocument.Statement as Statement[]);
const bySid = (sid: string): Statement => {
  const found = statements.filter((s) => s.Sid === sid);
  expect(found, sid).toHaveLength(1);
  return found[0]!;
};

const buckets = Object.entries(own).filter(
  ([id, r]) => r.Type === "AWS::S3::Bucket" && id.startsWith("CurExportBucket"),
);
const [bucketId, bucket] = buckets[0]!;
const bucketPolicy = Object.values(own).find(
  (r) => r.Type === "AWS::S3::BucketPolicy" && r.Properties.Bucket.Ref === bucketId,
)!;
const bucketStatements = bucketPolicy.Properties.PolicyDocument.Statement as Statement[];

describe("the bucket of the CUR 2.0 export (D104 (5), TM-CUR2)", () => {
  it("is one bucket of Core, retained, with no KMS key of its own: Data Exports writes with SSE-S3", () => {
    expect(buckets).toHaveLength(1);
    expect(bucket.DeletionPolicy).toBe("Retain");
    expect(bucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration).toEqual([
      { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
    ]);
    expect(bucket.Properties.OwnershipControls.Rules).toEqual([{ ObjectOwnership: "BucketOwnerEnforced" }]);
    expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    expect(bucket.Properties.VersioningConfiguration).toEqual({ Status: "Enabled" });
    expect(bucket.Properties.LoggingConfiguration.LogFilePrefix).toBe(CUR_EXPORT.accessLogsPrefix);
    // No name of its own: `mango-<ns>-core-…`, which the purge deletes (D58).
    expect(bucket.Properties.BucketName).toBeUndefined();
  });

  it("expires the export after 400 days and Athena's results after 7", () => {
    const rules = bucket.Properties.LifecycleConfiguration.Rules as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(rules.find((r) => r.Prefix === `${CUR_EXPORT.resultsPrefix}/`)?.ExpirationInDays).toBe(7);
    const all = rules.find((r) => r.Prefix === undefined && r.ExpirationInDays !== undefined)!;
    expect(all.ExpirationInDays).toBe(400);
    expect(all.NoncurrentVersionExpiration.NoncurrentDays).toBe(30);
  });

  it("lets only Data Exports write, on behalf of the payer, and nobody else into the export", () => {
    const allow = bucketStatements.find((s) => s.Sid === "EnableAWSDataExportsToWriteToS3")!;
    expect(allow).toMatchObject({
      Effect: "Allow",
      Principal: { Service: "bcm-data-exports.amazonaws.com" },
      Action: "s3:PutObject",
      Condition: {
        ArnLike: { "aws:SourceArn": `arn:aws:bcm-data-exports:us-east-1:${payer}:export/*` },
        StringEquals: { "aws:SourceAccount": payer },
      },
    });
    expect(dataExportsSourceArn(payer)).toBe(`arn:aws:bcm-data-exports:us-east-1:${payer}:export/*`);
    const deny = bucketStatements.find((s) => s.Sid === "OnlyDataExportsWritesTheExport")!;
    expect(deny).toMatchObject({
      Effect: "Deny",
      Principal: { AWS: "*" },
      Action: "s3:PutObject",
      Condition: { ArnNotLike: { "aws:SourceArn": dataExportsSourceArn(payer) } },
    });
    expect(JSON.stringify(deny.Resource)).toContain(`/${CUR_EXPORT.prefix}/*`);
    // TLS only, like every bucket.
    expect(bucketStatements.some((s) => s.Effect === "Deny" && JSON.stringify(s.Condition).includes("SecureTransport"))).toBe(true);
    // The service reads, lists and deletes nothing.
    const service = bucketStatements.filter((s) => JSON.stringify(s.Principal ?? "").includes("bcm-data-exports"));
    expect(service.flatMap(actions)).toEqual(["s3:PutObject"]);
  });

  it("names the bucket in an output of Core for the runbook", () => {
    const outputs = Template.fromStack(core).toJSON().Outputs as Record<string, { Value: unknown }>;
    expect(outputs.CurExportBucket!.Value).toEqual({ Ref: bucketId });
  });
});

describe("Glue and Athena (D104 (6))", () => {
  it("declares the table with partition projection by billing period and no crawler", () => {
    expect(template.findResources("AWS::Glue::Crawler")).toEqual({});
    const db = Object.values(resources).find((r) => r.Type === "AWS::Glue::Database")!;
    expect(db.Properties.DatabaseInput.Name).toBe(`mango_${ns}_cur`);
    const table = Object.values(resources).find((r) => r.Type === "AWS::Glue::Table")!;
    const input = table.Properties.TableInput;
    expect(input.PartitionKeys).toEqual([{ Name: "billing_period", Type: "string" }]);
    expect(input.Parameters).toMatchObject({
      "projection.enabled": "true",
      "projection.billing_period.type": "date",
      "projection.billing_period.format": "yyyy-MM",
      "projection.billing_period.interval.unit": "MONTHS",
    });
    const location = JSON.stringify(input.Parameters["storage.location.template"]);
    expect(location).toContain(`/${CUR_EXPORT.prefix}/mango-${ns}-bedrock/data/BILLING_PERIOD=\${billing_period}`);
    expect(input.StorageDescriptor.Columns.map((c: { Name: string }) => c.Name)).toEqual(CUR_COLUMNS.map((c) => c.name));
  });

  it("enforces the workgroup's configuration, a cap on bytes and encrypted results in their prefix", () => {
    const workgroup = Object.values(resources).find((r) => r.Type === "AWS::Athena::WorkGroup")!;
    expect(workgroup.Properties.Name).toBe(`Mango-${ns}-cur`);
    const config = workgroup.Properties.WorkGroupConfiguration;
    expect(config.EnforceWorkGroupConfiguration).toBe(true);
    expect(config.BytesScannedCutoffPerQuery).toBe(CUR_BYTES_SCANNED_CUTOFF);
    expect(config.ResultConfiguration.EncryptionConfiguration).toEqual({ EncryptionOption: "SSE_S3" });
    expect(JSON.stringify(config.ResultConfiguration.OutputLocation)).toContain(`/${CUR_EXPORT.resultsPrefix}/`);
  });

  it("lists in the runbook the columns of the table and the export it reads", () => {
    const runbook = readFileSync(resolve(import.meta.dirname, "../../docs/runbooks/install.md"), "utf8");
    for (const column of CUR_COLUMNS) expect(runbook, column.name).toContain(column.name);
    expect(runbook).toContain("mango-<ns>-bedrock");
    expect(runbook).toContain("INCLUDE_IAM_PRINCIPAL_DATA");
    for (const code of loadReleaseDefaults().curReconciliation.bedrockProductCodes) expect(runbook).toContain(`'${code}'`);
  });
});

describe("CurReconciler role (D104 (8), TM-CUR3)", () => {
  it("has exactly these actions", () => {
    expect([...new Set(statements.flatMap(actions))].sort()).toEqual([
      "athena:GetQueryExecution",
      "athena:GetQueryResults",
      "athena:StartQueryExecution",
      "athena:StopQueryExecution",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "firehose:PutRecord",
      "glue:GetDatabase",
      "glue:GetPartition",
      "glue:GetPartitions",
      "glue:GetTable",
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      // Its own log group (PythonFunction).
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "s3:AbortMultipartUpload",
      "s3:GetBucketLocation",
      "s3:GetObject",
      "s3:ListBucket",
      "s3:ListBucketMultipartUploads",
      "s3:ListMultipartUploadParts",
      "s3:PutObject",
      // Its dead-letter queue.
      "sqs:SendMessage",
      // Lambda's X-Ray tracing.
      "xray:PutTelemetryRecords",
      "xray:PutTraceSegments",
    ]);
  });

  it("reads only the day counters of agents and the organization, with the key required", () => {
    const counters = bySid("ReadTheDayCountersOfAgentsAndOrganization");
    expect(actions(counters)).toEqual(["dynamodb:Query"]);
    expect(counters.Resource).toEqual({ "Fn::GetAtt": [budgetsId, "Arn"] });
    expect(counters.Condition).toEqual({
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DAY#AGENT#*", "DAY#ORG"] },
      Null: { "dynamodb:LeadingKeys": "false" },
    });
    expect(CUR_RECONCILER_KEYS).toEqual(["DAY#AGENT#*", "DAY#ORG"]);
    // A person's keys are not among them (TM-CUR3).
    expect(JSON.stringify(statements)).not.toContain("USER#");
    const usage = python("packages/py/mango-core/src/mango_core/usage_days.py");
    expect(usage).toContain('AGENT_PREFIX: Final = "DAY#AGENT#"');
    expect(usage).toContain('ORG_KEY: Final = "DAY#ORG"');
  });

  it("queries only in its workgroup and reads only its table", () => {
    const workgroup = JSON.stringify(bySid("QueriesInItsWorkgroup").Resource);
    expect(workgroup).toMatch(new RegExp(`:athena:.*:workgroup/Mango-${ns}-cur"`));
    const glue = (bySid("ReadTheCurTable").Resource as unknown[]).map((r) => JSON.stringify(r));
    expect(glue).toHaveLength(3);
    expect(glue[0]).toMatch(/:glue:.*:catalog"/);
    expect(glue[1]).toMatch(new RegExp(`:database/mango_${ns}_cur"`));
    expect(glue[2]).toMatch(new RegExp(`:table/mango_${ns}_cur/bedrock"`));
  });

  it("reads the export's prefix, writes only the results' prefix and lists only those two", () => {
    expect(actions(bySid("ReadTheExport"))).toEqual(["s3:GetObject"]);
    expect(JSON.stringify(bySid("ReadTheExport").Resource)).toContain(`/${CUR_EXPORT.prefix}/*`);
    const writes = statements.filter((s) => actions(s).includes("s3:PutObject"));
    expect(writes).toHaveLength(1);
    expect(JSON.stringify(writes[0]!.Resource)).toContain(`/${CUR_EXPORT.resultsPrefix}/*`);
    expect(bySid("ListTheTwoPrefixes").Condition).toEqual({
      StringLike: { "s3:prefix": [`${CUR_EXPORT.prefix}/*`, `${CUR_EXPORT.resultsPrefix}/*`] },
    });
  });

  it("gets no other key than the data key through DynamoDB and the alerts key through SQS", () => {
    const kms = statements.filter((s) => actions(s).some((a) => a.startsWith("kms:")));
    expect(kms.map((s) => Object.values(s.Condition?.StringEquals ?? {})[0]).sort()).toEqual([
      `dynamodb.${region}.amazonaws.com`,
      `sqs.${region}.amazonaws.com`,
    ]);
  });
});

describe("CurReconciler function (D104 (7), TM-CUR7)", () => {
  const fn = resources[functionId]!;

  it("is asynchronous with a dead-letter queue, so Checkov's DLQ check is not suppressed", () => {
    expect(fn.Properties.DeadLetterConfig.TargetArn).toEqual({ "Fn::GetAtt": [queueId, "Arn"] });
    const skipped = (fn.Metadata?.checkov?.skip ?? []).map((s: { id: string }) => s.id);
    expect(skipped).not.toContain(CHECKOV_EXCEPTIONS.lambdaDlq.id);
  });

  it("takes the product codes and the thresholds from the configuration", () => {
    const env = fn.Properties.Environment.Variables;
    const defaults = loadReleaseDefaults().curReconciliation;
    expect(env.BEDROCK_PRODUCT_CODES).toBe(defaults.bedrockProductCodes.join(","));
    expect([env.THRESHOLD_PERCENT, env.THRESHOLD_USD]).toEqual(["10", "1"]);
    expect([env.CUR_DATABASE, env.CUR_TABLE, env.CUR_WORKGROUP]).toEqual([`mango_${ns}_cur`, "bedrock", `Mango-${ns}-cur`]);
    expect(env.MANGO_ACCOUNT_ID).toBe(account);
  });

  it("runs once a day from its own schedule group, whose role only Scheduler of that group assumes", () => {
    const schedule = Object.values(resources).find((r) => r.Type === "AWS::Scheduler::Schedule" && r.Properties.Name === `Mango-${ns}-cur-daily`)!;
    expect(schedule.Properties.ScheduleExpression).toBe("cron(30 7 * * ? *)");
    expect(schedule.Properties.GroupName).toBe(`Mango-${ns}-cur`);
    const roleRef = schedule.Properties.Target.RoleArn["Fn::GetAtt"][0] as string;
    const trust = resources[roleRef]!.Properties.AssumeRolePolicyDocument.Statement[0];
    expect(Object.keys(trust.Condition.StringEquals).sort()).toEqual(["aws:SourceAccount", "aws:SourceArn"]);
    expect(JSON.stringify(trust.Condition.StringEquals["aws:SourceArn"])).toMatch(
      new RegExp(`:schedule-group/Mango-${ns}-cur"`),
    );
    const invoke = Object.values(resources)
      .filter((r) => r.Type === "AWS::IAM::Policy" && r.Properties.Roles.some((x: { Ref: string }) => x.Ref === roleRef))
      .flatMap((r) => r.Properties.PolicyDocument.Statement as Statement[]);
    expect(invoke.flatMap(actions)).toEqual(["lambda:InvokeFunction"]);
  });

  it("alarms on findings and on a failed run, both on the Operations dashboard by name", () => {
    const alarms = Object.values(resources).filter((r) => r.Type === "AWS::CloudWatch::Alarm");
    const findings = alarms.find((a) => a.Properties.AlarmName === `Mango-${ns}-${CUR_RECONCILER_ALARMS.findings}`)!;
    expect(findings.Properties).toMatchObject({
      Namespace: CUR_RECONCILER_METRICS.namespace,
      MetricName: "Findings",
      TreatMissingData: "ignore",
    });
    const failed = alarms.find((a) => a.Properties.AlarmName === `Mango-${ns}-${CUR_RECONCILER_ALARMS.failed}`)!;
    expect(failed.Properties.Dimensions[0].Value).toEqual({ "Fn::GetAtt": [queueId, "QueueName"] });
    const handler = python("functions/cur-reconciler/src/mango_cur_reconciler/handler.py");
    expect(handler).toContain(`METRIC_NAMESPACE: Final = "${CUR_RECONCILER_METRICS.namespace}"`);
    const dashboard = Object.values(resources).find((r) => r.Type === "AWS::CloudWatch::Dashboard")!;
    const body = JSON.stringify(dashboard.Properties.DashboardBody);
    for (const alarm of Object.values(CUR_RECONCILER_ALARMS)) expect(body).toContain(`alarm:Mango-${ns}-${alarm}`);
  });

  it("lives in a nested stack that is a leaf, and only the bucket is in Core (D99)", () => {
    const nested = nestedStacks(core).find((s) => s.node.id === "CurReconciliation")!;
    const own = nestedTemplate(nested);
    expect(own.Outputs ?? {}).toEqual({});
    const types = Object.values(own.Resources as Record<string, Resource>).map((r) => r.Type);
    expect(types).not.toContain("AWS::S3::Bucket");
    expect(types).not.toContain("AWS::KMS::Key");
    expect(types).toContain("AWS::Lambda::Function");
  });
});

describe("under Lake Formation (D104, TM-CUR9)", () => {
  const nested = nestedTemplate(nestedStacks(core).find((s) => s.node.id === "CurReconciliation")!);
  const grants = Object.entries(resources).filter(([, r]) => r.Type.startsWith("AWS::LakeFormation::"));
  const tableId = logicalId("AWS::Glue::Table", { DatabaseName: `mango_${ns}_cur` });

  it("grants the function's role SELECT and DESCRIBE on its table, and nothing else", () => {
    expect(grants.map(([, r]) => r.Type)).toEqual(["AWS::LakeFormation::PrincipalPermissions"]);
    const [, grant] = grants[0]!;
    expect(CUR_LAKE_FORMATION_PERMISSIONS).toEqual(["SELECT", "DESCRIBE"]);
    expect(grant.Properties).toEqual({
      Catalog: account,
      Principal: { DataLakePrincipalIdentifier: { "Fn::GetAtt": [roleId, "Arn"] } },
      Resource: { Table: { CatalogId: account, DatabaseName: `mango_${ns}_cur`, Name: "bedrock" } },
      Permissions: ["SELECT", "DESCRIBE"],
      // No grant option: the role passes nothing on.
      PermissionsWithGrantOption: [],
    });
    // Granted once the table exists; revoked before the table is dropped.
    expect(grant.DependsOn).toContain(tableId);
  });

  it("leaves the data lake settings, the catalog, the database and the S3 locations alone", () => {
    const text = JSON.stringify(resources);
    expect(text).not.toMatch(/DataLakeSettings|DataLocation|"Catalog":\{\}|"Database":\{/);
    // The bucket is not registered in Lake Formation: no credentials vended, IAM reads S3.
    expect(statements.flatMap(actions).filter((a) => a.startsWith("lakeformation:"))).toEqual([]);
  });

  it("is created only when the installation says Lake Formation governs the catalog", () => {
    const [id, grant] = grants[0]!;
    expect(grant.Condition).toBeDefined();
    // This installation does not say so: the condition is false and the template is IAM only.
    expect(nested.Conditions[grant.Condition]).toEqual({ "Fn::Equals": ["false", "true"] });
    expect(nested.Resources[id].Condition).toBe(grant.Condition);
  });

  it("queries in the context of its database, never Athena's default", () => {
    const source = python("functions/cur-reconciler/src/mango_cur_reconciler/query.py");
    expect(source).toContain('QueryExecutionContext={"Catalog": "AwsDataCatalog", "Database": self._database}');
  });

  it("deletes the log group, which has a fixed name, when its first create rolls back", () => {
    const groups = Object.values(resources).filter(
      (r) => r.Type === "AWS::Logs::LogGroup" && r.Properties.LogGroupName === `/aws/lambda/${name}`,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.DeletionPolicy).toBe("RetainExceptOnCreate");
    expect(groups[0]!.UpdateReplacePolicy).toBe("Retain");
  });
});

describe("an installation that says Lake Formation governs its catalog", () => {
  it("creates the grant unconditionally", () => {
    const governed = new CoreStack(new App({ context: { skipSpa: true } }), "Core", {
      installation: { ...cfg, catalogGovernedByLakeFormation: true },
      env: { account, region },
    });
    const nested = nestedTemplate(nestedStacks(governed).find((s) => s.node.id === "CurReconciliation")!);
    const [grant] = Object.values(nested.Resources as Record<string, Resource>).filter(
      (r) => r.Type === "AWS::LakeFormation::PrincipalPermissions",
    );
    expect(nested.Conditions[grant!.Condition]).toEqual({ "Fn::Equals": ["true", "true"] });
  });
});
