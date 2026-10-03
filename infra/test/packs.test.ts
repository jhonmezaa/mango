import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { loadReleasePacks, packCatalog, packSigningKey, PAYLOAD_TYPE } from "../lib/config/pack-release.js";
import { installationSchema, loadInstallation } from "../lib/config/schema.js";
import { PACK_EGRESS_SERVICES, packSubnetCidrs } from "../lib/constructs/pack-network.js";
import { assertPackEgress, PACK_DATA_ACTIONS } from "../lib/constructs/pack-platform.js";
import { PACK_PROVISIONER_WRITABLE_ATTRIBUTES } from "../lib/constructs/pack-provisioner.js";
import { CoreStack } from "../lib/stacks/core-stack.js";
import { MEMBER_READ_ONLY_DATA_ACTIONS } from "../lib/stacks/member-stack.js";
import { BILLING_READER_DATA_ACTIONS } from "../lib/stacks/payer-stack.js";
import { payerTemplate } from "./parameters.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const examplePath = resolve(import.meta.dirname, "../config/example.json");
const cfg = loadInstallation(examplePath);
const ns = cfg.namespace;
const account = cfg.mangoAccountId;
const region = cfg.region;

type Resource = { Type: string; Properties: any; [k: string]: any };
interface Statement {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource: unknown;
  Condition?: Record<string, Record<string, unknown>>;
}

function synth(installation = cfg, context: Record<string, unknown> = {}) {
  const template = Template.fromStack(
    new CoreStack(new App({ context: { skipSpa: true, ...context } }), "Core", {
      installation,
      env: { account, region },
    }),
  );
  return { template, resources: template.toJSON().Resources as Record<string, Resource> };
}

// A release without signed packs, whatever `dist/packs` holds on this machine.
const { template, resources } = synth(cfg, { packsDir: mkdtempSync(join(tmpdir(), "mango-no-packs-")) });

function logicalId(type: string, props: Record<string, unknown>): string {
  const ids = Object.keys(template.findResources(type, { Properties: props }));
  expect(ids).toHaveLength(1);
  return ids[0]!;
}
function statementsOf(roleId: string, all = resources): Statement[] {
  return Object.values(all)
    .filter((r) => r.Type === "AWS::IAM::Policy" && r.Properties.Roles.some((x: { Ref: string }) => x.Ref === roleId))
    .flatMap((r) => r.Properties.PolicyDocument.Statement as Statement[]);
}
const actions = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
/** Environment of the mango-api container. */
function containerEnvironment(all: Record<string, Resource>): Record<string, unknown> {
  const containers = Object.values(all)
    .filter((r) => r.Type === "AWS::ECS::TaskDefinition")
    .flatMap((r) => r.Properties.ContainerDefinitions as { Environment?: { Name: string; Value: unknown }[] }[]);
  const entries = containers.flatMap((c) => c.Environment ?? []);
  return Object.fromEntries(entries.map((e) => [e.Name, e.Value]));
}
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);
const bySid = (statements: Statement[], sid: string): Statement => {
  const found = statements.filter((s) => s.Sid === sid);
  expect(found, sid).toHaveLength(1);
  return found[0]!;
};

const roleId = logicalId("AWS::IAM::Role", { RoleName: `Mango-${ns}-PackProvisioner` });
const agentProvisionerRoleId = logicalId("AWS::IAM::Role", { RoleName: `Mango-${ns}-Provisioner` });
const apiRoleId = logicalId("AWS::IAM::Role", { RoleName: `Mango-${ns}-ApiTask` });
const boundaryId = logicalId("AWS::IAM::ManagedPolicy", { ManagedPolicyName: `Mango-${ns}-mcp-boundary` });
const functionId = logicalId("AWS::Lambda::Function", { FunctionName: `Mango-${ns}-PackProvisioner` });
const machineId = logicalId("AWS::StepFunctions::StateMachine", { StateMachineName: `Mango-${ns}-PackProvisioner` });
const settingsId = logicalId("AWS::DynamoDB::GlobalTable", { TableName: `Mango-${ns}-Settings` });
const gatewayId = Object.keys(template.findResources("AWS::BedrockAgentCore::Gateway"))[0]!;
const engineId = Object.keys(template.findResources("AWS::BedrockAgentCore::PolicyEngine"))[0]!;
const bucketId = Object.keys(resources).find((id) => id.startsWith("PackPlatformBucket") && resources[id]!.Type === "AWS::S3::Bucket")!;
const gatewayRoleId = Object.keys(resources).find((id) => id.startsWith("ToolsGatewayRole") && resources[id]!.Type === "AWS::IAM::Role")!;
const provisioner = statementsOf(roleId);
const api = statementsOf(apiRoleId);

const packRoles = `arn:aws:iam::${account}:role/Mango-${ns}-mcp-*`;
const agentcore = `arn:aws:bedrock-agentcore:${region}:${account}`;
const runtimes = `${agentcore}:runtime/Mango_${ns}_mcp_*`;
const requestTags = {
  StringEquals: { "aws:RequestTag/mango:namespace": ns, "aws:RequestTag/mango:component": "mcp-pack" },
};
const withBoundary = { StringEquals: { "iam:PermissionsBoundary": { Ref: boundaryId } } };

describe("pack provisioner role: IAM (TM-M1, TM-B4)", () => {
  it("can only create roles under the pack prefix and with the pack boundary", () => {
    const create = bySid(provisioner, "CreatePackRoleWithBoundary");
    expect(actions(create)).toEqual(["iam:CreateRole"]);
    expect(create.Resource).toBe(packRoles);
    expect(create.Condition).toEqual(withBoundary);
    expect(provisioner.filter((s) => actions(s).includes("iam:CreateRole"))).toHaveLength(1);
  });

  it("can only write inline policies on roles that carry the boundary", () => {
    const policy = bySid(provisioner, "PackRolePolicyWithBoundary");
    expect(actions(policy).sort()).toEqual(["iam:DeleteRolePolicy", "iam:PutRolePolicy"]);
    expect(policy.Resource).toBe(packRoles);
    expect(policy.Condition).toEqual(withBoundary);
    expect(provisioner.filter((s) => actions(s).includes("iam:PutRolePolicy"))).toHaveLength(1);
  });

  it("passes pack roles only to AgentCore", () => {
    const pass = bySid(provisioner, "PassPackRoleToAgentCore");
    expect(pass.Resource).toBe(packRoles);
    expect(pass.Condition).toEqual({ StringEquals: { "iam:PassedToService": "bedrock-agentcore.amazonaws.com" } });
    expect(provisioner.filter((s) => actions(s).includes("iam:PassRole"))).toHaveLength(1);
  });

  it("has no other IAM power: no attach, no boundary or trust changes, no agent roles", () => {
    const iamActions = provisioner.flatMap(actions).filter((a) => a.startsWith("iam:")).sort();
    expect(iamActions).toEqual([
      "iam:CreateRole",
      "iam:CreateServiceLinkedRole",
      "iam:DeleteRole",
      "iam:DeleteRolePolicy",
      "iam:GetRole",
      "iam:PassRole",
      "iam:PutRolePolicy",
      "iam:TagRole",
    ]);
    // Pack roles only; the one exception is AgentCore's own network service role (R6), which
    // has its own test below.
    for (const s of provisioner.filter((x) => actions(x).some((a) => a.startsWith("iam:")))) {
      if (s.Sid !== "AgentCoreNetworkServiceRole") expect(s.Resource).toBe(packRoles);
    }
    expect(provisioner.flatMap(actions).some((a) => a.startsWith("sts:"))).toBe(false);
  });
});

describe("pack provisioner role: AgentCore", () => {
  it("tags what it creates for a runtime with this installation's pack tags", () => {
    const tag = bySid(provisioner, "TagNewPackRuntime");
    expect(actions(tag).sort()).toEqual([
      "bedrock-agentcore:CreateAgentRuntimeEndpoint",
      "bedrock-agentcore:TagResource",
    ]);
    expect(tag.Resource).toBe(`${agentcore}:runtime/*`);
    expect(tag.Condition).toEqual(requestTags);
    expect(bySid(provisioner, "CreatePackWorkloadIdentity").Condition).toEqual(requestTags);
  });

  it("cannot create or update a runtime while the release ships no pack (R6)", () => {
    // No pack network exists, so there is nowhere a runtime could run.
    const all = provisioner.flatMap(actions);
    expect(all).not.toContain("bedrock-agentcore:CreateAgentRuntime");
    expect(all).not.toContain("bedrock-agentcore:UpdateAgentRuntime");
  });

  it("manages and invokes only runtimes named after a pack", () => {
    for (const sid of ["ManagePackRuntime", "ListPackTools"]) {
      expect(list(bySid(provisioner, sid).Resource)).toEqual([runtimes, `${runtimes}/runtime-endpoint/*`]);
    }
    expect(actions(bySid(provisioner, "ListPackTools"))).toEqual(["bedrock-agentcore:InvokeAgentRuntime"]);
  });

  it("cannot touch agent harnesses or invoke one (TM-M11)", () => {
    const all = provisioner.flatMap(actions);
    expect(all.some((a) => a.includes("Harness"))).toBe(false);
    for (const s of provisioner) expect(JSON.stringify(s.Resource)).not.toContain("harness");
  });

  it("writes targets only in this installation's gateway", () => {
    const targets = bySid(provisioner, "PackGatewayTargets");
    expect(targets.Resource).toEqual({ "Fn::GetAtt": [gatewayId, "GatewayArn"] });
    expect(actions(targets).every((a) => /GatewayTargets?$/.test(a))).toBe(true);
    const gatewayActions = provisioner.flatMap(actions).filter((a) => /Gateway$/.test(a)).sort();
    // Never creates, updates or deletes the gateway itself.
    expect(gatewayActions).toEqual(["bedrock-agentcore:GetGateway", "bedrock-agentcore:InvokeGateway"]);
  });

  it("can only read, change or delete Cedar policies named after a pack (TM-B6)", () => {
    const engine = { "Fn::GetAtt": [engineId, "PolicyEngineArn"] };
    expect(bySid(provisioner, "PackPolicies").Resource).toEqual(engine);
    // AgentCore requires both the engine and the policy: this statement is the name scope.
    const manage = bySid(provisioner, "ManagePackPolicies");
    expect(actions(manage).sort()).toEqual([
      "bedrock-agentcore:DeletePolicy",
      "bedrock-agentcore:GetPolicy",
      "bedrock-agentcore:UpdatePolicy",
    ]);
    expect(manage.Resource).toEqual({ "Fn::Join": ["", [engine, `/policy/Mango_${ns}_mcp_*`]] });
    const policyActions = provisioner.filter((s) => actions(s).some((a) => /(Get|Update|Delete)Policy$/.test(a)));
    expect(policyActions.map((s) => s.Sid).sort()).toEqual(["ManagePackPolicies", "PackPolicies"]);
  });

  it("can only create policies scoped to this gateway, never wildcard-scoped or engine-wide", () => {
    const all = provisioner.flatMap(actions);
    expect(all).toContain("bedrock-agentcore:ManageResourceScopedPolicy");
    expect(all).not.toContain("bedrock-agentcore:ManageAdminPolicy");
    for (const forbidden of ["CreateGateway", "UpdateGateway", "DeleteGateway"]) {
      expect(all).not.toContain(`bedrock-agentcore:${forbidden}`);
    }
    expect(all.some((a) => a.includes("PolicyEngine"))).toBe(false);
    expect(bySid(provisioner, "ScopePackPoliciesToGateway").Resource).toEqual({
      "Fn::GetAtt": [gatewayId, "GatewayArn"],
    });
  });

  it("uses Resource '*' only where the API has no resource scope", () => {
    const star = provisioner.filter((s) => list(s.Resource).includes("*"));
    expect(star.flatMap(actions).sort()).toEqual([
      "bedrock-agentcore:ListAgentRuntimes",
      "xray:PutTelemetryRecords",
      "xray:PutTraceSegments",
    ]);
  });
});

describe("pack provisioner role: data", () => {
  it("only reads the signed packs, and never writes the bucket (TM-B1)", () => {
    const s3Statements = provisioner.filter((s) => actions(s).some((a) => a.startsWith("s3:")));
    expect(s3Statements).toHaveLength(1);
    expect(actions(s3Statements[0]!).sort()).toEqual(["s3:GetObject", "s3:GetObjectVersion"]);
    expect(s3Statements[0]!.Resource).toEqual({ "Fn::Join": ["", [{ "Fn::GetAtt": [bucketId, "Arn"] }, "/packs/*"]] });
  });

  it("reads enablements and writes only installation state", () => {
    const table = { "Fn::GetAtt": [settingsId, "Arn"] };
    const read = bySid(provisioner, "ReadPackEnablements");
    expect(actions(read)).toEqual(["dynamodb:GetItem"]);
    expect(read.Condition).toEqual({
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["MCP#*", "MCP_INSTALLED#*"] },
    });
    const write = bySid(provisioner, "WriteInstallationState");
    expect(actions(write)).toEqual(["dynamodb:UpdateItem"]);
    expect(write.Resource).toEqual(table);
    expect(write.Condition!["ForAllValues:StringLike"]).toEqual({ "dynamodb:LeadingKeys": ["MCP#*"] });
    expect(write.Condition!["ForAllValues:StringEquals"]).toEqual({
      "dynamodb:Attributes": PACK_PROVISIONER_WRITABLE_ATTRIBUTES,
    });
    for (const owned of ["config", "approved_by", "requested_by", "version"]) {
      expect(PACK_PROVISIONER_WRITABLE_ATTRIBUTES).not.toContain(owned);
    }
    const pointer = bySid(provisioner, "WriteInstalledPointer");
    expect(actions(pointer).sort()).toEqual(["dynamodb:DeleteItem", "dynamodb:PutItem"]);
    expect(pointer.Condition).toEqual({
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["MCP_INSTALLED#*"] },
    });
    const dynamo = provisioner.flatMap(actions).filter((a) => a.startsWith("dynamodb:"));
    expect(dynamo.some((a) => /Scan|Query|Batch/.test(a))).toBe(false);
  });

  it("is a different role from the agent provisioner, which gets none of this", () => {
    const agent = statementsOf(agentProvisionerRoleId);
    const all = agent.flatMap(actions);
    for (const forbidden of ["Gateway", "Policy", "InvokeAgentRuntime"]) {
      expect(all.filter((a) => a.startsWith("bedrock-agentcore:") && a.includes(forbidden))).toEqual([]);
    }
    expect(all.some((a) => a.startsWith("s3:"))).toBe(false);
    for (const s of agent) expect(JSON.stringify(s.Resource)).not.toContain("-mcp-");
    for (const s of provisioner) expect(JSON.stringify(s.Resource)).not.toContain("-agent-");
  });
});

describe("pack permissions boundary", () => {
  const statements = resources[boundaryId]!.Properties.PolicyDocument.Statement as Statement[];

  it("allows only the listed data actions, the broker and what the runtime needs for itself", () => {
    expect(actions(bySid(statements, "PackData"))).toEqual(PACK_DATA_ACTIONS);
    expect(statements.map((s) => s.Sid).sort()).toEqual(["AssumeBroker", "Metrics", "PackData", "RuntimeLogs", "Tracing"]);
    const services = new Set(statements.flatMap(actions).map((a) => a.split(":")[0]));
    expect([...services].sort()).toEqual(["cloudwatch", "logs", "pricing", "sts", "xray"]);
    // Rule 5 (D37, D51): the only roles a pack may ever assume are the installation's two
    // brokers, which demand a SourceIdentity and name in their trust the exact pack roles of
    // their chain. No account data action is in the ceiling of a pack role.
    const broker = bySid(statements, "AssumeBroker");
    expect(actions(broker)).toEqual(["sts:AssumeRole", "sts:SetSourceIdentity", "sts:TagSession"]);
    expect(JSON.stringify(broker.Resource)).not.toContain("*");
    expect(list(broker.Resource).map((r) => JSON.stringify(r).match(/Mango-[a-z0-9]+-[A-Za-z]+/)![0])).toEqual([
      `Mango-${ns}-BillingBroker`,
      `Mango-${ns}-ReadBroker`,
    ]);
    for (const action of [...BILLING_READER_DATA_ACTIONS, ...MEMBER_READ_ONLY_DATA_ACTIONS]) {
      expect(statements.flatMap(actions)).not.toContain(action);
    }
    expect(bySid(statements, "RuntimeLogs").Resource).toBe(
      `arn:aws:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/Mango_${ns}_mcp_*`,
    );
  });

  it("lists exact actions: no wildcards", () => {
    for (const action of PACK_DATA_ACTIONS) expect(action).toMatch(/^[a-z0-9-]+:[A-Za-z0-9]+$/);
  });

  it("covers every action the packs of this repository ask for", () => {
    const packsDir = resolve(REPO_ROOT, "packs");
    const manifests = readdirSync(packsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => readFileSync(join(packsDir, d.name, "manifest.yaml"), "utf8"));
    expect(manifests.length).toBeGreaterThan(0);
    for (const manifest of manifests) {
      const iam = manifest.slice(manifest.indexOf("\niam:"), manifest.indexOf("\ntools:"));
      const asked = [...iam.matchAll(/^\s+- ([a-z0-9-]+:[A-Za-z0-9]+)\s*$/gm)].map((m) => m[1]!);
      expect(asked.length).toBeGreaterThan(0);
      // A pack over account data asks for actions of the role behind its broker instead: the
      // payer role or, in the member chain, the role of the member accounts.
      const central = /^identity_mode: central_only$/m.test(manifest);
      const member = /^identity:\n\s+chain: member$/m.test(manifest);
      expect(member && !central).toBe(false);
      const brokered = member ? MEMBER_READ_ONLY_DATA_ACTIONS : BILLING_READER_DATA_ACTIONS;
      const ceiling = central ? brokered : PACK_DATA_ACTIONS;
      for (const action of asked) expect(ceiling).toContain(action);
    }
  });
});

describe("role behind the Billing broker, in the payer account (D10, D37, TM-BL11)", () => {
  const payer = payerTemplate(cfg).toJSON().Resources as Record<string, Resource>;
  // The payer stack also holds the write role of the first write tool (D27): its policy is
  // not the reader's (see write-tools.test.ts).
  const reader = Object.values(payer)
    .filter((r) => r.Type === "AWS::IAM::Policy")
    .flatMap((r) => r.Properties.PolicyDocument.Statement as Statement[])
    .filter((s) => s.Sid !== "OwnBudgets");
  const data = reader.filter((s) => s.Sid !== "OrganizationInventoryRead");

  it("allows exactly the listed data actions, and Organizations inventory", () => {
    expect(reader.map((s) => s.Sid).sort()).toEqual([
      "BudgetsRead",
      "ComputeOptimizerInventoryRead",
      "CostExplorerRead",
      "OptimizationRead",
      "OrganizationInventoryRead",
    ]);
    expect(reader.every((s) => s.Effect === "Allow")).toBe(true);
    expect(data.flatMap(actions).sort()).toEqual([...BILLING_READER_DATA_ACTIONS].sort());
    expect(new Set(BILLING_READER_DATA_ACTIONS).size).toBe(BILLING_READER_DATA_ACTIONS.length);
  });

  it("lists exact read-only actions: no wildcard and nothing that writes or starts a job (D43)", () => {
    const services = new Set(BILLING_READER_DATA_ACTIONS.map((a) => a.split(":")[0]));
    expect([...services].sort()).toEqual([
      "autoscaling",
      "budgets",
      "ce",
      "compute-optimizer",
      "cost-optimization-hub",
      "ec2",
      "ecs",
      "lambda",
      "rds",
    ]);
    for (const action of BILLING_READER_DATA_ACTIONS) {
      // Budgets names its only read action `ViewBudget`; every other one is a Get, a List
      // or a Describe.
      expect(action).toMatch(/^[a-z0-9-]+:(Get|List|Describe)[A-Za-z0-9]+$|^budgets:ViewBudget$/);
    }
  });

  it("reads inventory of the payer account only as far as Compute Optimizer asks (TM-BL13)", () => {
    // The actions the IAM service reference lists as authorizing its Get*Recommendations
    // operations, and nothing else outside billing: no action that reads the content of data.
    const inventory = data.find((s) => s.Sid === "ComputeOptimizerInventoryRead")!;
    expect(actions(inventory)).toEqual([
      "ec2:DescribeInstances",
      "ec2:DescribeVolumes",
      "autoscaling:DescribeAutoScalingGroups",
      "lambda:ListProvisionedConcurrencyConfigs",
      "rds:DescribeDBInstances",
      "rds:DescribeDBClusters",
      "ecs:ListClusters",
      "ecs:ListServices",
    ]);
    const billing = ["budgets", "ce", "compute-optimizer", "cost-optimization-hub"];
    const outside = BILLING_READER_DATA_ACTIONS.filter((a) => !billing.includes(a.split(":")[0]!));
    expect(outside).toEqual(actions(inventory));
    // It returns the environment variables of every function of the account (TM-BL11).
    expect(BILLING_READER_DATA_ACTIONS).not.toContain("lambda:ListFunctions");
  });

  it("scopes budgets to the payer account's own budgets", () => {
    const budgets = data.find((s) => s.Sid === "BudgetsRead")!;
    expect(actions(budgets)).toEqual(["budgets:ViewBudget"]);
    expect(budgets.Resource).toBe(`arn:aws:budgets::${cfg.managementAccountId}:budget/*`);
    // The other two services define no resource types: `*` is the only resource they accept.
    for (const sid of ["CostExplorerRead", "OptimizationRead", "ComputeOptimizerInventoryRead"]) {
      expect(data.find((s) => s.Sid === sid)!.Resource).toBe("*");
    }
    expect(actions(data.find((s) => s.Sid === "OptimizationRead")!).map((a) => a.split(":")[0])).not.toContain("ce");
  });

  it("fits the provisioner's environment, where the list is the ceiling of a manifest", () => {
    // Lambda limits the whole environment to 4 KB.
    expect(JSON.stringify(BILLING_READER_DATA_ACTIONS).length).toBeLessThan(1800);
  });
});

describe("who can reach a pack runtime (TM-M14, TM-B8)", () => {
  it("only the Gateway role and the pack provisioner can invoke pack runtimes", () => {
    const invokers = Object.values(resources)
      .filter((r) => r.Type === "AWS::IAM::Policy")
      .filter((r) =>
        (r.Properties.PolicyDocument.Statement as Statement[]).some(
          (s) => actions(s).includes("bedrock-agentcore:InvokeAgentRuntime") && JSON.stringify(s.Resource).includes("_mcp_"),
        ),
      )
      .flatMap((r) => r.Properties.Roles.map((x: { Ref: string }) => x.Ref));
    expect(invokers.sort()).toEqual([roleId, gatewayRoleId].sort());
  });

  it("the Gateway role reaches only this installation's pack runtimes", () => {
    const invoke = bySid(statementsOf(gatewayRoleId), "InvokePackRuntimes");
    expect(actions(invoke)).toEqual(["bedrock-agentcore:InvokeAgentRuntime"]);
    expect(invoke.Resource).toEqual([runtimes, `${runtimes}/runtime-endpoint/*`]);
  });

  it("the interceptor gets the closed list of connector targets (TM-B9)", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: `Mango-${ns}-GatewayInterceptor`,
      // The Cost Explorer connector and the approval executor (D27): both Mango's own code.
      Environment: { Variables: { CONTEXT_TARGETS: '["finops","ops"]' } },
    });
  });
});

describe("mango-api and the pack provisioner", () => {
  it("starts the pack machine and knows its ARN", () => {
    const start = bySid(api, "StartPackProvisioner");
    expect(actions(start)).toEqual(["states:StartExecution"]);
    expect(start.Resource).toEqual({ Ref: machineId });
    const task = Object.values(template.findResources("AWS::ECS::TaskDefinition"))[0]!;
    const env = task.Properties.ContainerDefinitions[0].Environment as { Name: string; Value: unknown }[];
    expect(env.find((e) => e.Name === "PACK_PROVISIONER_STATE_MACHINE_ARN")?.Value).toEqual({ Ref: machineId });
  });

  it("is denied writing what is installed", () => {
    const deny = bySid(api, "InstalledPacksAreProvisionerOnly");
    expect(deny.Effect).toBe("Deny");
    expect(actions(deny).sort()).toEqual([
      "dynamodb:BatchWriteItem",
      "dynamodb:DeleteItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    ]);
    expect(deny.Resource).toEqual({ "Fn::GetAtt": [settingsId, "Arn"] });
    expect(deny.Condition).toEqual({ "ForAnyValue:StringLike": { "dynamodb:LeadingKeys": ["MCP_INSTALLED#*"] } });
  });

  it("the deny covers every write action it is allowed on the Settings table", () => {
    // `BatchWriteItem` is an IAM action of its own: a deny of the single-item writes alone
    // would leave the pointer writable in a batch.
    const readOnly = /:(BatchGetItem|ConditionCheckItem|Describe\w+|Get\w+|Query|Scan)$/;
    const allowed = api
      .filter((s) => s.Effect === "Allow" && JSON.stringify(s.Resource).includes(settingsId))
      .flatMap(actions)
      .filter((a) => a.startsWith("dynamodb:") && !readOnly.test(a));
    expect(allowed).toContain("dynamodb:BatchWriteItem");
    const denied = actions(bySid(api, "InstalledPacksAreProvisionerOnly"));
    expect(allowed.filter((a) => !denied.includes(a))).toEqual([]);
  });

  it("has no write access to AgentCore runtimes, targets or policies", () => {
    const all = api.flatMap(actions);
    for (const forbidden of ["AgentRuntime", "GatewayTarget", "Policy"]) {
      expect(all.filter((a) => a.includes(forbidden) && /:(Create|Update|Delete|Synchronize)/.test(a))).toEqual([]);
    }
  });
});

describe("packs bucket (D36, TM-M15)", () => {
  it("is versioned, private, TLS-only and never expires versions a runtime may run from", () => {
    const bucket = resources[bucketId]!;
    expect(bucket.Properties.VersioningConfiguration).toEqual({ Status: "Enabled" });
    expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    expect(bucket.Properties.LifecycleConfiguration).toBeUndefined();
    expect(bucket.Properties.LoggingConfiguration).toBeDefined();
    const policy = Object.values(template.findResources("AWS::S3::BucketPolicy")).find(
      (p) => p.Properties.Bucket.Ref === bucketId,
    )!;
    const deny = (policy.Properties.PolicyDocument.Statement as Statement[]).filter(
      (s) => s.Effect === "Deny" && s.Condition?.Bool?.["aws:SecureTransport"] === "false",
    );
    expect(deny).toHaveLength(1);
  });
});

describe("pack provisioner function and state machine", () => {
  const environment = resources[functionId]!.Properties.Environment.Variables as Record<string, unknown>;

  it("gets what may be installed from the template only", () => {
    expect(resources[functionId]!.Properties.Handler).toBe("mango_provisioner.packs.handler.lambda_handler");
    expect(resources[functionId]!.Properties.Role).toEqual({ "Fn::GetAtt": [roleId, "Arn"] });
    expect(environment.PACK_BOUNDARY_ARN).toEqual({ Ref: boundaryId });
    expect(JSON.parse(environment.PACK_ALLOWED_ACTIONS as string)).toEqual(PACK_DATA_ACTIONS);
    expect(environment.PACKS_BUCKET).toEqual({ Ref: bucketId });
    expect(environment.CONNECTOR_TARGETS).toBe('["finops","ops"]');
    expect(environment.GATEWAY_ID).toEqual({ "Fn::GetAtt": [gatewayId, "GatewayIdentifier"] });
    expect(environment.POLICY_ENGINE_ID).toEqual({ "Fn::GetAtt": [engineId, "PolicyEngineId"] });
  });

  it("fails closed without signed packs: empty catalog, nothing installs", () => {
    // The release key exists since U10 (packs/signing-key.pub), but without signed artifacts in
    // dist/packs there is nothing the provisioner may install.
    const keyFile = resolve(__dirname, "../../packs/signing-key.pub");
    const releaseKey = existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : "";
    expect(String(environment.PACK_SIGNING_PUBLIC_KEY).trim()).toBe(releaseKey);
    expect(environment.PACK_CATALOG).toBe("{}");
    expect(Object.keys(resources).filter((id) => id.startsWith("PackPlatformPack"))).toEqual([]);
  });

  const definition = JSON.stringify(resources[machineId]!.Properties.DefinitionString);
  const states = (() => {
    const joined = (resources[machineId]!.Properties.DefinitionString["Fn::Join"][1] as unknown[])
      .map((part) => (typeof part === "string" ? part : "ARN"))
      .join("");
    return JSON.parse(joined).States as Record<string, any>;
  })();

  it("runs the steps in order and verifies tools before anything is exposed", () => {
    const order: string[] = [];
    let name: string | undefined = "EnsureRole";
    while (name && !order.includes(name)) {
      order.push(name);
      const state: any = states[name];
      name = state.Type === "Choice" ? state.Choices[0].Next : state.Next;
    }
    const tasks = order.filter((n) => states[n].Type === "Task");
    expect(tasks).toEqual([
      "EnsureRole",
      "EnsureRuntime",
      "CheckRuntime",
      "VerifyTools",
      "PointLive",
      "CheckLive",
      "GovernLogs",
      "EnsureTarget",
      "CheckTarget",
      "EnsurePolicies",
      "CheckPolicies",
      "Finish",
    ]);
  });

  it("compensates any failed step of an installation, and never undoes a removal", () => {
    for (const [name, state] of Object.entries(states)) {
      if (state.Type !== "Task") continue;
      const catcher = state.Catch?.[0];
      expect(catcher?.ErrorEquals, name).toEqual(["States.ALL"]);
      const expected =
        name === "MarkFailed" ? "PackFailed" : name === "Compensate" || name === "Remove" ? "MarkFailed" : "Compensate";
      expect(catcher.Next, name).toBe(expected);
      expect(state.Parameters["execution.$"], name).toBe("$$.Execution.Name");
    }
    expect(states.Compensate.Next).toBe("MarkFailed");
    expect(states.MarkFailed.Next).toBe("PackFailed");
  });

  it("is bounded below the lock and keeps execution data out of its logs", () => {
    expect(definition).toContain('\\"TimeoutSeconds\\":2400');
    expect(resources[machineId]!.Properties.LoggingConfiguration.IncludeExecutionData).toBe(false);
    expect(resources[machineId]!.Properties.TracingConfiguration).toEqual({ Enabled: true });
  });
});

// --- A release that ships a signed pack -------------------------------------------------------

interface PackSpec {
  id?: string;
  identityMode?: string;
  /** `identity` of the manifest (the broker chain); absent in the payer chain. */
  identity?: unknown;
  /** `null`: a statement signed before the field existed. */
  egress?: { aws: string[]; hosts?: string[] } | null;
}

function signedRelease(options: PackSpec & { tamper?: "zip" | "name"; also?: PackSpec[] } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const dir = mkdtempSync(join(tmpdir(), "mango-packs-"));
  const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
  const write = (spec: PackSpec, tamper?: "zip" | "name"): string => {
    const id = spec.id ?? "aws-pricing";
    const identityMode = spec.identityMode ?? "service";
    const egress =
      spec.egress === undefined
        ? { aws: identityMode === "service" ? ["pricing"] : ["sts", "ce"], hosts: [] }
        : spec.egress;
    const zip = Buffer.from("zip bytes of the pack");
    const sbom = Buffer.from('{"bomFormat":"CycloneDX"}');
    const statement = {
      schema_version: 1,
      manifest: {
        id,
        version: "1.1.1-1",
        name: "A pack",
        identity_mode: identityMode,
        ...(spec.identity !== undefined && { identity: spec.identity }),
        ...(egress === null ? {} : { egress }),
      },
      artifact: { file: `${id}-1.1.1-1.zip`, sha256: digest(zip), size: zip.length },
      sbom: { file: `${id}-1.1.1-1.sbom.cdx.json`, sha256: digest(sbom), size: sbom.length },
      lock_sha256: "e".repeat(64),
      source_revision: "f".repeat(40),
    };
    const payload = Buffer.from(JSON.stringify(statement));
    const kind = Buffer.from(PAYLOAD_TYPE);
    const message = Buffer.concat([
      Buffer.from(`DSSEv1 ${kind.length} `),
      kind,
      Buffer.from(` ${payload.length} `),
      payload,
    ]);
    const envelope = {
      payload_type: PAYLOAD_TYPE,
      payload: payload.toString("base64"),
      signature: {
        algorithm: "ECDSA_SHA_256",
        key_id: "arn:aws:kms:us-east-1:111122223333:key/test",
        value: sign("sha256", message, { key: privateKey, dsaEncoding: "der" }).toString("base64"),
      },
    };
    const name = tamper === "name" ? "other-1.1.1-1.pack.json" : `${id}-1.1.1-1.pack.json`;
    writeFileSync(join(dir, name), JSON.stringify(envelope));
    writeFileSync(join(dir, statement.artifact.file), tamper === "zip" ? Buffer.from("another zip, same size") : zip);
    writeFileSync(join(dir, statement.sbom.file), sbom);
    writeFileSync(join(dir, `${id}-1.1.1-1.statement.json`), payload);
    return digest(payload);
  };
  const statementSha256 = write(options, options.tamper);
  for (const spec of options.also ?? []) write(spec);
  return {
    dir,
    pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    statementSha256,
  };
}

describe("release packs (D36): only what the release key signed", () => {
  it("pins the signed statement of each pack by digest", () => {
    const release = signedRelease();
    const packs = loadReleasePacks(release.dir, release.pem);
    expect(packCatalog(packs)).toEqual({
      "aws-pricing": { version: "1.1.1-1", statement_sha256: release.statementSha256 },
    });
    expect(packs[0]!.files).toEqual([
      "aws-pricing-1.1.1-1.pack.json",
      "aws-pricing-1.1.1-1.zip",
      "aws-pricing-1.1.1-1.sbom.cdx.json",
    ]);
  });

  it("refuses a pack signed with another key, a replaced zip or a renamed envelope", () => {
    const release = signedRelease();
    expect(() => loadReleasePacks(release.dir, signedRelease().pem)).toThrow(/not signed by the release/);
    const replaced = signedRelease({ tamper: "zip" });
    expect(() => loadReleasePacks(replaced.dir, replaced.pem)).toThrow(/not the signed file/);
    const renamed = signedRelease({ tamper: "name" });
    expect(() => loadReleasePacks(renamed.dir, renamed.pem)).toThrow(/the signed manifest is aws-pricing/);
  });

  it("only accepts an ECC P-256 signing key", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" });
    expect(() => packSigningKey(rsa.toString())).toThrow(/P-256/);
    const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" }).publicKey.export({ type: "spki", format: "pem" });
    expect(() => packSigningKey(p384.toString())).toThrow(/P-256/);
    expect(loadReleasePacks(join(tmpdir(), "mango-no-such-dir"), signedRelease().pem)).toEqual([]);
  });

  const raw = JSON.parse(readFileSync(examplePath, "utf8")) as Record<string, unknown>;

  it("ships the pack to the bucket and the catalog to the provisioner", () => {
    const release = signedRelease();
    const lab = installationSchema.parse({
      ...raw,
      installationType: "lab",
      packs: { signingPublicKey: release.pem },
    });
    const shipped = synth(lab, { packsDir: release.dir });
    const fn = Object.values(shipped.resources).find(
      (r) => r.Type === "AWS::Lambda::Function" && r.Properties.FunctionName === `Mango-${ns}-PackProvisioner`,
    )!;
    const environment = fn.Properties.Environment.Variables;
    expect(JSON.parse(environment.PACK_CATALOG)).toEqual({
      "aws-pricing": { version: "1.1.1-1", statement_sha256: release.statementSha256 },
    });
    expect(environment.PACK_SIGNING_PUBLIC_KEY).toBe(release.pem);
    const deployments = Object.values(shipped.resources).filter((r) => r.Type === "Custom::CDKBucketDeployment");
    expect(deployments).toHaveLength(1);
    expect(deployments[0]!.Properties.DestinationBucketKeyPrefix).toBe("packs/aws-pricing/1.1.1-1/");
    expect(deployments[0]!.Properties.Prune).toBe(false);
    // The copy is the only writer of the bucket: no other role of the stack can put objects.
    const writers = Object.values(shipped.resources)
      .filter((r) => r.Type === "AWS::IAM::Policy")
      .filter((r) =>
        (r.Properties.PolicyDocument.Statement as Statement[]).some(
          (s) =>
            actions(s).some((a) => /^s3:(Put|Delete|Abort)/.test(a)) &&
            JSON.stringify(s.Resource).includes("PackPlatformBucket"),
        ),
      )
      .flatMap((r) => r.Properties.Roles.map((x: { Ref: string }) => x.Ref));
    expect(writers.every((id: string) => id.startsWith("CustomCDKBucketDeployment") || id.startsWith("CustomS3AutoDeleteObjects"))).toBe(true);
  });

  it("lets mango-api read the signed statements of the release's packs and nothing else of the bucket", () => {
    const release = signedRelease();
    const lab = installationSchema.parse({ ...raw, installationType: "lab", packs: { signingPublicKey: release.pem } });
    const shipped = synth(lab, { packsDir: release.dir });
    const onBucket = statementsOf(apiRoleId, shipped.resources).filter((s) =>
      JSON.stringify(s.Resource).includes("PackPlatformBucket"),
    );
    expect(onBucket).toHaveLength(1);
    const read = onBucket[0]!;
    expect(read.Sid).toBe("ReadReleasePackStatements");
    expect(read.Effect).toBe("Allow");
    // One exact object per pack of the release: no zip, no listing, no wildcard.
    expect(actions(read)).toEqual(["s3:GetObject"]);
    expect(list(read.Resource)).toHaveLength(1);
    const arn = JSON.stringify(read.Resource);
    expect(arn).toContain("/packs/aws-pricing/1.1.1-1/aws-pricing-1.1.1-1.pack.json");
    expect(arn).not.toContain("*");

    // mango-api lists what the provisioner would install: same key and same catalog.
    const environment = containerEnvironment(shipped.resources);
    const fn = Object.values(shipped.resources).find(
      (r) => r.Type === "AWS::Lambda::Function" && r.Properties.FunctionName === `Mango-${ns}-PackProvisioner`,
    )!.Properties.Environment.Variables;
    expect(environment.PACK_CATALOG).toBe(fn.PACK_CATALOG);
    expect(environment.PACK_SIGNING_PUBLIC_KEY).toBe(fn.PACK_SIGNING_PUBLIC_KEY);
    expect(environment.PACKS_BUCKET).toEqual(fn.PACKS_BUCKET);
    expect(environment.PACKS_BUCKET_OWNER).toBe(account);
  });

  it("gives mango-api no access to the packs bucket while the release ships no pack", () => {
    expect(api.filter((s) => JSON.stringify(s.Resource).includes("PackPlatformBucket"))).toEqual([]);
    const environment = containerEnvironment(resources);
    expect(environment.PACK_CATALOG).toBe("{}");
    expect(environment.PACKS_BUCKET).toEqual({ Ref: bucketId });
  });

  it("lets the agent provisioner read which tools an installed pack serves, and nothing more of Settings", () => {
    const onSettings = statementsOf(agentProvisionerRoleId).filter((s) =>
      JSON.stringify(s.Resource).includes(settingsId),
    );
    expect(onSettings.map((s) => s.Sid).sort()).toEqual(["ReadInstalledPacks", "ReadModelCatalog"]);
    const read = bySid(onSettings, "ReadInstalledPacks");
    expect(actions(read)).toEqual(["dynamodb:GetItem"]);
    expect(read.Condition).toEqual({ "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["MCP_INSTALLED#*"] } });
    // Read only: enablements and what is installed are never written by this role.
    expect(onSettings.every((s) => actions(s).every((a) => a === "dynamodb:GetItem"))).toBe(true);
  });

  it("customer installations only trust the key of the release", () => {
    const result = installationSchema.safeParse({ ...raw, packs: { signingPublicKey: signedRelease().pem } });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("only trust the pack signing key of the release");
    expect(installationSchema.safeParse({ ...raw, packs: { signingPublicKey: "not a key" }, installationType: "lab" }).success).toBe(false);
  });
});


// --- Packs over account data: identity of the caller (D37, TM-M3, TM-M14) ----------------------

describe("packs over account data act as the calling user (D37)", () => {
  const raw = JSON.parse(readFileSync(examplePath, "utf8")) as Record<string, unknown>;
  const brokerArn = `arn:aws:iam::${account}:role/Mango-${ns}-BillingBroker`;
  const keyId = Object.keys(template.findResources("AWS::KMS::Key", { Properties: { KeySpec: "ECC_NIST_P256" } }))[0]!;
  const environmentOf = (all: Record<string, Resource>, name: string): Record<string, any> =>
    Object.values(all).find((r) => r.Type === "AWS::Lambda::Function" && r.Properties.FunctionName === name)!.Properties
      .Environment.Variables;
  const trustOf = (all: Record<string, Resource>): Statement[] =>
    Object.values(all).find((r) => r.Type === "AWS::IAM::Role" && r.Properties.RoleName === `Mango-${ns}-BillingBroker`)!
      .Properties.AssumeRolePolicyDocument.Statement;
  const callersOf = (all: Record<string, Resource>): string[][] =>
    trustOf(all).map((s) => JSON.stringify(s.Condition!.ArnEquals!["aws:PrincipalArn"]).match(/Mango-[a-z0-9]+-mcp-[a-z0-9-]+/g) ?? []);

  // Two lab releases, synthesized once for the tests below: a stack synthesis takes seconds
  // (longer on a CI runner), so it does not run inside a test's own timeout.
  let withBilling: Record<string, Resource>;
  let withPricing: Record<string, Resource>;
  beforeAll(() => {
    const labWith = (release: ReturnType<typeof signedRelease>) =>
      synth(
        installationSchema.parse({ ...raw, installationType: "lab", packs: { signingPublicKey: release.pem } }),
        { packsDir: release.dir },
      ).resources;
    withBilling = labWith(signedRelease({ id: "aws-billing", identityMode: "central_only" }));
    withPricing = labWith(signedRelease());
  }, 180_000);

  it("signs callers with an asymmetric key only the interceptor can use", () => {
    expect(resources[keyId]!.Properties).toMatchObject({ KeySpec: "ECC_NIST_P256", KeyUsage: "SIGN_VERIFY" });
    const signers = Object.entries(resources)
      .filter(([, r]) => r.Type === "AWS::IAM::Policy")
      .filter(([, r]) =>
        (r.Properties.PolicyDocument.Statement as Statement[]).some(
          (s) => actions(s).includes("kms:Sign") && JSON.stringify(s.Resource).includes(keyId),
        ),
      )
      .flatMap(([, r]) => r.Properties.Roles.map((x: { Ref: string }) => x.Ref));
    expect(signers).toHaveLength(1);
    expect(signers[0]).toMatch(/^ToolsInterceptor/);
    // The key policy denies signing to every other principal of the account, whatever its
    // identity policy says (TM-I3).
    const keyPolicy = resources[keyId]!.Properties.KeyPolicy.Statement as (Statement & { Principal: unknown })[];
    const deny = bySid(keyPolicy, "OnlyTheInterceptorSigns");
    expect(deny).toMatchObject({ Effect: "Deny", Action: "kms:Sign", Principal: { AWS: "*" } });
    expect(deny.Condition).toEqual({
      ArnNotEquals: { "aws:PrincipalArn": { "Fn::GetAtt": [signers[0]!, "Arn"] } },
    });
    expect(keyPolicy.filter((s) => s.Effect === "Allow" && actions(s).includes("kms:Sign"))).toEqual([]);
  });

  it("gives the pack provisioner the public key only", () => {
    const statement = bySid(provisioner, "ReadPackIdentityPublicKey");
    expect(actions(statement)).toEqual(["kms:GetPublicKey"]);
    expect(statement.Resource).toEqual({ "Fn::GetAtt": [keyId, "Arn"] });
    expect(provisioner.flatMap(actions)).not.toContain("kms:Sign");
    const environment = environmentOf(resources, `Mango-${ns}-PackProvisioner`);
    expect(environment.PACK_IDENTITY_KEY_ARN).toEqual({ "Fn::GetAtt": [keyId, "Arn"] });
    expect(JSON.stringify(environment.PACK_BROKER_ROLE_ARN)).toContain(`role/Mango-${ns}-BillingBroker`);
    expect(environment.PACK_TARGET_ROLE_ARN).toBe(
      `arn:aws:iam::${cfg.managementAccountId}:role/Mango-${ns}-BillingReader`,
    );
    // The ceiling of a manifest is what the payer role allows: the same list, one source.
    expect(JSON.parse(environment.PACK_BROKERED_ACTIONS)).toEqual(BILLING_READER_DATA_ACTIONS);
    // The provisioner itself can never assume the broker or the payer role.
    expect(provisioner.flatMap(actions).filter((a) => a.startsWith("sts:"))).toEqual([]);
  });

  it("without such packs, no pack role may use the broker and the interceptor signs for none", () => {
    expect(JSON.parse(environmentOf(resources, `Mango-${ns}-GatewayInterceptor`).IDENTITY_TARGETS)).toEqual([]);
    expect(callersOf(resources).flat()).toEqual([]);
    expect(brokerArn).toContain("BillingBroker");
  });

  it("names the exact role of each account-data pack in the broker trust, and never a public pack's", () => {
    const shipped = withBilling;
    expect(JSON.parse(environmentOf(shipped, `Mango-${ns}-GatewayInterceptor`).IDENTITY_TARGETS)).toEqual(["aws-billing"]);
    const trust = trustOf(shipped);
    // AssumeRole, SetSourceIdentity and TagSession: the same closed list of callers, no wildcard.
    expect(callersOf(shipped)).toEqual(trust.map(() => [`Mango-${ns}-mcp-aws-billing`]));
    expect(JSON.stringify(trust)).not.toContain("mcp-*");
    for (const statement of trust) expect(statement.Condition!.ArnEquals).toBeDefined();
    // SourceIdentity stays mandatory for every caller.
    expect(trust[0]!.Condition!.Null).toEqual({ "sts:SourceIdentity": "false" });

    const publicOnly = withPricing;
    expect(JSON.parse(environmentOf(publicOnly, `Mango-${ns}-GatewayInterceptor`).IDENTITY_TARGETS)).toEqual([]);
    expect(callersOf(publicOnly).flat()).toEqual([]);
  });

  it("refuses a release whose pack names an identity mode the stack does not know", () => {
    const odd = signedRelease({ identityMode: "per_user" });
    expect(() => loadReleasePacks(odd.dir, odd.pem)).toThrow();
  });
});

describe("packs over member accounts use the Read broker (D51, identity.chain: member)", () => {
  const raw = JSON.parse(readFileSync(examplePath, "utf8")) as Record<string, unknown>;
  const environmentOf = (all: Record<string, Resource>, name: string): Record<string, any> =>
    Object.values(all).find((r) => r.Type === "AWS::Lambda::Function" && r.Properties.FunctionName === name)!.Properties
      .Environment.Variables;
  const trustOf = (all: Record<string, Resource>, broker: string): Statement[] =>
    Object.values(all).find((r) => r.Type === "AWS::IAM::Role" && r.Properties.RoleName === `Mango-${ns}-${broker}`)!
      .Properties.AssumeRolePolicyDocument.Statement;
  const packCallers = (trust: Statement[]): string[][] =>
    trust.map((s) => JSON.stringify(s.Condition!.ArnEquals!["aws:PrincipalArn"]).match(/Mango-[a-z0-9]+-mcp-[a-z0-9-]+/g) ?? []);

  let withBoth: Record<string, Resource>;
  beforeAll(() => {
    // One release with a pack of each chain.
    const member = signedRelease({ id: "aws-cloudwatch", identityMode: "central_only", identity: { chain: "member" } });
    const payer = signedRelease({ id: "aws-billing", identityMode: "central_only" });
    const dir = mkdtempSync(join(tmpdir(), "mango-two-chains-"));
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    for (const release of [member, payer]) {
      for (const file of readdirSync(release.dir)) {
        if (!file.endsWith(".pack.json")) {
          writeFileSync(join(dir, file), readFileSync(join(release.dir, file)));
          continue;
        }
        // Sign both statements with one key: a release has one signing key.
        const envelope = JSON.parse(readFileSync(join(release.dir, file), "utf8"));
        const payload = Buffer.from(envelope.payload, "base64");
        const kind = Buffer.from(PAYLOAD_TYPE);
        const message = Buffer.concat([Buffer.from(`DSSEv1 ${kind.length} `), kind, Buffer.from(` ${payload.length} `), payload]);
        envelope.signature.value = sign("sha256", message, { key: privateKey, dsaEncoding: "der" }).toString("base64");
        writeFileSync(join(dir, file), JSON.stringify(envelope));
      }
    }
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    withBoth = synth(
      installationSchema.parse({ ...raw, installationType: "lab", packs: { signingPublicKey: pem } }),
      { packsDir: dir },
    ).resources;
  }, 180_000);

  it("reads the chain from the signed statement, payer when it says nothing", () => {
    const member = signedRelease({ id: "aws-cloudwatch", identityMode: "central_only", identity: { chain: "member" } });
    expect(loadReleasePacks(member.dir, member.pem)[0]).toMatchObject({ identityMode: "central_only", identityChain: "member" });
    const payer = signedRelease({ id: "aws-billing", identityMode: "central_only" });
    expect(loadReleasePacks(payer.dir, payer.pem)[0]!.identityChain).toBe("payer");
    const service = signedRelease();
    expect(loadReleasePacks(service.dir, service.pem)[0]!.identityChain).toBe("payer");
  });

  it("refuses a chain the stack does not know, extra identity fields and a member chain outside central_only", () => {
    for (const options of [
      { identityMode: "central_only", identity: { chain: "operator" } },
      { identityMode: "central_only", identity: { chain: "member", role: "Admin" } },
      { identityMode: "service", identity: { chain: "member" } },
    ]) {
      const odd = signedRelease(options);
      expect(() => loadReleasePacks(odd.dir, odd.pem)).toThrow();
    }
  });

  it("names each pack role in the trust of the broker of its chain, and only there", () => {
    const read = trustOf(withBoth, "ReadBroker");
    const billing = trustOf(withBoth, "BillingBroker");
    expect(packCallers(read)).toEqual(read.map(() => [`Mango-${ns}-mcp-aws-cloudwatch`]));
    expect(packCallers(billing)).toEqual(billing.map(() => [`Mango-${ns}-mcp-aws-billing`]));
    for (const trust of [read, billing]) {
      expect(JSON.stringify(trust)).not.toContain("mcp-*");
      for (const statement of trust) expect(statement.Condition!.ArnEquals).toBeDefined();
    }
    // SourceIdentity and the organization stay mandatory for the pack, as for the probe.
    expect(read[0]!.Condition!.Null).toEqual({ "sts:SourceIdentity": "false" });
    for (const statement of read) {
      expect(statement.Condition!.StringEquals).toEqual({ "aws:PrincipalOrgID": cfg.organizationId });
    }
  });

  it("the interceptor signs the callers of both, and without member packs the Read broker trusts no pack", () => {
    expect(JSON.parse(environmentOf(withBoth, `Mango-${ns}-GatewayInterceptor`).IDENTITY_TARGETS).sort()).toEqual([
      "aws-billing",
      "aws-cloudwatch",
    ]);
    expect(packCallers(trustOf(resources, "ReadBroker")).flat()).toEqual([]);
  });

  it("gives the pack provisioner the Read broker, the name of the member role and its actions", () => {
    const environment = environmentOf(resources, `Mango-${ns}-PackProvisioner`);
    expect(environment.PACK_MEMBER_BROKER_ROLE_ARN).toBe(`arn:aws:iam::${account}:role/Mango-${ns}-ReadBroker`);
    // A name, never an ARN: the account is the one each call asks for.
    expect(environment.PACK_MEMBER_ROLE_NAME).toBe(`Mango-${ns}-ReadOnly`);
    expect(JSON.parse(environment.PACK_MEMBER_ACTIONS)).toEqual(MEMBER_READ_ONLY_DATA_ACTIONS);
    // The provisioner itself can never assume a broker or a member role.
    expect(provisioner.flatMap(actions).filter((a) => a.startsWith("sts:"))).toEqual([]);
  });
});

// --- Restricted egress of pack runtimes (R6, TM-E1 to TM-E9) ----------------------------------

describe("pack runtimes only reach the VPC endpoints their signed manifest declares (R6)", () => {
  const raw = JSON.parse(readFileSync(examplePath, "utf8")) as Record<string, unknown>;
  const ofType = (all: Record<string, Resource>, type: string) =>
    Object.entries(all).filter(([, r]) => r.Type === type);
  const provisionerEnvironment = (all: Record<string, Resource>): Record<string, any> =>
    Object.values(all).find(
      (r) => r.Type === "AWS::Lambda::Function" && r.Properties.FunctionName === `Mango-${ns}-PackProvisioner`,
    )!.Properties.Environment.Variables;

  // Pricing (public data), Billing (payer chain) and CloudWatch (member chain) in one release,
  // as the lab ships them.
  let shipped: Record<string, Resource>;
  let outputs: Record<string, { Value: unknown }>;
  let vpcId: string;
  let subnetIds: string[];
  const endpointOf = (service: string) =>
    ofType(shipped, "AWS::EC2::VPCEndpoint").find(
      ([, r]) => r.Properties.ServiceName === `com.amazonaws.${region}.${service}`,
    );
  const groupOf = (prefix: string): string => {
    const ids = Object.keys(shipped).filter(
      (id) => id.startsWith(prefix) && shipped[id]!.Type === "AWS::EC2::SecurityGroup",
    );
    expect(ids, prefix).toHaveLength(1);
    return ids[0]!;
  };
  /** Security group of the endpoint of one egress service (its construct id is the service). */
  const endpointGroup = (service: string): string => {
    const ids = Object.keys(shipped).filter(
      (id) =>
        new RegExp(`^PackNetworkEndpointSg${service.replace(/-/g, "")}[0-9A-F]{8}$`).test(id) &&
        shipped[id]!.Type === "AWS::EC2::SecurityGroup",
    );
    expect(ids, service).toHaveLength(1);
    return ids[0]!;
  };
  /** Destinations a security group may open a connection to (inline and standalone rules). */
  const egressOf = (groupId: string): Record<string, unknown>[] => [
    ...((shipped[groupId]!.Properties.SecurityGroupEgress as Record<string, unknown>[] | undefined) ?? []),
    ...ofType(shipped, "AWS::EC2::SecurityGroupEgress")
      .filter(([, r]) => JSON.stringify(r.Properties.GroupId).includes(groupId))
      .map(([, r]) => r.Properties as Record<string, unknown>),
  ];
  const ingressOf = (groupId: string): Record<string, unknown>[] => [
    ...((shipped[groupId]!.Properties.SecurityGroupIngress as Record<string, unknown>[] | undefined) ?? []),
    ...ofType(shipped, "AWS::EC2::SecurityGroupIngress")
      .filter(([, r]) => JSON.stringify(r.Properties.GroupId).includes(groupId))
      .map(([, r]) => r.Properties as Record<string, unknown>),
  ];

  beforeAll(() => {
    const release = signedRelease({
      also: [
        { id: "aws-billing", identityMode: "central_only" },
        {
          id: "aws-cloudwatch",
          identityMode: "central_only",
          identity: { chain: "member" },
          egress: { aws: ["sts", "cloudwatch", "logs"] },
        },
      ],
    });
    const stack = synth(
      installationSchema.parse({ ...raw, installationType: "lab", packs: { signingPublicKey: release.pem } }),
      { packsDir: release.dir },
    );
    shipped = stack.resources;
    outputs = stack.template.toJSON().Outputs as Record<string, { Value: unknown }>;
    const vpcs = ofType(shipped, "AWS::EC2::VPC").filter(([, r]) =>
      (r.Properties.Tags as { Key: string; Value: string }[]).some((t) => t.Value === `Mango-${ns}-PackVpc`),
    );
    expect(vpcs).toHaveLength(1);
    vpcId = vpcs[0]![0];
    subnetIds = ofType(shipped, "AWS::EC2::Subnet")
      .filter(([, r]) => r.Properties.VpcId.Ref === vpcId)
      .map(([id]) => id);
  }, 180_000);

  it("a release without packs has no pack network and nowhere to install one", () => {
    expect(Object.keys(resources).filter((id) => id.startsWith("PackNetwork"))).toEqual([]);
    expect(provisionerEnvironment(resources).PACK_NETWORK).toBe('{"subnets":[],"security_groups":{}}');
    expect(template.toJSON().Outputs.PackNetwork).toBeUndefined();
  });

  it("runs packs in a VPC of their own with no internet gateway, no NAT and no default route", () => {
    expect(shipped[vpcId]!.Properties.CidrBlock).toBe("10.210.0.0/22");
    const attachedTo = (type: string) =>
      ofType(shipped, type).filter(([, r]) => JSON.stringify(r.Properties).includes(vpcId));
    expect(attachedTo("AWS::EC2::VPCGatewayAttachment")).toEqual([]);
    expect(ofType(shipped, "AWS::EC2::NatGateway")).toEqual([]);
    expect(ofType(shipped, "AWS::EC2::VPCPeeringConnection")).toEqual([]);
    // No route at all is declared for the pack subnets: only the local route and, through
    // the gateway endpoint, the S3 prefix list.
    const tables = ofType(shipped, "AWS::EC2::RouteTable")
      .filter(([, r]) => r.Properties.VpcId.Ref === vpcId)
      .map(([id]) => id);
    expect(tables).toHaveLength(2);
    const routes = ofType(shipped, "AWS::EC2::Route").filter(([, r]) => tables.includes(r.Properties.RouteTableId.Ref));
    expect(routes).toEqual([]);
    // Rejected traffic is logged: what a pack tried to reach and could not.
    const flowLogs = ofType(shipped, "AWS::EC2::FlowLog").filter(([, r]) => r.Properties.ResourceId.Ref === vpcId);
    expect(flowLogs.map(([, r]) => r.Properties.TrafficType)).toEqual(["REJECT"]);
  });

  it("pins the subnets to Availability Zone ids AgentCore supports, without public addresses", () => {
    expect(subnetIds).toHaveLength(2);
    const subnets = subnetIds.map((id) => shipped[id]!.Properties);
    expect(subnets.map((p) => p.AvailabilityZoneId).sort()).toEqual(["use1-az1", "use1-az2"]);
    expect(subnets.map((p) => p.CidrBlock).sort()).toEqual(["10.210.0.0/24", "10.210.1.0/24"]);
    for (const subnet of subnets) {
      expect(subnet.AvailabilityZone).toBeUndefined();
      expect(subnet.MapPublicIpOnLaunch).toBe(false);
    }
    expect(packSubnetCidrs("172.20.8.0/22", 3)).toEqual(["172.20.8.0/24", "172.20.9.0/24", "172.20.10.0/24"]);
  });

  it("only has endpoints for the AWS APIs the release's packs declare, plus logs and S3", () => {
    const services = ofType(shipped, "AWS::EC2::VPCEndpoint")
      .filter(([, r]) => r.Properties.VpcId.Ref === vpcId)
      // The gateway endpoint's name is built from the region token: an object, not a string.
      .map(([, r]) => r.Properties.ServiceName as unknown)
      .map((name) => (typeof name === "string" ? name.replace(`com.amazonaws.${region}.`, "") : "s3"))
      .sort();
    // Billing declares sts and ce, Pricing declares pricing, CloudWatch declares sts, cloudwatch
    // and logs; nobody declared budgets. One endpoint per service, however many packs use it.
    expect(services.filter((service) => service !== "s3")).toEqual(["ce", "logs", "monitoring", "pricing.api", "sts"]);
    for (const service of ["ce", "logs", "monitoring", "pricing.api", "sts"]) {
      const properties = endpointOf(service)![1].Properties;
      expect(properties.VpcEndpointType).toBe("Interface");
      expect(properties.PrivateDnsEnabled).toBe(true);
      expect(properties.SubnetIds.map((x: { Ref: string }) => x.Ref).sort()).toEqual([...subnetIds].sort());
    }
  });

  it("refuses at the endpoint any principal outside the organization (TM-E3)", () => {
    for (const service of ["ce", "logs", "monitoring", "pricing.api", "sts"]) {
      const statements = endpointOf(service)![1].Properties.PolicyDocument.Statement as Statement[];
      expect(statements).toHaveLength(1);
      expect(statements[0]).toMatchObject({
        Effect: "Allow",
        Principal: "*",
        Condition: { StringEquals: { "aws:PrincipalOrgID": cfg.organizationId } },
      });
    }
    // S3: only AgentCore reading its code buckets. A pack cannot use S3 with any credentials.
    const s3 = ofType(shipped, "AWS::EC2::VPCEndpoint").find(
      ([, r]) => r.Properties.VpcId.Ref === vpcId && JSON.stringify(r.Properties.ServiceName).includes(".s3"),
    )![1].Properties;
    expect(s3.VpcEndpointType ?? "Gateway").toBe("Gateway");
    expect(s3.RouteTableIds).toHaveLength(2);
    const statements = s3.PolicyDocument.Statement as Statement[];
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({
      Effect: "Allow",
      // The service itself reads the code: `{"AWS": "*"}` would only match IAM principals.
      Principal: "*",
      Action: "s3:GetObject",
      Resource: [`arn:aws:s3:::acr-code-*-${region}-an`, `arn:aws:s3:::acr-code-*-${region}-an/*`],
      Condition: { StringEquals: { "aws:PrincipalServiceName": "bedrock-agentcore.amazonaws.com" } },
    });
  });

  it("gives each pack a security group that only reaches its own endpoints (TM-E1, TM-E4, TM-E5)", () => {
    const expected: Record<string, string[]> = {
      "aws-pricing": ["logs", "pricing"],
      "aws-billing": ["ce", "logs", "sts"],
      // `logs` declared as data is the same endpoint every pack has for its own log groups.
      "aws-cloudwatch": ["cloudwatch", "logs", "sts"],
    };
    for (const [pack, services] of Object.entries(expected)) {
      const group = groupOf(`PackNetworkPackSg${pack.replace(/-/g, "")}`);
      const rules = egressOf(group);
      // HTTPS only, and never to an address range: other security groups or the S3 prefix list.
      for (const rule of rules) {
        expect(rule).toMatchObject({ IpProtocol: "tcp", FromPort: 443, ToPort: 443 });
        expect(rule.CidrIp).toBeUndefined();
        expect(rule.CidrIpv6).toBeUndefined();
      }
      const toGroups = rules
        .filter((rule) => rule.DestinationSecurityGroupId !== undefined)
        .map((rule) => JSON.stringify(rule.DestinationSecurityGroupId));
      // Exact ids: `EndpointSgce…` and `EndpointSgcloudwatch…` share a prefix otherwise.
      const endpointGroups = services.map((service) => endpointGroup(service));
      expect(toGroups).toHaveLength(endpointGroups.length);
      for (const id of endpointGroups) expect(toGroups.join()).toContain(`"${id}"`);
      expect(rules.filter((rule) => rule.DestinationPrefixListId !== undefined).map((r) => r.DestinationPrefixListId)).toEqual([
        "pl-63a5400a",
      ]);
      expect(rules).toHaveLength(endpointGroups.length + 1);
      // Nothing connects to a pack runtime through the VPC: AgentCore invokes it by its API.
      expect(ingressOf(group)).toEqual([]);
    }
  });

  it("lets into each endpoint only the packs that declare it", () => {
    const admitted = (service: string): string[] =>
      ingressOf(endpointGroup(service)).map((rule) => {
        expect(rule).toMatchObject({ IpProtocol: "tcp", FromPort: 443, ToPort: 443 });
        expect(rule.CidrIp).toBeUndefined();
        return JSON.stringify(rule.SourceSecurityGroupId);
      });
    const pricing = groupOf("PackNetworkPackSgawspricing");
    const billing = groupOf("PackNetworkPackSgawsbilling");
    const cloudwatch = groupOf("PackNetworkPackSgawscloudwatch");
    const only = (service: string, ...groups: string[]) => {
      const sources = admitted(service).sort();
      expect(sources, service).toHaveLength(groups.length);
      for (const group of groups) expect(sources.join(), service).toContain(group);
    };
    only("sts", billing, cloudwatch);
    only("ce", billing);
    only("pricing", pricing);
    only("cloudwatch", cloudwatch);
    only("logs", pricing, billing, cloudwatch);
    // Endpoints start no connection.
    for (const service of ["sts", "ce", "pricing", "cloudwatch", "logs"]) {
      const out = egressOf(endpointGroup(service));
      expect(out.map((rule) => rule.CidrIp)).toEqual(["255.255.255.255/32"]);
    }
  });

  it("resolves the names of those endpoints and nothing else (TM-E2)", () => {
    const lists = ofType(shipped, "AWS::Route53Resolver::FirewallDomainList");
    const allowed = lists.find(([, r]) => r.Properties.Name === `Mango-${ns}-PackDnsAllowed`)!;
    const everything = lists.find(([, r]) => r.Properties.Name === `Mango-${ns}-PackDnsEverything`)!;
    expect(allowed[1].Properties.Domains).toEqual(
      [
        "*.s3.amazonaws.com.",
        `*.s3.${region}.amazonaws.com.`,
        `api.pricing.${region}.amazonaws.com.`,
        `ce.${region}.amazonaws.com.`,
        `logs.${region}.amazonaws.com.`,
        `monitoring.${region}.amazonaws.com.`,
        `s3.${region}.amazonaws.com.`,
        `sts.${region}.amazonaws.com.`,
      ].sort(),
    );
    expect(everything[1].Properties.Domains).toEqual(["*."]);
    const groups = ofType(shipped, "AWS::Route53Resolver::FirewallRuleGroup");
    expect(groups).toHaveLength(1);
    expect(groups[0]![1].Properties.FirewallRules).toEqual([
      {
        Priority: 100,
        Action: "ALLOW",
        FirewallDomainListId: { "Fn::GetAtt": [allowed[0], "Id"] },
        FirewallDomainRedirectionAction: "TRUST_REDIRECTION_DOMAIN",
      },
      {
        Priority: 200,
        Action: "BLOCK",
        BlockResponse: "NXDOMAIN",
        FirewallDomainListId: { "Fn::GetAtt": [everything[0], "Id"] },
      },
    ]);
    const associations = ofType(shipped, "AWS::Route53Resolver::FirewallRuleGroupAssociation");
    expect(associations).toHaveLength(1);
    expect(associations[0]![1].Properties).toMatchObject({
      VpcId: { Ref: vpcId },
      FirewallRuleGroupId: { "Fn::GetAtt": [groups[0]![0], "Id"] },
    });
  });

  it("tells the provisioner where each pack runs, from the stack and nowhere else", () => {
    const setting = provisionerEnvironment(shipped).PACK_NETWORK;
    const text = JSON.stringify(setting);
    for (const subnet of subnetIds) expect(text).toContain(subnet);
    expect(text).toContain(groupOf("PackNetworkPackSgawspricing"));
    expect(text).toContain(groupOf("PackNetworkPackSgawsbilling"));
    expect(text).toContain(groupOf("PackNetworkPackSgawscloudwatch"));
    for (const pack of ["aws-pricing", "aws-billing", "aws-cloudwatch"]) expect(text).toContain(pack);
    // Only pack groups: an endpoint's group would let a runtime reach every pack's endpoint.
    expect(text).not.toContain("EndpointSg");
    expect(outputs.PackNetwork!.Value).toEqual(setting);
    // The lab-only switch of D49 (7) is gone: no installation runs a pack on the PUBLIC network.
    expect(provisionerEnvironment(shipped).PACK_ACCOUNT_DATA_PUBLIC_NETWORK).toBeUndefined();
    expect(provisionerEnvironment(resources).PACK_ACCOUNT_DATA_PUBLIC_NETWORK).toBeUndefined();
  });

  it("IAM itself keeps runtimes on the pack network: never PUBLIC, never another subnet or group (TM-E9)", () => {
    const roleLogicalId = Object.keys(shipped).find(
      (id) => shipped[id]!.Type === "AWS::IAM::Role" && shipped[id]!.Properties.RoleName === `Mango-${ns}-PackProvisioner`,
    )!;
    const statements = statementsOf(roleLogicalId, shipped);
    const packGroups = ["aws-pricing", "aws-billing", "aws-cloudwatch"].map((pack) =>
      groupOf(`PackNetworkPackSg${pack.replace(/-/g, "")}`),
    );
    const pinned = (statement: Statement) => {
      const condition = statement.Condition!;
      // Absent keys (network mode PUBLIC) do not match: both must be present...
      expect(condition.Null).toEqual({
        "bedrock-agentcore:subnets": "false",
        "bedrock-agentcore:securityGroups": "false",
      });
      // ...and every value must be a subnet of the pack VPC or the group of a pack.
      const allowed = condition["ForAllValues:StringEquals"] as Record<string, unknown[]>;
      expect(allowed["bedrock-agentcore:subnets"]).toEqual(subnetIds.map((id) => ({ Ref: id })));
      expect(JSON.stringify(allowed["bedrock-agentcore:securityGroups"])).not.toContain("EndpointSg");
      expect(allowed["bedrock-agentcore:securityGroups"]).toHaveLength(packGroups.length);
      for (const group of packGroups) {
        expect(JSON.stringify(allowed["bedrock-agentcore:securityGroups"])).toContain(group);
      }
    };
    const create = bySid(statements, "CreatePackRuntime");
    expect(actions(create)).toEqual(["bedrock-agentcore:CreateAgentRuntime"]);
    expect(create.Resource).toBe(`${agentcore}:runtime/*`);
    expect(create.Condition!.StringEquals).toEqual(requestTags.StringEquals);
    pinned(create);
    const update = bySid(statements, "UpdatePackRuntime");
    expect(actions(update)).toEqual(["bedrock-agentcore:UpdateAgentRuntime"]);
    expect(update.Resource).toBe(runtimes);
    pinned(update);
    // No other statement lets it create or update a runtime without those conditions.
    for (const action of ["bedrock-agentcore:CreateAgentRuntime", "bedrock-agentcore:UpdateAgentRuntime"]) {
      expect(statements.filter((s) => actions(s).includes(action))).toHaveLength(1);
    }
    expect(statements.flatMap(actions).some((a) => /^bedrock-agentcore:\*|^\*$/.test(a))).toBe(false);
  });

  it("lets the provisioner create AgentCore's network service role and nothing else of the network", () => {
    const slr = bySid(provisioner, "AgentCoreNetworkServiceRole");
    expect(actions(slr)).toEqual(["iam:CreateServiceLinkedRole"]);
    expect(slr.Resource).toBe(
      `arn:aws:iam::${account}:role/aws-service-role/network.bedrock-agentcore.amazonaws.com/AWSServiceRoleForBedrockAgentCoreNetwork`,
    );
    expect(slr.Condition).toEqual({
      StringEquals: { "iam:AWSServiceName": "network.bedrock-agentcore.amazonaws.com" },
    });
    expect(provisioner.filter((s) => actions(s).includes("iam:CreateServiceLinkedRole"))).toHaveLength(1);
    // It names subnets and security groups; it can never change them.
    expect(provisioner.flatMap(actions).filter((a) => /^(ec2|route53resolver):/.test(a))).toEqual([]);
  });

  it("does not synthesize a release with a pack the pack network cannot serve (TM-E6)", () => {
    expect(() => assertPackEgress([{ id: "aws-pricing", egress: { aws: ["pricing"], hosts: [] } }])).not.toThrow();
    expect(() =>
      assertPackEgress([{ id: "web-search", egress: { aws: [], hosts: ["api.example.com"] } }]),
    ).toThrow(/web-search declares hosts outside AWS \(api\.example\.com\).*R6/s);
    expect(() => assertPackEgress([{ id: "odd", egress: { aws: ["s3"], hosts: [] } }])).toThrow(
      /odd declares AWS endpoints the pack network does not have: s3/,
    );
    // The whole path: such a release fails before any resource is defined.
    const external = signedRelease({ egress: { aws: ["pricing"], hosts: ["api.example.com"] } });
    const lab = installationSchema.parse({ ...raw, installationType: "lab", packs: { signingPublicKey: external.pem } });
    expect(() => synth(lab, { packsDir: external.dir })).toThrow(/hosts outside AWS/);
    // A statement signed before `egress` existed says nothing about what the pack reaches.
    const old = signedRelease({ egress: null });
    expect(() => loadReleasePacks(old.dir, old.pem)).toThrow(
      /aws-pricing-1\.1\.1-1\.pack\.json: the signed statement is not one this release accepts \(manifest\.egress\)/,
    );
  });

  it("knows the same AWS endpoints as the manifest schema", () => {
    const source = readFileSync(resolve(REPO_ROOT, "packages/py/mango-packs/src/mango_packs/manifest.py"), "utf8");
    const body = /class AwsEndpoint\(StrEnum\):([\s\S]*?)\n\n\n/.exec(source)![1]!;
    const declared = [...body.matchAll(/^ {4}[A-Z_]+ = "([a-z0-9-]+)"$/gm)].map((match) => match[1]!);
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.sort()).toEqual(Object.keys(PACK_EGRESS_SERVICES).sort());
  });

  it("the packs of this repository declare only endpoints of the catalog and no external host", () => {
    for (const pack of ["aws-pricing", "aws-billing", "aws-cloudwatch"]) {
      const manifest = readFileSync(resolve(REPO_ROOT, "packs", pack, "manifest.yaml"), "utf8");
      const egress = /^egress:\n {2}aws: \[([a-z0-9, -]*)\]$/m.exec(manifest);
      expect(egress, pack).not.toBeNull();
      const services = egress![1]!.split(",").map((item) => item.trim()).filter(Boolean);
      expect(() => assertPackEgress([{ id: pack, egress: { aws: services, hosts: [] } }])).not.toThrow();
      expect(manifest).not.toMatch(/^ {2}hosts:/m);
    }
  });

  it("takes two or three supported Availability Zone ids and a private /22, for every installation", () => {
    const network = (value: unknown) => installationSchema.safeParse({ ...raw, packs: { network: value } });
    expect(installationSchema.parse(raw).packs.network).toEqual({
      cidr: "10.210.0.0/22",
      availabilityZoneIds: ["use1-az1", "use1-az2"],
    });
    expect(network({ availabilityZoneIds: ["use1-az2", "use1-az4"], cidr: "172.20.8.0/22" }).success).toBe(true);
    expect(network({ availabilityZoneIds: ["use1-az1", "use1-az2", "use1-az4"] }).success).toBe(true);
    // One zone, a zone AgentCore does not support, a repeated zone, a zone name.
    expect(network({ availabilityZoneIds: ["use1-az1"] }).success).toBe(false);
    expect(network({ availabilityZoneIds: ["use1-az1", "use1-az6"] }).success).toBe(false);
    expect(network({ availabilityZoneIds: ["use1-az1", "use1-az1"] }).success).toBe(false);
    expect(network({ availabilityZoneIds: ["us-east-1a", "us-east-1b"] }).success).toBe(false);
    // Public ranges, other prefix lengths, a /22 that does not start on its boundary.
    for (const cidr of ["8.8.8.0/22", "10.210.0.0/16", "10.210.1.0/22", "10.300.0.0/22", "192.168.0.0/24"]) {
      expect(network({ cidr }).success, cidr).toBe(false);
    }
    expect(network({ mode: "PUBLIC" }).success).toBe(false);
  });
});
