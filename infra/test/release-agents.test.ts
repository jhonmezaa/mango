import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { loadInstallation } from "../lib/config/schema.js";
import {
  RELEASE_AGENT_IDS,
  releaseAgentDefinition,
  releaseAgents,
  releaseVersion,
} from "../lib/constructs/release-agents.js";
import { CoreStack } from "../lib/stacks/core-stack.js";

const cfg = loadInstallation(resolve(import.meta.dirname, "../config/example.json"));
const ns = cfg.namespace;
const repo = resolve(import.meta.dirname, "../..");

type Resource = { Type: string; Properties: any; DependsOn?: string[]; [k: string]: any };
const template = Template.fromStack(
  new CoreStack(new App({ context: { skipSpa: true } }), "Core", {
    installation: cfg,
    env: { account: cfg.mangoAccountId, region: cfg.region },
  }),
);
const resources = template.toJSON().Resources as Record<string, Resource>;

interface Statement {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource: unknown;
  Condition?: Record<string, Record<string, unknown>>;
}

function logicalId(type: string, props: Record<string, unknown>): string {
  const ids = Object.keys(template.findResources(type, { Properties: props }));
  expect(ids).toHaveLength(1);
  return ids[0]!;
}

/** A custom resource call as text: the table name is a token, so it is an Fn::Join of JSON. */
function call(resource: Resource, phase: "Create" | "Update" = "Create"): string {
  const value = resource.Properties[phase] as string | { "Fn::Join": [string, unknown[]] };
  if (typeof value === "string") return value;
  return value["Fn::Join"][1].map((part) => (typeof part === "string" ? part : "<token>")).join("");
}

function customResource(marker: string): [string, Resource] {
  const found = Object.entries(resources).filter(
    ([, r]) => r.Type === "Custom::AWS" && call(r).includes(marker),
  );
  expect(found, marker).toHaveLength(1);
  return found[0]!;
}

const agentsId = logicalId("AWS::DynamoDB::GlobalTable", { TableName: `Mango-${ns}-Agents` });
const machineId = logicalId("AWS::StepFunctions::StateMachine", { StateMachineName: `Mango-${ns}-AgentProvisioner` });
const functionId = logicalId("AWS::Lambda::Function", { FunctionName: `Mango-${ns}-Provisioner` });
const [finops] = releaseAgents(cfg);
const [seedId, seed] = customResource("agents-seed-finops");
const [publishId, publish] = customResource("agents-publish-finops");
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("release agent definition (D34)", () => {
  it("ships FinOps, and only agents with a release slug", () => {
    expect([...RELEASE_AGENT_IDS]).toEqual(["finops"]);
    for (const id of RELEASE_AGENT_IDS) expect(id).toMatch(/^[a-z][a-z0-9]{1,15}$/);
    // Routes of the API that an agent id must not shadow.
    for (const reserved of ["mine", "reviews", "org", "platform"]) expect(RELEASE_AGENT_IDS).not.toContain(reserved);
  });

  it("is the file of the release plus the model of the installation, with every field written out", () => {
    const file = JSON.parse(readFileSync(resolve(repo, "agents/finops/agent.json"), "utf8"));
    const definition = JSON.parse(finops!.canonical);
    expect(Object.keys(definition)).toEqual([
      "allowed_models",
      "approval_tools",
      "category",
      "color",
      "description",
      "groups",
      "icon",
      "limits",
      "model",
      "name",
      "reports_to",
      "role",
      "system_prompt",
      "tools",
      "users",
    ]);
    expect(definition.system_prompt).toBe(file.definition.system_prompt.join("\n"));
    expect(definition.model).toBe(cfg.models.agent);
    expect(definition.allowed_models).toEqual([cfg.models.agent]);
    expect(definition.limits).toEqual({
      max_iterations: 12,
      max_tokens: 8000,
      max_tokens_per_call: 4000,
      temperature: 0.2,
      timeout_seconds: 300,
    });
    // The file names no model (rule 7) and nothing that is not part of a definition.
    expect(file.definition.model).toBeUndefined();
    expect(file.definition.allowed_models).toBeUndefined();
    expect(definition.approval_tools).toEqual([]);
    expect(definition.users).toEqual([]);
    expect(definition.groups).toEqual(["bu-lead", "finops-central"]);
  });

  it("uses every tool of the Cost Explorer connector and nothing else", () => {
    const manifest = JSON.parse(readFileSync(resolve(repo, "connectors/cost-explorer/manifest.json"), "utf8"));
    const tools = (manifest.tools as { name: string; access: string }[]).map((t) => `cost-explorer.${t.name}`).sort();
    expect(JSON.parse(finops!.canonical).tools).toEqual(tools);
    for (const tool of manifest.tools) expect(tool.access).toBe("read");
  });

  it("stores the same bytes Python would (canonical JSON), so both sides agree on the hash", () => {
    // `apps/api/tests/test_release_agent.py` pins the same hash from `dumps_definition`. It
    // changes with any change to agents/finops/agent.json: update both on purpose.
    const { canonical } = releaseAgentDefinition("finops", "us.anthropic.claude-sonnet-4-6");
    expect(sha256(canonical)).toBe("d68ea3956b28a1989caba25e0169cb9755294804b05bccf759860c3ee968f5e9");
    expect(finops!.contentHash).toBe(sha256(finops!.canonical));
    // Sorted keys and no whitespace between tokens.
    expect(canonical.startsWith('{"allowed_models":["us.anthropic.claude-sonnet-4-6"],"approval_tools":[],')).toBe(true);
  });

  it("names the release as the approver", () => {
    expect(releaseVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("seed of the release agents (TM-M16)", () => {
  const text = call(seed);
  const approver = `release@${releaseVersion()}`;

  it("writes the agent and its first version, already approved by the release", () => {
    expect(text).toContain('"action":"transactWriteItems"');
    expect(text).toContain('"SK":{"S":"META"}');
    expect(text).toContain('"SK":{"S":"VERSION#000001"}');
    expect(text.match(/"PK":\{"S":"AGENT#finops"\}/g)).toHaveLength(2);
    expect(text).toContain('"status":{"S":"draft"}');
    expect(text).toContain('"open_version":{"N":"1"}');
    expect(text).toContain('"status":{"S":"approved"}');
    expect(text).toContain('"status_index":{"S":"VERSION#approved"}');
    expect(text).toContain(`"approved_by":{"S":"${approver}"}`);
    expect(text).toContain(`"created_by":{"S":"${approver}"}`);
    expect(text).toContain(`"editors":{"SS":["${approver}"]}`);
    expect(text).toContain(`"content_hash":{"S":"${finops!.contentHash}"}`);
    // Never published by the seed: only the provisioner writes that.
    expect(text).not.toContain("published");
    expect(text).not.toContain("PUBLISHED#");
    expect(text).not.toContain("harness");
  });

  it("stores exactly the content the hash covers", () => {
    const stored = JSON.parse(text).parameters.TransactItems[1].Put.Item.definition.S as string;
    expect(stored).toBe(finops!.canonical);
    expect(sha256(stored)).toBe(finops!.contentHash);
  });

  it("is put-if-absent on create and update, and never deletes", () => {
    expect(text.match(/attribute_not_exists\(PK\)/g)).toHaveLength(2);
    expect(text).toContain('"ignoreErrorCodesMatching":"TransactionCanceledException"');
    expect(call(seed, "Update")).toBe(text);
    expect(seed.Properties.Delete).toBeUndefined();
  });

  it("may only write the partition of the release agent", () => {
    const grants = Object.values(resources)
      .filter((r) => r.Type === "AWS::IAM::Policy")
      .flatMap((r) => (r.Properties.PolicyDocument.Statement as Statement[]).map((s) => ({ roles: r.Properties.Roles, s })))
      .filter(({ s }) => s.Action === "dynamodb:PutItem" && JSON.stringify(s.Resource).includes(`"${agentsId}"`))
      // The provisioner writes its own partition (`PUBLISHED#`, provisioner.test.ts).
      .filter(({ s }) => s.Sid !== "WritePublishedPointer");
    expect(grants).toHaveLength(1);
    const { roles, s } = grants[0]!;
    expect(s.Resource).toEqual({ "Fn::GetAtt": [agentsId, "Arn"] });
    expect(s.Condition).toEqual({ "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["AGENT#finops"] } });
    // The CDK singleton provider, which only CloudFormation invokes.
    expect(roles).toHaveLength(1);
    expect(roles[0].Ref).toMatch(/^AWS679f53fac002430cb0da5b7982bd2287ServiceRole/);
  });
});

describe("publication of the release agents", () => {
  it("starts the provisioner with identifiers and the hash only", () => {
    const text = call(publish);
    const parsed = JSON.parse(text);
    expect([parsed.service, parsed.action]).toEqual(["SFN", "startExecution"]);
    expect(JSON.parse(parsed.parameters.input)).toEqual({
      agent_id: "finops",
      content_hash: finops!.contentHash,
      version: 1,
    });
    expect(text).not.toContain("system_prompt");
    expect(call(publish, "Update")).toBe(text);
    expect(publish.Properties.Delete).toBeUndefined();
  });

  it("waits for the seed and for the provisioner of this release", () => {
    expect(publish.DependsOn).toEqual(expect.arrayContaining([seedId, machineId, functionId]));
  });

  it("may only start that state machine", () => {
    const grants = Object.values(resources)
      .filter((r) => r.Type === "AWS::IAM::Policy" && r.Properties.Roles.some((x: { Ref: string }) => /^AWS679f53fac/.test(x.Ref)))
      .flatMap((r) => r.Properties.PolicyDocument.Statement as Statement[])
      .filter((s) => JSON.stringify(s.Action).includes("states:"));
    expect(grants).toHaveLength(1);
    expect(grants[0]!.Action).toBe("states:StartExecution");
    expect(grants[0]!.Resource).toEqual({ Ref: machineId });
  });

  it("tells the provisioner which release approvals are genuine", () => {
    const env = resources[functionId]!.Properties.Environment.Variables as Record<string, string>;
    expect(JSON.parse(env.RELEASE_AGENTS!)).toEqual({ finops: finops!.contentHash });
  });
});

describe("mango-api and the release agent", () => {
  const [task] = Object.values(template.findResources("AWS::ECS::TaskDefinition"));
  const env = Object.fromEntries(
    (task!.Properties.ContainerDefinitions[0].Environment as { Name: string; Value: unknown }[]).map((e) => [
      e.Name,
      e.Value,
    ]),
  );

  it("knows which agent ships with the release, not what it is", () => {
    expect(env.AGENT_ID).toBe("finops");
    expect(env.AGENT_NAME).toBeUndefined();
    expect(env.AGENT_MODEL).toBe(cfg.models.agent);
    for (const gone of [
      "AGENT_SYSTEM_PROMPT",
      "AGENT_LIMITS",
      "AGENT_MAX_TOKENS_PER_CALL",
      "AGENT_TEMPERATURE",
      "HARNESS_ARN",
    ]) {
      expect(env, gone).not.toHaveProperty(gone);
    }
    // The prompt is data of the Agents table, never configuration of the service.
    expect(JSON.stringify(task!.Properties)).not.toContain("You are Mango FinOps");
  });

  it("starts its new tasks only once the release agents are seeded", () => {
    const [serviceId] = Object.keys(template.findResources("AWS::ECS::Service"));
    expect(resources[serviceId!]!.DependsOn).toEqual(expect.arrayContaining([seedId]));
    expect(resources[serviceId!]!.DependsOn).not.toContain(publishId);
  });
});

describe("FinOps is not a resource of the stack any more (D32, D34)", () => {
  it("has no harness: agents are published by the provisioner", () => {
    template.resourceCountIs("AWS::BedrockAgentCore::Harness", 0);
    expect(JSON.stringify(template.toJSON().Outputs)).not.toContain("Harness");
  });

  it("gives mango-api no harness of its own, only the ones of provisioned agents", () => {
    const [task] = Object.values(template.findResources("AWS::ECS::TaskDefinition"));
    const names = (task!.Properties.ContainerDefinitions[0].Environment as { Name: string }[]).map((e) => e.Name);
    expect(names.filter((name) => /HARNESS/.test(name))).toEqual([]);
    const invoke = Object.values(resources)
      .filter((r) => r.Type === "AWS::IAM::Policy")
      .flatMap((r) => r.Properties.PolicyDocument.Statement as Statement[])
      .filter((s) => JSON.stringify(s.Action).includes("bedrock-agentcore:InvokeHarness"));
    expect(invoke.map((s) => s.Sid)).toEqual(["InvokeAgentHarnesses"]);
    expect(JSON.stringify(invoke[0]!.Resource)).toContain(`harness/Mango_${ns}_a_*`);
  });

  it("has no policy that names an agent: FinOps is used through its groups like any other", () => {
    const statements = Object.values(template.findResources("AWS::VerifiedPermissions::Policy")).map(
      (p) => p.Properties.Definition.Static.Statement as string,
    );
    expect(statements.filter((s) => /Mango::Agent::"/.test(s))).toEqual([]);
  });
});
