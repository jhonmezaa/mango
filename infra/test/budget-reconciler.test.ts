import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CHECKOV_EXCEPTIONS } from "../lib/checkov.js";
import { loadInstallation } from "../lib/config/schema.js";
import {
  BUDGET_RECONCILER_KEYS,
  BUDGET_RECONCILER_METRICS,
  SPANS_LOG_GROUP,
} from "../lib/constructs/budget-reconciler.js";
import { CoreStack } from "../lib/stacks/core-stack.js";

const cfg = loadInstallation(resolve(import.meta.dirname, "../config/example.json"));
const ns = cfg.namespace;
const account = cfg.mangoAccountId;
const region = cfg.region;

type Resource = { Type: string; Properties: any; [k: string]: any };
const template = Template.fromStack(
  new CoreStack(new App({ context: { skipSpa: true } }), "Core", {
    installation: cfg,
    env: { account, region },
  }),
);
const resources = template.toJSON().Resources as Record<string, Resource>;
const ofType = (type: string) => Object.entries(resources).filter(([, r]) => r.Type === type);

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
const actions = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);

const name = `Mango-${ns}-BudgetReconciler`;
const roleId = logicalId("AWS::IAM::Role", { RoleName: name });
const functionId = logicalId("AWS::Lambda::Function", { FunctionName: name });
const queueId = logicalId("AWS::SQS::Queue", { QueueName: `${name}-dlq` });
const ruleId = logicalId("AWS::Events::Rule", { Name: `${name}-schedule` });
const topicId = logicalId("AWS::SNS::Topic", { TopicName: `Mango-${ns}-Alerts` });
const budgetsId = logicalId("AWS::DynamoDB::GlobalTable", { TableName: `Mango-${ns}-Budgets` });
const auditIndexId = logicalId("AWS::DynamoDB::GlobalTable", { TableName: `Mango-${ns}-AuditIndex` });
const streamId = logicalId("AWS::KinesisFirehose::DeliveryStream", { DeliveryStreamName: `Mango-${ns}-Audit` });
const alertsKeyId = resources[queueId]!.Properties.KmsMasterKeyId["Fn::GetAtt"][0] as string;

const statements = Object.values(resources)
  .filter((r) => r.Type === "AWS::IAM::Policy" && r.Properties.Roles.some((x: { Ref: string }) => x.Ref === roleId))
  .flatMap((r) => r.Properties.PolicyDocument.Statement as Statement[]);
const bySid = (sid: string): Statement => {
  const found = statements.filter((s) => s.Sid === sid);
  expect(found, sid).toHaveLength(1);
  return found[0]!;
};
const granted = [...new Set(statements.flatMap(actions))].sort();
const budgetsArn = { "Fn::GetAtt": [budgetsId, "Arn"] };
const keys = (s: Statement) => s.Condition?.["ForAllValues:StringLike"]?.["dynamodb:LeadingKeys"];

const python = (path: string) => readFileSync(resolve(import.meta.dirname, "../..", path), "utf8");

describe("budget reconciler role (D73, TM-BR6, TM-BR7)", () => {
  it("has exactly these actions", () => {
    expect(granted).toEqual([
      "dynamodb:DeleteItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
      "firehose:PutRecord",
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "logs:CreateLogStream",
      "logs:FilterLogEvents",
      "logs:PutLogEvents",
      "sqs:SendMessage",
      "xray:PutTelemetryRecords",
      "xray:PutTraceSegments",
    ]);
    expect(statements.every((s) => s.Effect === "Allow")).toBe(true);
    expect(granted.some((a) => a.endsWith("*"))).toBe(false);
  });

  it("never scans, reads whole tables, invokes a model or reaches a conversation", () => {
    const forbidden = /Scan|BatchWrite|BatchGet|GetItem|Invoke|bedrock|PassRole|AssumeRole|StartQuery|GetQueryResults|GetLogEvents|PutMetricData/;
    expect(granted.filter((a) => forbidden.test(a))).toEqual([]);
    const tables = statements
      .filter((s) => actions(s).some((a) => a.startsWith("dynamodb:")))
      .flatMap((s) => list(s.Resource));
    // Only the budgets and the audit index: no conversations, agents, settings or sessions.
    expect([...new Set(tables.map((t) => JSON.stringify(t)))].sort()).toEqual(
      [budgetsArn, { "Fn::GetAtt": [auditIndexId, "Arn"] }].map((t) => JSON.stringify(t)).sort(),
    );
  });

  it("reads the traces with one action on one log group", () => {
    const read = bySid("ReadAgentTraces");
    expect(actions(read)).toEqual(["logs:FilterLogEvents"]);
    expect(SPANS_LOG_GROUP).toBe("aws/spans");
    expect(read.Resource).toEqual({
      "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, `:logs:${region}:${account}:log-group:aws/spans:*`]],
    });
    // Nothing else of CloudWatch Logs but writing its own log group.
    const logs = statements.filter((s) => s !== read && actions(s).some((a) => a.startsWith("logs:")));
    expect(logs.flatMap(actions).sort()).toEqual(["logs:CreateLogStream", "logs:PutLogEvents"]);
    for (const own of logs) expect(JSON.stringify(own.Resource)).not.toContain("aws/spans");
    expect(python("functions/budget-reconciler/src/mango_budget_reconciler/config.py")).toContain(
      `SPANS_LOG_GROUP = "${SPANS_LOG_GROUP}"`,
    );
  });

  it("finds pending turns with a query on their partitions, and nothing else", () => {
    const find = bySid("FindPendingTurns");
    expect(actions(find)).toEqual(["dynamodb:Query"]);
    expect(find.Resource).toEqual(budgetsArn);
    expect(keys(find)).toEqual(["TURN#*"]);
  });

  it("writes the budgets by key: the pending turns and the counters they name", () => {
    const close = bySid("ClosePendingTurns");
    expect(actions(close).sort()).toEqual(["dynamodb:DeleteItem", "dynamodb:UpdateItem"]);
    expect(keys(close)).toEqual([BUDGET_RECONCILER_KEYS.turns]);
    const settle = bySid("SettleBudgets");
    expect(actions(settle)).toEqual(["dynamodb:UpdateItem"]);
    expect(keys(settle)).toEqual(["USER#*", "AGENT#*"]);
    for (const statement of [close, settle]) expect(statement.Resource).toEqual(budgetsArn);
    // Every statement on the Budgets table is limited to those keys.
    for (const statement of statements.filter((s) => JSON.stringify(s.Resource).includes(budgetsId))) {
      expect(keys(statement), statement.Sid).toBeDefined();
    }
  });

  it("uses the key prefixes the code writes", () => {
    const core = python("packages/py/mango-core/src/mango_core/budget_turns.py");
    expect(core).toContain('TURN_PREFIX: Final = "TURN#"');
    expect(BUDGET_RECONCILER_KEYS.turns).toBe("TURN#*");
    const api = python("apps/api/src/mango_api/app.py");
    expect(api).toContain('BudgetScope(f"USER#{user.user_id}"');
    expect(api).toContain('BudgetScope(f"AGENT#{agent_id}"');
  });

  it("writes audit the way mango-api does: the stream and the index, nothing else of them", () => {
    expect(bySid("WriteAuditTrail")).toMatchObject({
      Action: "firehose:PutRecord",
      Resource: { "Fn::GetAtt": [streamId, "Arn"] },
    });
    expect(bySid("WriteAuditIndex")).toMatchObject({
      Action: "dynamodb:PutItem",
      Resource: { "Fn::GetAtt": [auditIndexId, "Arn"] },
    });
  });

  it('uses Resource "*" only for X-Ray', () => {
    const wildcard = statements.filter((s) => list(s.Resource).includes("*"));
    expect(wildcard.flatMap(actions).sort()).toEqual(["xray:PutTelemetryRecords", "xray:PutTraceSegments"]);
  });

  it("uses the data key only through DynamoDB and the alerts key only through SQS", () => {
    const data = bySid("DataKeyViaDynamoDB");
    expect(actions(data).sort()).toEqual(["kms:Decrypt", "kms:DescribeKey", "kms:Encrypt", "kms:GenerateDataKey"]);
    expect(data.Condition).toEqual({ StringEquals: { "kms:ViaService": `dynamodb.${region}.amazonaws.com` } });
    const dlq = bySid("DeadLetterQueueKey");
    expect(actions(dlq).sort()).toEqual(["kms:Decrypt", "kms:GenerateDataKey"]);
    expect(dlq.Resource).toEqual({ "Fn::GetAtt": [alertsKeyId, "Arn"] });
    expect(dlq.Condition).toEqual({ StringEquals: { "kms:ViaService": `sqs.${region}.amazonaws.com` } });
  });

  it("is trusted only by Lambda and has no managed policies", () => {
    const role = resources[roleId]!.Properties;
    expect(role.AssumeRolePolicyDocument.Statement).toEqual([
      { Action: "sts:AssumeRole", Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" } },
    ]);
    expect(role.ManagedPolicyArns).toBeUndefined();
  });
});

describe("budget reconciler function and schedule", () => {
  const fn = resources[functionId]!;

  it("gets only names of the installation, encrypted", () => {
    expect(fn.Properties.Environment.Variables).toEqual({
      MANGO_NAMESPACE: ns,
      BUDGETS_TABLE: { Ref: budgetsId },
      AUDIT_STREAM: { Ref: streamId },
      AUDIT_INDEX_TABLE: { Ref: auditIndexId },
    });
    expect(fn.Properties.KmsKeyArn).toBeDefined();
    expect(fn.Properties.Role).toEqual({ "Fn::GetAtt": [roleId, "Arn"] });
    expect(fn.Properties.Handler).toBe("mango_budget_reconciler.handler.lambda_handler");
  });

  it("is asynchronous, so it has a dead-letter queue and keeps the Checkov DLQ check", () => {
    expect(fn.Properties.DeadLetterConfig).toEqual({ TargetArn: { "Fn::GetAtt": [queueId, "Arn"] } });
    const skipped = (fn.Metadata?.checkov?.skip ?? []).map((s: { id: string }) => s.id);
    expect(skipped).not.toContain(CHECKOV_EXCEPTIONS.lambdaDlq.id);
    const queue = resources[queueId]!.Properties;
    expect(resources[alertsKeyId]!.Type).toBe("AWS::KMS::Key");
    expect(queue.MessageRetentionPeriod).toBe(14 * 24 * 3600);
    const policies = ofType("AWS::SQS::QueuePolicy")
      .map(([, r]) => r.Properties)
      .filter((p) => JSON.stringify(p.Queues) === JSON.stringify([{ Ref: queueId }]));
    expect(policies).toHaveLength(1);
    expect(policies[0].PolicyDocument.Statement).toEqual([
      expect.objectContaining({ Effect: "Deny", Condition: { Bool: { "aws:SecureTransport": "false" } } }),
    ]);
  });

  it("runs every 5 minutes, for less than that, from a rule that only targets the function", () => {
    const rule = resources[ruleId]!.Properties;
    expect(rule.ScheduleExpression).toBe("rate(5 minutes)");
    expect(rule.State).toBe("ENABLED");
    expect(rule.Targets).toHaveLength(1);
    expect(rule.Targets[0].Arn).toEqual({ "Fn::GetAtt": [functionId, "Arn"] });
    expect(rule.Targets[0].Input).toBeUndefined();
    expect(fn.Properties.Timeout).toBeLessThan(300);
    const permissions = ofType("AWS::Lambda::Permission").filter(
      ([, r]) => JSON.stringify(r.Properties.FunctionName) === JSON.stringify({ "Fn::GetAtt": [functionId, "Arn"] }),
    );
    expect(permissions.map(([, r]) => r.Properties)).toEqual([
      {
        Action: "lambda:InvokeFunction",
        FunctionName: { "Fn::GetAtt": [functionId, "Arn"] },
        Principal: "events.amazonaws.com",
        SourceArn: { "Fn::GetAtt": [ruleId, "Arn"] },
      },
    ]);
  });

  it("leaves the daily reconciler read-only (D41)", () => {
    const dailyRole = logicalId("AWS::IAM::Role", { RoleName: `Mango-${ns}-Reconciler` });
    const daily = Object.values(resources)
      .filter((r) => r.Type === "AWS::IAM::Policy" && r.Properties.Roles.some((x: { Ref: string }) => x.Ref === dailyRole))
      .flatMap((r) => r.Properties.PolicyDocument.Statement as Statement[]);
    expect(JSON.stringify(daily)).not.toContain(budgetsId);
    expect(daily.flatMap(actions).filter((a) => /^dynamodb:/.test(a))).toEqual(["dynamodb:Scan"]);
  });
});

describe("budget reconciler alarms", () => {
  const alarm = (suffix: string) => {
    const found = ofType("AWS::CloudWatch::Alarm").filter(([, r]) => r.Properties.AlarmName === `${name}-${suffix}`);
    expect(found, suffix).toHaveLength(1);
    return found[0]![1].Properties;
  };

  it("alarms when a turn is charged its whole reservation, from a metric the function emits", () => {
    const properties = alarm("reservation-charged");
    expect(properties).toMatchObject({
      Namespace: BUDGET_RECONCILER_METRICS.namespace,
      MetricName: "ChargedByReservation",
      Dimensions: [{ Name: BUDGET_RECONCILER_METRICS.dimension, Value: ns }],
      Statistic: "Sum",
      Period: 300,
      Threshold: 1,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      EvaluationPeriods: 1,
      TreatMissingData: "notBreaching",
      AlarmActions: [{ Ref: topicId }],
    });
    // Embedded metric format: no metric filter and no PutMetricData. The one filter of the
    // stack reads the log of mango-api (D71 (18)).
    expect(ofType("AWS::Logs::MetricFilter").map(([, r]) => r.Properties.MetricTransformations[0].MetricName)).toEqual([
      "RateLimitStoreRefusals",
    ]);
    const handler = python("functions/budget-reconciler/src/mango_budget_reconciler/handler.py");
    expect(handler).toContain(`METRIC_NAMESPACE = "${BUDGET_RECONCILER_METRICS.namespace}"`);
    expect(handler).toContain(`METRIC_DIMENSION = "${BUDGET_RECONCILER_METRICS.dimension}"`);
    expect(handler).toContain('stats["ChargedByReservation"]');
  });

  it("alarms when a run ends in the dead-letter queue", () => {
    const properties = alarm("failed");
    expect(properties).toMatchObject({
      Namespace: "AWS/SQS",
      MetricName: "ApproximateNumberOfMessagesVisible",
      Dimensions: [{ Name: "QueueName", Value: { "Fn::GetAtt": [queueId, "QueueName"] } }],
      Threshold: 1,
      TreatMissingData: "notBreaching",
      AlarmActions: [{ Ref: topicId }],
    });
  });
});
