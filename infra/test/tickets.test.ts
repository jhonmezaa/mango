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
    // Nothing else of the stack is granted on the table.
    const others = Object.values(resources).filter(
      (r) =>
        (r.Type === "AWS::IAM::Policy" || r.Type === "AWS::IAM::ManagedPolicy") &&
        r !== policy &&
        JSON.stringify(r.Properties.PolicyDocument).includes(tableId),
    );
    expect(others).toEqual([]);
  });

  it("is named for mango-api", () => {
    const api = Object.values(resources).find((r) => r.Type === "AWS::ECS::TaskDefinition")!;
    const env = api.Properties.ContainerDefinitions[0].Environment as { Name: string; Value: unknown }[];
    expect(JSON.stringify(env.find((e) => e.Name === "TICKETS_TABLE")!.Value)).toContain(tableId);
  });
});
