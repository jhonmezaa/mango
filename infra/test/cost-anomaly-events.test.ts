import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CHECKOV_EXCEPTIONS } from "../lib/checkov.js";
import { loadInstallation } from "../lib/config/schema.js";
import { COST_ANOMALY_METRICS } from "../lib/constructs/cost-anomaly-events.js";
import { CoreStack } from "../lib/stacks/core-stack.js";
import { payerTemplate } from "./parameters.js";

const cfg = loadInstallation(resolve(import.meta.dirname, "../config/example.json"));
const ns = cfg.namespace;
const account = cfg.mangoAccountId;
const region = cfg.region;
const payerAccount = cfg.managementAccountId;

type Resource = { Type: string; Properties: any; [k: string]: any };
interface Statement {
  Sid?: string;
  Effect: string;
  Principal?: unknown;
  Action: string | string[];
  Resource: unknown;
  Condition?: Record<string, Record<string, unknown>>;
}
const actions = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);

const busName = `Mango-${ns}-CostAnomalies`;
const busArn = `arn:aws:events:${region}:${account}:event-bus/${busName}`;
const forwarderArn = `arn:aws:iam::${payerAccount}:role/Mango-${ns}-CostAnomalyForwarder`;
const pattern = { source: ["aws.ce"], "detail-type": ["Anomaly Detected"], account: [payerAccount] };

describe("forwarding in the payer account (D79)", () => {
  const payer = payerTemplate(cfg);
  const resources = payer.toJSON().Resources as Record<string, Resource>;
  const ids = (type: string, props: Record<string, unknown>) =>
    Object.keys(payer.findResources(type, { Properties: props }));
  const [roleId] = ids("AWS::IAM::Role", { RoleName: `Mango-${ns}-CostAnomalyForwarder` });
  const role = resources[roleId!]!.Properties;
  const ruleName = `Mango-${ns}-CostAnomalies-forward`;
  const [ruleId] = ids("AWS::Events::Rule", { Name: ruleName });
  const rule = resources[ruleId!]!.Properties;

  it("only EventBridge assumes the role, and only for the forwarding rule", () => {
    expect(role.AssumeRolePolicyDocument.Statement).toEqual([
      {
        Effect: "Allow",
        Action: "sts:AssumeRole",
        Principal: { Service: "events.amazonaws.com" },
        Condition: {
          StringEquals: { "aws:SourceAccount": payerAccount },
          ArnEquals: { "aws:SourceArn": `arn:aws:events:${region}:${payerAccount}:rule/${ruleName}` },
        },
      },
    ]);
  });

  it("the role can only put events on the Mango bus", () => {
    const statements = Object.values(resources)
      .filter((r) => r.Type === "AWS::IAM::Policy" && r.Properties.Roles.some((x: { Ref: string }) => x.Ref === roleId))
      .flatMap((r) => r.Properties.PolicyDocument.Statement as Statement[]);
    expect(statements).toEqual([
      { Effect: "Allow", Action: "events:PutEvents", Resource: busArn },
    ]);
    expect(Object.values(resources).filter((r) => r.Type === "AWS::IAM::ManagedPolicy")).toEqual([]);
  });

  it("forwards only Cost Anomaly Detection events of the payer account, unchanged, to the Mango bus", () => {
    expect(rule.EventBusName).toBeUndefined(); // the default bus, where AWS publishes them
    expect(rule.EventPattern).toEqual(pattern);
    expect(rule.State).toBe("ENABLED");
    expect(rule.Targets).toHaveLength(1);
    const [target] = rule.Targets;
    expect(target.Arn).toBe(busArn);
    expect(target.RoleArn).toEqual({ "Fn::GetAtt": [roleId, "Arn"] });
    expect(target.Input ?? target.InputPath ?? target.InputTransformer).toBeUndefined();
  });
});

describe("cost anomaly bus and consumer in Core (D79)", () => {
  const template = Template.fromStack(
    new CoreStack(new App({ context: { skipSpa: true } }), "Core", { installation: cfg, env: { account, region } }),
  );
  const resources = template.toJSON().Resources as Record<string, Resource>;
  const logicalId = (type: string, props: Record<string, unknown>) => {
    const found = Object.keys(template.findResources(type, { Properties: props }));
    expect(found).toHaveLength(1);
    return found[0]!;
  };
  const name = `Mango-${ns}-CostAnomalyConsumer`;
  const busId = logicalId("AWS::Events::EventBus", { Name: busName });
  const roleId = logicalId("AWS::IAM::Role", { RoleName: name });
  const functionId = logicalId("AWS::Lambda::Function", { FunctionName: name });
  const queueId = logicalId("AWS::SQS::Queue", { QueueName: `${name}-dlq` });
  const runQueueId = logicalId("AWS::SQS::Queue", { QueueName: `Mango-${ns}-TaskRuns` });
  const ruleId = logicalId("AWS::Events::Rule", { Name: `Mango-${ns}-CostAnomalies-consume` });
  const statements = Object.values(resources)
    .filter((r) => r.Type === "AWS::IAM::Policy" && r.Properties.Roles.some((x: { Ref: string }) => x.Ref === roleId))
    .flatMap((r) => r.Properties.PolicyDocument.Statement as Statement[]);

  it("the bus only takes events from the forwarding role of the payer account, in the organization", () => {
    const policies = Object.values(resources).filter((r) => r.Type === "AWS::Events::EventBusPolicy");
    const fromBus = Object.values(resources).find((r) => r.Type === "AWS::Events::EventBus")!.Properties.Policy;
    const documents = [...policies.map((p) => p.Properties.Statement ?? p.Properties), fromBus].filter(Boolean);
    const all = documents.flatMap((d: any) => (d.Statement ?? [d]) as Statement[]);
    expect(all).toHaveLength(1);
    const [statement] = all;
    expect(statement!.Effect).toBe("Allow");
    expect(JSON.stringify(statement!.Principal)).toContain(`:iam::${payerAccount}:root`);
    expect(actions(statement!)).toEqual(["events:PutEvents"]);
    expect(statement!.Resource).toEqual({ "Fn::GetAtt": [busId, "Arn"] });
    expect(statement!.Condition).toEqual({
      ArnEquals: { "aws:PrincipalArn": forwarderArn },
      StringEquals: { "aws:PrincipalOrgID": cfg.organizationId },
    });
  });

  it("the rule matches the same events as the payer's and invokes the consumer with retries", () => {
    const rule = resources[ruleId]!.Properties;
    expect(rule.EventBusName).toEqual({ Ref: busId });
    expect(rule.EventPattern).toEqual(pattern);
    expect(rule.Targets).toHaveLength(1);
    expect(rule.Targets[0].Arn).toEqual({ "Fn::GetAtt": [functionId, "Arn"] });
    expect(rule.Targets[0].RetryPolicy).toEqual({ MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 6 * 3600 });
  });

  it("the consumer only writes the audit trail and the task queue: no billing data, no model, no other account", () => {
    expect(statements.map((s) => s.Sid).filter(Boolean).sort()).toEqual([
      "DataKeyViaDynamoDB",
      "DeadLetterQueueKey",
      "WriteAuditIndex",
      "WriteAuditTrail",
    ]);
    const own = statements.filter((s) => s.Sid);
    for (const action of own.flatMap(actions)) {
      expect(action).toMatch(/^(dynamodb:PutItem|firehose:PutRecord|kms:(Decrypt|DescribeKey|Encrypt|GenerateDataKey))$/);
    }
    const all = statements.flatMap(actions);
    for (const prefix of ["sts:", "ce:", "bedrock", "events:", "lambda:"]) {
      expect(all.some((a) => a.startsWith(prefix))).toBe(false);
    }
    expect(statements.find((s) => s.Sid === "DataKeyViaDynamoDB")!.Condition).toEqual({
      StringEquals: { "kms:ViaService": `dynamodb.${region}.amazonaws.com` },
    });
    // SQS: its own dead-letter queue (Lambda) and the queue of task runs (D78), nothing else.
    const sends = statements.filter((s) => actions(s).some((a) => a.startsWith("sqs:")));
    expect(new Set(sends.flatMap(actions))).toEqual(new Set(["sqs:SendMessage"]));
    expect(sends.flatMap((s) => [s.Resource].flat())).toEqual(
      expect.arrayContaining([{ "Fn::GetAtt": [queueId, "Arn"] }, { "Fn::GetAtt": [runQueueId, "Arn"] }]),
    );
    expect(sends.flatMap((s) => [s.Resource].flat())).toHaveLength(2);
    const runQueueKey = statements.find(
      (s) => !s.Sid && actions(s).includes("kms:GenerateDataKey") && JSON.stringify(s.Resource).includes("RunQueueKey"),
    );
    expect(runQueueKey?.Condition).toEqual({ StringEquals: { "kms:ViaService": `sqs.${region}.amazonaws.com` } });
  });

  it("hands each anomaly to the queue of task runs of the installation (D78)", () => {
    expect(resources[runQueueId]!.Properties.QueueName).toBe(`Mango-${ns}-TaskRuns`);
    expect(resources[functionId]!.Properties.Environment.Variables.TASK_RUNS_QUEUE_URL).toEqual({ Ref: runQueueId });
  });

  it("is asynchronous: dead-letter queue, the Checkov DLQ check kept, no VPC", () => {
    const fn = resources[functionId]!;
    expect(fn.Properties.DeadLetterConfig).toEqual({ TargetArn: { "Fn::GetAtt": [queueId, "Arn"] } });
    const skipped = (fn.Metadata?.checkov?.skip ?? []).map((s: { id: string }) => s.id);
    expect(skipped).not.toContain(CHECKOV_EXCEPTIONS.lambdaDlq.id);
    expect(fn.Properties.VpcConfig).toBeUndefined();
    expect(fn.Properties.Environment.Variables).toMatchObject({
      MANGO_NAMESPACE: ns,
      MANAGEMENT_ACCOUNT_ID: payerAccount,
    });
    expect(resources[queueId]!.Properties.MessageRetentionPeriod).toBe(14 * 24 * 3600);
  });

  it("alarms on rejected events and on events that failed every retry", () => {
    const alarms = Object.values(resources)
      .filter((r) => r.Type === "AWS::CloudWatch::Alarm")
      .map((r) => r.Properties)
      .filter((p) => /CostAnomal/.test(p.AlarmName));
    expect(alarms.map((a) => a.AlarmName).sort()).toEqual([
      `Mango-${ns}-CostAnomalies-rejected`,
      `Mango-${ns}-CostAnomalyConsumer-failed`,
    ]);
    const rejected = alarms.find((a) => a.AlarmName.endsWith("rejected"))!;
    expect(rejected.Namespace).toBe(COST_ANOMALY_METRICS.namespace);
    expect(rejected.MetricName).toBe("Rejected");
    expect(rejected.Threshold).toBe(1);
  });
});
