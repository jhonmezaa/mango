import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CoreStack } from "../lib/stacks/core-stack.js";

/* D77: the stack tagger gives the stack's tags to what CloudFormation cannot tag. Its role
 * writes tags only, and only on the installation's policies and network resources
 * (stack-tagger-threat-model.md). */

interface Statement {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource: unknown;
  Condition?: Record<string, Record<string, unknown>>;
}
interface Resource {
  Type: string;
  DependsOn?: string[];
  Properties: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const context = { packsDir: mkdtempSync(join(tmpdir(), "mango-no-packs-")) };
const template = Template.fromStack(new CoreStack(new App({ context }), "Core", { env: { region: "us-east-1" } })).toJSON() as {
  Resources: Record<string, Resource>;
};
const resources = template.Resources;
const idOf = (type: string, match: (r: Resource) => boolean) => {
  const found = Object.entries(resources).filter(([, r]) => r.Type === type && match(r));
  expect(found, type).toHaveLength(1);
  return found[0]![0];
};
const roleId = idOf("AWS::IAM::Role", (r) => JSON.stringify(r.Properties.RoleName ?? "").includes("-StackTagger"));
const statements = Object.values(resources)
  .filter((r) => r.Type === "AWS::IAM::Policy" && JSON.stringify(r.Properties.Roles).includes(roleId))
  .flatMap((r) => r.Properties.PolicyDocument.Statement as Statement[]);
const actions = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
const bySid = (sid: string) => {
  const found = statements.filter((s) => s.Sid === sid);
  expect(found, sid).toHaveLength(1);
  return found[0]!;
};
const taggerId = idOf("Custom::MangoStackTags", () => true);
const tagger = resources[taggerId]!;
const ownNamespace = { "aws:RequestTag/mango:namespace": { Ref: "Namespace" } };
const json = (value: unknown) => JSON.stringify(value);

describe("stack tagger role (D77)", () => {
  it("is assumed only by Lambda and has no managed policies", () => {
    const role = resources[roleId]!.Properties;
    expect(role.ManagedPolicyArns).toBeUndefined();
    expect(role.AssumeRolePolicyDocument.Statement).toEqual([
      { Action: "sts:AssumeRole", Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" } },
    ]);
  });

  it("writes tags and nothing else", () => {
    // Besides reads, only what every function of the installation writes: its own log and X-Ray traces.
    const reads = /^(ec2:Describe|cloudformation:(Describe|List)|kms:Decrypt|xray:Put(TraceSegments|TelemetryRecords)|logs:(CreateLogStream|PutLogEvents))/;
    const writes = statements.flatMap(actions).filter((a) => !reads.test(a));
    expect(writes.sort()).toEqual(["ec2:CreateTags", "ec2:CreateTags", "iam:TagPolicy"]);
  });

  it("tags only the installation's policies, and every request carries its namespace", () => {
    const tag = bySid("TagInstallationPolicies");
    expect(actions(tag)).toEqual(["iam:TagPolicy"]);
    expect(json(tag.Resource)).toContain(":policy/Mango-");
    expect(json(tag.Resource)).toContain('{"Ref":"Namespace"}');
    expect(tag.Condition).toEqual({ StringEquals: ownNamespace });
  });

  it("tags the defaults of the network only in the installation's two VPCs", () => {
    const tag = bySid("TagVpcDefaults");
    expect(actions(tag)).toEqual(["ec2:CreateTags"]);
    const kinds = (tag.Resource as unknown[]).map((r) => json(r).match(/:(security-group|network-acl|route-table)\/\*/)?.[1]);
    expect(kinds.sort()).toEqual(["network-acl", "route-table", "security-group"]);
    const vpcs = tag.Condition!.StringEquals!["ec2:Vpc"] as unknown[];
    expect(vpcs).toHaveLength(2);
    expect(json(vpcs[0])).toContain(":vpc/");
    expect(json(vpcs[1])).toContain("-PackNetwork-VpcId");
    expect(tag.Condition!.StringEquals!["aws:RequestTag/mango:namespace"]).toEqual({ Ref: "Namespace" });
  });

  it("tags security group rules only with its namespace on the request: they admit no VPC key", () => {
    const tag = bySid("TagSecurityGroupRules");
    expect(actions(tag)).toEqual(["ec2:CreateTags"]);
    expect(json(tag.Resource)).toContain(":security-group-rule/*");
    expect(tag.Condition).toEqual({ StringEquals: ownNamespace });
  });

  it("reads only its own stack and the pack network's, and the network", () => {
    const read = bySid("ReadInstallationStacks");
    expect(actions(read).sort()).toEqual(["cloudformation:DescribeStacks", "cloudformation:ListStackResources"]);
    expect(json(read.Resource)).toContain('{"Ref":"AWS::StackId"}');
    expect(json(read.Resource)).toContain("-PackNetwork/*");
    // The nested stacks are named after the installed stack (`Mango-<ns>-Core-…`), never
    // after the construct id the template is synthesized with (D99 (7)).
    expect(json(read.Resource)).toContain('{"Ref":"AWS::StackName"},"-*/*"');
    expect(json(read.Resource)).not.toContain(":stack/Core-");
    expect(actions(bySid("ReadNetwork")).sort()).toEqual([
      "ec2:DescribeNetworkAcls",
      "ec2:DescribeRouteTables",
      "ec2:DescribeSecurityGroupRules",
      "ec2:DescribeSecurityGroups",
      "ec2:DescribeVpcs",
    ]);
  });
});

describe("stack tagger resource and function (D77)", () => {
  it("runs on every version and on both VPCs", () => {
    expect(tagger.Properties.Release).toBe("v0.0.0-unpublished");
    expect(json(tagger.Properties.VpcIds)).toContain("NetworkVpc");
    expect(json(tagger.Properties.VpcIds)).toContain("-PackNetwork-VpcId");
    expect(tagger.Properties.ServiceTimeout).toBe("600");
  });

  it("waits for every policy, VPC, security group and rule of the stack", () => {
    const needed = Object.entries(resources)
      .filter(([, r]) =>
        [
          "AWS::IAM::ManagedPolicy",
          "AWS::EC2::VPC",
          "AWS::EC2::SecurityGroup",
          "AWS::EC2::SecurityGroupIngress",
          "AWS::EC2::SecurityGroupEgress",
          "Custom::VpcRestrictDefaultSG",
        ].includes(r.Type),
      )
      .map(([id]) => id);
    expect(needed.length).toBeGreaterThan(5);
    for (const id of needed) expect(tagger.DependsOn, id).toContain(id);
  });

  it("is waited for by the uninstall guard, like every other resource", () => {
    const guard = Object.values(resources).find((r) => r.Type === "Custom::MangoUninstallGuard")!;
    expect(guard.DependsOn).toContain(taggerId);
  });

  it("is configured from the stack only, with an encrypted environment", () => {
    const fn = Object.values(resources).find(
      (r) => r.Type === "AWS::Lambda::Function" && json(r.Properties.FunctionName ?? "").includes("-StackTagger"),
    )!.Properties;
    expect(fn.Handler).toBe("mango_provisioner.stack_tagger.lambda_handler");
    expect(Object.keys(fn.Environment.Variables).sort()).toEqual(["MANGO_ACCOUNT_ID", "MANGO_NAMESPACE"]);
    expect(fn.KmsKeyArn).toBeDefined();
    expect(fn.Role).toEqual({ "Fn::GetAtt": [roleId, "Arn"] });
  });
});
