import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import { loadInstallation } from "../lib/config/schema.js";
import {
  TEXTDOC_TARGET_NAME,
  textdocTools,
} from "../lib/constructs/textdoc-connector.js";
import { CoreStack } from "../lib/stacks/core-stack.js";
import { fromCore, nestedStacks, nestedTemplate } from "./nested.js";

/* The Canvas connector (D124 (2)); threat model canvas-threat-model.md (TM-CV1, CV2). */

const cfg = loadInstallation(
  resolve(import.meta.dirname, "../config/example.json"),
);
const ns = cfg.namespace;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resource = {
  Type: string;
  Properties: any;
  DependsOn?: string[];
  [k: string]: any;
};
interface Statement {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource: unknown;
  Condition?: Record<string, Record<string, unknown>>;
}

const core = new CoreStack(new App({ context: { skipSpa: true } }), "Core", {
  installation: cfg,
  env: { account: cfg.mangoAccountId, region: cfg.region },
});
const template = fromCore(core);
const resources = template.toJSON().Resources as Record<string, Resource>;
const sandboxStack = nestedStacks(core).find(
  (stack) => stack.node.id === "Sandbox",
)!;
const sandboxResources = nestedTemplate(sandboxStack).Resources as Record<
  string,
  Resource
>;
const actions = (s: Statement) =>
  Array.isArray(s.Action) ? s.Action : [s.Action];
function only(
  type: string,
  props: Record<string, unknown>,
): [string, Resource] {
  const found = Object.entries(
    template.findResources(type, { Properties: props }),
  );
  expect(found).toHaveLength(1);
  return found[0] as [string, Resource];
}
function statementsOf(roleId: string): Statement[] {
  return Object.values(resources)
    .filter(
      (r) =>
        (r.Type === "AWS::IAM::Policy" ||
          r.Type === "AWS::IAM::ManagedPolicy") &&
        (r.Properties.Roles ?? []).some(
          (x: { Ref: string }) => x.Ref === roleId,
        ),
    )
    .flatMap((r) => r.Properties.PolicyDocument.Statement as Statement[]);
}

const [roleId, role] = only("AWS::IAM::Role", {
  RoleName: `Mango-${ns}-Textdoc`,
});
const [fnId, fn] = only("AWS::Lambda::Function", {
  FunctionName: `Mango-${ns}-Textdoc`,
});
const [, target] = only("AWS::BedrockAgentCore::GatewayTarget", {
  Name: TEXTDOC_TARGET_NAME,
});
const [, cedar] = only("AWS::BedrockAgentCore::Policy", {
  Name: `Mango_${ns}_Textdoc`,
});
const statements = statementsOf(roleId);
const bySid = (sid: string) => statements.find((s) => s.Sid === sid)!;

describe("Canvas connector (D124)", () => {
  it("lives in the sandbox stack nested in Core, without data of its own", () => {
    for (const id of [roleId, fnId]) expect(sandboxResources[id]).toBeDefined();
    const kinds = new Set(Object.values(sandboxResources).map((r) => r.Type));
    expect(kinds.has("AWS::KMS::Key")).toBe(false);
    expect(kinds.has("AWS::DynamoDB::Table")).toBe(false);
  });

  it("writes only in Mango: a person's rows through ConversationData, no S3 nor another system", () => {
    expect(bySid("OnePersonsRows")).toMatchObject({ Action: "sts:AssumeRole" });
    const all = statements.flatMap(actions);
    expect(all.some((a) => a.startsWith("s3:"))).toBe(false);
    // Bedrock only to mask what it stores with the base guardrail (D124 (8)): never a model.
    expect(all.filter((a) => a.startsWith("bedrock"))).toEqual(["bedrock:ApplyGuardrail"]);
    expect(JSON.stringify(bySid("MaskWithBaseGuardrail").Resource)).toContain("GuardrailArn");
    expect(all.some((a) => a.startsWith("lambda:"))).toBe(false);
    const tables = statements.filter((s) =>
      actions(s).some((a) => a.startsWith("dynamodb:")),
    );
    expect(tables.map((s) => s.Sid).sort()).toEqual([
      "LimitPerPerson",
      "WriteAuditIndex",
    ]);
    expect(bySid("LimitPerPerson").Condition).toEqual({
      "ForAllValues:StringLike": {
        "dynamodb:LeadingKeys": ["LIMIT#textdoc.write#*"],
      },
    });
    const [, dataRole] = only("AWS::IAM::Role", {
      RoleName: `Mango-${ns}-ConversationData`,
    });
    expect(
      JSON.stringify(dataRole.Properties.AssumeRolePolicyDocument),
    ).toContain(`:role/Mango-${ns}-Textdoc`);
  });

  it("never holds a wildcard resource but X-Ray's", () => {
    for (const s of statements) {
      const list = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
      for (const r of list) {
        if (r === "*")
          expect(actions(s).every((a) => a.startsWith("xray:"))).toBe(true);
      }
      expect(actions(s).some((a) => a.endsWith(":*"))).toBe(false);
    }
  });

  it("is a target of the Gateway with the four tools of the connector", () => {
    const tools = target.Properties.TargetConfiguration.Mcp.Lambda.ToolSchema
      .InlinePayload as { Name: string }[];
    expect(tools.map((t) => t.Name)).toEqual(textdocTools().map((t) => t.name));
    expect(tools.map((t) => t.Name)).toEqual([
      "create",
      "update",
      "comment",
      "read",
    ]);
    const invoke = Object.values(resources).find(
      (r) =>
        r.Type === "AWS::IAM::Policy" &&
        (r.Properties.PolicyDocument.Statement as Statement[]).some(
          (s) => s.Sid === "InvokeTextdocConnector",
        ),
    )!;
    const [statement] = invoke.Properties.PolicyDocument
      .Statement as Statement[];
    expect(statement!.Resource).toEqual({ "Fn::GetAtt": [fnId, "Arn"] });
  });

  it("has a Cedar policy (L2) for its four tools, on this Gateway only", () => {
    const statement = JSON.stringify(
      cedar.Properties.Definition.Cedar.Statement,
    );
    for (const tool of ["create", "update", "comment", "read"]) {
      expect(statement).toContain(`AgentCore::Action::\\"textdoc___${tool}\\"`);
    }
    expect(statement).toContain("principal is AgentCore::OAuthUser");
  });

  it("gets the caller's context from the interceptor, like every Mango connector", () => {
    const [, interceptor] = only("AWS::Lambda::Function", {
      FunctionName: `Mango-${ns}-GatewayInterceptor`,
    });
    const targets = JSON.parse(
      interceptor.Properties.Environment.Variables.CONTEXT_TARGETS as string,
    ) as string[];
    expect(targets).toContain(TEXTDOC_TARGET_NAME);
  });

  it("holds no secret in its environment and is invoked by Lambda only", () => {
    const env = fn.Properties.Environment.Variables as Record<string, unknown>;
    expect(Object.keys(env).some((k) => /SECRET|TOKEN|PASSWORD/.test(k))).toBe(
      false,
    );
    // The pinned version of the base guardrail it masks with (D124 (8)), as a parameter of Core.
    expect(Object.keys(env)).toEqual(expect.arrayContaining(["GUARDRAIL_ID", "GUARDRAIL_VERSION"]));
    expect(
      role.Properties.AssumeRolePolicyDocument.Statement[0].Principal,
    ).toEqual({ Service: "lambda.amazonaws.com" });
  });

  it("lets mango-api render a PDF only where the render function exists (D117 (8))", () => {
    const api = Object.values(resources).find(
      (r) =>
        r.Type === "AWS::IAM::ManagedPolicy" &&
        r.Properties.ManagedPolicyName === `Mango-${ns}-ApiChatFiles`,
    );
    const nested = Object.values(sandboxResources).find(
      (r) =>
        r.Type === "AWS::IAM::ManagedPolicy" &&
        r.Properties.ManagedPolicyName === `Mango-${ns}-ApiChatFiles`,
    );
    const policy = (api ?? nested)!;
    const sids = (
      policy.Properties.PolicyDocument.Statement as Statement[]
    ).map((s) => s.Sid);
    expect(sids).not.toContain("RenderCanvasPdf");
  });
});
