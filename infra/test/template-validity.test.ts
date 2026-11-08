import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { releaseSynthesizer, UNPUBLISHED_TARGET } from "../lib/release-target.js";
import { CoreStack } from "../lib/stacks/core-stack.js";
import { MemberStack } from "../lib/stacks/member-stack.js";
import { OrgAccessStack } from "../lib/stacks/org-access-stack.js";
import { PackNetworkStack } from "../lib/stacks/pack-network-stack.js";
import { PayerStack } from "../lib/stacks/payer-stack.js";
import { nestedStacks, nestedTemplate } from "./nested.js";

/*
 * What CloudFormation rejects when it validates a template, and neither cdk-nag, cfn-guard nor
 * Checkov sees. An update of Core to a release with `Dimensions: []` in a metric filter rolled
 * back in a customer's account: the nested stack failed its schema validation
 * ("expected minimum item count: 1, found: 0").
 */

interface Resource {
  Type: string;
  Properties?: Record<string, unknown>;
  DeletionPolicy?: string;
}

// Every template of a release, as `bin/mango.ts` builds it: the five stacks and every stack nested in them.
const app = new App({ context: { packsDir: mkdtempSync(join(tmpdir(), "mango-no-packs-")) } });
const release = { synthesizer: releaseSynthesizer(UNPUBLISHED_TARGET) };
const stacks: Stack[] = [
  new CoreStack(app, "Core", { env: { region: "us-east-1" }, ...release, release: UNPUBLISHED_TARGET }),
  new PackNetworkStack(app, "PackNetwork", { env: { region: "us-east-1" }, ...release }),
  new PayerStack(app, "Payer", {}),
  new MemberStack(app, "Member"),
  new OrgAccessStack(app, "OrgAccess", {}),
];
interface Parameter {
  Type: string;
}
const templates = new Map<string, Record<string, Resource>>();
const parameters = new Map<string, Record<string, Parameter>>();
for (const stack of stacks) {
  const root = Template.fromStack(stack).toJSON() as { Resources: Record<string, Resource>; Parameters?: Record<string, Parameter> };
  templates.set(stack.node.id, root.Resources);
  parameters.set(stack.node.id, root.Parameters ?? {});
  for (const nested of nestedStacks(stack)) {
    const template = nestedTemplate(nested);
    templates.set(`${stack.node.id}/${nested.node.id}`, template.Resources as Record<string, Resource>);
    parameters.set(`${stack.node.id}/${nested.node.id}`, (template.Parameters ?? {}) as Record<string, Parameter>);
  }
}

describe("templates CloudFormation accepts", () => {
  it("cover every stack of the release and the stacks nested in Core", () => {
    expect([...templates.keys()]).toEqual(expect.arrayContaining(["Core", "PackNetwork", "Payer", "Member", "OrgAccess"]));
    expect([...templates.keys()].filter((name) => name.startsWith("Core/")).length).toBeGreaterThan(0);
  });

  // A nested stack takes only strings: a list parameter of Core passed whole is rejected when the
  // change set is created ("Value of property Parameters must be an object with String (or
  // simple type) properties"). Seen updating a customer's Core to v0.1.0-g41f0f27, 2026-11-08.
  it("pass only strings to the parameters of a nested stack", () => {
    const lists: string[] = [];
    let nestedResources = 0;
    for (const [name, resources] of templates) {
      const own = parameters.get(name) ?? {};
      for (const [id, resource] of Object.entries(resources)) {
        if (resource.Type !== "AWS::CloudFormation::Stack") continue;
        nestedResources += 1;
        const passed = (resource.Properties?.Parameters ?? {}) as Record<string, unknown>;
        for (const [key, value] of Object.entries(passed)) {
          const ref = (value as { Ref?: unknown } | null)?.Ref;
          const type = typeof ref === "string" ? own[ref]?.Type : undefined;
          if (Array.isArray(value) || (type !== undefined && type !== "String" && type !== "Number")) {
            lists.push(`${name}: ${id}.${key}`);
          }
        }
      }
    }
    expect(nestedResources).toBeGreaterThan(0);
    expect(lists).toEqual([]);
  });

  it("never give a metric filter an empty list of dimensions", () => {
    const empty: string[] = [];
    let filters = 0;
    for (const [name, resources] of templates) {
      for (const [id, resource] of Object.entries(resources)) {
        if (resource.Type !== "AWS::Logs::MetricFilter") continue;
        filters += 1;
        const transformations = (resource.Properties?.MetricTransformations ?? []) as { Dimensions?: unknown }[];
        for (const transformation of transformations) {
          const dimensions = transformation.Dimensions;
          if (dimensions !== undefined && (!Array.isArray(dimensions) || dimensions.length === 0)) {
            empty.push(`${name}: ${id}`);
          }
        }
      }
    }
    expect(filters).toBeGreaterThan(0);
    expect(empty).toEqual([]);
  });
});

/*
 * D58 (27): a log group or KMS key a release adds is RetainExceptOnCreate, so a create that rolls
 * back leaves nothing behind that makes the retry fail ("already exists") or keeps costing. Those
 * below came before that rule and stay `Retain`: changing them now changes nothing for an
 * installation that has them. Tables, buckets and the user pool keep `Retain`: a table is born
 * with deletion protection and a rollback could not delete it (runbook: delete it by hand).
 */
const RETAINED_BEFORE_D58_27 = [
  "Core/LogsKey",
  "Core/NetworkFlowLogs",
  "Core/IdentityAuthEvents",
  "Core/IdentityConfigKey",
  "Core/IdentityPreSignUpLogs",
  "Core/IdentityPreTokenLogs",
  "Core/GovernanceDataKey",
  "Core/GovernanceAuditStreamLogs",
  "Core/ToolsConfigKey",
  "Core/ToolsCostExplorerLogs",
  "Core/ToolsAdminProbeLogs",
  "Core/ToolsInterceptorLogs",
  "Core/ToolsResponseInterceptorLogs",
  "Core/WriteToolsExecutorLogs",
  "Core/TasksChallengeLogs",
  "Core/FinOpsAgentRuntimeLogsKey",
  "Core/SkillsKey",
  "Core/ProvisionerFunctionLogs",
  "Core/ProvisionerStateMachineLogs",
  "Core/DeprovisionerFunctionLogs",
  "Core/DeprovisionerStateMachineLogs",
  "Core/AlertsKey",
  "Core/TaskReportsKey",
  "Core/TaskReportsFunctionLogs",
  "Core/KnowledgeKey",
  "Core/KnowledgeSyncLogs",
  "Core/KnowledgeRetrieveLogs",
  "Core/KnowledgeSourcesLogs",
  "Core/ReconcilerFunctionLogs",
  "Core/AccountHealthFunctionLogs",
  "Core/BudgetReconcilerFunctionLogs",
  "Core/CostAnomalyEventsFunctionLogs",
  "Core/PackProvisionerFunctionLogs",
  "Core/PackProvisionerStateMachineLogs",
  "Core/UninstallGuardFunctionLogs",
  "Core/StackTaggerFunctionLogs",
  "Core/ApiLogs",
  "Core/RemoteMcp/RemoteMcpProvisionerFunctionLogs",
  "Core/RemoteMcp/RemoteMcpProvisionerStateMachineLogs",
  "PackNetwork/LogsKey",
  "PackNetwork/PackNetworkFlowLogs",
  "PackNetwork/PackNetworkDnsQueries",
];

describe("what a rolled-back create leaves behind (D58 (27))", () => {
  // The logical id without the hash CDK appends to it.
  const retained = [...templates].flatMap(([name, resources]) =>
    Object.entries(resources)
      .filter(([, r]) => ["AWS::Logs::LogGroup", "AWS::KMS::Key"].includes(r.Type) && r.DeletionPolicy === "Retain")
      .map(([id]) => `${name}/${id.replace(/[0-9A-F]{8}$/, "")}`),
  );

  it("retains a new log group or key except when the operation that created it rolls back", () => {
    expect([...new Set(retained)].filter((id) => !RETAINED_BEFORE_D58_27.includes(id))).toEqual([]);
  });

  it("keeps the trace reader's log group and the key of the evals log groups among the new ones", () => {
    const policy = (stack: string, prefix: string) =>
      Object.entries(templates.get(stack)!).find(([id]) => id.startsWith(prefix))![1].DeletionPolicy;
    expect(policy("Core/Traces", "TraceReaderFunctionLogs")).toBe("RetainExceptOnCreate");
    expect(policy("Core/EvalJudge", "EvalJudgeFunctionLogs")).toBe("RetainExceptOnCreate");
    expect(policy("Core", "EvalsCaptureLogsKey")).toBe("RetainExceptOnCreate");
  });

  it("keeps the tables of this release Retain, with deletion protection", () => {
    for (const prefix of ["Evals", "Tickets"]) {
      const [, table] = Object.entries(templates.get("Core")!).find(
        ([id, r]) => r.Type === "AWS::DynamoDB::GlobalTable" && new RegExp(`^${prefix}[0-9A-F]{8}$`).test(id),
      )!;
      expect(table.DeletionPolicy).toBe("Retain");
      expect((table.Properties!.Replicas as { DeletionProtectionEnabled: boolean }[])[0]!.DeletionProtectionEnabled).toBe(true);
    }
  });
});
