import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { loadInstallation } from "../lib/config/schema.js";
import { EVALS_CONTENT_ACTIONS } from "../lib/constructs/evals.js";
import { CoreStack } from "../lib/stacks/core-stack.js";
import { fromCore } from "./nested.js";

// D16, precised 2026-11-08 (decided by the owner, by menu): the runtime log of a harness is
// content. Own key, 7 days, reading denied to every role of Mango but the trace reader (D108),
// and the published harnesses' log groups corrected on every update.

const cfg = loadInstallation(resolve(import.meta.dirname, "../config/example.json"));
const ns = cfg.namespace;
const account = cfg.mangoAccountId;
const region = cfg.region;

type Resource = { Type: string; Properties: any; [k: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Statement {
  Sid?: string;
  Effect: string;
  Principal?: unknown;
  Action: string | string[];
  Resource: unknown;
  Condition?: Record<string, Record<string, unknown>>;
}

const core = new CoreStack(new App({ context: { skipSpa: true } }), "Core", { installation: cfg, env: { account, region } });
const own = Template.fromStack(core).toJSON().Resources as Record<string, Resource>;
const template = fromCore(core);
const resources = template.toJSON().Resources as Record<string, Resource>;
const actions = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
const resourcesOf = (s: Statement) => (Array.isArray(s.Resource) ? s.Resource : [s.Resource]);
const harnessGroups = `arn:aws:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/harness_Mango_${ns}_a_*`;

function only(type: string, props: Record<string, unknown>): [string, Resource] {
  const found = Object.entries(template.findResources(type, { Properties: props }));
  expect(found, JSON.stringify(props)).toHaveLength(1);
  return found[0]! as [string, Resource];
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

const [aliasId, alias] = only("AWS::KMS::Alias", { AliasName: `alias/Mango-${ns}-harness-runtime-logs` });
const keyId = (alias.Properties.TargetKeyId as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];

describe("the key of the harnesses' runtime logs", () => {
  it("is in Core, rotates and is retained, and CloudWatch Logs uses it only for the harnesses' log groups", () => {
    expect(own[aliasId]).toBeDefined();
    const key = own[keyId]!;
    expect(key.Type).toBe("AWS::KMS::Key");
    expect(key.Properties.EnableKeyRotation).toBe(true);
    expect(key.DeletionPolicy).toBe(cfg.retainData ? "RetainExceptOnCreate" : "Delete");
    const logs = (key.Properties.KeyPolicy.Statement as Statement[]).find(
      (s) => s.Sid === "CloudWatchLogsHarnessRuntimeLogGroups",
    )!;
    expect(logs.Principal).toEqual({ Service: `logs.${region}.amazonaws.com` });
    expect(logs.Condition).toEqual({ ArnLike: { "kms:EncryptionContext:aws:logs:arn": harnessGroups } });
  });

  it("is the provisioner's key for the harnesses, and not the evals' nor the packs'", () => {
    const [, provisioner] = only("AWS::Lambda::Function", { FunctionName: `Mango-${ns}-Provisioner` });
    const env = provisioner.Properties.Environment.Variables;
    expect(env.HARNESS_LOGS_KEY_ARN).toEqual({ "Fn::GetAtt": [keyId, "Arn"] });
    expect(env.RUNTIME_LOGS_KEY_ARN).toBeUndefined();
    const [, packs] = only("AWS::Lambda::Function", { FunctionName: `Mango-${ns}-PackProvisioner` });
    expect(packs.Properties.Environment.Variables.RUNTIME_LOGS_KEY_ARN).not.toEqual({ "Fn::GetAtt": [keyId, "Arn"] });
  });
});

describe("who reads the harnesses' runtime logs: IAM", () => {
  const [denyId, deny] = only("AWS::IAM::ManagedPolicy", { ManagedPolicyName: `Mango-${ns}-evals-content-deny` });
  const denyStatements = deny.Properties.PolicyDocument.Statement as Statement[];
  const traceReaderArn = `arn:aws:iam::${account}:role/Mango-${ns}-TraceReader`;

  it("denies reading and exporting them to every principal but the trace reader, by its full ARN", () => {
    const content = denyStatements.find((s) => s.Sid === "NoHarnessRuntimeContent")!;
    expect(content.Effect).toBe("Deny");
    expect(resourcesOf(content)).toEqual([harnessGroups]);
    expect(actions(content)).toEqual([...EVALS_CONTENT_ACTIONS]);
    for (const a of ["logs:GetLogEvents", "logs:FilterLogEvents", "logs:StartQuery", "logs:StartLiveTail", "logs:CreateExportTask"]) {
      expect(actions(content)).toContain(a);
    }
    expect(content.Condition).toEqual({ ArnNotEquals: { "aws:PrincipalArn": traceReaderArn } });
  });

  it("lets only the provisioner take a key off", () => {
    const removal = denyStatements.find((s) => s.Sid === "NoHarnessLogsKeyRemoval")!;
    expect(removal.Effect).toBe("Deny");
    expect(actions(removal)).toEqual(["logs:DisassociateKmsKey"]);
    expect(removal.Condition).toEqual({
      ArnNotEquals: { "aws:PrincipalArn": `arn:aws:iam::${account}:role/Mango-${ns}-Provisioner` },
    });
  });

  it("is carried by mango-api, the provisioner and the trace reader, whose own Allow is the only read", () => {
    const carries = (name: string) => {
      const [, role] = only("AWS::IAM::Role", { RoleName: name });
      return JSON.stringify(role.Properties.ManagedPolicyArns ?? []).includes(JSON.stringify({ Ref: denyId }));
    };
    for (const name of [`Mango-${ns}-Provisioner`, `Mango-${ns}-TraceReader`, `Mango-${ns}-HarnessLogs`]) {
      expect(carries(name), name).toBe(true);
    }
  });

  it("is in the boundary of every role created at runtime: agents, packs and knowledge base sources", () => {
    for (const name of ["agent-boundary", "mcp-boundary", "kbsrc-boundary"]) {
      const [, boundary] = only("AWS::IAM::ManagedPolicy", { ManagedPolicyName: `Mango-${ns}-${name}` });
      const statements = boundary.Properties.PolicyDocument.Statement as Statement[];
      const content = statements.find((s) => s.Sid === "NoHarnessRuntimeContent")!;
      expect(content?.Effect, name).toBe("Deny");
      expect(resourcesOf(content)).toEqual([harnessGroups]);
      expect(statements.find((s) => s.Sid === "NoHarnessLogsKeyRemoval")?.Effect, name).toBe("Deny");
    }
  });

  it("never denies what a harness writes with nor what the provisioner and the governor set", () => {
    const denied = denyStatements.filter((s) => s.Sid === "NoHarnessRuntimeContent").flatMap(actions);
    for (const a of [
      "logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams",
      "logs:AssociateKmsKey", "logs:PutRetentionPolicy", "logs:TagResource", "logs:DescribeLogGroups",
    ]) {
      expect(denied).not.toContain(a);
    }
  });
});

describe("the harness log governor (Mango-<ns>-HarnessLogs)", () => {
  const name = `Mango-${ns}-HarnessLogs`;
  const [roleId] = only("AWS::IAM::Role", { RoleName: name });
  const statements = statementsOf(roleId);
  const allowed = statements.filter((s) => s.Effect === "Allow");

  it("lives in a nested stack, not in Core (D99)", () => {
    expect(Object.values(own).some((r) => r.Properties?.RoleName === name)).toBe(false);
    expect(Object.values(own).some((r) => r.Properties?.FunctionName === name)).toBe(false);
  });

  it("writes only key, retention and tags, only on the harnesses' log groups, and never touches the evals'", () => {
    // Its own log group aside (CreateLogStream and PutLogEvents of the function's logs).
    const writes = allowed.filter((s) => JSON.stringify(s.Resource).includes("/aws/bedrock-agentcore/runtimes/"));
    expect(writes.flatMap(actions).sort()).toEqual(["logs:AssociateKmsKey", "logs:PutRetentionPolicy", "logs:TagResource"]);
    expect(writes.flatMap(resourcesOf).sort()).toEqual([harnessGroups, `${harnessGroups}:*`].sort());
    const never = statements.find((s) => s.Sid === "NeverTheEvalsHarness")!;
    expect(never.Effect).toBe("Deny");
    expect(actions(never)).toEqual(["logs:*"]);
    expect(JSON.stringify(never.Resource)).toContain(`harness_Mango_${ns}_a_evals-*`);
    // Nothing that reads an event, deletes or removes a key.
    for (const a of ["logs:GetLogEvents", "logs:FilterLogEvents", "logs:StartQuery", "logs:DeleteLogGroup", "logs:DisassociateKmsKey"]) {
      expect(allowed.flatMap(actions)).not.toContain(a);
    }
  });

  it("only describes the harness logs key and reads the Core stack", () => {
    const kms = allowed.filter((s) => actions(s).some((a) => a.startsWith("kms:")));
    expect(kms.flatMap(actions)).toEqual(["kms:DescribeKey"]);
    expect(kms.flatMap(resourcesOf)).toEqual([{ "Fn::GetAtt": [keyId, "Arn"] }]);
    const cfn = allowed.find((s) => s.Sid === "ReadCoreStack")!;
    expect(actions(cfn)).toEqual(["cloudformation:DescribeStacks"]);
    expect(JSON.stringify(cfn.Resource)).toContain(`stack/Mango-${ns}-Core/*`);
  });

  it("runs on every update: its custom resource carries the release and the Core stack's id", () => {
    const custom = Object.values(resources).filter((r) => r.Type === "Custom::MangoHarnessLogs");
    expect(custom).toHaveLength(1);
    expect(custom[0]!.Properties.Release).toBeDefined();
    expect(custom[0]!.Properties.CoreStackId).toEqual({ Ref: "AWS::StackId" });
    const [, fn] = only("AWS::Lambda::Function", { FunctionName: name });
    expect(fn.Properties.Handler).toBe("mango_provisioner.harness_logs.lambda_handler");
    expect(fn.Properties.Environment.Variables.HARNESS_LOGS_KEY_ARN).toEqual({ "Fn::GetAtt": [keyId, "Arn"] });
    expect(fn.Properties.KmsKeyArn).toBeDefined();
  });
});
