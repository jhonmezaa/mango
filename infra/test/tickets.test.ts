import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { loadInstallation } from "../lib/config/schema.js";
import { TICKETS_BY_ASSIGNEE, TICKETS_BY_CREATOR, TICKETS_BY_UPDATED } from "../lib/constructs/tickets.js";
import { CoreStack } from "../lib/stacks/core-stack.js";

// Tickets of Mango (D112, tickets-threat-model.md): a table with production data, read and
// written by mango-api only.

const cfg = loadInstallation(resolve(import.meta.dirname, "../config/example.json"));
const ns = cfg.namespace;
const template = Template.fromStack(
  new CoreStack(new App({ context: { skipSpa: true } }), "Core", {
    installation: cfg,
    env: { account: cfg.mangoAccountId, region: cfg.region },
  }),
);
type Resource = { Type: string; Properties: any; DeletionPolicy?: string }; // eslint-disable-line @typescript-eslint/no-explicit-any
const resources = template.toJSON().Resources as Record<string, Resource>;
const [tableId, table] = Object.entries(resources).find(
  ([, r]) => r.Type === "AWS::DynamoDB::GlobalTable" && r.Properties.TableName === `Mango-${ns}-Tickets`,
)!;
const python = readFileSync(resolve(import.meta.dirname, "../../packages/py/mango-core/src/mango_core/tickets.py"), "utf8");

describe("the Tickets table (D112)", () => {
  it("keeps production data like every table with data", () => {
    const replica = table.Properties.Replicas[0];
    expect(replica.PointInTimeRecoverySpecification).toEqual({ PointInTimeRecoveryEnabled: true });
    expect(replica.DeletionProtectionEnabled).toBe(cfg.retainData);
    expect(table.DeletionPolicy).toBe(cfg.retainData ? "Retain" : "Delete");
    expect(table.Properties.SSESpecification.SSEType).toBe("KMS");
    expect(replica.SSESpecification.KMSMasterKeyId).toBeDefined();
    expect(table.Properties.TimeToLiveSpecification).toBeUndefined();
  });

  it("has the indexes mango_core.tickets reads, sorted by the last change", () => {
    const indexes = table.Properties.GlobalSecondaryIndexes as { IndexName: string; KeySchema: { AttributeName: string }[] }[];
    expect(indexes.map((i) => i.IndexName).sort()).toEqual([TICKETS_BY_ASSIGNEE, TICKETS_BY_CREATOR, TICKETS_BY_UPDATED].sort());
    for (const index of indexes) {
      expect(index.KeySchema[1]!.AttributeName).toBe("updated_at");
      expect(python).toContain(`"${index.IndexName}"`);
    }
  });

  it("is read and written by mango-api without Scan nor DeleteItem", () => {
    const policy = Object.values(resources).find(
      (r) => r.Type === "AWS::IAM::ManagedPolicy" && r.Properties.ManagedPolicyName === `Mango-${ns}-ApiTickets`,
    )!;
    const statements = policy.Properties.PolicyDocument.Statement as { Sid: string; Action: string[]; Resource: unknown; Condition?: unknown }[];
    const onTable = statements.find((s) => s.Sid === "TicketsTable")!;
    expect(onTable.Action.sort()).toEqual(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem"]);
    expect(JSON.stringify(onTable.Resource)).toContain(tableId);
    expect(JSON.stringify(onTable.Resource)).not.toContain('"*"');
    const key = statements.find((s) => s.Sid === "TicketsTableKey")!;
    expect(key.Condition).toBeDefined();
    // Nothing else of the stack is granted on the table but the tickets tool (below).
    const others = Object.values(resources).filter(
      (r) =>
        (r.Type === "AWS::IAM::Policy" || r.Type === "AWS::IAM::ManagedPolicy") &&
        r !== policy &&
        JSON.stringify(r.Properties.PolicyDocument).includes(tableId),
    );
    expect(others.map((r) => JSON.stringify(r.Properties.Roles))).toEqual([expect.stringContaining("ExecutorRole")]);
  });

  it("is named for mango-api", () => {
    const api = Object.values(resources).find((r) => r.Type === "AWS::ECS::TaskDefinition")!;
    const env = api.Properties.ContainerDefinitions[0].Environment as { Name: string; Value: unknown }[];
    expect(JSON.stringify(env.find((e) => e.Name === "TICKETS_TABLE")!.Value)).toContain(tableId);
  });
});

describe("the tickets tool in the target ops (D112 (8), (9))", () => {
  const target = Object.values(resources).find(
    (r) => r.Type === "AWS::BedrockAgentCore::GatewayTarget" && r.Properties.Name === "ops",
  )!;
  const executorRoleId = Object.keys(resources).find(
    (id) => resources[id]!.Type === "AWS::IAM::Role" && resources[id]!.Properties.RoleName === `Mango-${ns}-ApprovalExecutor`,
  );

  it("is served by the approval executor next to the approved writes", () => {
    const tools = target.Properties.TargetConfiguration.Mcp.Lambda.ToolSchema.InlinePayload as { Name: string }[];
    expect(tools.map((t) => t.Name).sort()).toEqual(["comment_ticket", "create_budget", "create_ticket", "update_ticket"]);
  });

  it("needs an approval token at the Gateway, like every write", () => {
    const interceptor = Object.values(resources).find(
      (r) => r.Type === "AWS::Lambda::Function" && r.Properties.Environment?.Variables?.APPROVAL_TOOLS,
    )!;
    const approvalTools = JSON.parse(interceptor.Properties.Environment.Variables.APPROVAL_TOOLS as string) as string[];
    expect(approvalTools).toEqual(expect.arrayContaining(["ops___create_ticket", "ops___update_ticket", "ops___comment_ticket"]));
  });

  it("may be asked for by any signed-in person, and only those three tools", () => {
    const policy = Object.values(resources).find(
      (r) => r.Type === "AWS::BedrockAgentCore::Policy" && r.Properties.Name === `Mango_${ns}_WriteMangoRecords`,
    )!;
    // The Gateway's ARN is joined in: read the statement as text.
    const statement = JSON.stringify(policy.Properties.Definition.Cedar.Statement);
    expect(statement).toContain("permit (");
    expect(statement).not.toContain("forbid");
    expect(statement).not.toContain("when");
    for (const tool of ["create_ticket", "update_ticket", "comment_ticket"]) expect(statement).toContain(`ops___${tool}`);
    expect(statement).not.toContain("create_budget");
  });

  it("lets the executor write the Tickets table only, without Query nor Scan", () => {
    expect(executorRoleId).toBeDefined();
    const statements = Object.values(resources)
      .filter((r) => r.Type === "AWS::IAM::Policy" && JSON.stringify(r.Properties.Roles).includes(executorRoleId!))
      .flatMap((r) => r.Properties.PolicyDocument.Statement as { Sid?: string; Action: string | string[]; Resource: unknown }[]);
    const onTickets = statements.filter((s) => JSON.stringify(s.Resource).includes(tableId));
    expect(onTickets.map((s) => s.Sid)).toEqual(["TicketsTool"]);
    expect([onTickets[0]!.Action].flat().sort()).toEqual(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]);
    expect(JSON.stringify(onTickets[0]!.Resource)).not.toContain("index");
  });
});
