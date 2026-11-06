import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { loadInstallation } from "../lib/config/schema.js";
import { CoreStack } from "../lib/stacks/core-stack.js";
import { fromCore, nestedStacks } from "./nested.js";

/* The trace reader of the Observability view (D108 (b); TM-OB5). */

const cfg = loadInstallation(resolve(import.meta.dirname, "../config/example.json"));
const ns = cfg.namespace;
const account = cfg.mangoAccountId;
const region = cfg.region;

type Resource = { Type: string; Properties: any; [k: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const core = new CoreStack(new App({ context: { skipSpa: true } }), "Core", { installation: cfg, env: { account, region } });
const template = fromCore(core);
const resources = template.toJSON().Resources as Record<string, Resource>;

interface Statement {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource: unknown;
  Condition?: unknown;
}

const name = `Mango-${ns}-TraceReader`;
const logicalId = (type: string, props: Record<string, unknown>): string => {
  const ids = Object.keys(template.findResources(type, { Properties: props }));
  expect(ids, JSON.stringify(props)).toHaveLength(1);
  return ids[0]!;
};
const roleId = logicalId("AWS::IAM::Role", { RoleName: name });
const functionId = logicalId("AWS::Lambda::Function", { FunctionName: name });
const policiesOf = (id: string) =>
  Object.values(resources).filter(
    (r) =>
      (r.Type === "AWS::IAM::Policy" || r.Type === "AWS::IAM::ManagedPolicy") &&
      (r.Properties.Roles ?? []).some((x: { Ref: string }) => x.Ref === id),
  );
const statements = policiesOf(roleId).flatMap((r) => r.Properties.PolicyDocument.Statement as Statement[]);
const actions = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
const text = (value: unknown) => JSON.stringify(value);

describe("the trace reader (D108 (b))", () => {
  it("lives in the nested stack Traces, not in Core", () => {
    const traces = nestedStacks(core).find((s) => s.node.id === "Traces");
    expect(traces).toBeDefined();
    const own = Template.fromStack(core).toJSON().Resources as Record<string, Resource>;
    for (const id of [roleId, functionId]) expect(own[id]).toBeUndefined();
  });

  it("is a synchronous function with the namespace only in its environment, encrypted, and no DLQ", () => {
    const fn = resources[functionId]!.Properties;
    expect(fn.Environment.Variables).toEqual({ MANGO_NAMESPACE: ns });
    expect(fn.KmsKeyArn).toBeDefined();
    expect(fn.DeadLetterConfig).toBeUndefined();
    expect(fn.Timeout).toBe(25);
    expect(fn.Handler).toBe("mango_trace_reader.handler.lambda_handler");
  });

  it("may query or filter aws/spans and the installation's runtime log groups, read its own queries, list log groups, and nothing else", () => {
    // Besides X-Ray (every function) and writing its own log group.
    const logs = statements.filter((s) => actions(s).includes("logs:PutLogEvents"));
    expect(logs).toHaveLength(1);
    expect(text(logs[0]!.Resource)).toContain("TraceReaderFunctionLogs");
    const own = statements.filter((s) => s.Sid !== undefined);
    expect(statements.filter((s) => s.Sid === undefined)).toHaveLength(2);
    expect(own.map((s) => s.Sid).sort()).toEqual([
      "FindRuntimeLogGroups",
      "NeverTheEvalsHarness",
      "QueryAgentSpans",
      "ReadAgentSpans",
      "ReadOwnQueries",
    ]);
    const deny = own.find((s) => s.Sid === "NeverTheEvalsHarness")!;
    expect(deny.Effect).toBe("Deny");
    expect(text(deny.Resource)).toContain(`:log-group:/aws/bedrock-agentcore/runtimes/harness_Mango_${ns}_a_evals-*`);
    // The Deny covers Logs Insights too: no query of the reader may name the evals log groups (D113).
    expect(deny.Action).toBe("logs:*");
    const read = own.find((s) => s.Sid === "ReadAgentSpans")!;
    expect(actions(read)).toEqual(["logs:FilterLogEvents"]);
    const query = own.find((s) => s.Sid === "QueryAgentSpans")!;
    expect(actions(query)).toEqual(["logs:StartQuery"]);
    const queried = query.Resource as unknown[];
    expect(queried).toHaveLength(3);
    expect(text(queried)).toContain(`:log-group:aws/spans"`);
    expect(text(queried)).toContain(`:log-group:aws/spans:*`);
    expect(text(queried)).toContain(`:log-group:/aws/bedrock-agentcore/runtimes/harness_Mango_${ns}_a_*`);
    const arns = text(read.Resource);
    expect(arns).toContain(`:log-group:aws/spans:*`);
    expect(arns).toContain(`:log-group:/aws/bedrock-agentcore/runtimes/harness_Mango_${ns}_a_*`);
    expect((read.Resource as unknown[]).length).toBe(2);
    const find = own.find((s) => s.Sid === "FindRuntimeLogGroups")!;
    expect(actions(find)).toEqual(["logs:DescribeLogGroups"]);
    // The query APIs without a resource: its own queries only, and never a way to list others'.
    const queries = own.find((s) => s.Sid === "ReadOwnQueries")!;
    expect(actions(queries)).toEqual(["logs:GetQueryResults", "logs:StopQuery"]);
    expect(queries.Resource).toBe("*");
    expect(statements.flatMap(actions)).not.toContain("logs:DescribeQueries");
    for (const s of statements.filter((x) => x.Sid !== "NeverTheEvalsHarness")) {
      expect(s.Effect).toBe("Allow");
      for (const a of actions(s))
        expect(a).toMatch(
          /^(logs:(StartQuery|GetQueryResults|StopQuery|FilterLogEvents|DescribeLogGroups|CreateLogStream|PutLogEvents)|xray:Put\w+)$/,
        );
    }
  });

  it("may be invoked by mango-api only, from a managed policy of its own on its ARN", () => {
    const apiRoleId = logicalId("AWS::IAM::Role", { RoleName: `Mango-${ns}-ApiTask` });
    const invokers = Object.values(resources).filter(
      (r) =>
        (r.Type === "AWS::IAM::Policy" || r.Type === "AWS::IAM::ManagedPolicy") &&
        text(r.Properties.PolicyDocument).includes(functionId),
    );
    expect(invokers).toHaveLength(1);
    const policy = invokers[0]!.Properties;
    expect(policy.ManagedPolicyName).toBe(`Mango-${ns}-ApiObservability`);
    expect(policy.Roles).toEqual([{ Ref: apiRoleId }]);
    expect(policy.PolicyDocument.Statement).toEqual([
      {
        Sid: "ReadTraces",
        Effect: "Allow",
        Action: "lambda:InvokeFunction",
        Resource: { "Fn::GetAtt": [functionId, "Arn"] },
      },
    ]);
    expect(Object.values(resources).filter((r) => r.Type === "AWS::Lambda::Permission" && text(r).includes(functionId))).toEqual([]);
  });

  it("is named to mango-api by its name", () => {
    const task = Object.values(resources).find((r) => r.Type === "AWS::ECS::TaskDefinition")!;
    const env = task.Properties.ContainerDefinitions[0].Environment as { Name: string; Value: unknown }[];
    expect(env.find((e) => e.Name === "TRACE_READER_FUNCTION")?.Value).toBe(name);
  });
});
