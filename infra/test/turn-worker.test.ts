import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import { loadInstallation } from "../lib/config/schema.js";
import {
  CHAT_TURN_DEAD_LETTER_RETENTION,
  CHAT_TURN_RECEIPTS,
  CHAT_TURN_RETENTION,
  CHAT_TURN_VISIBILITY,
  CHAT_TURNS_QUEUE_ENV,
  TURN_WORKER_COMMAND,
  TURN_WORKER_ENVIRONMENT,
  TURN_WORKER_STOP_SECONDS,
  TURN_WORKER_TASKS,
} from "../lib/constructs/turn-worker.js";
import { CoreStack } from "../lib/stacks/core-stack.js";
import { fromCore } from "./nested.js";

/* The turn worker and the queue of chat turns (D121; turn-worker-threat-model.md, TM-TW1, TW10). */

const cfg = loadInstallation(resolve(import.meta.dirname, "../config/example.json"));
const ns = cfg.namespace;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Resource = { Type: string; Properties: any; [k: string]: any };
interface Statement {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource: unknown;
  Principal?: unknown;
  Condition?: Record<string, Record<string, unknown>>;
}

const template = fromCore(
  new CoreStack(new App({ context: { skipSpa: true } }), "Core", {
    installation: cfg,
    env: { account: cfg.mangoAccountId, region: cfg.region },
  }),
);
const resources = template.toJSON().Resources as Record<string, Resource>;
const list = <T>(value: T | T[]): T[] => (Array.isArray(value) ? value : [value]);
function logicalId(type: string, props: Record<string, unknown>): string {
  const ids = Object.keys(template.findResources(type, { Properties: props }));
  expect(ids, JSON.stringify(props)).toHaveLength(1);
  return ids[0]!;
}
const policies = Object.values(resources).filter(
  (r) => r.Type === "AWS::IAM::Policy" || r.Type === "AWS::IAM::ManagedPolicy",
);
/** Statements of the inline and managed policies attached to a role. */
const statementsOf = (roleId: string): Statement[] =>
  policies
    .filter((r) => (r.Properties.Roles ?? []).some((x: { Ref: string }) => x.Ref === roleId))
    .flatMap((r) => r.Properties.PolicyDocument.Statement as Statement[]);
/** Every allow of an identity policy, with the roles it is attached to. */
const allows = () =>
  policies.flatMap((r) =>
    (r.Properties.PolicyDocument.Statement as Statement[])
      .filter((s) => s.Effect === "Allow")
      .map((statement) => ({ roles: ((r.Properties.Roles ?? []) as { Ref: string }[]).map((x) => x.Ref), statement })),
  );
const mentions = (resource: unknown, id: string) => JSON.stringify(resource).includes(`"${id}"`);
const bySid = (statements: Statement[], sid: string): Statement => {
  const found = statements.filter((s) => s.Sid === sid);
  expect(found, sid).toHaveLength(1);
  return found[0]!;
};

const workerRoleId = logicalId("AWS::IAM::Role", { RoleName: `Mango-${ns}-TurnWorker` });
const apiRoleId = logicalId("AWS::IAM::Role", { RoleName: `Mango-${ns}-ApiTask` });
const queueId = logicalId("AWS::SQS::Queue", { QueueName: `Mango-${ns}-ChatTurns` });
const dlqId = logicalId("AWS::SQS::Queue", { QueueName: `Mango-${ns}-ChatTurns-dlq` });
const queue = resources[queueId]!.Properties;
const dlq = resources[dlqId]!.Properties;
const keyId = queue.KmsMasterKeyId["Fn::GetAtt"][0] as string;
const key = resources[keyId]!.Properties;
const queuePolicyOf = (id: string): Statement[] =>
  Object.values(resources)
    .filter((r) => r.Type === "AWS::SQS::QueuePolicy" && mentions(r.Properties.Queues, id))
    .flatMap((r) => r.Properties.PolicyDocument.Statement as Statement[]);
const serviceId = logicalId("AWS::ECS::Service", { ServiceName: `Mango-${ns}-turn-worker` });
const service = resources[serviceId]!.Properties;
const apiService = resources[logicalId("AWS::ECS::Service", { ServiceName: `Mango-${ns}-api` })]!.Properties;
const taskDef = resources[logicalId("AWS::ECS::TaskDefinition", { Family: `Mango-${ns}-turn-worker` })]!.Properties;
const apiTaskDef = resources[logicalId("AWS::ECS::TaskDefinition", { Family: `Mango-${ns}-api` })]!.Properties;
const container = taskDef.ContainerDefinitions[0];
const apiContainer = apiTaskDef.ContainerDefinitions[0];
const envOf = (c: any): Record<string, unknown> =>
  Object.fromEntries((c.Environment as { Name: string; Value: unknown }[]).map((e) => [e.Name, e.Value]));
// Core names the role of its nested stack by its name (D99 (4)).
const workerRoleArn = {
  "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, `:iam::${cfg.mangoAccountId}:role/Mango-${ns}-TurnWorker`]],
};
const apiRoleArn = { "Fn::GetAtt": [apiRoleId, "Arn"] };

describe("the queue of chat turns (TM-TW1)", () => {
  it("is a standard queue with a key of its own and a dead-letter queue after one receipt", () => {
    expect(queue.FifoQueue).toBeUndefined();
    expect(key.EnableKeyRotation).toBe(true);
    const alias = Object.values(resources).find((r) => r.Type === "AWS::KMS::Alias" && mentions(r.Properties.TargetKeyId, keyId));
    expect(alias?.Properties.AliasName).toBe(`alias/Mango-${ns}-chat-turns`);
    expect(dlq.KmsMasterKeyId).toEqual(queue.KmsMasterKeyId);
    expect(CHAT_TURN_RECEIPTS).toBe(1);
    expect(queue.RedrivePolicy).toEqual({
      deadLetterTargetArn: { "Fn::GetAtt": [dlqId, "Arn"] },
      maxReceiveCount: CHAT_TURN_RECEIPTS,
    });
  });

  it("hides a taken turn for the longest turn and a margin, and keeps messages longer than that", () => {
    expect(CHAT_TURN_VISIBILITY.toSeconds()).toBe(960);
    expect(queue.VisibilityTimeout).toBe(960);
    // Longer than the visibility, or a turn of a worker that fell would never reach the DLQ.
    expect(queue.MessageRetentionPeriod).toBe(CHAT_TURN_RETENTION.toSeconds());
    expect(CHAT_TURN_RETENTION.toSeconds()).toBeGreaterThan(CHAT_TURN_VISIBILITY.toSeconds());
    // A dead letter keeps its first timestamp: one hour, the life of the access token inside.
    expect(dlq.MessageRetentionPeriod).toBe(CHAT_TURN_DEAD_LETTER_RETENTION.toSeconds());
    expect(dlq.MessageRetentionPeriod).toBeLessThanOrEqual(3600);
  });

  it("is read only by the worker and written only by mango-api, whatever another policy says", () => {
    const statements = queuePolicyOf(queueId);
    const reads = bySid(statements, "OnlyTheWorkerReads");
    expect(reads.Effect).toBe("Deny");
    expect(reads.Principal).toEqual({ AWS: "*" });
    expect(list(reads.Action).sort()).toEqual(["sqs:ChangeMessageVisibility", "sqs:DeleteMessage", "sqs:ReceiveMessage"]);
    expect(reads.Condition).toEqual({ ArnNotEquals: { "aws:PrincipalArn": workerRoleArn } });
    const sends = bySid(statements, "OnlyMangoApiSends");
    expect(sends.Effect).toBe("Deny");
    expect(sends.Action).toBe("sqs:SendMessage");
    expect(sends.Condition).toEqual({ ArnNotEquals: { "aws:PrincipalArn": apiRoleArn } });
    // TLS only, as every queue.
    expect(statements.some((s) => s.Effect === "Deny" && (JSON.stringify(s.Condition) ?? "").includes("aws:SecureTransport"))).toBe(true);
  });

  it("lets nobody read the dead letters or move them back (TM-TW5)", () => {
    const deny = bySid(queuePolicyOf(dlqId), "NobodyReadsTurns");
    expect(deny.Effect).toBe("Deny");
    expect(deny.Condition).toBeUndefined();
    expect(list(deny.Action)).toEqual(
      expect.arrayContaining(["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:StartMessageMoveTask"]),
    );
    const dlqArn = JSON.stringify({ "Fn::GetAtt": [dlqId, "Arn"] });
    expect(allows().filter(({ statement }) => JSON.stringify(statement.Resource).includes(dlqArn))).toEqual([]);
  });

  it("is received only by the worker and sent to only by mango-api", () => {
    const queueArn = JSON.stringify({ "Fn::GetAtt": [queueId, "Arn"] });
    const on = (action: string) =>
      allows()
        .filter(({ statement }) => list(statement.Action).includes(action) && JSON.stringify(statement.Resource).includes(queueArn))
        .flatMap(({ roles }) => roles);
    expect(on("sqs:ReceiveMessage")).toEqual([workerRoleId]);
    expect(on("sqs:DeleteMessage")).toEqual([workerRoleId]);
    expect(on("sqs:ChangeMessageVisibility")).toEqual([workerRoleId]);
    expect(on("sqs:SendMessage")).toEqual([apiRoleId]);
  });

  it("has a key only the two turn roles decrypt, and only through this queue", () => {
    const keyStatements = key.KeyPolicy.Statement as Statement[];
    const others = bySid(keyStatements, "OnlyTheTurnRolesDecrypt");
    expect(others.Effect).toBe("Deny");
    expect(others.Action).toBe("kms:Decrypt");
    expect(others.Condition).toEqual({
      ArnNotEquals: { "aws:PrincipalArn": [apiRoleArn, workerRoleArn] },
      Bool: { "aws:PrincipalIsAWSService": "false" },
    });
    const direct = bySid(keyStatements, "DecryptOnlyThroughSqs");
    expect(direct.Effect).toBe("Deny");
    expect(direct.Condition?.StringNotEquals).toEqual({ "kms:ViaService": `sqs.${cfg.region}.amazonaws.com` });

    const keyArn = JSON.stringify({ "Fn::GetAtt": [keyId, "Arn"] });
    const decrypting = allows().filter(
      ({ statement }) => list(statement.Action).includes("kms:Decrypt") && JSON.stringify(statement.Resource).includes(keyArn),
    );
    expect(decrypting.flatMap(({ roles }) => roles).sort()).toEqual([apiRoleId, workerRoleId].sort());
    for (const { statement } of decrypting) {
      expect(statement.Condition).toEqual({
        StringEquals: {
          "kms:ViaService": `sqs.${cfg.region}.amazonaws.com`,
          "kms:EncryptionContext:aws:sqs:arn": { "Fn::GetAtt": [queueId, "Arn"] },
        },
      });
    }
    // mango-api encrypts to send (SQS asks a sender for Decrypt too); only the worker reads.
    expect(list(bySid(statementsOf(apiRoleId), "SendChatTurnsKey").Action).sort()).toEqual([
      "kms:Decrypt",
      "kms:GenerateDataKey",
    ]);
    expect(bySid(statementsOf(workerRoleId), "ReadChatTurnsKey").Action).toBe("kms:Decrypt");
  });
});

describe("the service mango-turn-worker (D121 (3))", () => {
  it("runs the image of mango-api with another command, in its cluster and network", () => {
    expect(container.Image).toEqual(apiContainer.Image);
    expect(container.Command).toEqual(TURN_WORKER_COMMAND);
    expect(TURN_WORKER_COMMAND).toEqual(["python", "-m", "mango_api.turn_worker"]);
    expect(service.Cluster).toEqual(apiService.Cluster);
    expect(service.LaunchType).toBe("FARGATE");
    expect(taskDef.RuntimePlatform).toEqual({ CpuArchitecture: "ARM64", OperatingSystemFamily: "LINUX" });
    const network = service.NetworkConfiguration.AwsvpcConfiguration;
    expect(network.Subnets).toEqual(apiService.NetworkConfiguration.AwsvpcConfiguration.Subnets);
    expect(network.AssignPublicIp).toBe("ENABLED");
  });

  it("has no load balancer, no port and no inbound rule", () => {
    expect(service.LoadBalancers).toBeUndefined();
    expect(container.PortMappings).toBeUndefined();
    const groups = service.NetworkConfiguration.AwsvpcConfiguration.SecurityGroups as { "Fn::GetAtt": [string, string] }[];
    expect(groups).toHaveLength(1);
    const groupId = groups[0]!["Fn::GetAtt"][0];
    expect(resources[groupId]!.Properties.SecurityGroupIngress).toBeUndefined();
    const ingress = Object.values(resources).filter(
      (r) => r.Type === "AWS::EC2::SecurityGroupIngress" && mentions(r.Properties.GroupId, groupId),
    );
    expect(ingress).toEqual([]);
  });

  it("deploys new tasks first, rolls back a failed deployment and gives a stopped task 120 s", () => {
    expect(service.DeploymentConfiguration).toMatchObject({
      MinimumHealthyPercent: 100,
      MaximumPercent: 200,
      DeploymentCircuitBreaker: { Enable: true, Rollback: true },
    });
    expect(TURN_WORKER_STOP_SECONDS).toBe(120);
    expect(container.StopTimeout).toBe(TURN_WORKER_STOP_SECONDS);
    expect(container.ReadonlyRootFilesystem).toBe(true);
    expect(container.User).toBe("10001");
    expect(service.EnableExecuteCommand).toBe(false);
  });

  it("stays at zero tasks until its entry point is in the image (R2 sets it to 2)", () => {
    expect(TURN_WORKER_TASKS).toBe(0);
    expect(service.DesiredCount).toBe(TURN_WORKER_TASKS);
  });

  it("logs to a group of its own, encrypted and with a retention", () => {
    const group = resources[logicalId("AWS::Logs::LogGroup", { LogGroupName: `/mango/${ns}/turn-worker` })]!.Properties;
    expect(group.RetentionInDays).toBe(90);
    expect(group.KmsKeyId).toBeDefined();
    expect(container.LogConfiguration.Options["awslogs-group"]).toEqual({
      Ref: logicalId("AWS::Logs::LogGroup", { LogGroupName: `/mango/${ns}/turn-worker` }),
    });
  });

  it("takes only the environment of the turn from mango-api, and the queue", () => {
    const worker = envOf(container);
    const api = envOf(apiContainer);
    const queueUrl = { Ref: queueId };
    expect(api[CHAT_TURNS_QUEUE_ENV]).toEqual(queueUrl);
    expect(worker[CHAT_TURNS_QUEUE_ENV]).toEqual(queueUrl);
    for (const name of TURN_WORKER_ENVIRONMENT) expect(worker[name], name).toEqual(api[name]);
    expect(Object.keys(worker).sort()).toEqual(
      [...TURN_WORKER_ENVIRONMENT, CHAT_TURNS_QUEUE_ENV, "AWS_DEFAULT_REGION"].sort(),
    );
    // Nothing of the web session, the tasks client or administration.
    for (const name of ["WEB_SESSIONS_TABLE", "TASKS_CLIENT_SECRET_ARN", "TASK_IDENTITY_KEY_ARN", "FIRST_ADMIN_EMAILS"]) {
      expect(worker[name], name).toBeUndefined();
    }
  });
});

describe("the role of the turn worker", () => {
  const statements = statementsOf(workerRoleId);

  it("never names every resource", () => {
    for (const statement of statements) {
      expect(list(statement.Resource as unknown), statement.Sid).not.toContain("*");
    }
  });

  it("is assumed by ECS tasks only and may take a person's conversation rows like mango-api", () => {
    const role = resources[workerRoleId]!.Properties;
    expect(role.AssumeRolePolicyDocument.Statement).toEqual([
      { Action: "sts:AssumeRole", Effect: "Allow", Principal: { Service: "ecs-tasks.amazonaws.com" } },
    ]);
    const dataRoleId = logicalId("AWS::IAM::Role", { RoleName: `Mango-${ns}-ConversationData` });
    const trust = resources[dataRoleId]!.Properties.AssumeRolePolicyDocument.Statement[0];
    expect(trust.Condition).toEqual({ ArnEquals: { "aws:PrincipalArn": [apiRoleArn, workerRoleArn] } });
    expect(bySid(statements, "ConversationDataRls").Resource).toEqual({ "Fn::GetAtt": [dataRoleId, "Arn"] });
  });

  it("protects only tasks of the cluster of mango-api", () => {
    const protection = bySid(statements, "OwnTaskProtection");
    expect(list(protection.Action).sort()).toEqual(["ecs:GetTaskProtection", "ecs:UpdateTaskProtection"]);
    // `task/<cluster of mango-api>/*`, by its fixed name.
    expect(apiService.Cluster).toEqual({ Ref: expect.stringMatching(/^ApiCluster/) });
    const cluster = resources[(apiService.Cluster as { Ref: string }).Ref]!.Properties.ClusterName;
    expect(cluster).toBe(`Mango-${ns}-api`);
    expect(protection.Resource).toEqual({
      "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, `:ecs:${cfg.region}:${cfg.mangoAccountId}:task/${cluster}/*`]],
    });
  });

  it("has the permissions of the turn and no administration of mango-api", () => {
    const actions = new Set(statements.filter((s) => s.Effect === "Allow").flatMap((s) => list(s.Action)));
    for (const action of [
      "bedrock-agentcore:InvokeHarness",
      "bedrock-agentcore:InvokeAgentRuntime",
      "verifiedpermissions:IsAuthorized",
      "sts:AssumeRole",
      "firehose:PutRecordBatch",
      "secretsmanager:GetSecretValue",
    ]) {
      expect(actions.has(action), action).toBe(true);
    }
    for (const action of [
      "states:StartExecution",
      "lambda:InvokeFunction",
      "kms:Sign",
      "cognito-idp:AdminInitiateAuth",
      "iam:PassRole",
      "scheduler:CreateSchedule",
      "bedrock:ListFoundationModels",
      "sqs:SendMessage",
    ]) {
      expect(actions.has(action), action).toBe(false);
    }
    // Settings and Agents: read only.
    for (const sid of ["ReadSettings", "ReadAgents"]) {
      expect(list(bySid(statements, sid).Action).sort()).toEqual(["dynamodb:BatchGetItem", "dynamodb:GetItem", "dynamodb:Query"]);
    }
  });

  it("is only granted by the identity policies of this stack", () => {
    // Snapshot of the role's statements, with logical ids, so a change to them is reviewed.
    const normalized = statements
      .map((s) => ({ ...s, Action: list(s.Action).sort() }))
      .sort((a, b) => (a.Sid ?? JSON.stringify(a.Action)).localeCompare(b.Sid ?? JSON.stringify(b.Action)));
    expect(JSON.stringify(normalized, null, 1).replace(/[0-9a-f]{64}/g, "<hash>")).toMatchSnapshot();
  });
});
