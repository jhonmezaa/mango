import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { loadInstallation } from "../lib/config/schema.js";
import { CoreStack } from "../lib/stacks/core-stack.js";

/* Tasks without chat (D78; tasks-threat-model.md). */

const cfg = loadInstallation(resolve(import.meta.dirname, "../config/example.json"));
const ns = cfg.namespace;
const account = cfg.mangoAccountId;
const region = cfg.region;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resource = { Type: string; Properties: any; [k: string]: any };
interface Statement {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource: unknown;
  Principal?: unknown;
  Condition?: Record<string, Record<string, unknown>>;
}

const template = Template.fromStack(
  new CoreStack(new App({ context: { skipSpa: true } }), "Core", {
    installation: cfg,
    env: { account, region },
  }),
);
const resources = template.toJSON().Resources as Record<string, Resource>;
const actions = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
function logicalId(type: string, props: Record<string, unknown>): string {
  const ids = Object.keys(template.findResources(type, { Properties: props }));
  expect(ids).toHaveLength(1);
  return ids[0]!;
}
/** Statements of the inline and managed policies attached to a role. */
function statementsOf(roleId: string): Statement[] {
  return Object.values(resources)
    .filter(
      (r) =>
        (r.Type === "AWS::IAM::Policy" || r.Type === "AWS::IAM::ManagedPolicy") &&
        (r.Properties.Roles ?? []).some((x: { Ref: string }) => x.Ref === roleId),
    )
    .flatMap((r) => r.Properties.PolicyDocument.Statement as Statement[]);
}
function grants(): { roles: string[]; statement: Statement }[] {
  return Object.values(resources)
    .filter((r) => r.Type === "AWS::IAM::Policy" || r.Type === "AWS::IAM::ManagedPolicy")
    .flatMap((r) =>
      (r.Properties.PolicyDocument.Statement as Statement[]).map((statement) => ({
        roles: ((r.Properties.Roles ?? []) as { Ref: string }[]).map((x) => x.Ref),
        statement,
      })),
    );
}
const bySid = (statements: Statement[], sid: string): Statement => {
  const found = statements.filter((s) => s.Sid === sid);
  expect(found, sid).toHaveLength(1);
  return found[0]!;
};
const clients = Object.values(resources).filter((r) => r.Type === "AWS::Cognito::UserPoolClient");
const tasksClientId = logicalId("AWS::Cognito::UserPoolClient", { ClientName: `Mango-${ns}-tasks` });
const apiRoleId = logicalId("AWS::IAM::Role", { RoleName: `Mango-${ns}-ApiTask` });
const schedulerRoleId = logicalId("AWS::IAM::Role", { RoleName: `Mango-${ns}-TaskScheduler` });
const challengeRoleId = logicalId("AWS::IAM::Role", { RoleName: `Mango-${ns}-TaskAuth` });
const queueId = logicalId("AWS::SQS::Queue", { QueueName: `Mango-${ns}-TaskRuns` });
const keyId = Object.keys(
  template.findResources("AWS::KMS::Key", {
    Properties: { KeySpec: "ECC_NIST_P256", Description: "Answers the challenge of the tasks client; only mango-api can sign" },
  }),
)[0]!;
const fnByName = (name: string) => resources[logicalId("AWS::Lambda::Function", { FunctionName: name })]!;

describe("the identity of a run (TM-T1, TM-T2)", () => {
  it("has a client of its own that only allows the custom challenge", () => {
    const client = resources[tasksClientId]!.Properties;
    expect(client.ExplicitAuthFlows.sort()).toEqual(["ALLOW_CUSTOM_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]);
    expect(client.GenerateSecret).toBe(false);
    expect(client.AllowedOAuthFlows ?? []).toEqual([]);
    expect(client.AllowedOAuthFlowsUserPoolClient ?? false).toBe(false);
    expect(client.AccessTokenValidity).toBe(15);
    expect(client.EnableTokenRevocation).toBe(true);
    expect(client.ReadAttributes ?? []).toEqual([]);
    expect(client.WriteAttributes ?? []).toEqual([]);
  });

  it("no other client may start the custom challenge, nor sign in with a password", () => {
    for (const client of clients) {
      const flows: string[] = client.Properties.ExplicitAuthFlows ?? [];
      if (client.Properties.ClientName === `Mango-${ns}-tasks`) continue;
      expect(flows).not.toContain("ALLOW_CUSTOM_AUTH");
      expect(flows.some((f) => f.includes("PASSWORD"))).toBe(false);
    }
  });

  it("the three challenge triggers are one function that can only verify", () => {
    const pool = Object.values(resources).find((r) => r.Type === "AWS::Cognito::UserPool")!;
    const config = pool.Properties.LambdaConfig;
    const challenge = { "Fn::GetAtt": [logicalId("AWS::Lambda::Function", { FunctionName: `Mango-${ns}-TaskAuth` }), "Arn"] };
    expect(config.DefineAuthChallenge).toEqual(challenge);
    expect(config.CreateAuthChallenge).toEqual(challenge);
    expect(config.VerifyAuthChallengeResponse).toEqual(challenge);
    const statements = statementsOf(challengeRoleId);
    expect(statements.flatMap(actions).filter((a) => a.startsWith("kms:"))).toEqual(["kms:GetPublicKey"]);
    expect(bySid(statements, "TasksClientId").Resource).toEqual({
      "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, `:ssm:${region}:${account}:parameter/Mango-${ns}-tasks/client-id`]],
    });
  });

  it("only mango-api signs with the identity key, whatever another policy says", () => {
    const signers = grants().filter((g) => actions(g.statement).includes("kms:Sign") && JSON.stringify(g.statement.Resource).includes(keyId));
    expect(signers.flatMap((g) => g.roles)).toEqual([apiRoleId]);
    const policy = resources[keyId]!.Properties.KeyPolicy.Statement as Statement[];
    const deny = policy.find((s) => s.Sid === "OnlyMangoApiSigns")!;
    expect(deny.Effect).toBe("Deny");
    expect(deny.Action).toBe("kms:Sign");
    expect(deny.Condition).toEqual({ ArnNotEquals: { "aws:PrincipalArn": { "Fn::GetAtt": [apiRoleId, "Arn"] } } });
  });

  it("the Gateway and the Cost Explorer connector take the tasks client; the approval executor does not (A3)", () => {
    const gateway = Object.values(resources).find((r) => r.Type === "AWS::BedrockAgentCore::Gateway")!;
    const allowed = gateway.Properties.AuthorizerConfiguration.CustomJWTAuthorizer.AllowedClients;
    expect(allowed).toHaveLength(2);
    expect(allowed).toContainEqual({ Ref: tasksClientId });
    const costExplorer = fnByName(`Mango-${ns}-CostExplorerConnector`).Properties.Environment.Variables;
    expect(costExplorer.TASKS_CLIENT_ID).toEqual({ Ref: tasksClientId });
    const executor = fnByName(`Mango-${ns}-ApprovalExecutor`).Properties.Environment.Variables;
    expect(executor.TASKS_CLIENT_ID).toBeUndefined();
    expect(JSON.stringify(executor)).not.toContain(tasksClientId);
  });
});

describe("the schedules and the queue of runs", () => {
  it("the scheduler role is for this installation's schedule group and only sends to the queue", () => {
    const role = resources[schedulerRoleId]!.Properties;
    const trust = role.AssumeRolePolicyDocument.Statement[0];
    expect(trust.Principal).toEqual({ Service: "scheduler.amazonaws.com" });
    expect(trust.Condition.StringEquals).toEqual({ "aws:SourceAccount": account });
    expect(JSON.stringify(trust.Condition.ArnLike)).toContain(`schedule-group/Mango-${ns}-tasks/*`);
    const statements = statementsOf(schedulerRoleId);
    expect(statements.flatMap(actions).sort()).toEqual(["kms:Decrypt", "kms:GenerateDataKey", "sqs:SendMessage"]);
    expect(bySid(statements, "SendDueTimes").Resource).toEqual({ "Fn::GetAtt": [queueId, "Arn"] });
  });

  it("the schedule group is a resource of the stack, named with the namespace (D58, D76)", () => {
    // CloudFormation puts the stack's tags on it and deletes it, with its schedules, with
    // the stack. Schedules take no tags: the group carries them.
    const groups = Object.values(template.findResources("AWS::Scheduler::ScheduleGroup"));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.Properties.Name).toBe(`Mango-${ns}-tasks`);
    expect(groups[0]!.DeletionPolicy ?? "Delete").toBe("Delete");
  });

  it("the queue is encrypted, refuses plain HTTP and sends failing messages to a dead-letter queue", () => {
    const queue = resources[queueId]!.Properties;
    expect(queue.KmsMasterKeyId).toBeDefined();
    expect(queue.VisibilityTimeout).toBe(900);
    expect(queue.RedrivePolicy.maxReceiveCount).toBe(3);
    const policies = Object.values(template.findResources("AWS::SQS::QueuePolicy"));
    expect(JSON.stringify(policies)).toContain("aws:SecureTransport");
  });

  it("a run that failed every receipt alarms on the alerts topic and shows on the dashboard (D71)", () => {
    const dlqId = logicalId("AWS::SQS::Queue", { QueueName: `Mango-${ns}-TaskRuns-dlq` });
    const alarmId = logicalId("AWS::CloudWatch::Alarm", { AlarmName: `Mango-${ns}-TaskRuns-failed` });
    const alarm = resources[alarmId]!.Properties;
    expect(alarm).toMatchObject({
      MetricName: "ApproximateNumberOfMessagesVisible",
      Namespace: "AWS/SQS",
      Statistic: "Maximum",
      Period: 300,
      Threshold: 1,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      EvaluationPeriods: 1,
      TreatMissingData: "notBreaching",
    });
    expect(alarm.Dimensions).toEqual([{ Name: "QueueName", Value: { "Fn::GetAtt": [dlqId, "QueueName"] } }]);
    const topics = Object.keys(template.findResources("AWS::SNS::Topic"));
    expect(alarm.AlarmActions).toEqual([{ Ref: topics[0] }]);
    expect(alarm.AlarmDescription).toMatch(/Look first at /);
    const [dashboard] = Object.values(template.findResources("AWS::CloudWatch::Dashboard"));
    expect(JSON.stringify(dashboard!.Properties.DashboardBody)).toContain(`"${alarmId}"`);
  });

  it("mango-api manages only the schedules of its group and passes only the scheduler role", () => {
    const statements = statementsOf(apiRoleId);
    const schedules = bySid(statements, "TaskSchedules");
    expect(JSON.stringify(schedules.Resource)).toContain(`:schedule/Mango-${ns}-tasks/*`);
    expect(actions(schedules).every((a) => a.startsWith("scheduler:"))).toBe(true);
    const pass = bySid(statements, "PassTaskSchedulerRole");
    expect(pass.Resource).toEqual({ "Fn::GetAtt": [schedulerRoleId, "Arn"] });
    expect(pass.Condition).toEqual({ StringEquals: { "iam:PassedToService": "scheduler.amazonaws.com" } });
    expect(actions(bySid(statements, "TasksTable"))).not.toContain("dynamodb:Scan");
  });

  it("the Tasks table is retained, recoverable and encrypted, with a TTL for runs", () => {
    const tableId = logicalId("AWS::DynamoDB::GlobalTable", { TableName: `Mango-${ns}-Tasks` });
    const table = resources[tableId]!;
    expect(table.Properties.Replicas[0].PointInTimeRecoverySpecification).toEqual({ PointInTimeRecoveryEnabled: true });
    expect(table.Properties.Replicas[0].SSESpecification.KMSMasterKeyId).toBeDefined();
    expect(table.Properties.TimeToLiveSpecification).toEqual({ AttributeName: "expires_at", Enabled: true });
    expect(table.Properties.GlobalSecondaryIndexes.map((i: { IndexName: string }) => i.IndexName).sort()).toEqual([
      "All",
      "ByEvent",
      "ByOwner",
    ]);
    if (cfg.retainData) expect(table.DeletionPolicy).toBe("Retain");
  });

  it("the role of mango-api keeps everything else in its inline policy, with no overflow", () => {
    const overflow = Object.keys(resources).filter((id) => id.startsWith("ApiTaskRoleOverflowPolicy"));
    expect(overflow).toEqual([]);
    const managed = Object.values(template.findResources("AWS::IAM::ManagedPolicy", {
      Properties: { ManagedPolicyName: `Mango-${ns}-ApiTasks` },
    }));
    expect(managed).toHaveLength(1);
    expect(managed[0]!.Properties.Roles).toEqual([{ Ref: apiRoleId }]);
    // IAM caps a managed policy at 6,144 characters.
    expect(JSON.stringify(managed[0]!.Properties.PolicyDocument).length).toBeLessThan(6144);
  });

  it("mango-api gets everything it needs to run tasks", () => {
    const api = Object.values(resources).find((r) => r.Type === "AWS::ECS::TaskDefinition")!;
    const env = (api.Properties.ContainerDefinitions[0].Environment as { Name: string }[]).map((e) => e.Name);
    for (const name of [
      "TASKS_TABLE",
      "TASK_RUNS_QUEUE_URL",
      "TASK_RUNS_QUEUE_ARN",
      "TASK_SCHEDULE_GROUP",
      "TASK_SCHEDULER_ROLE_ARN",
      "TASKS_CLIENT_ID",
      "TASK_IDENTITY_KEY_ARN",
    ]) {
      expect(env).toContain(name);
    }
  });

  it("no new statement uses a wildcard resource except the schedules of the group", () => {
    const sids = ["TasksTable", "TasksTableKey", "TaskRunQueue", "TaskRunQueueKey", "TaskSchedules", "PassTaskSchedulerRole", "TaskIdentitySign", "TaskIdentityChallenge"];
    for (const sid of sids) {
      const resource = JSON.stringify(bySid(statementsOf(apiRoleId), sid).Resource);
      expect(resource === '"*"', sid).toBe(false);
      if (sid !== "TaskSchedules") expect(resource.includes("*"), sid).toBe(false);
    }
  });
});
