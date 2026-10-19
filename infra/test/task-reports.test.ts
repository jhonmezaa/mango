import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { loadInstallation } from "../lib/config/schema.js";
import { REPORT_LINK_MS, REPORT_READS, REPORT_WRITES } from "../lib/constructs/task-reports.js";
import { CoreStack } from "../lib/stacks/core-stack.js";

/* Downloadable reports of task runs (D86, D87; task-reports-threat-model.md). */

const cfg = loadInstallation(resolve(import.meta.dirname, "../config/example.json"));
const ns = cfg.namespace;

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
    env: { account: cfg.mangoAccountId, region: cfg.region },
  }),
);
const resources = template.toJSON().Resources as Record<string, Resource>;
const actions = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
function only(type: string, props: Record<string, unknown>): [string, Resource] {
  const found = Object.entries(template.findResources(type, { Properties: props }));
  expect(found).toHaveLength(1);
  return found[0] as [string, Resource];
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
const [roleId] = only("AWS::IAM::Role", { RoleName: `Mango-${ns}-TaskReport` });
const [functionId, fn] = only("AWS::Lambda::Function", { FunctionName: `Mango-${ns}-TaskReport` });
const [keyAliasId, alias] = only("AWS::KMS::Alias", { AliasName: `alias/Mango-${ns}-task-reports` });
const keyId = (alias.Properties.TargetKeyId as { "Fn::GetAtt": string[] })["Fn::GetAtt"][0]!;
const bucketId = Object.entries(resources).find(
  ([, r]) =>
    r.Type === "AWS::S3::Bucket" &&
    JSON.stringify(r.Properties.BucketEncryption ?? {}).includes(keyId),
)![0];
const bucket = resources[bucketId]!;

describe("task reports", () => {
  it("keeps each PDF in a bucket of its own: its key, TLS only, no public access, 90 days", () => {
    expect(keyAliasId).toBeDefined();
    expect(resources[keyId]!.Properties.EnableKeyRotation).toBe(true);
    const encryption = bucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0];
    expect(encryption.ServerSideEncryptionByDefault.SSEAlgorithm).toBe("aws:kms");
    expect(encryption.BucketKeyEnabled).toBe(true);
    expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    expect(bucket.Properties.LoggingConfiguration.LogFilePrefix).toBe("task-reports/");
    const [rule] = bucket.Properties.LifecycleConfiguration.Rules;
    expect(rule.ExpirationInDays).toBe(90);
    expect(bucket.DeletionPolicy).toBe(cfg.retainData ? "Retain" : "Delete");
    expect(resources[keyId]!.DeletionPolicy).toBe(bucket.DeletionPolicy);
  });

  it("refuses links older than five minutes and requests without TLS", () => {
    const [, policy] = only("AWS::S3::BucketPolicy", { Bucket: { Ref: bucketId } });
    const statements = policy.Properties.PolicyDocument.Statement as Statement[];
    const links = statements.find((s) => s.Sid === "LinksLiveFiveMinutes")!;
    expect(links.Effect).toBe("Deny");
    expect(links.Condition).toEqual({ NumericGreaterThan: { "s3:signatureAge": REPORT_LINK_MS } });
    expect(
      statements.some((s) => s.Effect === "Deny" && JSON.stringify(s.Condition).includes("aws:SecureTransport")),
    ).toBe(true);
  });

  it("gives the function only one run's report: read some attributes, mark its status, write under owner/", () => {
    const statements = statementsOf(roleId);
    const sids = Object.fromEntries(statements.filter((s) => s.Sid).map((s) => [s.Sid, s]));
    expect(actions(sids.ReadRunReport!)).toEqual(["dynamodb:GetItem"]);
    expect(sids.ReadRunReport!.Condition!["ForAllValues:StringEquals"]).toEqual({ "dynamodb:Attributes": REPORT_READS });
    expect(REPORT_READS).not.toContain("result");
    // Without it, a request that names no attribute (a GetItem without a projection) passes.
    expect(sids.ReadRunReport!.Condition!.Null).toEqual({ "dynamodb:Attributes": "false" });
    expect(sids.MarkRunReport!.Condition!.Null).toEqual({ "dynamodb:Attributes": "false" });
    expect(actions(sids.MarkRunReport!)).toEqual(["dynamodb:UpdateItem"]);
    expect(sids.MarkRunReport!.Condition!["ForAllValues:StringEquals"]).toEqual({ "dynamodb:Attributes": REPORT_WRITES });
    expect(actions(sids.WritePdf!)).toEqual(["s3:PutObject"]);
    expect(JSON.stringify(sids.WritePdf!.Resource)).toContain("/owner/*");
    const all = statements.flatMap(actions);
    for (const forbidden of ["s3:GetObject", "s3:DeleteObject", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:Scan"]) {
      expect(all).not.toContain(forbidden);
    }
    expect(all.some((a) => a.endsWith("*"))).toBe(false);
  });

  it("is invoked asynchronously with retries and a dead-letter queue that alarms", () => {
    expect(fn.Properties.DeadLetterConfig.TargetArn).toBeDefined();
    expect(fn.Properties.VpcConfig).toBeUndefined();
    const [, config] = only("AWS::Lambda::EventInvokeConfig", { FunctionName: { Ref: functionId } });
    expect(config.Properties.MaximumRetryAttempts).toBe(2);
    const [, alarm] = only("AWS::CloudWatch::Alarm", { AlarmName: `Mango-${ns}-TaskReport-failed` });
    expect(alarm.Properties.AlarmDescription).toMatch(/Look first at /);
    expect(JSON.stringify(fn.Metadata ?? {})).not.toContain("CKV_AWS_116");
  });

  it("lets mango-api only invoke it and sign links under owner/, from a managed policy of its own", () => {
    const [, policy] = only("AWS::IAM::ManagedPolicy", { ManagedPolicyName: `Mango-${ns}-ApiTaskReports` });
    const statements = policy.Properties.PolicyDocument.Statement as Statement[];
    expect(statements.map((s) => [s.Sid, actions(s)])).toEqual([
      ["DrawReport", ["lambda:InvokeFunction"]],
      ["SignReportLinks", ["s3:GetObject"]],
      ["ReportsKeyViaS3", ["kms:Decrypt"]],
    ]);
    expect(JSON.stringify(statements[0]!.Resource)).toContain(functionId);
    expect(JSON.stringify(statements[1]!.Resource)).toContain("/owner/*");
    expect(Object.keys(resources).some((id) => id.includes("ApiTaskRoleOverflowPolicy"))).toBe(false);
  });

  it("tells mango-api where the function and the bucket are, never a secret", () => {
    const [, service] = Object.entries(template.findResources("AWS::ECS::TaskDefinition"))[0]!;
    const env = (service.Properties.ContainerDefinitions[0].Environment as { Name: string }[]).map((e) => e.Name);
    expect(env).toEqual(expect.arrayContaining(["TASK_REPORT_FUNCTION", "TASK_REPORTS_BUCKET"]));
    expect(Object.keys(fn.Properties.Environment.Variables).sort()).toEqual([
      "REPORTS_BUCKET",
      "REPORTS_KEY_ARN",
      "TASKS_TABLE",
    ]);
  });
});
