import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as iam from "aws-cdk-lib/aws-iam";
import { describe, expect, it } from "vitest";
import { loadInstallation } from "../lib/config/schema.js";
import {
  AGENT_MEMORY_ENABLED,
  AgentMemory,
  API_MEMORY_ACTIONS,
  MEMORY_EVENT_EXPIRY_DAYS,
  MEMORY_MIN_SCORE,
  MEMORY_STRATEGIES,
  memoryPrices,
  WORKER_MEMORY_ACTIONS,
} from "../lib/constructs/agent-memory.js";
import { loadReleaseDefaults } from "../lib/config/release.js";
import { CoreStack } from "../lib/stacks/core-stack.js";
import { fromCore, nestedStacks, nestedTemplate } from "./nested.js";

/* The AgentCore Memory of the installation (D122); threat model memory-threat-model.md
 * (TM-ME1, ME2, ME5, ME7, ME8). On in the release since 2026-11-08 (the owner accepted TM-ME1,
 * ME2, ME4 and ME5); each agent turns it on in an approved version. Read and written by the turn worker
 * only (D122 (8), precised 2026-11-08): the harness of an agent has none. */

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
  it("is on in the release, and mango-api and the worker are told so, with its prices (TM-ME7)", () => {
    expect(AGENT_MEMORY_ENABLED).toBe(true);
    const api = containerEnv(`Mango-${ns}-api`);
    expect(api.AGENT_MEMORY_ENABLED).toBe("true");
    expect(JSON.parse(api.AGENT_MEMORY_PRICES as string)).toEqual(memoryPrices(cfg));
    const worker = nestedStacks(core)
      .flatMap((stack) => Object.values(nestedTemplate(stack).Resources as Record<string, Resource>))
      .find((r) => r.Type === "AWS::ECS::TaskDefinition" && r.Properties.Family === `Mango-${ns}-turn-worker`)!;
    const env = Object.fromEntries(
      (worker.Properties.ContainerDefinitions[0].Environment as { Name: string; Value: unknown }[]).map((e) => [e.Name, e.Value]),
    );
    expect(Object.keys(env)).toEqual(
      expect.arrayContaining(["AGENT_MEMORY_ENABLED", "AGENT_MEMORY_ARN", "AGENT_MEMORY_MIN_SCORE", "AGENT_MEMORY_PRICES"]),
    );
    expect(env.AGENT_MEMORY_ENABLED).toBe("true");
    expect(env.AGENT_MEMORY_PRICES).toBe(api.AGENT_MEMORY_PRICES);
    // Never the key: the worker uses it through the service only.
    expect(env.AGENT_MEMORY_KEY_ARN).toBeUndefined();
  });

  it("is never named by the provisioner: the harness has no memory (D122 (8))", () => {
    const provisioner = Object.values(resources).find(
      (r) => r.Type === "AWS::Lambda::Function" && r.Properties.FunctionName === `Mango-${ns}-Provisioner`,
    )!;
    expect(Object.keys(provisioner.Properties.Environment.Variables).filter((k) => k.includes("MEMORY"))).toEqual([]);
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
    expect(python).toContain(`RETRIEVAL_MIN_SCORE = ${MEMORY_MIN_SCORE}`);
  });

  it("is priced by the release unless the installation says otherwise (TM-ME7, rule 7)", () => {
    expect(memoryPrices({ ...cfg, memoryPrices: undefined })).toEqual(loadReleaseDefaults().memoryPrices);
    expect(memoryPrices({ ...cfg, memoryPrices: { gbIngested: 2, thousandRetrievals: 3 } })).toEqual({
      gbIngested: 2,
      thousandRetrievals: 3,
    });
    // As AWS lists them (2026-11-08): $1.00 per GB ingested and $0.50 per 1,000 retrievals.
    expect(loadReleaseDefaults().memoryPrices).toEqual({ gbIngested: 1, thousandRetrievals: 0.5 });
  });

  it("is reached in the release by mango-api and the turn worker only, never an agent (TM-ME1, TM-ME8)", () => {
    const onMemory = allStatements.filter((s) => JSON.stringify(s.Resource).includes(memoryId));
    expect(onMemory.map((s) => s.Sid).sort()).toEqual(["ApiMemory", "WorkerMemoryEvents", "WorkerMemoryRecall"]);
    const memoryActions = allStatements
      .flatMap(actions)
      .filter((a) => /Memory|Event|Actors|Sessions/.test(a) && a.startsWith("bedrock-agentcore:"));
    expect([...new Set(memoryActions)].sort()).toEqual([...new Set([...API_MEMORY_ACTIONS, ...WORKER_MEMORY_ACTIONS])].sort());
    // Each Sid in one policy only: the API's on the task role of mango-api, the worker's on its own.
    const policies = Object.values(resources).filter(
      (r) =>
        (r.Type === "AWS::IAM::Policy" || r.Type === "AWS::IAM::ManagedPolicy") &&
        JSON.stringify(r.Properties.PolicyDocument).includes("Memory"),
    );
    // mango-api's in a managed policy of its own: its role is close to its limit of inline policies.
    const apiMemory = Object.values(resources).filter(
      (r) => r.Type === "AWS::IAM::ManagedPolicy" && r.Properties.ManagedPolicyName === `Mango-${ns}-ApiMemory`,
    );
    expect(apiMemory).toHaveLength(1);
    expect((apiMemory[0]!.Properties.PolicyDocument.Statement as Statement[]).map((s) => s.Sid)).toEqual([
      "ApiMemory",
      "ApiMemoryKey",
    ]);
    const owners = policies.flatMap((r) =>
      (r.Properties.PolicyDocument.Statement as Statement[])
        .filter((s) => s.Sid?.includes("Memory"))
        .map((s) => [s.Sid, JSON.stringify(r.Properties.Roles)] as const),
    );
    const apiRoles = new Set(owners.filter(([sid]) => sid!.startsWith("Api")).map(([, roles]) => roles));
    const workerRoles = new Set(owners.filter(([sid]) => sid!.startsWith("Worker")).map(([, roles]) => roles));
    expect(apiRoles.size).toBe(1);
    expect(workerRoles.size).toBe(1);
    expect([...apiRoles][0]).not.toEqual([...workerRoles][0]);
  });
});

describe("the memory once on", () => {
  const stack = new Stack(new App(), "Memory", { env: { account: cfg.mangoAccountId, region: cfg.region } });
  const on = new AgentMemory(stack, "Memory", { installation: cfg, enabled: true });
  const api = new iam.Role(stack, "Api", { assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com") });
  const worker = new iam.Role(stack, "Worker", { assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com") });
  on.grantApi(api);
  on.grantWorker(worker);
  const json = Template.fromStack(stack).toJSON().Resources as Record<string, Resource>;
  const memoryLogical = Object.entries(json).find(([, r]) => r.Type === "AWS::BedrockAgentCore::Memory")![0];
  const memoryArn = { "Fn::GetAtt": [memoryLogical, "MemoryArn"] };
  const policyOf = (roleLogical: string): Record<string, Statement> =>
    Object.fromEntries(
      Object.values(json)
        .filter(
          (r) =>
            (r.Type === "AWS::IAM::Policy" || r.Type === "AWS::IAM::ManagedPolicy") &&
            JSON.stringify(r.Properties.Roles).includes(roleLogical),
        )
        .flatMap((r) => r.Properties.PolicyDocument.Statement as Statement[])
        .map((s) => [s.Sid, s]),
    );
  const roleLogical = (prefix: string) => Object.keys(json).find((k) => k.startsWith(prefix) && json[k]!.Type === "AWS::IAM::Role")!;

  it("tells mango-api and the worker, with the least score of a recall", () => {
    expect(on.environment.AGENT_MEMORY_ENABLED).toBe("true");
    expect(on.environment.AGENT_MEMORY_MIN_SCORE).toBe("0.3");
  });

  it("lets the worker write events of people and recall their preferences and facts, nothing else", () => {
    const policy = policyOf(roleLogical("Worker"));
    expect(Object.keys(policy).sort()).toEqual(["WorkerMemoryEvents", "WorkerMemoryKey", "WorkerMemoryRecall"]);
    expect(actions(policy.WorkerMemoryEvents!)).toEqual(["bedrock-agentcore:CreateEvent"]);
    expect(policy.WorkerMemoryEvents!.Condition).toEqual({ StringLike: { "bedrock-agentcore:actorId": "m1:*" } });
    expect(actions(policy.WorkerMemoryRecall!)).toEqual(["bedrock-agentcore:RetrieveMemoryRecords"]);
    // Never the summaries, never the sentinel's namespaces (TM-ME1).
    expect(policy.WorkerMemoryRecall!.Condition).toEqual({
      StringLike: { "bedrock-agentcore:namespace": ["/mango/m1:*/preferences/", "/mango/m1:*/facts/"] },
    });
    for (const sid of ["WorkerMemoryEvents", "WorkerMemoryRecall"]) expect(policy[sid]!.Resource).toEqual(memoryArn);
    expect([...WORKER_MEMORY_ACTIONS].sort()).toEqual(["bedrock-agentcore:CreateEvent", "bedrock-agentcore:RetrieveMemoryRecords"]);
    expect(policy.WorkerMemoryKey!.Condition).toEqual({
      StringEquals: { "kms:ViaService": `bedrock-agentcore.${cfg.region}.amazonaws.com` },
    });
  });

  it("lets mango-api list and delete on this memory only, its namespaces checked in its code", () => {
    const policy = policyOf(roleLogical("Api"));
    expect(actions(policy.ApiMemory!).sort()).toEqual([...API_MEMORY_ACTIONS].sort());
    expect(policy.ApiMemory!.Resource).toEqual(memoryArn);
    // A condition on the namespace would deny every call by record id, even on one's own (M0).
    expect(policy.ApiMemory!.Condition).toBeUndefined();
    expect(actions(policy.ApiMemoryKey!).sort()).toEqual(["kms:Decrypt", "kms:GenerateDataKey"]);
    for (const s of Object.values(policy)) {
      expect(actions(s).some((a) => a.endsWith(":*"))).toBe(false);
      expect(s.Resource).not.toBe("*");
    }
  });
});
