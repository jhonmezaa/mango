import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { loadInstallation } from "../lib/config/schema.js";
import { writeTools } from "../lib/constructs/write-tools.js";
import { CoreStack } from "../lib/stacks/core-stack.js";
import { BILLING_READER_DATA_ACTIONS, BUDGETS_OPERATOR_ACTIONS } from "../lib/stacks/payer-stack.js";
import { payerTemplate } from "./parameters.js";

/* Write tools with approval (D27; write-tools-approval-threat-model.md). */

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
const payer = payerTemplate(cfg).toJSON().Resources as Record<string, Resource>;

const actions = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
function logicalId(type: string, props: Record<string, unknown>): string {
  const ids = Object.keys(template.findResources(type, { Properties: props }));
  expect(ids).toHaveLength(1);
  return ids[0]!;
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
/** Every statement of every identity policy in the Core stack, with the roles it is attached to. */
function grants(): { roles: string[]; statement: Statement }[] {
  return Object.values(resources)
    .filter((r) => r.Type === "AWS::IAM::Policy")
    .flatMap((r) =>
      (r.Properties.PolicyDocument.Statement as Statement[]).map((statement) => ({
        roles: (r.Properties.Roles as { Ref: string }[]).map((x) => x.Ref),
        statement,
      })),
    );
}

const apiRoleId = logicalId("AWS::IAM::Role", { RoleName: `Mango-${ns}-ApiTask` });
const executorRoleId = logicalId("AWS::IAM::Role", { RoleName: `Mango-${ns}-ApprovalExecutor` });
const brokerId = logicalId("AWS::IAM::Role", { RoleName: `Mango-${ns}-OperateBroker` });
const tableId = logicalId("AWS::DynamoDB::GlobalTable", { TableName: `Mango-${ns}-Approvals` });
const executorFnId = logicalId("AWS::Lambda::Function", { FunctionName: `Mango-${ns}-ApprovalExecutor` });
const interceptorFnId = logicalId("AWS::Lambda::Function", { FunctionName: `Mango-${ns}-GatewayInterceptor` });
const interceptorRoleId = (resources[interceptorFnId]!.Properties.Role as { "Fn::GetAtt": [string, string] })[
  "Fn::GetAtt"
][0];
const keyId = Object.keys(
  template.findResources("AWS::KMS::Key", { Properties: { KeySpec: "ECC_NIST_P256", Description: "Signs the approval tokens of write tool calls; only mango-api can sign" } }),
)[0]!;
const budgetsOperatorArn = `arn:aws:iam::${cfg.managementAccountId}:role/Mango-${ns}-BudgetsOperator`;
const tableArn = { "Fn::GetAtt": [tableId, "Arn"] };

describe("approvals table", () => {
  const table = resources[tableId]!;

  it("is encrypted with the data key, recoverable and named with the namespace", () => {
    expect(table.Properties.SSESpecification).toEqual({ SSEEnabled: true, SSEType: "KMS" });
    expect(table.Properties.Replicas[0].SSESpecification.KMSMasterKeyId).toBeDefined();
    expect(table.Properties.Replicas[0].PointInTimeRecoverySpecification).toEqual({
      PointInTimeRecoveryEnabled: true,
    });
    expect(table.Properties.TimeToLiveSpecification).toEqual({ AttributeName: "ttl", Enabled: true });
    expect(table.Properties.BillingMode).toBe("PAY_PER_REQUEST");
  });

  it("has the two indexes mango-api queries", () => {
    const indexes = table.Properties.GlobalSecondaryIndexes as {
      IndexName: string;
      KeySchema: { AttributeName: string; KeyType: string }[];
    }[];
    expect(indexes.map((i) => [i.IndexName, ...i.KeySchema.map((k) => k.AttributeName)]).sort()).toEqual([
      ["ByRequester", "requester_pk", "sort"],
      ["ByState", "state_pk", "sort"],
    ]);
  });

  it("lets mango-api read and move requests, without Scan or Delete", () => {
    const statement = bySid(statementsOf(apiRoleId), "ApprovalsTable");
    expect(actions(statement).sort()).toEqual([
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
    ]);
    expect(statement.Resource).toEqual([
      tableArn,
      { "Fn::Join": ["", [tableArn, "/index/ByState"]] },
      { "Fn::Join": ["", [tableArn, "/index/ByRequester"]] },
    ]);
  });

  it("gives the table to nobody else but the two enforcement points, for their mark only", () => {
    const onTable = grants().filter(
      (g) => actions(g.statement).some((a) => a.startsWith("dynamodb:")) && JSON.stringify(g.statement.Resource).includes(tableId),
    );
    expect(onTable.map((g) => [g.statement.Sid, g.roles]).sort()).toEqual(
      [
        ["ApprovalsTable", [apiRoleId]],
        ["SpendApprovalAtTheExecutor", [executorRoleId]],
        ["SpendApprovalAtTheGateway", [interceptorRoleId]],
      ].sort(),
    );
    const claim = ["PK", "SK"];
    const expected: Record<string, string[]> = {
      SpendApprovalAtTheGateway: [...claim, "gateway_used_at"],
      SpendApprovalAtTheExecutor: [...claim, "gateway_used_at", "executor_used_at"],
    };
    for (const [sid, attributes] of Object.entries(expected)) {
      const { statement } = onTable.find((g) => g.statement.Sid === sid)!;
      // One conditional update of its own mark. It cannot read a request, and it cannot even
      // name its status, its signatures, its arguments or who asked (TM-W7).
      for (const decisive of ["status", "signers", "signatures", "args_hash", "arguments", "requested_by", "tier"]) {
        expect(attributes).not.toContain(decisive);
      }
      expect(actions(statement)).toEqual(["dynamodb:UpdateItem"]);
      expect(statement.Resource).toEqual(tableArn);
      expect(statement.Condition).toEqual({
        "ForAllValues:StringEquals": { "dynamodb:Attributes": attributes },
        StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
      });
    }
  });
});

describe("approval key (TM-W7)", () => {
  const key = resources[keyId]!;
  const policy = key.Properties.KeyPolicy.Statement as Statement[];
  const apiRoleArn = { "Fn::GetAtt": [apiRoleId, "Arn"] };

  it("is asymmetric, so whoever verifies cannot sign", () => {
    expect(key.Properties.KeySpec).toBe("ECC_NIST_P256");
    expect(key.Properties.KeyUsage).toBe("SIGN_VERIFY");
    template.hasResourceProperties("AWS::KMS::Alias", { AliasName: `alias/Mango-${ns}-approval` });
  });

  it("denies signing to everyone but mango-api, whatever their identity policy says", () => {
    const deny = bySid(policy, "OnlyMangoApiSigns");
    expect(deny.Effect).toBe("Deny");
    expect(actions(deny)).toEqual(["kms:Sign"]);
    expect(deny.Principal).toEqual({ AWS: "*" });
    expect(deny.Condition).toEqual({ ArnNotEquals: { "aws:PrincipalArn": apiRoleArn } });
  });

  it("is used by exactly three roles: mango-api signs, the enforcement points read the public key", () => {
    const onKey = grants().filter((g) => JSON.stringify(g.statement.Resource).includes(keyId));
    expect(onKey.map((g) => [actions(g.statement).join(), g.roles]).sort()).toEqual(
      [
        ["kms:Sign", [apiRoleId]],
        ["kms:GetPublicKey", [interceptorRoleId]],
        ["kms:GetPublicKey", [executorRoleId]],
      ].sort(),
    );
  });

  it("tells mango-api and both enforcement points where the key and the table are", () => {
    const task = Object.values(template.findResources("AWS::ECS::TaskDefinition"))[0]!;
    const env = Object.fromEntries(
      (task.Properties.ContainerDefinitions[0].Environment as { Name: string; Value: unknown }[]).map((e) => [e.Name, e.Value]),
    );
    expect(env.APPROVALS_TABLE).toEqual({ Ref: tableId });
    expect(env.APPROVAL_KEY_ARN).toEqual({ "Fn::GetAtt": [keyId, "Arn"] });
    for (const fn of [interceptorFnId, executorFnId]) {
      const variables = resources[fn]!.Properties.Environment.Variables;
      expect(variables.APPROVALS_TABLE).toEqual({ Ref: tableId });
      expect(variables.APPROVAL_KEY_ARN).toEqual({ "Fn::GetAtt": [keyId, "Arn"] });
    }
  });
});

describe("the Gateway refuses write tools without an approval (TM-W1)", () => {
  const variables = resources[interceptorFnId]!.Properties.Environment.Variables;

  it("gives the interceptor the closed list of write tools of the release", () => {
    expect(writeTools()).toEqual([{ name: "create_budget", central: true }]);
    expect(JSON.parse(variables.APPROVAL_TOOLS as string)).toEqual(["ops___create_budget"]);
  });

  it("exposes exactly the tools the manifest declares, on their own target", () => {
    const targets = Object.values(template.findResources("AWS::BedrockAgentCore::GatewayTarget"));
    const ops = targets.filter((t) => t.Properties.Name === "ops");
    expect(ops).toHaveLength(1);
    const lambda = ops[0]!.Properties.TargetConfiguration.Mcp.Lambda;
    expect(lambda.LambdaArn).toEqual({ "Fn::GetAtt": [executorFnId, "Arn"] });
    expect(lambda.ToolSchema.InlinePayload.map((t: { Name: string }) => t.Name)).toEqual(["create_budget"]);
    const manifest = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../connectors/aws-budgets/manifest.json"), "utf8"),
    ) as { gateway_target: string; tools: { access: string }[] };
    expect(manifest.gateway_target).toBe("ops");
    // A read tool on this target would get the approval executor for free.
    expect(manifest.tools.every((t) => t.access === "write")).toBe(true);
  });

  it("lets only central FinOps ask for it, and forbids everyone else (Cedar L2)", () => {
    const statement = (name: string) => {
      const policy = Object.values(template.findResources("AWS::BedrockAgentCore::Policy")).find(
        (r) => r.Properties.Name === `Mango_${ns}_${name}`,
      )!;
      const cedar = policy.Properties.Definition.Cedar.Statement as { "Fn::Join": [string, unknown[]] };
      return cedar["Fn::Join"][1].map((part) => (typeof part === "string" ? part : "<gateway>")).join("");
    };
    const central = 'principal.hasTag("mango_role") && (principal.getTag("mango_role") == "finops-central")';
    const permit = statement("WriteCentral");
    const forbid = statement("WriteCentralForbidOthers");
    expect(permit).toBe(
      [
        "permit (",
        "  principal is AgentCore::OAuthUser,",
        '  action in [AgentCore::Action::"ops___create_budget"],',
        '  resource == AgentCore::Gateway::"<gateway>"',
        `) when { ${central} };`,
      ].join("\n"),
    );
    expect(forbid).toBe(permit.replace("permit (", "forbid (").replace(") when {", ") unless {"));
  });
});

describe("approval executor and the write chain (§4.10, TM-W8)", () => {
  const executor = statementsOf(executorRoleId);
  const brokerArn = { "Fn::GetAtt": [brokerId, "Arn"] };
  const executorRoleArn = { "Fn::GetAtt": [executorRoleId, "Arn"] };

  it("can only assume the operate broker, spend approvals and write its own logs", () => {
    const sts = executor.filter((s) => actions(s).some((a) => a.startsWith("sts:")));
    expect(sts).toHaveLength(1);
    expect(sts[0]!.Resource).toEqual(brokerArn);
    for (const statement of executor) {
      for (const action of actions(statement)) {
        expect(action).toMatch(
          /^(sts:(AssumeRole|SetSourceIdentity|TagSession)|dynamodb:UpdateItem|kms:(GetPublicKey|Decrypt|Encrypt|GenerateDataKey)|logs:|xray:)/,
        );
      }
    }
    // No AWS data or write action of its own: every change goes through the broker.
    expect(executor.flatMap(actions).some((a) => a.startsWith("budgets:"))).toBe(false);
  });

  it("is invoked only by the Gateway", () => {
    const invokers = grants().filter(
      (g) => actions(g.statement).includes("lambda:InvokeFunction") && JSON.stringify(g.statement.Resource).includes(executorFnId),
    );
    const gatewayRoleId = Object.keys(resources).find(
      (id) => id.startsWith("ToolsGatewayRole") && resources[id]!.Type === "AWS::IAM::Role",
    )!;
    expect(invokers.map((g) => g.roles)).toEqual([[gatewayRoleId]]);
    expect(
      Object.keys(template.findResources("AWS::Lambda::Permission")).filter((id) =>
        JSON.stringify(resources[id]).includes(executorFnId),
      ),
    ).toEqual([]);
  });

  it("names its resources with the installation prefix", () => {
    const variables = resources[executorFnId]!.Properties.Environment.Variables;
    expect(variables.RESOURCE_PREFIX).toBe(`Mango-${ns}-`);
    expect(variables.BUDGETS_OPERATOR_ROLE_ARN).toBe(budgetsOperatorArn);
    expect(variables.OPERATE_BROKER_ROLE_ARN).toEqual(brokerArn);
    expect(resources[executorFnId]!.Properties.KmsKeyArn).toBeDefined();
  });

  it("is the only principal the operate broker trusts, always with a person and an approval", () => {
    const trust = resources[brokerId]!.Properties.AssumeRolePolicyDocument.Statement as Statement[];
    expect(trust).toHaveLength(3);
    for (const statement of trust) {
      expect(statement.Condition?.ArnEquals).toEqual({ "aws:PrincipalArn": executorRoleArn });
    }
    const assume = trust.find((s) => actions(s).includes("sts:AssumeRole"))!;
    expect(assume.Condition?.Null).toEqual({
      "sts:SourceIdentity": "false",
      "aws:RequestTag/mango_approval": "false",
    });
    const tag = trust.find((s) => actions(s).includes("sts:TagSession"))!;
    expect(tag.Condition?.["ForAllValues:StringEquals"]).toEqual({
      "aws:TagKeys": ["mango_user", "mango_agent", "mango_approval"],
    });
    // Nobody else in the account may assume it.
    const assumers = grants().filter((g) => JSON.stringify(g.statement.Resource) === JSON.stringify(brokerArn));
    expect(assumers.map((g) => g.roles)).toEqual([[executorRoleId]]);
  });

  it("lets the broker reach the payer write role and nothing else", () => {
    const broker = statementsOf(brokerId);
    expect(broker).toHaveLength(1);
    expect(actions(broker[0]!).sort()).toEqual(["sts:AssumeRole", "sts:SetSourceIdentity", "sts:TagSession"]);
    expect(broker[0]!.Resource).toBe(budgetsOperatorArn);
  });
});

describe("write role of the payer account (TM-W8)", () => {
  const roleId = Object.keys(payer).find((id) => payer[id]!.Properties?.RoleName === `Mango-${ns}-BudgetsOperator`)!;
  const role = payer[roleId]!;
  const policies = Object.values(payer)
    .filter((r) => r.Type === "AWS::IAM::Policy" && r.Properties.Roles.some((x: { Ref: string }) => x.Ref === roleId))
    .flatMap((r) => r.Properties.PolicyDocument.Statement as Statement[]);

  it("can only touch budgets named with the installation prefix", () => {
    expect(policies).toHaveLength(1);
    expect(policies[0]!.Effect).toBe("Allow");
    expect(actions(policies[0]!)).toEqual(BUDGETS_OPERATOR_ACTIONS);
    expect(BUDGETS_OPERATOR_ACTIONS).toEqual(["budgets:ModifyBudget"]);
    expect(policies[0]!.Resource).toBe(`arn:aws:budgets::${cfg.managementAccountId}:budget/Mango-${ns}-*`);
    expect(role.Properties.ManagedPolicyArns).toBeUndefined();
  });

  it("trusts only the operate broker, inside the organization and with a SourceIdentity", () => {
    const trust = role.Properties.AssumeRolePolicyDocument.Statement as Statement[];
    expect(trust).toHaveLength(3);
    for (const statement of trust) {
      expect(statement.Condition?.ArnEquals).toEqual({
        "aws:PrincipalArn": `arn:aws:iam::${account}:role/Mango-${ns}-OperateBroker`,
      });
      expect(statement.Condition?.StringEquals?.["aws:PrincipalOrgID"]).toBe(cfg.organizationId);
    }
    const assume = trust.find((s) => actions(s).includes("sts:AssumeRole"))!;
    expect(assume.Condition?.Null).toEqual({ "sts:SourceIdentity": "false" });
    const tag = trust.find((s) => actions(s).includes("sts:TagSession"))!;
    expect(tag.Condition?.["ForAllValues:StringEquals"]).toEqual({
      "aws:TagKeys": ["mango_user", "mango_agent", "mango_approval"],
    });
  });

  it("keeps the reader read-only: the write action is not behind the Billing broker", () => {
    expect(BILLING_READER_DATA_ACTIONS).not.toContain("budgets:ModifyBudget");
    const readerId = Object.keys(payer).find((id) => payer[id]!.Properties?.RoleName === `Mango-${ns}-BillingReader`)!;
    const reader = Object.values(payer)
      .filter((r) => r.Type === "AWS::IAM::Policy" && r.Properties.Roles.some((x: { Ref: string }) => x.Ref === readerId))
      .flatMap((r) => r.Properties.PolicyDocument.Statement as Statement[]);
    expect(reader.flatMap(actions)).not.toContain("budgets:ModifyBudget");
  });
});
