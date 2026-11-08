import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as iam from "aws-cdk-lib/aws-iam";
import { describe, expect, it } from "vitest";
import { loadInstallation } from "../lib/config/schema.js";
import {
  AGENT_MEMORY_ACTIONS,
  AGENT_MEMORY_ENABLED,
  AgentMemory,
  API_MEMORY_ACTIONS,
  MEMORY_EVENT_EXPIRY_DAYS,
  MEMORY_STRATEGIES,
} from "../lib/constructs/agent-memory.js";
import { CoreStack } from "../lib/stacks/core-stack.js";
import { fromCore, nestedStacks, nestedTemplate } from "./nested.js";

/* The AgentCore Memory of the installation (D122); threat model memory-threat-model.md
 * (TM-ME1, ME5, ME8). Off until the M0 test in AWS. */

const cfg = loadInstallation(resolve(import.meta.dirname, "../config/example.json"));
const ns = cfg.namespace;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resource = { Type: string; Properties: any; DeletionPolicy?: string; UpdateReplacePolicy?: string };
interface Statement {
  Sid?: string;
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
const memories = Object.entries(resources).filter(([, r]) => r.Type === "AWS::BedrockAgentCore::Memory");
const [memoryId, memory] = memories[0]!;
const actions = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
const allStatements = Object.values(resources)
  .filter((r) => r.Type === "AWS::IAM::Policy" || r.Type === "AWS::IAM::ManagedPolicy")
  .flatMap((r) => r.Properties.PolicyDocument.Statement as Statement[]);
const containerEnv = (family: string): Record<string, unknown> => {
  const def = Object.values(resources).find(
    (r) => r.Type === "AWS::ECS::TaskDefinition" && r.Properties.Family === family,
  )!;
  return Object.fromEntries(
    (def.Properties.ContainerDefinitions[0].Environment as { Name: string; Value: unknown }[]).map((e) => [
      e.Name,
      e.Value,
    ]),
  );
};

describe("the memory of the installation (D122)", () => {
  it("is off in the release until M0 confirms the isolation", () => {
    expect(AGENT_MEMORY_ENABLED).toBe(false);
    expect(containerEnv(`Mango-${ns}-api`).AGENT_MEMORY_ENABLED).toBe("false");
    const provisioner = Object.values(resources).find(
      (r) => r.Type === "AWS::Lambda::Function" && r.Properties.FunctionName === `Mango-${ns}-Provisioner`,
    )!;
    expect(provisioner.Properties.Environment.Variables.AGENT_MEMORY_ENABLED).toBe("false");
  });

  it("is one memory in Core, never in a nested stack, retained with the data (D99 (2), TM-ME8)", () => {
    expect(memories).toHaveLength(1);
    expect(memory.Properties.Name).toBe(`Mango_${ns}_memory`);
    // Retained on update and deletion; a failed first creation leaves nothing behind.
    expect(memory.DeletionPolicy).toBe("RetainExceptOnCreate");
    expect(memory.UpdateReplacePolicy).toBe("Retain");
    for (const stack of nestedStacks(core)) {
      const nested = nestedTemplate(stack).Resources as Record<string, Resource>;
      expect(Object.values(nested).filter((r) => r.Type === "AWS::BedrockAgentCore::Memory")).toEqual([]);
    }
  });

  it("is encrypted with a key of its own, rotated and retained", () => {
    const keyId = memory.Properties.EncryptionKeyArn["Fn::GetAtt"][0] as string;
    const key = resources[keyId]!;
    expect(key.Type).toBe("AWS::KMS::Key");
    expect(key.Properties.EnableKeyRotation).toBe(true);
    expect(key.DeletionPolicy).toBe("RetainExceptOnCreate");
    const alias = Object.values(resources).find(
      (r) => r.Type === "AWS::KMS::Alias" && r.Properties.AliasName === `alias/Mango-${ns}-memory`,
    )!;
    expect(alias.Properties.TargetKeyId).toEqual({ "Fn::GetAtt": [keyId, "Arn"] });
  });

  it("keeps events 7 days and extracts preferences, facts and summaries into the actor's namespaces", () => {
    expect(memory.Properties.EventExpiryDuration).toBe(MEMORY_EVENT_EXPIRY_DAYS);
    expect(MEMORY_EVENT_EXPIRY_DAYS).toBe(7);
    const strategies = memory.Properties.MemoryStrategies as Record<string, { Name: string; NamespaceTemplates: string[] }>[];
    expect(strategies.map((s) => Object.keys(s)[0]).sort()).toEqual([
      "SemanticMemoryStrategy",
      "SummaryMemoryStrategy",
      "UserPreferenceMemoryStrategy",
    ]);
    const byName = Object.fromEntries(strategies.map((s) => Object.values(s)[0]!).map((s) => [s.Name, s.NamespaceTemplates]));
    expect(byName).toEqual({
      preferences: [MEMORY_STRATEGIES.preferences],
      facts: [MEMORY_STRATEGIES.facts],
      summaries: [MEMORY_STRATEGIES.summaries],
    });
    // Every namespace starts with the actor (TM-ME3): its owner is read from it.
    for (const template of Object.values(MEMORY_STRATEGIES)) expect(template.startsWith("/mango/{actorId}/")).toBe(true);
  });

  it("writes the namespaces mango_core reads", () => {
    const python = readFileSync(resolve(import.meta.dirname, "../../packages/py/mango-core/src/mango_core/memory.py"), "utf8");
    for (const [kind, template] of Object.entries(MEMORY_STRATEGIES)) {
      expect(python).toContain(`Kind.${kind.toUpperCase()}: "${template}"`);
    }
    expect(python).toContain(`EVENT_EXPIRY_DAYS = ${MEMORY_EVENT_EXPIRY_DAYS}`);
  });

  it("gives no role a permission on it while it is off (TM-ME1)", () => {
    const onMemory = allStatements.filter((s) => JSON.stringify(s.Resource).includes(memoryId));
    expect(onMemory).toEqual([]);
    const memoryActions = allStatements.flatMap(actions).filter((a) => /Memory|Event|Actors|Sessions/.test(a) && a.startsWith("bedrock-agentcore:"));
    expect(memoryActions).toEqual([]);
  });
});

describe("the memory once on (M1, after M0)", () => {
  const stack = new Stack(new App(), "Memory", { env: { account: cfg.mangoAccountId, region: cfg.region } });
  const on = new AgentMemory(stack, "Memory", { installation: cfg, enabled: true });
  const api = new iam.Role(stack, "Api", { assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com") });
  const provisioner = new iam.Role(stack, "Provisioner", { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") });
  on.grantApi(api);
  on.grantProvisioner(provisioner);
  new iam.ManagedPolicy(stack, "Boundary", { statements: on.agentStatements() });
  const json = Template.fromStack(stack).toJSON().Resources as Record<string, Resource>;
  const memoryLogical = Object.entries(json).find(([, r]) => r.Type === "AWS::BedrockAgentCore::Memory")![0];
  const memoryArn = { "Fn::GetAtt": [memoryLogical, "MemoryArn"] };
  const statements = (type: string) =>
    Object.values(json)
      .filter((r) => r.Type === type)
      .flatMap((r) => r.Properties.PolicyDocument.Statement as Statement[]);
  const bySid = (type: string) => Object.fromEntries(statements(type).map((s) => [s.Sid, s]));

  it("tells mango-api and the provisioner", () => {
    expect(on.environment.AGENT_MEMORY_ENABLED).toBe("true");
  });

  it("lets an agent's role store events and recall, never delete nor reach another memory", () => {
    const boundary = bySid("AWS::IAM::ManagedPolicy");
    expect(actions(boundary.AgentMemory!).sort()).toEqual([...AGENT_MEMORY_ACTIONS].sort());
    expect(boundary.AgentMemory!.Resource).toEqual(memoryArn);
    expect(actions(boundary.AgentMemory!).some((a) => a.includes("Delete"))).toBe(false);
    expect(boundary.AgentMemoryKey!.Condition).toEqual({
      StringEquals: { "kms:ViaService": `bedrock-agentcore.${cfg.region}.amazonaws.com` },
    });
  });

  it("lets mango-api list and delete, on this memory only", () => {
    const policy = bySid("AWS::IAM::Policy");
    expect(actions(policy.ApiMemory!).sort()).toEqual([...API_MEMORY_ACTIONS].sort());
    expect(policy.ApiMemory!.Resource).toEqual(memoryArn);
    expect(actions(policy.ApiMemoryKey!).sort()).toEqual(["kms:Decrypt", "kms:GenerateDataKey"]);
    expect(policy.ReadAgentMemory!.Resource).toEqual(memoryArn);
    for (const s of statements("AWS::IAM::Policy")) {
      expect(actions(s).some((a) => a.endsWith(":*"))).toBe(false);
      expect(s.Resource).not.toBe("*");
    }
  });
});
