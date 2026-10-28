import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import { loadInstallation } from "../lib/config/schema.js";
import { REMOTE_CONSENT_ATTRIBUTES } from "../lib/constructs/tools.js";
import { CoreStack } from "../lib/stacks/core-stack.js";
import { fromCore } from "./nested.js";

/* Gateway side of the remote MCP servers (D93, D94, D98 (13), (16); remote-mcp-threat-model.md). */

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

const template = fromCore(
  new CoreStack(new App({ context: { skipSpa: true } }), "Core", {
    installation: cfg,
    env: { account, region },
  }),
);
const resources = template.toJSON().Resources as Record<string, Resource>;

const actions = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
const resourcesOf = (s: Statement) => (Array.isArray(s.Resource) ? s.Resource : [s.Resource]);
function logicalId(type: string, props: Record<string, unknown>): string {
  const ids = Object.keys(template.findResources(type, { Properties: props }));
  expect(ids).toHaveLength(1);
  return ids[0]!;
}
function roleOf(functionName: string): string {
  const fn = resources[logicalId("AWS::Lambda::Function", { FunctionName: functionName })]!;
  return (fn.Properties.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];
}
function statementsOf(roleId: string): Statement[] {
  return Object.values(resources)
    .filter((r) => r.Type === "AWS::IAM::Policy" && r.Properties.Roles.some((x: { Ref: string }) => x.Ref === roleId))
    .flatMap((r) => r.Properties.PolicyDocument.Statement as Statement[]);
}
const bySid = (statements: Statement[], sid: string): Statement => {
  const found = statements.filter((s) => s.Sid === sid);
  expect(found, sid).toHaveLength(1);
  return found[0]!;
};
function allStatements(): { roles: string[]; statement: Statement }[] {
  return Object.values(resources)
    .filter((r) => r.Type === "AWS::IAM::Policy" || r.Type === "AWS::IAM::ManagedPolicy")
    .flatMap((r) =>
      (r.Properties.PolicyDocument.Statement as Statement[]).map((statement) => ({
        roles: ((r.Properties.Roles ?? []) as { Ref: string }[]).map((x) => x.Ref),
        statement,
      })),
    );
}
const text = (value: unknown) => JSON.stringify(value) ?? "";

const settingsArn = { "Fn::GetAtt": [logicalId("AWS::DynamoDB::GlobalTable", { TableName: `Mango-${ns}-Settings` }), "Arn"] };
const aliasId = logicalId("AWS::KMS::Alias", { AliasName: `alias/Mango-${ns}-remote-mcp` });
const keyId = (resources[aliasId]!.Properties.TargetKeyId as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];
const requestRole = roleOf(`Mango-${ns}-GatewayInterceptor`);
const responseRole = roleOf(`Mango-${ns}-GatewayResponseInterceptor`);
const gatewayId = logicalId("AWS::BedrockAgentCore::Gateway", { Name: `Mango-${ns}-Tools` });
const gatewayRole = (resources[gatewayId]!.Properties.RoleArn as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];

describe("remote MCP catalog key (D93 (9), TM-012)", () => {
  const key = resources[keyId]!;

  it("is an asymmetric signing key named alias/Mango-<ns>-remote-mcp", () => {
    expect(key.Properties.KeySpec).toBe("ECC_NIST_P256");
    expect(key.Properties.KeyUsage).toBe("SIGN_VERIFY");
  });

  it("denies kms:Sign to every principal but the remote provisioner role, named by ARN", () => {
    const deny = (key.Properties.KeyPolicy.Statement as Statement[]).filter((s) => s.Effect === "Deny");
    expect(deny).toEqual([
      {
        Sid: "OnlyTheRemoteProvisionerSigns",
        Effect: "Deny",
        Principal: { AWS: "*" },
        Action: "kms:Sign",
        Resource: "*",
        Condition: {
          ArnNotEquals: { "aws:PrincipalArn": `arn:aws:iam::${account}:role/Mango-${ns}-RemoteMcpProvisioner` },
        },
      },
    ]);
  });

  it("no identity policy of the stack lets anyone but the remote provisioner sign with it", () => {
    const signer = logicalId("AWS::IAM::Role", { RoleName: `Mango-${ns}-RemoteMcpProvisioner` });
    const signing = allStatements().filter(
      ({ statement }) =>
        statement.Effect === "Allow" &&
        actions(statement).some((a) => a === "kms:Sign" || a === "kms:*") &&
        text(statement.Resource).includes(keyId),
    );
    // The remote MCP provisioner (PR-4), and only it, by an identity policy too.
    expect(signing.map(({ roles }) => roles)).toEqual([[signer]]);
  });
});

describe("REQUEST interceptor on remote targets (D98 (13))", () => {
  const statements = statementsOf(requestRole);

  it("reads only the approved catalog partition of Settings", () => {
    const read = bySid(statements, "ReadRemoteCatalog");
    expect(actions(read)).toEqual(["dynamodb:GetItem"]);
    expect(read.Resource).toEqual(settingsArn);
    expect(read.Condition).toEqual({
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["MCP_REMOTE#*"] },
      Null: { "dynamodb:LeadingKeys": "false" },
    });
    // No other access to Settings.
    const settings = statements.filter((s) => text(s.Resource).includes(text(settingsArn)));
    expect(settings).toEqual([read]);
  });

  it("verifies with the public key and never signs with it", () => {
    expect(bySid(statements, "VerifyRemoteCatalog")).toMatchObject({
      Action: "kms:GetPublicKey",
      Resource: { "Fn::GetAtt": [keyId, "Arn"] },
    });
    const onKey = statements.filter((s) => text(s.Resource).includes(keyId));
    expect(onKey.flatMap(actions)).toEqual(["kms:GetPublicKey"]);
  });

  it("finds the Gateway id by name, in an SSM parameter the Gateway's id fills", () => {
    const name = `/Mango-${ns}-tools/gateway-id`;
    const parameter = resources[logicalId("AWS::SSM::Parameter", { Name: name })]!;
    expect(parameter.Properties.Value).toEqual({ "Fn::GetAtt": [gatewayId, "GatewayIdentifier"] });
    expect(bySid(statements, "GatewayId")).toMatchObject({
      Action: "ssm:GetParameter",
      Resource: `arn:aws:ssm:${region}:${account}:parameter${name}`,
    });
    const fn = resources[logicalId("AWS::Lambda::Function", { FunctionName: `Mango-${ns}-GatewayInterceptor` })]!;
    expect(fn.Properties.Environment.Variables).toMatchObject({
      GATEWAY_ID_PARAMETER: name,
      REMOTE_MCP_KEY_ARN: { "Fn::GetAtt": [keyId, "Arn"] },
    });
  });
});

describe("RESPONSE interceptor (D98 (16), TM-017)", () => {
  const statements = statementsOf(responseRole);

  it("runs on every answer of the Gateway, with the request headers", () => {
    const configs = resources[gatewayId]!.Properties.InterceptorConfigurations as {
      Interceptor: { Lambda: { Arn: unknown } };
      InterceptionPoints: string[];
      InputConfiguration: { PassRequestHeaders: boolean };
    }[];
    const response = configs.filter((c) => c.InterceptionPoints.includes("RESPONSE"));
    expect(response).toHaveLength(1);
    expect(response[0]!.InterceptionPoints).toEqual(["RESPONSE"]);
    expect(response[0]!.InputConfiguration).toEqual({ PassRequestHeaders: true });
    const fnId = logicalId("AWS::Lambda::Function", { FunctionName: `Mango-${ns}-GatewayResponseInterceptor` });
    expect(response[0]!.Interceptor.Lambda.Arn).toEqual({ "Fn::GetAtt": [fnId, "Arn"] });
  });

  it("only puts pending consents, with their attributes and nothing else", () => {
    const write = bySid(statements, "WritePendingConsents");
    expect(actions(write)).toEqual(["dynamodb:PutItem"]);
    expect(write.Resource).toEqual(settingsArn);
    expect(write.Condition).toEqual({
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["MCP_CONSENT#*"] },
      "ForAllValues:StringEquals": { "dynamodb:Attributes": REMOTE_CONSENT_ATTRIBUTES },
      Null: { "dynamodb:LeadingKeys": "false", "dynamodb:Attributes": "false" },
    });
    const dynamo = statements.filter((s) => actions(s).some((a) => a.startsWith("dynamodb:")));
    expect(dynamo).toEqual([write]);
  });

  it("is the only role that may write the pending consents", () => {
    for (const { roles, statement } of allStatements()) {
      if (statement.Effect !== "Allow" || !text(statement.Condition).includes("MCP_CONSENT#")) continue;
      expect(roles).toEqual([responseRole]);
    }
  });

  it("verifies invocations with the shared key and learns the tasks client", () => {
    const fn = resources[logicalId("AWS::Lambda::Function", { FunctionName: `Mango-${ns}-GatewayResponseInterceptor` })]!;
    const env = fn.Properties.Environment.Variables as Record<string, unknown>;
    expect(Object.keys(env).sort()).toEqual(["INVOCATION_KEY_SECRET_ARN", "SETTINGS_TABLE", "TASKS_CLIENT_ID"]);
    expect(statements.some((s) => actions(s).includes("secretsmanager:GetSecretValue"))).toBe(true);
    expect(statements.flatMap(actions)).not.toContain("kms:Sign");
  });

  it("alarms on its errors like the REQUEST interceptor (D71)", () => {
    expect(
      Object.keys(template.findResources("AWS::CloudWatch::Alarm", { Properties: { AlarmName: `Mango-${ns}-ops-GatewayResponseInterceptor-failing` } })),
    ).toHaveLength(1);
  });
});

describe("Gateway role and the token vault (D94 (3))", () => {
  const statements = statementsOf(gatewayRole);
  const base = `arn:aws:bedrock-agentcore:${region}:${account}`;

  it("reads the tokens of remote MCP providers only", () => {
    const tokens = bySid(statements, "RemoteMcpTokens");
    expect(actions(tokens)).toEqual(["bedrock-agentcore:GetResourceOauth2Token"]);
    expect(resourcesOf(tokens)).toEqual([
      `${base}:token-vault/default/oauth2credentialprovider/Mango-${ns}-remote-*`,
      `${base}:token-vault/default`,
      `${base}:workload-identity-directory/default`,
      `${base}:workload-identity-directory/default/workload-identity/mango-${ns}-tools-*`,
    ]);
  });

  it("gets tokens of its own workload identity only, which reading a person's token needs", () => {
    const identity = bySid(statements, "RemoteMcpWorkloadIdentity");
    expect(actions(identity)).toEqual([
      "bedrock-agentcore:GetWorkloadAccessToken",
      "bedrock-agentcore:GetWorkloadAccessTokenForJWT",
    ]);
    expect(resourcesOf(identity)).toEqual([
      `${base}:workload-identity-directory/default`,
      `${base}:workload-identity-directory/default/workload-identity/mango-${ns}-tools-*`,
    ]);
    // Not the variant that names any user: the person comes from the JWT the Gateway verified.
    expect(statements.flatMap(actions)).not.toContain("bedrock-agentcore:GetWorkloadAccessTokenForUserId");
  });

  it("reads the client secrets of remote MCP providers only", () => {
    expect(bySid(statements, "RemoteMcpClientSecrets")).toMatchObject({
      Action: "secretsmanager:GetSecretValue",
      Resource: `arn:aws:secretsmanager:${region}:${account}:secret:bedrock-agentcore-identity!default/oauth2/Mango-${ns}-remote-*`,
    });
  });

  it("never reads the Settings table nor signs a catalog", () => {
    expect(text(statements)).not.toContain("Settings");
    expect(statements.flatMap(actions)).not.toContain("kms:Sign");
  });
});
