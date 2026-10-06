import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CHECKOV_EXCEPTIONS } from "../lib/checkov.js";
import { installationSchema, loadInstallation } from "../lib/config/schema.js";
import {
  PROVISIONER_EXECUTIONS_PER_HOUR,
  RECONCILER_METRICS,
  RECONCILER_READABLE_ATTRIBUTES,
} from "../lib/constructs/reconciler.js";
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
  Principal?: unknown;
  Condition?: Record<string, Record<string, unknown>>;
}

function logicalId(type: string, props: Record<string, unknown>): string {
  const ids = Object.keys(template.findResources(type, { Properties: props }));
  expect(ids).toHaveLength(1);
  return ids[0]!;
}
const actions = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);

const roleId = logicalId("AWS::IAM::Role", { RoleName: `Mango-${ns}-Reconciler` });
const functionId = logicalId("AWS::Lambda::Function", { FunctionName: `Mango-${ns}-Reconciler` });
const queueId = logicalId("AWS::SQS::Queue", { QueueName: `Mango-${ns}-Reconciler-dlq` });
const topicId = logicalId("AWS::SNS::Topic", { TopicName: `Mango-${ns}-Alerts` });
const ruleId = logicalId("AWS::Events::Rule", { Name: `Mango-${ns}-Reconciler-daily` });
const agentsId = logicalId("AWS::DynamoDB::GlobalTable", { TableName: `Mango-${ns}-Agents` });
const machineId = logicalId("AWS::StepFunctions::StateMachine", { StateMachineName: `Mango-${ns}-AgentProvisioner` });
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

const agentcore = `arn:aws:bedrock-agentcore:${region}:${account}`;
const harnesses = `${agentcore}:harness/Mango_${ns}_a_*`;
const runtimes = `${agentcore}:runtime/harness_Mango_${ns}_a_*`;
const packRuntimes = `${agentcore}:runtime/Mango_${ns}_mcp_*`;

const python = (file: string) =>
  readFileSync(resolve(import.meta.dirname, "../../functions/reconciler/src/mango_reconciler", file), "utf8");

describe("reconciler role: read-only (plan A11, TM-M6)", () => {
  it("has exactly these actions", () => {
    expect(granted).toEqual([
      "bedrock-agentcore:GetAgentRuntime",
      "bedrock-agentcore:GetAgentRuntimeEndpoint",
      "bedrock-agentcore:GetHarness",
      "bedrock-agentcore:GetHarnessEndpoint",
      "bedrock-agentcore:ListAgentRuntimes",
      "bedrock-agentcore:ListHarnesses",
      "dynamodb:Scan",
      "iam:GetRole",
      "iam:ListAttachedRolePolicies",
      "iam:ListRolePolicies",
      "iam:ListRoles",
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:GenerateDataKey",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "sqs:SendMessage",
      "xray:PutTelemetryRecords",
      "xray:PutTraceSegments",
    ]);
    expect(statements.every((s) => s.Effect === "Allow")).toBe(true);
  });

  it("only reads AgentCore, IAM and the Agents table", () => {
    for (const action of granted.filter((a) => /^(bedrock-agentcore|iam|dynamodb):/.test(a))) {
      expect(action).toMatch(/:(Get|List|Scan)/);
    }
    expect(granted.some((a) => a.endsWith("*"))).toBe(false);
    expect(granted.filter((a) => /Invoke|PassRole|AssumeRole|PutMetricData|GetRolePolicy/.test(a))).toEqual([]);
  });

  it("reads harnesses, runtimes and roles only under this installation's agent names", () => {
    expect(bySid("ReadAgentHarnesses").Resource).toEqual([harnesses, `${harnesses}/harness-endpoint/*`]);
    expect(bySid("ReadHarnessRuntimes").Resource).toEqual([runtimes, `${runtimes}/runtime-endpoint/*`]);
    expect(bySid("ReadAgentRoles").Resource).toBe(`arn:aws:iam::${account}:role/Mango-${ns}-agent-*`);
  });

  it("reads the network of pack runtimes, and nothing else of them (TM-E7)", () => {
    const read = bySid("ReadPackRuntimeNetwork");
    expect(actions(read).sort()).toEqual([
      "bedrock-agentcore:GetAgentRuntime",
      "bedrock-agentcore:GetAgentRuntimeEndpoint",
    ]);
    expect(read.Resource).toEqual([packRuntimes, `${packRuntimes}/runtime-endpoint/*`]);
    expect(read.Condition).toBeUndefined();
    // Every runtime it can read is an agent harness or a pack of this installation.
    const reachable = statements
      .filter((s) => actions(s).some((a) => /^bedrock-agentcore:Get/.test(a)))
      .flatMap((s) => list(s.Resource) as string[]);
    for (const resource of reachable) {
      expect(resource).toMatch(new RegExp(`:(harness/Mango_${ns}_a_|runtime/(harness_Mango_${ns}_a_|Mango_${ns}_mcp_))\\*`));
    }
  });

  it("reports pack runtimes through the same finding count the alarm reads", () => {
    const checks = python("checks.py");
    expect(checks).toContain('"pack_runtime_not_in_vpc"');
    expect(python("config.py")).toContain(`return f"Mango_{self.namespace}_mcp_"`);
  });

  it('uses Resource "*" only where the API has no resource scope', () => {
    const wildcard = statements.filter((s) => list(s.Resource).includes("*"));
    expect(wildcard.flatMap(actions).sort()).toEqual([
      "bedrock-agentcore:ListAgentRuntimes",
      "bedrock-agentcore:ListHarnesses",
      "iam:ListRoles",
      "xray:PutTelemetryRecords",
      "xray:PutTraceSegments",
    ]);
  });

  it("scans the Agents table without ever reading a definition", () => {
    const scan = bySid("ReadAgentRecordsWithoutContent");
    expect(actions(scan)).toEqual(["dynamodb:Scan"]);
    expect(scan.Resource).toEqual({ "Fn::GetAtt": [agentsId, "Arn"] });
    expect(scan.Condition).toEqual({
      "ForAllValues:StringEquals": { "dynamodb:Attributes": RECONCILER_READABLE_ATTRIBUTES },
      StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
    });
    for (const content of ["definition", "approved_by", "created_by_email", "rejection_reason", "editors"]) {
      expect(RECONCILER_READABLE_ATTRIBUTES).not.toContain(content);
    }
    // No other statement reaches the table or its indexes.
    const others = statements.filter((s) => s !== scan && JSON.stringify(s.Resource).includes(agentsId));
    expect(others).toEqual([]);
  });

  it("allows exactly the attributes the function projects", () => {
    const block = /SCAN_ATTRIBUTES = \(([^)]*)\)/.exec(python("snapshot.py"))![1]!;
    const projected = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(projected.length).toBeGreaterThan(5);
    expect([...RECONCILER_READABLE_ATTRIBUTES].sort()).toEqual([...projected].sort());
  });

  it("uses the data key only through DynamoDB and the alerts key only through SQS", () => {
    const data = bySid("DataKeyViaDynamoDB");
    expect(actions(data).sort()).toEqual(["kms:Decrypt", "kms:DescribeKey"]);
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

describe("reconciler function and schedule", () => {
  const fn = resources[functionId]!;

  it("gets only identifiers of the installation, encrypted", () => {
    expect(Object.keys(fn.Properties.Environment.Variables).sort()).toEqual([
      "AGENTS_TABLE",
      "AGENT_BOUNDARY_ARN",
      "MANGO_ACCOUNT_ID",
      "MANGO_NAMESPACE",
      "RELEASE_AGENTS",
    ]);
    // Ids and hashes of the agents the release ships: the same the provisioner gets (D42).
    const shipped = JSON.parse(fn.Properties.Environment.Variables.RELEASE_AGENTS as string) as Record<string, string>;
    expect(Object.keys(shipped)).toEqual(["finops"]);
    expect(shipped.finops).toMatch(/^[0-9a-f]{64}$/);
    const provisioner = Object.values(resources).find(
      (r) => r.Type === "AWS::Lambda::Function" && r.Properties.FunctionName === `Mango-${ns}-Provisioner`,
    );
    expect(provisioner!.Properties.Environment.Variables.RELEASE_AGENTS).toBe(
      fn.Properties.Environment.Variables.RELEASE_AGENTS,
    );
    expect(fn.Properties.KmsKeyArn).toBeDefined();
    expect(fn.Properties.Role).toEqual({ "Fn::GetAtt": [roleId, "Arn"] });
    expect(fn.Properties.Handler).toBe("mango_reconciler.handler.lambda_handler");
  });

  it("is asynchronous, so it has a dead-letter queue and keeps the Checkov DLQ check", () => {
    expect(fn.Properties.DeadLetterConfig).toEqual({ TargetArn: { "Fn::GetAtt": [queueId, "Arn"] } });
    const skipped = (fn.Metadata?.checkov?.skip ?? []).map((s: { id: string }) => s.id);
    expect(skipped).not.toContain(CHECKOV_EXCEPTIONS.lambdaDlq.id);
    // The uninstall guard invokes itself asynchronously to keep waiting: it has its own queue.
    const guards = ofType("AWS::Lambda::Function").filter(([id]) => id.startsWith("UninstallGuard"));
    expect(guards).toHaveLength(1);
    expect(guards[0]![1].Properties.DeadLetterConfig).toBeDefined();
    expect((guards[0]![1].Metadata?.checkov?.skip ?? []).map((s: { id: string }) => s.id)).not.toContain(
      CHECKOV_EXCEPTIONS.lambdaDlq.id,
    );
    // So is the budget reconciler (D73); details in budget-reconciler.test.ts.
    const budgetReconcilerId = logicalId("AWS::Lambda::Function", { FunctionName: `Mango-${ns}-BudgetReconciler` });
    expect(resources[budgetReconcilerId]!.Properties.DeadLetterConfig).toBeDefined();
    // Every other function is invoked synchronously and keeps the agreed exception.
    for (const [id, other] of ofType("AWS::Lambda::Function")) {
      if (id === functionId || id === budgetReconcilerId || id.startsWith("UninstallGuard")) continue;
      expect(other.Properties.DeadLetterConfig).toBeUndefined();
      expect((other.Metadata?.checkov?.skip ?? []).map((s: { id: string }) => s.id)).toContain(
        CHECKOV_EXCEPTIONS.lambdaDlq.id,
      );
    }
  });

  it("encrypts the dead-letter queue with a customer-managed key and requires TLS", () => {
    const queue = resources[queueId]!.Properties;
    expect(resources[alertsKeyId]!.Type).toBe("AWS::KMS::Key");
    expect(queue.MessageRetentionPeriod).toBe(14 * 24 * 3600);
    const [policy] = ofType("AWS::SQS::QueuePolicy")
      .map(([, r]) => r.Properties)
      .filter((p) => JSON.stringify(p.Queues) === JSON.stringify([{ Ref: queueId }]));
    expect(policy.Queues).toEqual([{ Ref: queueId }]);
    expect(policy.PolicyDocument.Statement).toEqual([
      expect.objectContaining({ Effect: "Deny", Condition: { Bool: { "aws:SecureTransport": "false" } } }),
    ]);
  });

  it("runs once a day from an EventBridge rule that only targets the function", () => {
    const rule = resources[ruleId]!.Properties;
    expect(rule.ScheduleExpression).toBe("cron(0 7 * * ? *)");
    expect(rule.State).toBe("ENABLED");
    expect(rule.Targets).toHaveLength(1);
    expect(rule.Targets[0].Arn).toEqual({ "Fn::GetAtt": [functionId, "Arn"] });
    expect(rule.Targets[0].Input).toBeUndefined();
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

  it("emits the metrics the alarm reads", () => {
    const handler = python("handler.py");
    expect(handler).toContain(`METRIC_NAMESPACE = "${RECONCILER_METRICS.namespace}"`);
    expect(handler).toContain(`METRIC_DIMENSION = "${RECONCILER_METRICS.dimension}"`);
    expect(handler).toContain('"Findings": report.alarming');
  });
});

describe("alarms and the alerts topic", () => {
  const alarms = Object.fromEntries(
    ofType("AWS::CloudWatch::Alarm").map(([, r]) => [r.Properties.AlarmName as string, r.Properties]),
  );

  it("creates these alarms, all named after the installation and all notifying the alerts topic", () => {
    // The operational alarms (D71) have their own tests: `operational-alarms.test.ts`.
    const publication = /-(Reconciler|AgentProvisioner|AgentDeprovisioner)-/;
    expect(Object.keys(alarms).filter((name) => publication.test(name)).sort()).toEqual([
      `Mango-${ns}-AgentDeprovisioner-failed`,
      `Mango-${ns}-AgentProvisioner-failed`,
      `Mango-${ns}-AgentProvisioner-volume`,
      `Mango-${ns}-Reconciler-failed`,
      `Mango-${ns}-Reconciler-findings`,
    ]);
    for (const alarm of Object.values(alarms)) {
      expect(alarm.AlarmActions).toEqual([{ Ref: topicId }]);
      expect(alarm.AlarmDescription.length).toBeGreaterThan(20);
    }
  });

  it("alarms on any finding and holds its state between daily runs", () => {
    expect(alarms[`Mango-${ns}-Reconciler-findings`]).toMatchObject({
      Namespace: RECONCILER_METRICS.namespace,
      MetricName: "Findings",
      Dimensions: [{ Name: RECONCILER_METRICS.dimension, Value: ns }],
      Statistic: "Maximum",
      Threshold: 1,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      EvaluationPeriods: 1,
      TreatMissingData: "ignore",
    });
  });

  it("alarms when a reconciliation could not run", () => {
    expect(alarms[`Mango-${ns}-Reconciler-failed`]).toMatchObject({
      Namespace: "AWS/SQS",
      MetricName: "ApproximateNumberOfMessagesVisible",
      Dimensions: [{ Name: "QueueName", Value: { "Fn::GetAtt": [queueId, "QueueName"] } }],
      Threshold: 1,
      TreatMissingData: "notBreaching",
    });
  });

  it("alarms on failed, timed-out or aborted provisioner executions", () => {
    const alarm = alarms[`Mango-${ns}-AgentProvisioner-failed`];
    expect(alarm).toMatchObject({ Threshold: 1, ComparisonOperator: "GreaterThanOrEqualToThreshold" });
    const metrics = alarm.Metrics as { Expression?: string; MetricStat?: { Metric: any; Stat: string } }[];
    expect(metrics.filter((m) => m.Expression).map((m) => m.Expression)).toEqual(["failed + timedOut + aborted"]);
    const stats = metrics.filter((m) => m.MetricStat).map((m) => m.MetricStat!);
    expect(stats.map((s) => s.Metric.MetricName).sort()).toEqual([
      "ExecutionsAborted",
      "ExecutionsFailed",
      "ExecutionsTimedOut",
    ]);
    for (const stat of stats) {
      expect(stat.Stat).toBe("Sum");
      expect(stat.Metric.Namespace).toBe("AWS/States");
      expect(stat.Metric.Dimensions).toEqual([{ Name: "StateMachineArn", Value: { Ref: machineId } }]);
    }
  });

  it("alarms on an unusual number of publications (TM-M9)", () => {
    expect(alarms[`Mango-${ns}-AgentProvisioner-volume`]).toMatchObject({
      Namespace: "AWS/States",
      MetricName: "ExecutionsStarted",
      Dimensions: [{ Name: "StateMachineArn", Value: { Ref: machineId } }],
      Statistic: "Sum",
      Period: 3600,
      Threshold: PROVISIONER_EXECUTIONS_PER_HOUR,
      ComparisonOperator: "GreaterThanThreshold",
    });
  });

  it("encrypts the topic and lets only this account's alarms publish, over TLS", () => {
    expect(resources[topicId]!.Properties.KmsMasterKeyId).toEqual({ "Fn::GetAtt": [alertsKeyId, "Arn"] });
    expect(resources[alertsKeyId]!.Properties.EnableKeyRotation).toBe(true);
    const [policy] = ofType("AWS::SNS::TopicPolicy").map(([, r]) => r.Properties);
    expect(policy.Topics).toEqual([{ Ref: topicId }]);
    const document = policy.PolicyDocument.Statement as Statement[];
    const allows = document.filter((s) => s.Effect === "Allow");
    expect(allows).toEqual([
      {
        Sid: "AlarmsOfThisAccount",
        Effect: "Allow",
        Principal: { Service: "cloudwatch.amazonaws.com" },
        Action: "sns:Publish",
        Resource: { Ref: topicId },
        Condition: {
          StringEquals: { "aws:SourceAccount": account },
          ArnLike: { "aws:SourceArn": `arn:aws:cloudwatch:${region}:${account}:alarm:*` },
        },
      },
    ]);
    expect(document.filter((s) => s.Effect === "Deny")).toEqual([
      expect.objectContaining({ Condition: { Bool: { "aws:SecureTransport": "false" } } }),
    ]);
    // Without `alerts.emails` the stack sends alerts nowhere by itself.
    expect(ofType("AWS::SNS::Subscription")).toEqual([]);
  });

  it("subscribes the mailboxes of the installation config, and nothing else", () => {
    const withEmails = installationSchema.parse({
      ...JSON.parse(readFileSync(resolve(import.meta.dirname, "../config/example.json"), "utf8")),
      alerts: { emails: ["oncall@example.com", "platform@example.com"] },
    });
    const subscribed = Template.fromStack(
      new CoreStack(new App({ context: { skipSpa: true } }), "Core", {
        installation: withEmails,
        env: { account, region },
      }),
    );
    const found = Object.values(subscribed.findResources("AWS::SNS::Subscription")).map((r) => r.Properties);
    expect(found.map((s) => [s.Protocol, s.Endpoint]).sort()).toEqual([
      ["email", "oncall@example.com"],
      ["email", "platform@example.com"],
    ]);
    for (const subscription of found) expect(subscription.TopicArn).toEqual({ Ref: expect.any(String) });
  });

  it.each([
    [{ emails: ["not-an-email"] }],
    [{ emails: ["a@example.com", "A@example.com"] }],
    [{ emails: Array.from({ length: 11 }, (_, i) => `u${i}@example.com`) }],
  ])("rejects an invalid alerts configuration %#", (alerts) => {
    const raw = JSON.parse(readFileSync(resolve(import.meta.dirname, "../config/example.json"), "utf8"));
    expect(installationSchema.safeParse({ ...raw, alerts }).success).toBe(false);
  });

  it("lets CloudWatch use the alerts key only to publish notifications", () => {
    const keyStatements = resources[alertsKeyId]!.Properties.KeyPolicy.Statement as Statement[];
    const service = keyStatements.filter((s) => JSON.stringify(s.Principal).includes("Service"));
    expect(service).toEqual([
      {
        Sid: "CloudWatchAlarmsToAlertsTopic",
        Effect: "Allow",
        Principal: { Service: "cloudwatch.amazonaws.com" },
        Action: ["kms:Decrypt", "kms:GenerateDataKey*"],
        Resource: "*",
        // Only for alarms of this account (confused deputy).
        Condition: { StringEquals: { "aws:SourceAccount": account } },
      },
    ]);
  });

  it("exports the topic so the customer can subscribe", () => {
    template.hasOutput("AlertsTopicArn", { Value: { Ref: topicId } });
  });
});
