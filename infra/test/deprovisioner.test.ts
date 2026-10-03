import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { loadInstallation } from "../lib/config/schema.js";
import {
  DEPROVISIONER_READABLE_ATTRIBUTES,
  DEPROVISIONER_WRITABLE_ATTRIBUTES,
} from "../lib/constructs/deprovisioner.js";
import { releaseAgents } from "../lib/constructs/release-agents.js";
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

const roleId = logicalId("AWS::IAM::Role", { RoleName: `Mango-${ns}-Deprovisioner` });
const apiRoleId = logicalId("AWS::IAM::Role", { RoleName: `Mango-${ns}-ApiTask` });
const provisionerRoleId = logicalId("AWS::IAM::Role", { RoleName: `Mango-${ns}-Provisioner` });
const boundaryId = logicalId("AWS::IAM::ManagedPolicy", { ManagedPolicyName: `Mango-${ns}-agent-boundary` });
const functionId = logicalId("AWS::Lambda::Function", { FunctionName: `Mango-${ns}-Deprovisioner` });
const machineId = logicalId("AWS::StepFunctions::StateMachine", {
  StateMachineName: `Mango-${ns}-AgentDeprovisioner`,
});
const provisionerMachineId = logicalId("AWS::StepFunctions::StateMachine", {
  StateMachineName: `Mango-${ns}-AgentProvisioner`,
});
const agentsId = logicalId("AWS::DynamoDB::GlobalTable", { TableName: `Mango-${ns}-Agents` });
const topicId = logicalId("AWS::SNS::Topic", { TopicName: `Mango-${ns}-Alerts` });
const allStatements = statementsOf(roleId);
const deprovisioner = allStatements.filter((s) => s.Effect === "Allow");
const api = statementsOf(apiRoleId);
const granted = [...new Set(deprovisioner.flatMap(actions))].sort();

const agentRoles = `arn:aws:iam::${account}:role/Mango-${ns}-agent-*`;
const agentcore = `arn:aws:bedrock-agentcore:${region}:${account}`;
const harnesses = `${agentcore}:harness/Mango_${ns}_a_*`;
const runtimes = `${agentcore}:runtime/harness_Mango_${ns}_a_*`;

describe("deprovisioner role: delete-only, on agent names (D48)", () => {
  it("has exactly these actions", () => {
    expect(granted).toEqual([
      "bedrock-agentcore:DeleteAgentRuntime",
      "bedrock-agentcore:DeleteAgentRuntimeEndpoint",
      "bedrock-agentcore:DeleteHarness",
      "bedrock-agentcore:DeleteHarnessEndpoint",
      "bedrock-agentcore:DeleteWorkloadIdentity",
      "bedrock-agentcore:GetAgentRuntime",
      "bedrock-agentcore:GetAgentRuntimeEndpoint",
      "bedrock-agentcore:ListHarnessEndpoints",
      "bedrock-agentcore:ListHarnesses",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "firehose:PutRecord",
      "iam:DeleteRole",
      "iam:DeleteRolePolicy",
      "iam:GetRole",
      "iam:ListRolePolicies",
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "xray:PutTelemetryRecords",
      "xray:PutTraceSegments",
    ]);
  });

  it("is denied the agents of the release, whatever the function or the table say", () => {
    const denies = allStatements.filter((s) => s.Effect === "Deny");
    expect(denies.map((s) => s.Sid)).toEqual(["NeverTheAgentsOfTheRelease"]);
    const deny = denies[0]!;
    expect(deny.Condition).toBeUndefined();
    // Every delete the role is allowed is denied for them.
    expect(actions(deny).sort()).toEqual(granted.filter((a) => /:Delete/.test(a)).sort());
    const shipped = releaseAgents(cfg).map((a) => a.id).sort();
    expect(shipped).toContain("finops");
    expect(list(deny.Resource)).toEqual(
      shipped.flatMap((id) => [
        `arn:aws:iam::${account}:role/Mango-${ns}-agent-${id}`,
        `${agentcore}:harness/Mango_${ns}_a_${id}-*`,
        `${agentcore}:runtime/harness_Mango_${ns}_a_${id}-*`,
        `${agentcore}:workload-identity-directory/default/workload-identity/harness_Mango_${ns}_a_${id}-*`,
      ]),
    );
  });

  it("cannot create, update, tag, pass or invoke anything", () => {
    for (const action of granted.filter((a) => /^(iam|bedrock-agentcore|sts|lambda|states):/.test(a))) {
      expect(action).toMatch(/:(Delete|Get|List)[A-Za-z]+$/);
    }
    for (const action of granted) expect(action.endsWith("*")).toBe(false);
    for (const forbidden of ["iam:PassRole", "iam:CreateRole", "iam:PutRolePolicy", "sts:AssumeRole"]) {
      expect(granted).not.toContain(forbidden);
    }
    expect(granted.filter((a) => a.startsWith("bedrock:"))).toEqual([]);
  });

  it("deletes harnesses and their endpoints only under Mango_<ns>_a_*, and never reads one", () => {
    const harness = bySid(deprovisioner, "DeleteAgentHarness");
    expect(actions(harness).sort()).toEqual([
      "bedrock-agentcore:DeleteHarness",
      "bedrock-agentcore:DeleteHarnessEndpoint",
      "bedrock-agentcore:ListHarnessEndpoints",
    ]);
    expect(harness.Resource).toEqual([harnesses, `${harnesses}/harness-endpoint/*`]);
    expect(harness.Condition).toBeUndefined();
    // A harness stores the prompt of the agent.
    expect(granted).not.toContain("bedrock-agentcore:GetHarness");
    expect(granted).not.toContain("bedrock-agentcore:GetHarnessEndpoint");
  });

  it("deletes only the managed runtime and the workload identity of those harnesses", () => {
    const runtime = bySid(deprovisioner, "DeleteHarnessRuntime");
    expect(runtime.Resource).toEqual([runtimes, `${runtimes}/runtime-endpoint/*`]);
    const identity = bySid(deprovisioner, "DeleteHarnessWorkloadIdentity");
    expect(actions(identity)).toEqual(["bedrock-agentcore:DeleteWorkloadIdentity"]);
    expect(list(identity.Resource)).toEqual([
      `${agentcore}:workload-identity-directory/default`,
      `${agentcore}:workload-identity-directory/default/workload-identity/harness_Mango_${ns}_a_*`,
    ]);
  });

  it("touches nothing of packs, the Gateway or other AgentCore resources", () => {
    for (const statement of deprovisioner) {
      for (const resource of list(statement.Resource)) {
        const text = JSON.stringify(resource);
        expect(text).not.toContain(`Mango_${ns}_mcp_`);
        expect(text).not.toContain(`Mango-${ns}-mcp-`);
        expect(text).not.toMatch(/gateway|policy-engine|memory/);
      }
    }
  });

  it("deletes roles only under the agent prefix, and their policies only with the boundary", () => {
    const iamStatements = deprovisioner.filter((s) => actions(s).some((a) => a.startsWith("iam:")));
    expect(iamStatements.map((s) => s.Sid).sort()).toEqual([
      "DeleteAgentRole",
      "DeleteAgentRolePolicyWithBoundary",
      "ReadAgentRole",
    ]);
    for (const statement of iamStatements) expect(statement.Resource).toBe(agentRoles);
    const policy = bySid(deprovisioner, "DeleteAgentRolePolicyWithBoundary");
    expect(actions(policy)).toEqual(["iam:DeleteRolePolicy"]);
    expect(policy.Condition).toEqual({ StringEquals: { "iam:PermissionsBoundary": { Ref: boundaryId } } });
    expect(actions(bySid(deprovisioner, "DeleteAgentRole"))).toEqual(["iam:DeleteRole"]);
  });

  it("does not match its own role or any other role of the stack", () => {
    const names = Object.values(resources)
      .filter((r) => r.Type === "AWS::IAM::Role" && typeof r.Properties.RoleName === "string")
      .map((r) => r.Properties.RoleName as string);
    expect(names).toContain(`Mango-${ns}-Deprovisioner`);
    for (const name of names) expect(name.toLowerCase().startsWith(`mango-${ns}-agent-`)).toBe(false);
  });

  it('uses Resource "*" only where the API has no resource scope', () => {
    const wildcard = deprovisioner.filter((s) => list(s.Resource).includes("*"));
    const allowed = new Set(["bedrock-agentcore:ListHarnesses", "xray:PutTraceSegments", "xray:PutTelemetryRecords"]);
    for (const statement of wildcard) for (const action of actions(statement)) expect(allowed).toContain(action);
  });
});

describe("deprovisioner role: data", () => {
  it("reads the state of an agent without its content", () => {
    const read = bySid(deprovisioner, "ReadAgentStateWithoutContent");
    expect(actions(read)).toEqual(["dynamodb:GetItem"]);
    expect(read.Resource).toEqual({ "Fn::GetAtt": [agentsId, "Arn"] });
    expect(read.Condition).toEqual({
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["AGENT#*", "PUBLISHED#*"] },
      "ForAllValues:StringEquals": { "dynamodb:Attributes": DEPROVISIONER_READABLE_ATTRIBUTES },
      StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
    });
    for (const content of ["definition", "approved_by", "created_by", "retire_reason", "retired_by_email"]) {
      expect(DEPROVISIONER_READABLE_ATTRIBUTES).not.toContain(content);
    }
  });

  it("allows exactly the attributes the function projects", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../../functions/provisioner/src/mango_provisioner/deprovision/store.py"),
      "utf8",
    );
    const block = /READ_ATTRIBUTES = \(([^)]*)\)/.exec(source)![1]!;
    expect([...block.matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual(DEPROVISIONER_READABLE_ATTRIBUTES);
  });

  it("writes only the provisioner lock in the Agents table", () => {
    const lock = bySid(deprovisioner, "HoldAgentLock");
    expect(actions(lock)).toEqual(["dynamodb:UpdateItem"]);
    expect(lock.Condition).toEqual({
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["AGENT#*"] },
      "ForAllValues:StringEquals": { "dynamodb:Attributes": DEPROVISIONER_WRITABLE_ATTRIBUTES },
      StringEqualsIfExists: { "dynamodb:ReturnValues": ["NONE", "UPDATED_OLD", "UPDATED_NEW"] },
    });
    expect(DEPROVISIONER_WRITABLE_ATTRIBUTES).toEqual(["PK", "SK", "provision_lock", "provision_lock_until"]);
    const agentsWrites = deprovisioner.filter(
      (s) =>
        JSON.stringify(s.Resource).includes(agentsId) &&
        actions(s).some((a) => /dynamodb:(Put|Update|Delete|BatchWrite)/.test(a)),
    );
    expect(agentsWrites.map((s) => s.Sid)).toEqual(["HoldAgentLock"]);
    for (const forbidden of ["dynamodb:DeleteItem", "dynamodb:Scan", "dynamodb:Query", "dynamodb:BatchWriteItem"]) {
      expect(granted).not.toContain(forbidden);
    }
  });

  it("only appends to the audit trail, and uses the data key only through DynamoDB", () => {
    const index = bySid(deprovisioner, "WriteAuditIndex");
    expect(actions(index)).toEqual(["dynamodb:PutItem"]);
    expect(index.Condition).toEqual({ "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DAY#*"] } });
    expect(JSON.stringify(index.Resource)).not.toContain(agentsId);
    expect(actions(bySid(deprovisioner, "WriteAuditTrail"))).toEqual(["firehose:PutRecord"]);
    expect(bySid(deprovisioner, "DataKeyViaDynamoDB").Condition).toEqual({
      StringEquals: { "kms:ViaService": `dynamodb.${region}.amazonaws.com` },
    });
  });

  it("has no managed policies, is assumed only by Lambda and is not the provisioner's role", () => {
    const role = resources[roleId]!;
    expect(role.Properties.ManagedPolicyArns).toBeUndefined();
    expect(role.Properties.AssumeRolePolicyDocument.Statement).toEqual([
      { Action: "sts:AssumeRole", Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" } },
    ]);
    expect(roleId).not.toBe(provisionerRoleId);
    expect(resources[functionId]!.Properties.Role).toEqual({ "Fn::GetAtt": [roleId, "Arn"] });
  });
});

describe("deprovisioner function and state machine", () => {
  const fn = resources[functionId]!.Properties;
  const definition = JSON.stringify(resources[machineId]!.Properties.DefinitionString);
  // The definition is an Fn::Join around the function ARN: parse the states from its text parts.
  const machine = JSON.parse(
    (resources[machineId]!.Properties.DefinitionString["Fn::Join"][1] as unknown[])
      .map((part) => (typeof part === "string" ? part : "ARN"))
      .join(""),
  ) as { StartAt: string; TimeoutSeconds: number; States: Record<string, any> };

  it("runs the deprovision handler of the provisioner package with identifiers only", () => {
    expect(fn.Handler).toBe("mango_provisioner.deprovision.handler.lambda_handler");
    expect(Object.keys(fn.Environment.Variables).sort()).toEqual([
      "AGENTS_TABLE",
      "AGENT_BOUNDARY_ARN",
      "AUDIT_INDEX_TABLE",
      "AUDIT_STREAM",
      "MANGO_ACCOUNT_ID",
      "MANGO_NAMESPACE",
      "RELEASE_AGENTS",
    ]);
    expect(fn.KmsKeyArn).toBeDefined();
    // The agents of the release are named by the stack: the function never deletes them.
    expect(Object.keys(JSON.parse(fn.Environment.Variables.RELEASE_AGENTS)).sort()).toEqual(
      releaseAgents(cfg)
        .map((a) => a.id)
        .sort(),
    );
  });

  it("deletes endpoints, then the harness, then the role, polling each deletion", () => {
    expect(machine.StartAt).toBe("Load");
    const next = (state: string) => machine.States[state].Next as string;
    expect(next("Load")).toBe("Action?");
    const action = machine.States["Action?"];
    expect(action.Choices).toEqual([
      { Variable: "$.action", StringEquals: "deprovision", Next: "DeleteEndpoints" },
    ]);
    expect(action.Default).toBe("NothingToDo");
    expect(machine.States.NothingToDo.Type).toBe("Succeed");

    expect(next("DeleteEndpoints")).toBe("EndpointsGone?");
    expect(machine.States["EndpointsGone?"].Choices[0].Next).toBe("DeleteHarness");
    expect(machine.States["EndpointsGone?"].Default).toBe("WaitEndpoints");
    expect(next("WaitEndpoints")).toBe("DeleteEndpoints");
    expect(next("DeleteHarness")).toBe("HarnessGone?");
    expect(machine.States["HarnessGone?"].Choices[0].Next).toBe("DeleteRole");
    expect(machine.States["HarnessGone?"].Default).toBe("WaitHarness");
    expect(next("WaitHarness")).toBe("DeleteHarness");
    expect(next("DeleteRole")).toBe("Finish");
    expect(next("Finish")).toBe("Deprovisioned");
    expect(machine.States.Deprovisioned.Type).toBe("Succeed");
  });

  it("sends each step only the state and the execution name from the context", () => {
    const steps: Record<string, string> = {
      Load: "load",
      DeleteEndpoints: "delete_endpoints",
      DeleteHarness: "delete_harness",
      DeleteRole: "delete_role",
      Finish: "finish",
      MarkFailed: "mark_failed",
    };
    const tasks = Object.entries(machine.States).filter(([, s]) => s.Type === "Task");
    expect(tasks.map(([name]) => name).sort()).toEqual(Object.keys(steps).sort());
    for (const [name, state] of tasks) {
      expect(state.Parameters).toEqual({
        step: steps[name],
        "state.$": "$",
        "execution.$": "$$.Execution.Name",
      });
      expect(state.Resource).toBe("ARN");
    }
    expect(definition).toContain(functionId);
  });

  it("audits every failure and never undoes a removal", () => {
    for (const name of ["Load", "DeleteEndpoints", "DeleteHarness", "DeleteRole", "Finish"]) {
      expect(machine.States[name].Catch).toEqual([
        { ErrorEquals: ["States.ALL"], ResultPath: "$.error", Next: "MarkFailed" },
      ]);
    }
    expect(machine.States.MarkFailed.Next).toBe("DeprovisionFailed");
    expect(machine.States.DeprovisionFailed.Type).toBe("Fail");
    expect(Object.keys(machine.States)).not.toContain("Compensate");
  });

  it("waits for a running publication to let go of the agent", () => {
    const busy = (machine.States.Load.Retry as any[]).find((r) => r.ErrorEquals.includes("RetryableStepError"));
    // The provisioner stops at 25 minutes: 60 attempts every 30 seconds cover it.
    expect(busy.IntervalSeconds * busy.MaxAttempts).toBeGreaterThanOrEqual(25 * 60);
    expect(busy.BackoffRate).toBe(1);
    expect(machine.TimeoutSeconds).toBe(80 * 60);
  });

  it("logs without execution data and traces", () => {
    const props = resources[machineId]!.Properties;
    expect(props.LoggingConfiguration).toMatchObject({ IncludeExecutionData: false, Level: "ALL" });
    expect(props.TracingConfiguration).toEqual({ Enabled: true });
    expect(props.StateMachineType).toBe("STANDARD");
  });
});

describe("who can start a deprovision", () => {
  it("is only mango-api, on exactly this state machine", () => {
    const start = bySid(api, "StartAgentDeprovisioner");
    expect(actions(start)).toEqual(["states:StartExecution"]);
    expect(start.Resource).toEqual({ Ref: machineId });
    const starters = Object.values(resources)
      .filter((r) => r.Type === "AWS::IAM::Policy")
      .flatMap((r) => r.Properties.PolicyDocument.Statement as Statement[])
      .filter((s) => actions(s).includes("states:StartExecution") && JSON.stringify(s.Resource).includes(machineId));
    expect(starters).toHaveLength(1);
  });

  it("lets mango-api list the executions of this state machine, and nothing else about them", () => {
    const list = bySid(api, "ListAgentDeprovisions");
    expect(actions(list)).toEqual(["states:ListExecutions"]);
    expect(list.Resource).toEqual({ Ref: machineId });
    const apiStates = api
      .filter((s) => s.Effect === "Allow" && JSON.stringify(s.Resource).includes(machineId))
      .flatMap(actions)
      .sort();
    expect(apiStates).toEqual(["states:ListExecutions", "states:StartExecution"]);
    const allStates = api.filter((s) => s.Effect === "Allow").flatMap(actions).filter((a) => a.startsWith("states:"));
    for (const forbidden of ["states:DescribeExecution", "states:GetExecutionHistory", "states:StopExecution", "states:*"]) {
      expect(allStates).not.toContain(forbidden);
    }
  });

  it("gives mango-api the state machine and still no way to delete agent resources itself", () => {
    const container = Object.values(resources).find((r) => r.Type === "AWS::ECS::TaskDefinition")!;
    const env = container.Properties.ContainerDefinitions[0].Environment as { Name: string; Value: unknown }[];
    expect(env.find((e) => e.Name === "DEPROVISIONER_STATE_MACHINE_ARN")!.Value).toEqual({ Ref: machineId });
    const apiActions = api.filter((s) => s.Effect === "Allow").flatMap(actions);
    for (const forbidden of [
      "bedrock-agentcore:DeleteHarness",
      "bedrock-agentcore:DeleteHarnessEndpoint",
      "iam:DeleteRole",
      "iam:DeleteRolePolicy",
    ]) {
      expect(apiActions).not.toContain(forbidden);
    }
  });

  it("exports the state machine for the operator", () => {
    template.hasOutput("AgentDeprovisionerArn", { Value: { Ref: machineId } });
    expect(machineId).not.toBe(provisionerMachineId);
  });
});

describe("a failed removal alarms", () => {
  it("on failed, timed-out or aborted deprovisioner executions, to the alerts topic", () => {
    const alarm = resources[logicalId("AWS::CloudWatch::Alarm", { AlarmName: `Mango-${ns}-AgentDeprovisioner-failed` })]!
      .Properties;
    expect(alarm).toMatchObject({
      Threshold: 1,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      TreatMissingData: "notBreaching",
      AlarmActions: [{ Ref: topicId }],
    });
    const metrics = alarm.Metrics as { Expression?: string; MetricStat?: { Metric: any; Stat: string } }[];
    expect(metrics.filter((m) => m.Expression).map((m) => m.Expression)).toEqual(["failed + timedOut + aborted"]);
    const stats = metrics.filter((m) => m.MetricStat).map((m) => m.MetricStat!);
    expect(stats.map((s) => s.Metric.MetricName).sort()).toEqual([
      "ExecutionsAborted",
      "ExecutionsFailed",
      "ExecutionsTimedOut",
    ]);
    for (const stat of stats) {
      expect(stat.Metric.Dimensions).toEqual([{ Name: "StateMachineArn", Value: { Ref: machineId } }]);
    }
  });
});
