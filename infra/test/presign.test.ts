import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { loadInstallation } from "../lib/config/schema.js";
import { PRESIGN_SESSION } from "../lib/constructs/presign.js";
import { CoreStack } from "../lib/stacks/core-stack.js";

/* The role that signs every URL a browser uses (D86 (4), D88 (9)). Signed with the task's
 * credentials, GuardDuty reports their use from a browser as
 * ResourceCredentialExfiltration.OutsideAWS (seen on 2026-10-21). */

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
const keyOf = (alias: string) => {
  const [, found] = only("AWS::KMS::Alias", { AliasName: `alias/Mango-${ns}-${alias}` });
  return (found.Properties.TargetKeyId as { "Fn::GetAtt": string[] })["Fn::GetAtt"][0]!;
};
const bucketOf = (keyId: string) =>
  Object.entries(resources).find(
    ([, r]) => r.Type === "AWS::S3::Bucket" && JSON.stringify(r.Properties.BucketEncryption ?? {}).includes(keyId),
  )![0];
const [presignId, presign] = only("AWS::IAM::Role", { RoleName: `Mango-${ns}-Presign` });
const [apiRoleId] = only("AWS::IAM::Role", { RoleName: `Mango-${ns}-ApiTask` });
const knowledgeKey = keyOf("knowledge");
const reportsKey = keyOf("task-reports");
const documentsBucket = bucketOf(knowledgeKey);
const reportsBucket = bucketOf(reportsKey);

describe("presign role", () => {
  it("is assumed only by the task role of mango-api, with a source identity", () => {
    const trust = presign.Properties.AssumeRolePolicyDocument.Statement as Statement[];
    expect(trust.map((s) => actions(s)).flat().sort()).toEqual(["sts:AssumeRole", "sts:SetSourceIdentity"]);
    for (const statement of trust) {
      expect(statement.Effect).toBe("Allow");
      expect(statement.Principal).toEqual({ AWS: { "Fn::GetAtt": [apiRoleId, "Arn"] } });
      expect(statement.Condition).toEqual({ Null: { "sts:SourceIdentity": "false" } });
    }
    expect(presign.Properties.MaxSessionDuration).toBe(3600);
    expect(PRESIGN_SESSION.toSeconds()).toBeLessThanOrEqual(presign.Properties.MaxSessionDuration);
  });

  it("puts only under uploads/ of the documents and gets only under owner/ of the reports", () => {
    const statements = statementsOf(presignId);
    const sids = Object.fromEntries(statements.map((s) => [s.Sid, s]));
    expect(Object.keys(sids).sort()).toEqual(["DocumentsKey", "DownloadReports", "ReportsKey", "UploadDocuments"]);
    expect(actions(sids.UploadDocuments!)).toEqual(["s3:PutObject"]);
    expect(JSON.stringify(sids.UploadDocuments!.Resource)).toContain(documentsBucket);
    expect(JSON.stringify(sids.UploadDocuments!.Resource)).toContain("/uploads/*");
    expect(actions(sids.DownloadReports!)).toEqual(["s3:GetObject"]);
    expect(JSON.stringify(sids.DownloadReports!.Resource)).toContain(reportsBucket);
    expect(JSON.stringify(sids.DownloadReports!.Resource)).toContain("/owner/*");
    expect(actions(sids.DocumentsKey!)).toEqual(["kms:GenerateDataKey"]);
    expect(sids.DocumentsKey!.Resource).toEqual({ "Fn::GetAtt": [knowledgeKey, "Arn"] });
    expect(actions(sids.ReportsKey!)).toEqual(["kms:Decrypt"]);
    expect(sids.ReportsKey!.Resource).toEqual({ "Fn::GetAtt": [reportsKey, "Arn"] });
    for (const key of [sids.DocumentsKey!, sids.ReportsKey!]) {
      expect(key.Condition).toEqual({ StringEquals: { "kms:ViaService": `s3.${cfg.region}.amazonaws.com` } });
    }
    expect(statements.every((s) => s.Effect === "Allow" && !actions(s).some((a) => a.includes("*")))).toBe(true);
  });

  it("is what mango-api signs with: its task role may assume it and no longer signs itself", () => {
    const [, policy] = only("AWS::IAM::ManagedPolicy", { ManagedPolicyName: `Mango-${ns}-ApiPresign` });
    expect(policy.Properties.Roles).toEqual([{ Ref: apiRoleId }]);
    const [statement] = policy.Properties.PolicyDocument.Statement as Statement[];
    expect(actions(statement!).sort()).toEqual(["sts:AssumeRole", "sts:SetSourceIdentity"]);
    expect(statement!.Resource).toEqual({ "Fn::GetAtt": [presignId, "Arn"] });
    // The task role of mango-api can neither upload under uploads/ nor read a PDF: a URL signed
    // with its session would not work.
    const api = statementsOf(apiRoleId);
    const puts = api.filter(
      (s) => actions(s).includes("s3:PutObject") && JSON.stringify(s.Resource).includes("/uploads/"),
    );
    expect(puts).toEqual([]);
    const reads = api.filter(
      (s) => actions(s).includes("s3:GetObject") && JSON.stringify(s.Resource).includes(reportsBucket),
    );
    expect(reads).toEqual([]);
    const [, service] = Object.entries(template.findResources("AWS::ECS::TaskDefinition"))[0]!;
    const env = service.Properties.ContainerDefinitions[0].Environment as { Name: string; Value: unknown }[];
    expect(env.find((e) => e.Name === "PRESIGN_ROLE_ARN")!.Value).toEqual({ "Fn::GetAtt": [presignId, "Arn"] });
    expect(Object.keys(resources).some((id) => id.startsWith("ApiTaskRoleOverflowPolicy"))).toBe(false);
  });
});
