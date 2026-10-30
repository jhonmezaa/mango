import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import { loadInstallation } from "../lib/config/schema.js";
import { DATA_ACCESS_BUDGET_KEYS } from "../lib/constructs/governance.js";
import { CoreStack } from "../lib/stacks/core-stack.js";
import { fromCore } from "./nested.js";

// Inicio (D102, home-threat-model.md): a person's own day counters and budget are read with
// the row-level security role, narrowed by mango-api to that person's keys.

const cfg = loadInstallation(resolve(import.meta.dirname, "../config/example.json"));
const ns = cfg.namespace;
const template = fromCore(
  new CoreStack(new App({ context: { skipSpa: true } }), "Core", {
    installation: cfg,
    env: { account: cfg.mangoAccountId, region: cfg.region },
  }),
);

type Resource = { Type: string; Properties: any };
interface Statement {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource: unknown;
  Condition?: Record<string, Record<string, unknown>>;
}
const resources = template.toJSON().Resources as Record<string, Resource>;
function logicalId(type: string, props: Record<string, unknown>): string {
  const ids = Object.keys(template.findResources(type, { Properties: props }));
  expect(ids).toHaveLength(1);
  return ids[0]!;
}
const actions = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
const roleId = logicalId("AWS::IAM::Role", { RoleName: `Mango-${ns}-ConversationData` });
const budgetsId = logicalId("AWS::DynamoDB::GlobalTable", { TableName: `Mango-${ns}-Budgets` });
const statements = Object.values(resources)
  .filter((r) => r.Type === "AWS::IAM::Policy" && r.Properties.Roles.some((x: { Ref: string }) => x.Ref === roleId))
  .flatMap((r) => r.Properties.PolicyDocument.Statement as Statement[]);
const python = (path: string) => readFileSync(resolve(import.meta.dirname, "../..", path), "utf8");

describe("row-level security role and the Budgets table (D102, TM-H1)", () => {
  it("only reads a person's budget and day counters, by key", () => {
    const onBudgets = statements.filter((s) => JSON.stringify(s.Resource).includes(budgetsId));
    expect(onBudgets).toHaveLength(1);
    const own = onBudgets[0]!;
    expect(own.Sid).toBe("OwnBudgetRead");
    expect(actions(own).sort()).toEqual(["dynamodb:GetItem", "dynamodb:Query"]);
    expect(own.Resource).toEqual({ "Fn::GetAtt": [budgetsId, "Arn"] });
    expect(own.Condition).toEqual({
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["USER#*", "DAY#USER#*"] },
    });
  });

  it("narrows each session to the keys the code reads", () => {
    expect([...DATA_ACCESS_BUDGET_KEYS]).toEqual(["USER#*", "DAY#USER#*"]);
    const api = python("apps/api/src/mango_api/conversations.py");
    expect(api).toContain('"dynamodb:LeadingKeys": [f"USER#{user_id}", f"DAY#USER#{user_id}"]');
    expect(python("packages/py/mango-core/src/mango_core/usage_days.py")).toContain(
      'USER_PREFIX: Final = "DAY#USER#"',
    );
  });
});
