import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { releaseSynthesizer, UNPUBLISHED_TARGET } from "../lib/release-target.js";
import { CoreStack } from "../lib/stacks/core-stack.js";
import { nestedStacks, nestedTemplate } from "./nested.js";

/* The stacks nested in Core (D99). The budget of Core with packs is checked in packs.test.ts. */

interface Resource {
  Type: string;
  Properties?: Record<string, unknown>;
  DependsOn?: string[];
}
type TemplateJson = {
  Description?: string;
  Parameters?: Record<string, unknown>;
  Resources: Record<string, Resource>;
  Outputs?: Record<string, unknown>;
};

// A release as `bin/mango.ts` builds it, without signed packs, whatever `dist/packs` holds here.
const context = { packsDir: mkdtempSync(join(tmpdir(), "mango-no-packs-")) };
const core = new CoreStack(new App({ context }), "Core", {
  env: { region: "us-east-1" },
  synthesizer: releaseSynthesizer(UNPUBLISHED_TARGET),
  release: UNPUBLISHED_TARGET,
});
const template = Template.fromStack(core).toJSON() as TemplateJson;
const nested = new Map(
  nestedStacks(core).map((stack) => [stack.node.id, nestedTemplate(stack) as TemplateJson]),
);
const stackResources = Object.entries(template.Resources).filter(([, r]) => r.Type === "AWS::CloudFormation::Stack");

/** Kinds of resource that hold data, or protect it: never in a nested stack (D99 (2)). */
const STATEFUL = [
  "AWS::DynamoDB::GlobalTable",
  "AWS::DynamoDB::Table",
  "AWS::S3::Bucket",
  "AWS::S3Vectors::VectorBucket",
  "AWS::KMS::Key",
  "AWS::Cognito::UserPool",
  "AWS::SecretsManager::Secret",
  "AWS::VerifiedPermissions::PolicyStore",
];

describe("stacks nested in Core (D99)", () => {
  it("are Operations, Authorization and RemoteMcp, and keep Core of a release under 400 resources", () => {
    expect([...nested.keys()].sort()).toEqual(["Authorization", "Operations", "RemoteMcp"]);
    expect(stackResources).toHaveLength(3);
    expect(Object.keys(template.Resources).length).toBeLessThanOrEqual(400);
  });

  it("are created from a template of the release's assets bucket, named by its content (D25, D69)", () => {
    for (const [, resource] of stackResources) {
      const url = JSON.stringify(resource.Properties!.TemplateURL);
      expect(url).toMatch(new RegExp(`/${UNPUBLISHED_TARGET.bucket}-us-east-1/mango/assets/[0-9a-f]{64}\\.json`));
    }
  });

  it("never name the release in their description", () => {
    for (const nestedTemplate of nested.values()) {
      expect(nestedTemplate.Description).toMatch(/^\(Mango\) mango-hub core: /);
      expect(nestedTemplate.Description).not.toContain(UNPUBLISHED_TARGET.label);
    }
  });

  it("hold nothing with data", () => {
    for (const [id, nestedTemplate] of nested) {
      const stateful = Object.values(nestedTemplate.Resources).filter((r) => STATEFUL.includes(r.Type));
      expect(stateful, id).toEqual([]);
    }
  });

  it("are leaves: Core reads none of their outputs", () => {
    const ids = stackResources.map(([id]) => id);
    const text = JSON.stringify(template.Resources);
    for (const id of ids) {
      expect(text).not.toContain(`"Fn::GetAtt":["${id}"`);
      expect(text).not.toMatch(new RegExp(`"Ref":"${id}"`));
    }
    for (const nestedTemplate of nested.values()) expect(nestedTemplate.Outputs ?? {}).toEqual({});
  });

  it("take the namespace as a parameter of their own where they name things", () => {
    for (const id of ["Operations", "RemoteMcp"]) {
      expect(Object.keys(nested.get(id)!.Parameters ?? {})).toContain("Namespace");
    }
    for (const [, resource] of stackResources) {
      const parameters = resource.Properties!.Parameters as Record<string, unknown> | undefined;
      if (parameters?.Namespace !== undefined) expect(parameters.Namespace).toEqual({ Ref: "Namespace" });
    }
  });

  it("are deleted after the uninstall guard, which depends on them", () => {
    const guard = Object.values(template.Resources).find((r) => r.Type === "Custom::MangoUninstallGuard")!;
    for (const [id] of stackResources) expect(guard.DependsOn).toContain(id);
  });

  it("keep the operational alarms and the dashboard, under names of their own (D99 (3))", () => {
    const operations = Object.values(nested.get("Operations")!.Resources);
    const alarms = operations.filter((r) => r.Type === "AWS::CloudWatch::Alarm");
    expect(alarms.length).toBeGreaterThanOrEqual(28);
    const named = [
      ...alarms.map((r) => r.Properties!.AlarmName),
      ...operations.filter((r) => r.Type === "AWS::CloudWatch::Dashboard").map((r) => r.Properties!.DashboardName),
      ...operations.filter((r) => r.Type === "AWS::Logs::MetricFilter").map((r) => r.Properties!.FilterName),
    ];
    for (const name of named) {
      expect(JSON.stringify(name)).toMatch(/^\{"Fn::Join":\["",\["Mango-",\{"Ref":"Namespace"\},"-ops(-|")/);
    }
    // None of them stayed in Core under its former name.
    expect(Object.values(template.Resources).some((r) => r.Type === "AWS::CloudWatch::Dashboard")).toBe(false);
  });

  it("keep every Cedar policy of the platform out of Core, and the store in Core", () => {
    const types = (t: TemplateJson) => Object.values(t.Resources).map((r) => r.Type);
    expect(types(template)).not.toContain("AWS::VerifiedPermissions::Policy");
    expect(types(template)).toContain("AWS::VerifiedPermissions::PolicyStore");
    expect(types(nested.get("Authorization")!).every((t) => t === "AWS::VerifiedPermissions::Policy")).toBe(true);
  });

  it("keep the policy of mango-api for remote MCP servers in RemoteMcp, on the role of Core", () => {
    const remote = Object.values(nested.get("RemoteMcp")!.Resources);
    const policy = remote.find((r) => r.Type === "AWS::IAM::ManagedPolicy")!;
    expect(JSON.stringify(policy.Properties!.ManagedPolicyName)).toContain("-ApiRemoteMcp");
    expect(JSON.stringify(policy.Properties!.Roles)).toMatch(/referencetoCoreApiTaskRole/);
    // The stack tagger (D77) waits for the nested stack that holds a policy it tags.
    const tagger = Object.values(template.Resources).find((r) => r.Type === "Custom::MangoStackTags")!;
    const remoteId = stackResources.find(([id]) => id.startsWith("RemoteMcp"))![0];
    expect(tagger.DependsOn).toContain(remoteId);
  });
});
