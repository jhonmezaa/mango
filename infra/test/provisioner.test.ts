import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { loadInstallation } from "../lib/config/schema.js";
import { connectorCatalog, PROVISIONER_WRITABLE_ATTRIBUTES } from "../lib/constructs/provisioner.js";
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

/** Identity-policy statements attached to a role (by logical id). */
function statementsOf(roleId: string): Statement[] {
  return Object.values(resources)
    .filter((r) => r.Type === "AWS::IAM::Policy" && r.Properties.Roles.some((x: { Ref: string }) => x.Ref === roleId))
    .flatMap((r) => r.Properties.PolicyDocument.Statement as Statement[]);
}
const actions = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);
const bySid = (statements: Statement[], sid: string): Statement => {
  const found = statements.filter((s) => s.Sid === sid);
  expect(found, sid).toHaveLength(1);
  return found[0]!;
};

const provisionerRoleId = logicalId("AWS::IAM::Role", { RoleName: `Mango-${ns}-Provisioner` });
const apiRoleId = logicalId("AWS::IAM::Role", { RoleName: `Mango-${ns}-ApiTask` });
const boundaryId = logicalId("AWS::IAM::ManagedPolicy", { ManagedPolicyName: `Mango-${ns}-agent-boundary` });
const functionId = logicalId("AWS::Lambda::Function", { FunctionName: `Mango-${ns}-Provisioner` });
const machineId = logicalId("AWS::StepFunctions::StateMachine", { StateMachineName: `Mango-${ns}-AgentProvisioner` });
const agentsId = logicalId("AWS::DynamoDB::GlobalTable", { TableName: `Mango-${ns}-Agents` });
const provisioner = statementsOf(provisionerRoleId);
const api = statementsOf(apiRoleId);

const agentRoles = `arn:aws:iam::${account}:role/Mango-${ns}-agent-*`;
const agentcore = `arn:aws:bedrock-agentcore:${region}:${account}`;
const harnesses = `${agentcore}:harness/Mango_${ns}_a_*`;
const runtimes = `${agentcore}:runtime/harness_Mango_${ns}_a_*`;
const logGroups = `arn:aws:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/harness_Mango_${ns}_a_*`;
const requestTags = {
  StringEquals: { "aws:RequestTag/mango:namespace": ns, "aws:RequestTag/mango:component": "agent" },
};

describe("provisioner role: IAM (TM-M1)", () => {
  const iamStatements = provisioner.filter((s) => actions(s).some((a) => a.startsWith("iam:")));

  it("can only create roles under the agent prefix and with the agent boundary", () => {
    const create = bySid(provisioner, "CreateAgentRoleWithBoundary");
    expect(actions(create)).toEqual(["iam:CreateRole"]);
    expect(create.Resource).toBe(agentRoles);
    expect(create.Condition).toEqual({ StringEquals: { "iam:PermissionsBoundary": { Ref: boundaryId } } });
    // No other statement grants CreateRole.
    expect(provisioner.filter((s) => actions(s).includes("iam:CreateRole"))).toHaveLength(1);
  });

  it("can only write inline policies on roles that carry the boundary", () => {
    const policy = bySid(provisioner, "AgentRolePolicyWithBoundary");
    expect(actions(policy).sort()).toEqual(["iam:DeleteRolePolicy", "iam:PutRolePolicy"]);
    expect(policy.Resource).toBe(agentRoles);
    expect(policy.Condition).toEqual({ StringEquals: { "iam:PermissionsBoundary": { Ref: boundaryId } } });
    expect(provisioner.filter((s) => actions(s).includes("iam:PutRolePolicy"))).toHaveLength(1);
  });

  it("passes agent roles only to AgentCore", () => {
    const pass = provisioner.filter((s) => actions(s).includes("iam:PassRole"));
    expect(pass).toHaveLength(1);
    expect(pass[0]!.Resource).toBe(agentRoles);
    expect(pass[0]!.Condition).toEqual({
      StringEquals: { "iam:PassedToService": "bedrock-agentcore.amazonaws.com" },
    });
  });

  it("has exactly these IAM actions, all on the agent prefix", () => {
    const granted = [...new Set(iamStatements.flatMap(actions))].sort();
    expect(granted).toEqual([
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:DeleteRolePolicy",
      "iam:GetRole",
      "iam:PassRole",
      "iam:PutRolePolicy",
      "iam:TagRole",
    ]);
    for (const statement of iamStatements) expect(statement.Resource).toBe(agentRoles);
  });

  it("cannot attach managed policies, change boundaries or trust policies", () => {
    const granted = provisioner.flatMap(actions);
    for (const forbidden of [
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
      "iam:PutRolePermissionsBoundary",
      "iam:DeleteRolePermissionsBoundary",
      "iam:UpdateAssumeRolePolicy",
      "iam:UpdateRole",
      "iam:CreatePolicy",
      "iam:CreatePolicyVersion",
      "sts:AssumeRole",
    ]) {
      expect(granted).not.toContain(forbidden);
    }
    expect(granted.some((a) => a.endsWith("*"))).toBe(false);
  });

  it("does not match the provisioner's own role or any other Mango role", () => {
    const names = Object.values(resources)
      .filter((r) => r.Type === "AWS::IAM::Role" && typeof r.Properties.RoleName === "string")
      .map((r) => r.Properties.RoleName as string);
    expect(names.length).toBeGreaterThan(3);
    for (const name of names) expect(name.toLowerCase().startsWith(`mango-${ns}-agent-`)).toBe(false);
  });
});

describe("provisioner role: AgentCore", () => {
  it("creates harnesses only with this installation's tags", () => {
    const create = bySid(provisioner, "CreateAgentHarness");
    expect(actions(create).sort()).toEqual(["bedrock-agentcore:CreateHarness", "bedrock-agentcore:TagResource"]);
    expect(create.Resource).toBe(`${agentcore}:harness/*`);
    expect(create.Condition).toEqual(requestTags);
  });

  it("manages only harnesses named Mango_<ns>_a_*", () => {
    const manage = bySid(provisioner, "ManageAgentHarness");
    expect(manage.Resource).toEqual([harnesses, `${harnesses}/harness-endpoint/*`]);
    expect(manage.Condition).toBeUndefined();
    const elsewhere = provisioner.filter(
      (s) => s !== manage && actions(s).some((a) => /:(Update|Delete)Harness/.test(a)),
    );
    expect(elsewhere).toEqual([]);
  });

  it("can never invoke a harness or a runtime (TM-M11)", () => {
    const granted = provisioner.flatMap(actions);
    expect(granted.filter((a) => a.startsWith("bedrock-agentcore:Invoke"))).toEqual([]);
    expect(granted.filter((a) => a.startsWith("bedrock:"))).toEqual([]);
  });

  it("creates the managed runtime and its identity only with the agent tags, and manages them by name", () => {
    const createRuntime = bySid(provisioner, "CreateHarnessRuntime");
    expect(createRuntime.Resource).toBe(`${agentcore}:runtime/*`);
    expect(createRuntime.Condition).toEqual(requestTags);
    const manageRuntime = bySid(provisioner, "ManageHarnessRuntime");
    expect(manageRuntime.Resource).toEqual([runtimes, `${runtimes}/runtime-endpoint/*`]);
    const createIdentity = bySid(provisioner, "CreateHarnessWorkloadIdentity");
    expect(createIdentity.Condition).toEqual(requestTags);
    const deleteIdentity = bySid(provisioner, "DeleteHarnessWorkloadIdentity");
    expect(actions(deleteIdentity)).toEqual(["bedrock-agentcore:DeleteWorkloadIdentity"]);
    expect(JSON.stringify(deleteIdentity.Resource)).toContain(`workload-identity/harness_Mango_${ns}_a_*`);
  });

  it("touches nothing of the Gateway, policies or other AgentCore resources", () => {
    const granted = provisioner.flatMap(actions).filter((a) => a.startsWith("bedrock-agentcore:"));
    for (const action of granted) {
      expect(action).toMatch(/Harness|AgentRuntime|WorkloadIdentity|TagResource/);
      expect(action).not.toMatch(/Gateway|Policy|Memory|Token/);
    }
  });
});

describe("provisioner role: wildcards and the rest", () => {
  it('uses Resource "*" only where the API has no resource scope', () => {
    const wildcard = provisioner.filter((s) => list(s.Resource).includes("*"));
    const allowed = new Set(["bedrock-agentcore:ListHarnesses", "xray:PutTraceSegments", "xray:PutTelemetryRecords"]);
    for (const statement of wildcard) for (const action of actions(statement)) expect(allowed).toContain(action);
    expect(wildcard.flatMap(actions)).toContain("bedrock-agentcore:ListHarnesses");
  });

  it("governs only the runtime log groups of this installation's agents", () => {
    const logs = bySid(provisioner, "GovernRuntimeLogGroups");
    expect(logs.Resource).toEqual([logGroups, `${logGroups}:*`]);
    expect(actions(logs)).not.toContain("logs:PutLogEvents");
    expect(actions(logs)).not.toContain("logs:GetLogEvents");
  });

  it("writes only publication state in the Agents table", () => {
    const write = bySid(provisioner, "WritePublicationState");
    expect(actions(write)).toEqual(["dynamodb:UpdateItem"]);
    expect(write.Resource).toEqual({ "Fn::GetAtt": [agentsId, "Arn"] });
    expect(write.Condition!["ForAllValues:StringLike"]).toEqual({ "dynamodb:LeadingKeys": ["AGENT#*"] });
    const attributes = write.Condition!["ForAllValues:StringEquals"]!["dynamodb:Attributes"] as string[];
    expect(attributes).toEqual(PROVISIONER_WRITABLE_ATTRIBUTES);
    for (const owned of ["definition", "approved_by", "created_by", "editors", "revision", "latest_version"]) {
      expect(attributes).not.toContain(owned);
    }
    expect(write.Condition!.StringEqualsIfExists).toEqual({
      "dynamodb:ReturnValues": ["NONE", "UPDATED_OLD", "UPDATED_NEW"],
    });
  });

  it("is the only writer of the published pointer, and writes nothing else with PutItem there", () => {
    const pointer = bySid(provisioner, "WritePublishedPointer");
    expect(actions(pointer)).toEqual(["dynamodb:PutItem"]);
    expect(pointer.Condition).toEqual({ "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["PUBLISHED#*"] } });
    const agentsWrites = provisioner.filter(
      (s) =>
        JSON.stringify(s.Resource).includes(agentsId) &&
        actions(s).some((a) => /dynamodb:(Put|Update|Delete|BatchWrite)/.test(a)),
    );
    expect(agentsWrites.map((s) => s.Sid).sort()).toEqual(["WritePublicationState", "WritePublishedPointer"]);
    const granted = provisioner.flatMap(actions);
    for (const forbidden of ["dynamodb:DeleteItem", "dynamodb:Scan", "dynamodb:Query", "dynamodb:BatchWriteItem"]) {
      expect(granted).not.toContain(forbidden);
    }
  });

  it("reads only the model catalog from Settings and only appends to the audit trail", () => {
    const catalog = bySid(provisioner, "ReadModelCatalog");
    expect(actions(catalog)).toEqual(["dynamodb:GetItem"]);
    expect(catalog.Condition).toEqual({ "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["MODELS"] } });
    expect(actions(bySid(provisioner, "WriteAuditIndex"))).toEqual(["dynamodb:PutItem"]);
    expect(actions(bySid(provisioner, "WriteAuditTrail"))).toEqual(["firehose:PutRecord"]);
    const dataKey = bySid(provisioner, "DataKeyViaDynamoDB");
    expect(dataKey.Condition).toEqual({ StringEquals: { "kms:ViaService": `dynamodb.${region}.amazonaws.com` } });
  });

  it("has no managed policies and is assumed only by Lambda", () => {
    const role = resources[provisionerRoleId]!;
    expect(role.Properties.ManagedPolicyArns).toBeUndefined();
    expect(role.Properties.AssumeRolePolicyDocument.Statement).toEqual([
      { Action: "sts:AssumeRole", Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" } },
    ]);
  });
});

describe("agent permissions boundary", () => {
  const statements = resources[boundaryId]!.Properties.PolicyDocument.Statement as Statement[];
  const granted = statements.flatMap(actions);

  it("only allows what an agent runtime needs", () => {
    expect(statements.every((s) => s.Effect === "Allow")).toBe(true);
    expect(granted.sort()).toEqual([
      "bedrock-agentcore:GetWorkloadAccessToken",
      "bedrock-agentcore:GetWorkloadAccessTokenForJWT",
      "bedrock:ApplyGuardrail",
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
      "cloudwatch:PutMetricData",
      "ecr-public:GetAuthorizationToken",
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:DescribeLogStreams",
      "logs:PutLogEvents",
      "sts:GetServiceBearerToken",
      "xray:PutTelemetryRecords",
      "xray:PutTraceSegments",
    ]);
  });

  it("gives no access to IAM, data stores, secrets, role assumption or other compute", () => {
    for (const action of granted) {
      expect(action).not.toMatch(/^(iam|dynamodb|s3|secretsmanager|ssm|kms|lambda|states|ec2|organizations|ce):/);
      expect(action).not.toBe("sts:AssumeRole");
      expect(action.endsWith("*")).toBe(false);
    }
  });

  it("limits logs, identity and the guardrail to this installation", () => {
    expect(bySid(statements, "RuntimeLogs").Resource).toBe(logGroups);
    expect(JSON.stringify(bySid(statements, "WorkloadIdentity").Resource)).toContain(
      `workload-identity/harness_Mango_${ns}_a_*`,
    );
    expect(bySid(statements, "ApplyBaseGuardrail").Resource).toEqual({
      "Fn::GetAtt": ["FinOpsAgentGuardrailEC59A646", "GuardrailArn"],
    });
    expect(bySid(statements, "Metrics").Condition).toEqual({
      StringEquals: { "cloudwatch:namespace": "bedrock-agentcore" },
    });
  });

  it("is not attached to anything by the stack", () => {
    const boundary = resources[boundaryId]!.Properties;
    expect(boundary.Roles).toBeUndefined();
    expect(boundary.Users).toBeUndefined();
    expect(boundary.Groups).toBeUndefined();
  });
});

describe("shared agent resources keep their identity (no replacement on upgrade)", () => {
  it("keeps the logical ids of the guardrail and the runtime logs key", () => {
    expect(resources.FinOpsAgentGuardrailEC59A646!.Type).toBe("AWS::Bedrock::Guardrail");
    expect(resources.FinOpsAgentGuardrailEC59A646!.Properties.Name).toBe(`Mango-${ns}-base`);
    expect(resources.FinOpsAgentGuardrailVersion2A836BE7!.Type).toBe("AWS::Bedrock::GuardrailVersion");
    expect(resources.FinOpsAgentRuntimeLogsKey5A378BE8!.Type).toBe("AWS::KMS::Key");
    expect(resources.FinOpsAgentRuntimeLogsKeyAliasD7F791BF!.Properties.AliasName).toBe(
      `alias/Mango-${ns}-agent-runtime-logs`,
    );
    template.resourceCountIs("AWS::Bedrock::Guardrail", 1);
  });

  it("lets CloudWatch Logs use the key only for agent runtime log groups", () => {
    const statements = resources.FinOpsAgentRuntimeLogsKey5A378BE8!.Properties.KeyPolicy.Statement as (Statement & {
      Principal: { Service?: string };
    })[];
    const logs = statements.filter((s) => s.Principal.Service === `logs.${region}.amazonaws.com`);
    expect(logs.length).toBeGreaterThan(0);
    for (const statement of logs) {
      const condition = JSON.stringify(statement.Condition);
      expect(condition).toContain("kms:EncryptionContext:aws:logs:arn");
      expect(condition).toContain("/aws/bedrock-agentcore/runtimes/");
    }
    expect(logs.some((s) => JSON.stringify(s.Condition).includes(logGroups))).toBe(true);
  });
});

describe("mango-api and the provisioner (TM-M2, TM-M11)", () => {
  it("invokes harnesses of provisioned agents by prefix", () => {
    const invoke = bySid(api, "InvokeAgentHarnesses");
    expect(actions(invoke).sort()).toEqual([
      "bedrock-agentcore:InvokeAgentRuntime",
      "bedrock-agentcore:InvokeHarness",
    ]);
    expect(invoke.Resource).toEqual([harnesses, `${harnesses}/harness-endpoint/*`, runtimes, `${runtimes}/*`]);
  });

  it("is the only role that can invoke a harness", () => {
    for (const [id, resource] of Object.entries(resources)) {
      if (resource.Type !== "AWS::IAM::Policy") continue;
      const invokes = (resource.Properties.PolicyDocument.Statement as Statement[]).some((s) =>
        actions(s).some((a) => a.startsWith("bedrock-agentcore:InvokeHarness")),
      );
      if (invokes) expect(resource.Properties.Roles, id).toEqual([{ Ref: apiRoleId }]);
    }
  });

  it("starts only the provisioner state machines (agents here; packs in packs.test.ts; D48 in deprovisioner.test.ts)", () => {
    const start = bySid(api, "StartAgentProvisioner");
    expect(actions(start)).toEqual(["states:StartExecution"]);
    expect(start.Resource).toEqual({ Ref: machineId });
    const states = api.filter((s) => actions(s).some((a) => a.startsWith("states:")));
    expect(states.map((s) => s.Sid).sort()).toEqual([
      "ListAgentDeprovisions",
      "StartAgentDeprovisioner",
      "StartAgentProvisioner",
      "StartPackProvisioner",
    ]);
    // Besides starting them, it only lists the removals of retired agents (deprovisioner.test.ts).
    expect([...new Set(states.flatMap(actions))].sort()).toEqual(["states:ListExecutions", "states:StartExecution"]);
  });

  it("is denied writing the published pointer", () => {
    const deny = bySid(api, "PublishedPointerIsProvisionerOnly");
    expect(deny.Effect).toBe("Deny");
    expect(actions(deny).sort()).toEqual(["dynamodb:DeleteItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]);
    expect(deny.Resource).toEqual({ "Fn::GetAtt": [agentsId, "Arn"] });
    expect(deny.Condition).toEqual({ "ForAnyValue:StringLike": { "dynamodb:LeadingKeys": ["PUBLISHED#*"] } });
  });

  it("has no write access to IAM or to the AgentCore control plane", () => {
    const granted = api.filter((s) => s.Effect === "Allow").flatMap(actions);
    expect(granted.filter((a) => a.startsWith("iam:"))).toEqual([]);
    expect(
      granted.filter((a) => a.startsWith("bedrock-agentcore:") && !a.startsWith("bedrock-agentcore:Invoke")),
    ).toEqual([]);
  });

  it("gets the state machine ARN in its environment", () => {
    const task = Object.values(template.findResources("AWS::ECS::TaskDefinition"))[0]!;
    const env = task.Properties.ContainerDefinitions[0].Environment as { Name: string; Value: unknown }[];
    expect(env.find((e) => e.Name === "PROVISIONER_STATE_MACHINE_ARN")!.Value).toEqual({ Ref: machineId });
  });
});

describe("provisioner function and state machine", () => {
  const fn = resources[functionId]!.Properties;
  const machine = resources[machineId]!.Properties;
  const definition = JSON.parse(
    (machine.DefinitionString["Fn::Join"][1] as unknown[]).map((part) => (typeof part === "string" ? part : "LAMBDA")).join(""),
  ) as { StartAt: string; TimeoutSeconds: number; States: Record<string, any> };
  const tasks = Object.entries(definition.States).filter(([, s]) => s.Type === "Task");

  it("configures the function from the stack, with an encrypted environment and no secrets", () => {
    const env = fn.Environment.Variables as Record<string, unknown>;
    expect(Object.keys(env).sort()).toEqual([
      "AGENTS_TABLE",
      "AGENT_BOUNDARY_ARN",
      "AGENT_SESSION_IDLE_SECONDS",
      "AGENT_SESSION_MAX_SECONDS",
      "AUDIT_INDEX_TABLE",
      "AUDIT_STREAM",
      "CONNECTOR_CATALOG",
      "GATEWAY_URL",
      "GUARDRAIL_ID",
      "GUARDRAIL_VERSION",
      "MANGO_ACCOUNT_ID",
      "MANGO_NAMESPACE",
      "RELEASE_AGENTS",
      "RUNTIME_LOGS_KEY_ARN",
      "SETTINGS_TABLE",
    ]);
    expect(env.AGENT_BOUNDARY_ARN).toEqual({ Ref: boundaryId });
    expect(env.MANGO_NAMESPACE).toBe(ns);
    expect(fn.KmsKeyArn).toBeDefined();
    expect(fn.Runtime).toBe("python3.13");
    expect(fn.Role).toEqual({ "Fn::GetAtt": [provisionerRoleId, "Arn"] });
  });

  it("ships the connector catalog of the release", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../connectors/cost-explorer/manifest.json"), "utf8"),
    ) as { id: string; gateway_target: string; tools: { name: string; access: string }[] };
    const catalog = JSON.parse(fn.Environment.Variables.CONNECTOR_CATALOG as string);
    expect(catalog).toEqual(connectorCatalog());
    expect(catalog[manifest.id].target).toBe(manifest.gateway_target);
    expect(Object.keys(catalog[manifest.id].tools).sort()).toEqual(manifest.tools.map((t) => t.name).sort());
  });

  it("can only be invoked by its state machine", () => {
    // No resource-based permission: only identity policies can allow invoking it.
    for (const permission of Object.values(template.findResources("AWS::Lambda::Permission"))) {
      expect(JSON.stringify(permission.Properties.FunctionName)).not.toContain(functionId);
    }
    for (const [id, resource] of Object.entries(resources)) {
      if (resource.Type !== "AWS::IAM::Policy") continue;
      const invokes = (resource.Properties.PolicyDocument.Statement as Statement[]).some(
        (s) => actions(s).includes("lambda:InvokeFunction") && JSON.stringify(s.Resource).includes(functionId),
      );
      if (invokes) expect(id).toMatch(/^ProvisionerStateMachineRole/);
    }
  });

  it("is a standard workflow with logs (no execution data), tracing and a timeout", () => {
    expect(machine.StateMachineType).toBe("STANDARD");
    expect(machine.TracingConfiguration).toEqual({ Enabled: true });
    expect(machine.LoggingConfiguration.Level).toBe("ALL");
    expect(machine.LoggingConfiguration.IncludeExecutionData).toBe(false);
    expect(definition.TimeoutSeconds).toBe(25 * 60);
    const logGroup = resources[machine.LoggingConfiguration.Destinations[0].CloudWatchLogsLogGroup.LogGroupArn["Fn::GetAtt"][0]]!;
    expect(logGroup.Properties.LogGroupName).toBe(`/aws/vendedlogs/states/Mango-${ns}-AgentProvisioner`);
    expect(logGroup.Properties.KmsKeyId).toBeDefined();
    expect(logGroup.Properties.RetentionInDays).toBeDefined();
  });

  it("runs the steps in order and gives each one only the state and the execution name", () => {
    expect(definition.StartAt).toBe("Load");
    const steps = Object.fromEntries(tasks.map(([name, s]) => [name, s.Parameters.step]));
    expect(steps).toEqual({
      Load: "load",
      EnsureRole: "ensure_role",
      EnsureHarness: "ensure_harness",
      CheckHarness: "check_harness",
      PointLive: "point_live",
      CheckLive: "check_live",
      GovernLogs: "govern_logs",
      Publish: "publish",
      Compensate: "compensate",
      MarkFailed: "mark_failed",
    });
    for (const [, task] of tasks) {
      expect(task.Resource).toBe("LAMBDA");
      expect(task.Parameters).toEqual({
        step: task.Parameters.step,
        "state.$": "$",
        "execution.$": "$$.Execution.Name",
      });
      expect(task.TimeoutSeconds).toBeDefined();
    }
    const s = definition.States;
    expect(s.Load.Next).toBe("AlreadyPublished?");
    expect(s["AlreadyPublished?"].Choices).toEqual([{ Variable: "$.action", StringEquals: "noop", Next: "NothingToDo" }]);
    expect(s["AlreadyPublished?"].Default).toBe("EnsureRole");
    expect(s.EnsureRole.Next).toBe("EnsureHarness");
    expect(s.EnsureHarness.Next).toBe("WaitHarness");
    expect(s.WaitHarness.Next).toBe("CheckHarness");
    expect(s["HarnessReady?"].Default).toBe("WaitHarness");
    expect(s["HarnessReady?"].Choices[0].Next).toBe("PointLive");
    expect(s.PointLive.Next).toBe("WaitLive");
    expect(s["LiveReady?"].Default).toBe("WaitLive");
    expect(s["LiveReady?"].Choices[0].Next).toBe("GovernLogs");
    expect(s.GovernLogs.Next).toBe("Publish");
    expect(s.Publish.Next).toBe("Published");
    expect(s.Published.Type).toBe("Succeed");
  });

  it("sends every failure through compensation and then marks the version as failed", () => {
    const forward = tasks.filter(([name]) => !["Compensate", "MarkFailed"].includes(name));
    expect(forward).toHaveLength(8);
    for (const [, task] of forward) {
      expect(task.Catch).toEqual([{ ErrorEquals: ["States.ALL"], ResultPath: "$.error", Next: "Compensate" }]);
      expect(task.Retry.some((r: { ErrorEquals: string[] }) => r.ErrorEquals.includes("RetryableStepError"))).toBe(true);
    }
    const s = definition.States;
    expect(s.Compensate.Next).toBe("MarkFailed");
    expect(s.Compensate.Catch).toEqual([
      { ErrorEquals: ["States.ALL"], ResultPath: "$.compensation_error", Next: "MarkFailed" },
    ]);
    // Deleting a harness that was never published takes minutes.
    const retry = s.Compensate.Retry.find((r: { ErrorEquals: string[] }) => r.ErrorEquals.includes("RetryableStepError"));
    expect(retry.IntervalSeconds * retry.MaxAttempts).toBeGreaterThanOrEqual(300);
    expect(s.MarkFailed.Next).toBe("PublicationFailed");
    expect(s.PublicationFailed.Type).toBe("Fail");
    // The execution only succeeds when the version is published or there was nothing to do.
    const succeed = Object.entries(s).filter(([, state]) => state.Type === "Succeed").map(([name]) => name);
    expect(succeed.sort()).toEqual(["NothingToDo", "Published"]);
  });
});
