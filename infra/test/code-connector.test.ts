import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import { loadInstallation } from "../lib/config/schema.js";
import { CODE_CELL_SECONDS, CODE_TARGET_NAME, codeTools } from "../lib/constructs/code-connector.js";
import { CoreStack } from "../lib/stacks/core-stack.js";
import { fromCore, nestedStacks, nestedTemplate } from "./nested.js";

/* The code connector (D114 (1), (4), (6)); threat model code-interpreter-threat-model.md
 * (TM-CI1, CI2, CI10, CI11). */

const cfg = loadInstallation(resolve(import.meta.dirname, "../config/example.json"));
const ns = cfg.namespace;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resource = { Type: string; Properties: any; DependsOn?: string[]; [k: string]: any };
interface Statement {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource: unknown;
  Principal?: unknown;
  Condition?: Record<string, Record<string, unknown>>;
}

const core = new CoreStack(new App({ context: { skipSpa: true } }), "Core", {
  installation: cfg,
  env: { account: cfg.mangoAccountId, region: cfg.region },
});
const template = fromCore(core);
const resources = template.toJSON().Resources as Record<string, Resource>;
const sandboxStack = nestedStacks(core).find((stack) => stack.node.id === "Sandbox")!;
const sandboxResources = nestedTemplate(sandboxStack).Resources as Record<string, Resource>;
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

const [roleId, role] = only("AWS::IAM::Role", { RoleName: `Mango-${ns}-CodeInterpreter` });
const [fnId, fn] = only("AWS::Lambda::Function", { FunctionName: `Mango-${ns}-CodeInterpreter` });
const [ciId] = only("AWS::BedrockAgentCore::CodeInterpreterCustom", { Name: `Mango_${ns}_sandbox` });
const [, target] = only("AWS::BedrockAgentCore::GatewayTarget", { Name: CODE_TARGET_NAME });
const [, cedar] = only("AWS::BedrockAgentCore::Policy", { Name: `Mango_${ns}_CodeInterpreter` });
const [, dataAlias] = only("AWS::KMS::Alias", { AliasName: `alias/Mango-${ns}-data` });
const dataKeyId = (dataAlias.Properties.TargetKeyId as { "Fn::GetAtt": string[] })["Fn::GetAtt"][0]!;
const statements = statementsOf(roleId);
const bySid = (sid: string) => statements.find((s) => s.Sid === sid)!;

describe("code connector (D114)", () => {
  it("lives in the sandbox stack nested in Core, beside its Code Interpreter", () => {
    for (const id of [roleId, fnId, ciId]) expect(sandboxResources[id]).toBeDefined();
    // No key of its own: a key would be data in a nested stack (D99 (2)).
    expect(Object.values(sandboxResources).some((r) => r.Type === "AWS::KMS::Key")).toBe(false);
  });

  it("reaches only the sessions of Mango_<ns>_sandbox, never another code interpreter", () => {
    const sessions = bySid("SandboxSessions");
    expect(actions(sessions).sort()).toEqual([
      "bedrock-agentcore:InvokeCodeInterpreter",
      "bedrock-agentcore:StartCodeInterpreterSession",
      "bedrock-agentcore:StopCodeInterpreterSession",
    ]);
    expect(sessions.Resource).toEqual({ "Fn::GetAtt": [ciId, "CodeInterpreterArn"] });
    // No other statement of the role names the service.
    const others = statements.filter((s) => s !== sessions);
    expect(others.flatMap(actions).some((a) => a.startsWith("bedrock-agentcore:"))).toBe(false);
  });

  it("never holds a wildcard resource but X-Ray's", () => {
    for (const s of statements) {
      const list = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
      for (const r of list) {
        if (r === "*") expect(actions(s).every((a) => a.startsWith("xray:"))).toBe(true);
      }
      expect(actions(s).some((a) => a.endsWith(":*"))).toBe(false);
    }
  });

  it("takes a person's rows only through ConversationData, which trusts it by name (RLS)", () => {
    expect(bySid("OnePersonsRows")).toMatchObject({ Action: "sts:AssumeRole" });
    const tableStatements = statements.filter((s) => actions(s).some((a) => a.startsWith("dynamodb:")));
    // Only its own rate limits and the audit index: never Conversations directly.
    expect(tableStatements.map((s) => s.Sid).sort()).toEqual(["LimitPerPerson", "WriteAuditIndex"]);
    expect(bySid("LimitPerPerson").Condition).toEqual({
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["LIMIT#code.run#*", "LIMIT#code.session#*"] },
    });
    const [, dataRole] = only("AWS::IAM::Role", { RoleName: `Mango-${ns}-ConversationData` });
    const trust = JSON.stringify(dataRole.Properties.AssumeRolePolicyDocument);
    expect(trust).toContain(`:role/Mango-${ns}-CodeInterpreter`);
  });

  it("seals the session ids with the data key, for this purpose only (TM-CI1)", () => {
    const seal = bySid("SealSessionIds");
    expect(actions(seal).sort()).toEqual(["kms:Decrypt", "kms:Encrypt"]);
    expect(seal.Resource).toEqual({ "Fn::GetAtt": [dataKeyId, "Arn"] });
    expect(seal.Condition).toEqual({ StringEquals: { "kms:EncryptionContext:purpose": "code-session" } });
    expect(fn.Properties.Environment.Variables.SESSION_KEY_ARN).toEqual({ "Fn::GetAtt": [dataKeyId, "Arn"] });
  });

  it("writes the cells' files under owner/ of the chat files bucket, never a tag nor a read", () => {
    const write = bySid("WriteCellFiles");
    expect(write.Action).toBe("s3:PutObject");
    expect(JSON.stringify(write.Resource)).toContain("/owner/*");
    const s3 = statements.flatMap(actions).filter((a) => a.startsWith("s3:"));
    expect(s3).toEqual(["s3:PutObject"]);
    expect(bySid("ChatFilesKey").Condition).toEqual({
      StringEquals: { "kms:ViaService": `s3.${cfg.region}.amazonaws.com` },
    });
  });

  it("is a target of the Gateway with the tool schema of the connector, invoked with the Gateway's role", () => {
    const tools = target.Properties.TargetConfiguration.Mcp.Lambda.ToolSchema.InlinePayload as { Name: string }[];
    expect(tools.map((t) => t.Name)).toEqual(codeTools().map((t) => t.name));
    expect(tools.map((t) => t.Name)).toEqual(["run_python", "list_files", "read_file"]);
    expect(target.Properties.CredentialProviderConfigurations).toEqual([{ CredentialProviderType: "GATEWAY_IAM_ROLE" }]);
    const invoke = Object.values(resources).find(
      (r) =>
        r.Type === "AWS::IAM::Policy" &&
        (r.Properties.PolicyDocument.Statement as Statement[]).some((s) => s.Sid === "InvokeCodeConnector"),
    )!;
    const [statement] = invoke.Properties.PolicyDocument.Statement as Statement[];
    expect(statement!.Action).toBe("lambda:InvokeFunction");
    expect(statement!.Resource).toEqual({ "Fn::GetAtt": [fnId, "Arn"] });
  });

  it("has a Cedar policy (L2) for its three tools, on this Gateway only", () => {
    const statement = JSON.stringify(cedar.Properties.Definition.Cedar.Statement);
    for (const tool of ["run_python", "list_files", "read_file"]) {
      expect(statement).toContain(`AgentCore::Action::\\"code___${tool}\\"`);
    }
    expect(statement).toContain("principal is AgentCore::OAuthUser");
    expect(statement).not.toContain("run_shell");
  });

  it("gets the caller's context from the interceptor, like every Mango connector", () => {
    const [, interceptor] = only("AWS::Lambda::Function", { FunctionName: `Mango-${ns}-GatewayInterceptor` });
    const targets = JSON.parse(interceptor.Properties.Environment.Variables.CONTEXT_TARGETS as string) as string[];
    expect(targets).toContain(CODE_TARGET_NAME);
  });

  it("cuts a cell before the function's own timeout, and logs no content", () => {
    const env = fn.Properties.Environment.Variables as Record<string, unknown>;
    expect(env.CELL_SECONDS).toBe(String(CODE_CELL_SECONDS));
    expect(fn.Properties.Timeout).toBeGreaterThan(CODE_CELL_SECONDS);
    expect(Object.keys(env).some((k) => /SECRET|TOKEN|PASSWORD/.test(k))).toBe(false);
    expect(role.Properties.AssumeRolePolicyDocument.Statement[0].Principal).toEqual({ Service: "lambda.amazonaws.com" });
  });

  it("gives mango-api and the turn worker the sandbox prices (D115 (2), rule 7)", () => {
    const [, api] = only("AWS::ECS::TaskDefinition", { Family: `Mango-${ns}-api` });
    const variables = (api.Properties.ContainerDefinitions[0].Environment as { Name: string; Value: unknown }[]).map(
      (v) => v.Name,
    );
    expect(variables).toContain("CODE_INTERPRETER_PRICES");
  });
});
