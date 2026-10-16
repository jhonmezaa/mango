import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CHECKOV_EXCEPTIONS } from "../lib/checkov.js";
import { loadInstallation } from "../lib/config/schema.js";
import {
  ACCOUNT_HEALTH_METRICS,
  ACCOUNT_HEALTH_PARTITION,
  SYSTEM_SOURCE_IDENTITY,
} from "../lib/constructs/account-health.js";
import { SESSION_TAG_KEYS } from "../lib/names.js";
import { CoreStack } from "../lib/stacks/core-stack.js";

const cfg = loadInstallation(resolve(import.meta.dirname, "../config/example.json"));
const ns = cfg.namespace;
const account = cfg.mangoAccountId;
const HEALTH_ROLE = `arn:aws:iam::${account}:role/Mango-${ns}-AccountHealth`;

type Resource = { Type: string; Properties: any; [k: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Statement {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource?: unknown;
  Principal?: unknown;
  Condition?: Record<string, Record<string, unknown>>;
}

const template = Template.fromStack(
  new CoreStack(new App({ context: { skipSpa: true } }), "Core", {
    installation: cfg,
    env: { account, region: cfg.region },
  }),
);
const resources = template.toJSON().Resources as Record<string, Resource>;
const listed = <T>(value: T | T[]): T[] => (Array.isArray(value) ? value : [value]);

function roleNamed(name: string): [string, Resource] {
  const found = Object.entries(resources).filter(
    ([, r]) => r.Type === "AWS::IAM::Role" && r.Properties.RoleName === `Mango-${ns}-${name}`,
  );
  expect(found).toHaveLength(1);
  return found[0]!;
}
const trustOf = (name: string) => roleNamed(name)[1].Properties.AssumeRolePolicyDocument.Statement as Statement[];
const policiesOf = (logicalId: string): Statement[] =>
  Object.values(resources)
    .filter((r) => r.Type === "AWS::IAM::Policy" && JSON.stringify(r.Properties.Roles).includes(logicalId))
    .flatMap((r) => r.Properties.PolicyDocument.Statement as Statement[]);
const callersOf = (s: Statement) => JSON.stringify(s.Condition?.ArnEquals?.["aws:PrincipalArn"] ?? null);

describe("daily account health (D84): its own role, as the system identity only", () => {
  it.each(["ReadBroker", "BillingBroker"])("the %s lets the health role in only as mango-health", (broker) => {
    const trust = trustOf(broker);
    const health = trust.filter((s) => callersOf(s).includes(HEALTH_ROLE));
    expect(health.map((s) => s.Sid).sort()).toEqual(["AccountHealthAsTheSystemIdentity", "AccountHealthSessionTags"]);
    const asSystem = health.find((s) => s.Sid === "AccountHealthAsTheSystemIdentity")!;
    expect(listed(asSystem.Action).sort()).toEqual(["sts:AssumeRole", "sts:SetSourceIdentity"]);
    expect(asSystem.Condition!.StringEquals!["sts:SourceIdentity"]).toBe(SYSTEM_SOURCE_IDENTITY);
    // Exactly that role: no other principal in these statements.
    expect(JSON.parse(callersOf(asSystem))).toBe(HEALTH_ROLE);
    const tags = health.find((s) => s.Sid === "AccountHealthSessionTags")!;
    expect(tags.Action).toBe("sts:TagSession");
    expect(tags.Condition!["ForAllValues:StringEquals"]!["aws:TagKeys"]).toEqual(SESSION_TAG_KEYS);
    if (broker === "ReadBroker") {
      // The Read broker's callers must belong to the organization; the health role too.
      for (const s of health) expect(s.Condition!.StringEquals!["aws:PrincipalOrgID"]).toBe(cfg.organizationId);
    }
  });

  it.each(["ReadBroker", "BillingBroker"])("no other caller of the %s may name the system identity", (broker) => {
    const others = trustOf(broker).filter((s) => !callersOf(s).includes(HEALTH_ROLE));
    const identity = others.filter((s) => listed(s.Action).some((a) => a !== "sts:TagSession"));
    expect(identity.map((s) => listed(s.Action)).flat().sort()).toEqual(["sts:AssumeRole", "sts:SetSourceIdentity"]);
    for (const s of identity) {
      expect(s.Condition!.StringNotEqualsIgnoreCase).toEqual({ "sts:SourceIdentity": SYSTEM_SOURCE_IDENTITY });
      expect(callersOf(s)).not.toContain("AccountHealth");
    }
    // A person's SourceIdentity stays mandatory for them.
    const assume = identity.find((s) => listed(s.Action).includes("sts:AssumeRole"))!;
    expect(assume.Condition!.Null).toEqual({ "sts:SourceIdentity": "false" });
  });

  it("the role can only use the two brokers and write its own item", () => {
    const [id] = roleNamed("AccountHealth");
    const statements = policiesOf(id);
    const actions = statements.flatMap((s) => listed(s.Action)).sort();
    expect(actions).toEqual(
      [
        "dynamodb:PutItem",
        "kms:Decrypt",
        "kms:Decrypt",
        "kms:Encrypt",
        "kms:GenerateDataKey",
        "kms:GenerateDataKey",
        // Its own log stream and traces (every function of the stack).
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "sqs:SendMessage",
        "sts:AssumeRole",
        "sts:SetSourceIdentity",
        "sts:TagSession",
        "xray:PutTelemetryRecords",
        "xray:PutTraceSegments",
      ].sort(),
    );
    // DynamoDB needs Decrypt with the table's key on a write too (seen in an installation).
    const dataKey = statements.find((s) => s.Sid === "DataKeyViaDynamoDB")!;
    expect(listed(dataKey.Action).sort()).toEqual(["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]);
    expect(JSON.stringify(dataKey.Condition)).toContain("dynamodb.");
    const brokers = statements.find((s) => s.Sid === "UseTheBrokersAsTheSystemIdentity")!;
    expect(JSON.stringify(brokers.Resource)).toContain(`Mango-${ns}-ReadBroker`);
    expect(JSON.stringify(brokers.Resource)).toContain(`Mango-${ns}-BillingBroker`);
    expect(listed(brokers.Resource)).toHaveLength(2);
    const write = statements.find((s) => s.Sid === "WriteTheAccountHealthItem")!;
    expect(write.Condition).toEqual({
      "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [ACCOUNT_HEALTH_PARTITION] },
    });
  });

  it("mango-api can read the item but never write it", () => {
    const [id] = roleNamed("ApiTask");
    const managed = Object.values(resources).filter(
      (r) => r.Type === "AWS::IAM::ManagedPolicy" && r.Properties.ManagedPolicyName === `Mango-${ns}-ApiAccountHealth`,
    );
    expect(managed).toHaveLength(1);
    expect(managed[0]!.Properties.Roles).toEqual([{ Ref: id }]);
    const statements = managed[0]!.Properties.PolicyDocument.Statement as Statement[];
    expect(statements).toHaveLength(1);
    const deny = statements[0]!;
    expect(deny.Sid).toBe("AccountHealthIsItsFunctionOnly");
    expect(deny.Effect).toBe("Deny");
    expect(listed(deny.Action).sort()).toEqual([
      "dynamodb:BatchWriteItem",
      "dynamodb:DeleteItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    ]);
    expect(deny.Condition).toEqual({
      "ForAnyValue:StringEquals": { "dynamodb:LeadingKeys": [ACCOUNT_HEALTH_PARTITION] },
    });
  });

  it("runs once a day with a dead-letter queue, and only the rule invokes it", () => {
    const fns = Object.entries(resources).filter(
      ([, r]) => r.Type === "AWS::Lambda::Function" && r.Properties.FunctionName === `Mango-${ns}-AccountHealth`,
    );
    expect(fns).toHaveLength(1);
    const [fnId, fn] = fns[0]!;
    expect(fn.Properties.Handler).toBe("mango_admin_probe.health.lambda_handler");
    expect(fn.Properties.DeadLetterConfig).toBeDefined();
    const skipped = (fn.Metadata?.checkov?.skip ?? []).map((s: { id: string }) => s.id);
    expect(skipped).not.toContain(CHECKOV_EXCEPTIONS.lambdaDlq.id);
    const env = fn.Properties.Environment.Variables;
    expect(env.MANGO_NAMESPACE).toBe(ns);
    expect(env.ORG_ACCESS_TARGETS).toBe(cfg.orgAccess!.targets.join(","));
    const rules = Object.values(resources).filter(
      (r) => r.Type === "AWS::Events::Rule" && r.Properties.Name === `Mango-${ns}-AccountHealth-daily`,
    );
    expect(rules).toHaveLength(1);
    expect(rules[0]!.Properties.ScheduleExpression).toBe("cron(30 6 * * ? *)");
    const permissions = Object.values(resources).filter(
      (r) => r.Type === "AWS::Lambda::Permission" && JSON.stringify(r.Properties.FunctionName).includes(fnId),
    );
    expect(permissions.map((p) => p.Properties.Principal)).toEqual(["events.amazonaws.com"]);
  });

  it("alarms on an account it cannot enter, a broker without identity and a failed run", () => {
    const alarms = Object.values(resources).filter((r) => r.Type === "AWS::CloudWatch::Alarm");
    const named = (name: string) => alarms.find((a) => a.Properties.AlarmName === `Mango-${ns}-${name}`)!;
    const invalid = named("AccountHealth-invalid");
    const metrics = JSON.stringify(invalid.Properties.Metrics);
    expect(metrics).toContain("InvalidAccounts");
    expect(metrics).toContain("IdentityNotRequired");
    expect(metrics).toContain(ACCOUNT_HEALTH_METRICS.namespace);
    expect(invalid.Properties.TreatMissingData).toBe("ignore");
    expect(named("AccountHealth-failed").Properties.TreatMissingData).toBe("notBreaching");
    for (const alarm of [invalid, named("AccountHealth-failed")]) {
      expect(JSON.stringify(alarm.Properties.AlarmActions)).toContain("Alerts");
    }
  });
});
