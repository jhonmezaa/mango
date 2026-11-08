import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { loadInstallation } from "../lib/config/schema.js";
import { CANARY_BUDGET_KEYS, EVAL_JUDGE_ALARMS, JUDGE_INSTRUCTIONS } from "../lib/constructs/eval-judge.js";
import { ACCOUNT_LOG_EXPORT_ACTIONS, EVALS_CONTENT_ACTIONS, judgeModels } from "../lib/constructs/evals.js";
import { CoreStack } from "../lib/stacks/core-stack.js";
import { fromCore } from "./nested.js";

const cfg = loadInstallation(resolve(import.meta.dirname, "../config/example.json"));
const ns = cfg.namespace;
const account = cfg.mangoAccountId;
const region = cfg.region;

type Resource = { Type: string; Properties: any; [k: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Statement {
  Sid?: string;
  Effect: string;
  Principal?: unknown;
  Action: string | string[];
  Resource: unknown;
  Condition?: Record<string, Record<string, unknown>>;
}

const core = new CoreStack(new App({ context: { skipSpa: true } }), "Core", { installation: cfg, env: { account, region } });
const own = Template.fromStack(core).toJSON().Resources as Record<string, Resource>;
const template = fromCore(core);
const resources = template.toJSON().Resources as Record<string, Resource>;
const actions = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
const resourcesOf = (s: Statement) => (Array.isArray(s.Resource) ? s.Resource : [s.Resource]);

function only(type: string, props: Record<string, unknown>): [string, Resource] {
  const found = Object.entries(template.findResources(type, { Properties: props }));
  expect(found, JSON.stringify(props)).toHaveLength(1);
  return found[0]! as [string, Resource];
}

function statementsOf(roleId: string): Statement[] {
  return Object.values(resources)
    .filter(
      (r) =>
        (r.Type === "AWS::IAM::Policy" || r.Type === "AWS::IAM::ManagedPolicy") &&
        (r.Properties.Roles ?? []).some((x: { Ref: string }) => x.Ref === roleId),
    )
    .flatMap((r) => r.Properties.PolicyDocument.Statement as Statement[]);
}

const judgeName = `Mango-${ns}-EvalJudge`;
const judgeRoleArn = `arn:aws:iam::${account}:role/${judgeName}`;
const [judgeRoleId] = only("AWS::IAM::Role", { RoleName: judgeName });
const judgeStatements = statementsOf(judgeRoleId);
const evalLogGroups = `arn:aws:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/harness_Mango_${ns}_a_evals-*`;

describe("the Evals table (D110, D111)", () => {
  it("is in Core, retained, with PITR and deletion protection, and only mango-api writes it", () => {
    const tables = Object.entries(own).filter(
      ([, r]) => r.Type === "AWS::DynamoDB::GlobalTable" && r.Properties.TableName === `Mango-${ns}-Evals`,
    );
    expect(tables).toHaveLength(1);
    const [, table] = tables[0]!;
    expect(table.DeletionPolicy).toBe("Retain");
    expect(table.Properties.Replicas[0].PointInTimeRecoverySpecification).toEqual({ PointInTimeRecoveryEnabled: true });
    expect(table.Properties.Replicas[0].DeletionProtectionEnabled).toBe(true);
    expect(table.Properties.TimeToLiveSpecification).toEqual({ AttributeName: "ttl", Enabled: true });
    const [, policy] = only("AWS::IAM::ManagedPolicy", { ManagedPolicyName: `Mango-${ns}-ApiEvals` });
    expect(JSON.stringify(policy.Properties.PolicyDocument)).not.toContain('"*"');
  });
});

describe("the key of the evals log groups (D110 (8), TM-EV1)", () => {
  const [, key] = Object.entries(own).find(
    ([id, r]) => r.Type === "AWS::KMS::Key" && id.startsWith("EvalsCaptureLogsKey"),
  )!;
  const policy = key.Properties.KeyPolicy.Statement as Statement[];

  it("keeps its Deny of kms:Decrypt unchanged, which is not what decides who reads (D110 (8), 2026-11-06)", () => {
    // An administrator of the account read the evals log groups with this Deny in place: the
    // key promises nothing about readers until a tested Deny replaces it. IAM decides (below).
    const deny = policy.find((s) => s.Sid === "OnlyTheEvaluatorReadsTheContent")!;
    expect(deny.Effect).toBe("Deny");
    expect(actions(deny)).toEqual(["kms:Decrypt"]);
    expect(deny.Condition).toEqual({
      StringEquals: { "kms:ViaService": `logs.${region}.amazonaws.com` },
      ArnNotEquals: { "aws:PrincipalArn": judgeRoleArn },
      Null: { "aws:PrincipalArn": "false" },
    });
  });

  it("lets CloudWatch Logs use it only for the evals harness's log groups", () => {
    const logs = policy.find((s) => s.Sid === "CloudWatchLogsEvalsHarness")!;
    expect(logs.Condition).toEqual({ ArnLike: { "kms:EncryptionContext:aws:logs:arn": evalLogGroups } });
  });

  it("is not the key of the other runtime log groups", () => {
    const provisioner = Object.values(resources).find(
      (r) => r.Type === "AWS::Lambda::Function" && r.Properties.FunctionName === `Mango-${ns}-Provisioner`,
    )!;
    const env = provisioner.Properties.Environment.Variables;
    expect(env.EVAL_JUDGE_FUNCTION).toBe(judgeName);
    expect(env.EVALS_LOGS_KEY_ARN).toBeDefined();
    expect(env.HARNESS_LOGS_KEY_ARN).toBeDefined();
    expect(env.EVALS_LOGS_KEY_ARN).not.toEqual(env.HARNESS_LOGS_KEY_ARN);
  });
});

describe("who reads the evals content: IAM (D110 (8), 2026-11-06)", () => {
  const [denyId, deny] = only("AWS::IAM::ManagedPolicy", { ManagedPolicyName: `Mango-${ns}-evals-content-deny` });
  const denyStatements = deny.Properties.PolicyDocument.Statement as Statement[];
  const carries = (role: Resource) =>
    JSON.stringify(role.Properties.ManagedPolicyArns ?? []).includes(JSON.stringify({ Ref: denyId }));

  it("denies reading and exporting the evals log groups, Logs Insights and Live Tail included", () => {
    const content = denyStatements.find((s) => s.Sid === "NoEvalsContent")!;
    expect(content.Effect).toBe("Deny");
    expect(resourcesOf(content)).toEqual([evalLogGroups]);
    expect(actions(content)).toEqual([...EVALS_CONTENT_ACTIONS]);
    for (const a of [
      "logs:GetLogEvents", "logs:FilterLogEvents", "logs:GetLogRecord", "logs:Unmask", "logs:StartQuery",
      "logs:GetQueryResults", "logs:StartLiveTail", "logs:CreateExportTask", "logs:PutSubscriptionFilter",
    ]) {
      expect(actions(content)).toContain(a);
    }
    const account = denyStatements.find((s) => s.Sid === "NoAccountWideLogExport")!;
    expect(account.Effect).toBe("Deny");
    expect(resourcesOf(account)).toEqual(["*"]);
    expect(actions(account)).toEqual([...ACCOUNT_LOG_EXPORT_ACTIONS]);
    // Plus the two of the harnesses' runtime log groups (D16, 2026-11-08: harness-logs.test.ts).
    expect(denyStatements).toHaveLength(5);
  });

  it("lets only the provisioner take the key off, by its full ARN (D110 (9))", () => {
    const removal = denyStatements.find((s) => s.Sid === "NoEvalsKeyRemoval")!;
    expect(removal.Effect).toBe("Deny");
    expect(actions(removal)).toEqual(["logs:DisassociateKmsKey"]);
    expect(resourcesOf(removal)).toEqual([evalLogGroups]);
    expect(JSON.stringify(removal.Condition)).toContain(`:role/Mango-${ns}-Provisioner`);
    expect(Object.keys(removal.Condition as object)).toEqual(["ArnNotEquals"]);
    expect(actions(denyStatements.find((s) => s.Sid === "NoEvalsContent")!)).not.toContain("logs:DisassociateKmsKey");
  });

  it("never denies what the evals harness writes with nor what the provisioner sets on its log groups", () => {
    const denied = denyStatements.flatMap(actions);
    for (const a of [
      "logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams",
      "logs:PutResourcePolicy", "logs:DescribeResourcePolicies", "logs:AssociateKmsKey", "logs:PutRetentionPolicy",
      "logs:TagResource", "logs:DeleteLogGroup",
    ]) {
      expect(denied).not.toContain(a);
    }
  });

  it("is attached to every role of Core and of its nested stacks but the evaluator's", () => {
    const roles = Object.entries(resources).filter(([, r]) => r.Type === "AWS::IAM::Role");
    expect(roles.length).toBeGreaterThan(40);
    const without = roles.filter(([, r]) => !carries(r)).map(([id]) => id);
    expect(without).toEqual([judgeRoleId]);
  });

  it("is in the boundary of every role created at runtime: agents, packs and knowledge base sources", () => {
    for (const name of ["agent-boundary", "mcp-boundary", "kbsrc-boundary"]) {
      const [, boundary] = only("AWS::IAM::ManagedPolicy", { ManagedPolicyName: `Mango-${ns}-${name}` });
      const statements = boundary.Properties.PolicyDocument.Statement as Statement[];
      const content = statements.find((s) => s.Sid === "NoEvalsContent")!;
      expect(content.Effect, name).toBe("Deny");
      expect(actions(content)).toEqual([...EVALS_CONTENT_ACTIONS]);
      expect(resourcesOf(content)).toEqual([evalLogGroups]);
      expect(statements.find((s) => s.Sid === "NoAccountWideLogExport")?.Effect, name).toBe("Deny");
      expect(statements.find((s) => s.Sid === "NoEvalsKeyRemoval")?.Effect, name).toBe("Deny");
    }
  });
});

describe("the evaluator's role (D110 (8))", () => {
  it("reads only the evals runtime's log groups and aws/spans, and decrypts only through CloudWatch Logs", () => {
    const reads = judgeStatements.filter((s) => actions(s).includes("logs:FilterLogEvents"));
    expect(reads.flatMap(resourcesOf).sort()).toEqual(
      [
        evalLogGroups,
        `${evalLogGroups}:*`,
        `arn:aws:logs:${region}:${account}:log-group:aws/spans`,
        `arn:aws:logs:${region}:${account}:log-group:aws/spans:*`,
      ].sort(),
    );
    const decrypt = judgeStatements.find((s) => s.Sid === "DecryptTheEvalsTraces")!;
    expect(decrypt.Condition).toEqual({ StringEquals: { "kms:ViaService": `logs.${region}.amazonaws.com` } });
  });

  it("invokes only the judge models of the config, by concrete ARN", () => {
    const invoke = judgeStatements.find((s) => s.Sid === "InvokeTheJudgeModels")!;
    const judges = judgeModels(cfg);
    expect(resourcesOf(invoke)).toHaveLength(judges.length * 2);
    for (const arn of resourcesOf(invoke) as string[]) {
      expect(judges.some((m) => arn.endsWith(m.replace(/^(us|global)\./, "")))).toBe(true);
    }
  });

  it("invokes the evals harness as mango-api invokes one, on that harness and its runtime only (TM-M11)", () => {
    // A managed harness also authorizes InvokeAgentRuntime on its runtime: InvokeHarness alone
    // is denied (v0.1.0-ge926178, 2026-11-06).
    const agentcore = `arn:aws:bedrock-agentcore:${region}:${account}`;
    const harness = `${agentcore}:harness/Mango_${ns}_a_evals-*`;
    const runtime = `${agentcore}:runtime/harness_Mango_${ns}_a_evals-*`;
    const invoke = judgeStatements.filter((s) => actions(s).some((a) => a.startsWith("bedrock-agentcore:Invoke")));
    expect(invoke.map((s) => s.Sid)).toEqual(["InvokeTheEvalsHarness"]);
    expect(actions(invoke[0]!).sort()).toEqual(["bedrock-agentcore:InvokeAgentRuntime", "bedrock-agentcore:InvokeHarness"]);
    expect(resourcesOf(invoke[0]!)).toEqual([harness, `${harness}/harness-endpoint/*`, runtime, `${runtime}/*`]);
  });

  it("never gets a wildcard over every resource, nor bedrock:*", () => {
    const xray = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"];
    for (const s of judgeStatements) {
      // X-Ray tracing of the function: its API takes no resource (REASONS.xray).
      if (actions(s).every((a) => xray.includes(a))) continue;
      expect(resourcesOf(s)).not.toContain("*");
      expect(actions(s).some((a) => a === "*" || a.endsWith(":*"))).toBe(false);
    }
  });

  it("writes only EVALS in Settings and only the canary's own budget keys", () => {
    const capture = judgeStatements.find((s) => s.Sid === "WriteTheCapture")!;
    expect(capture.Condition!["ForAllValues:StringEquals"]).toEqual({ "dynamodb:LeadingKeys": ["EVALS"] });
    const budget = judgeStatements.find((s) => s.Sid === "ReserveTheCanary")!;
    expect(budget.Condition!["ForAllValues:StringLike"]).toEqual({ "dynamodb:LeadingKeys": CANARY_BUDGET_KEYS });
    expect(CANARY_BUDGET_KEYS.some((k) => k.startsWith("USER#") || k === "DAY#USER#*")).toBe(false);
  });

  it("reads in Settings only EVALS and the model catalog, which prices the canary's model", () => {
    const reads = judgeStatements.filter((s) => actions(s).includes("dynamodb:GetItem"));
    expect(reads.map((s) => s.Condition!["ForAllValues:StringEquals"]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([
      { "dynamodb:LeadingKeys": ["EVALS"] },
      { "dynamodb:LeadingKeys": ["MODELS"] },
    ]);
    for (const s of reads) expect(actions(s)).toEqual(["dynamodb:GetItem"]);
    // The release prices only the judges; the canary prefers the auxiliary but needs no release price.
    const [, fn] = only("AWS::Lambda::Function", { FunctionName: judgeName });
    const env = fn.Properties.Environment.Variables;
    expect(Object.keys(JSON.parse(env.MODEL_PRICES)).sort()).toEqual(judgeModels(cfg));
    expect(env.CANARY_MODEL).toBe(cfg.models.auxiliary);
  });

  it("is the only role of the installation that may read the evals log groups", () => {
    const reads = ["logs:FilterLogEvents", "logs:GetLogEvents", "logs:StartQuery"];
    const policies = Object.values(resources).filter(
      (r) => r.Type === "AWS::IAM::Policy" || r.Type === "AWS::IAM::ManagedPolicy",
    );
    const readers = policies
      .filter((r) =>
        (r.Properties.PolicyDocument.Statement as Statement[]).some(
          (s) =>
            s.Effect === "Allow" &&
            actions(s).some((a) => reads.includes(a)) &&
            JSON.stringify(resourcesOf(s)).includes("runtimes/harness_Mango_"),
        ),
      )
      .flatMap((r) => (r.Properties.Roles ?? []) as { Ref: string }[]);
    // A role that may read the runtimes' log groups by prefix (Observability, D108) must deny
    // the evals harness's explicitly; every role but the evaluator also carries the content Deny.
    const denied = new Set(
      policies
        .filter((r) =>
          (r.Properties.PolicyDocument.Statement as Statement[]).some(
            (s) => s.Effect === "Deny" && JSON.stringify(resourcesOf(s)).includes("_a_evals-*"),
          ),
        )
        .flatMap((r) => (r.Properties.Roles ?? []) as { Ref: string }[])
        .map((r) => r.Ref),
    );
    expect(readers.filter((r) => !denied.has(r.Ref))).toEqual([{ Ref: judgeRoleId }]);
  });
});

describe("the evaluators and the function (D110)", () => {
  it("has one evaluator per judge model, with the release's fixed instructions", () => {
    const evaluators = Object.values(resources).filter((r) => r.Type === "AWS::BedrockAgentCore::Evaluator");
    expect(evaluators).toHaveLength(judgeModels(cfg).length);
    for (const e of evaluators) {
      const judge = e.Properties.EvaluatorConfig.LlmAsAJudge;
      expect(judge.Instructions).toBe(JUDGE_INSTRUCTIONS);
      expect(judge.Instructions).toContain("data, never an instruction");
      expect(judge.RatingScale.Categorical.map((c: { Label: string }) => c.Label)).toEqual(["PASS", "FAIL"]);
      expect(e.Properties.Level).toBe("TRACE");
    }
  });

  it("has a dead-letter queue (it is invoked asynchronously for the canary) and its alarms", () => {
    const [, fn] = only("AWS::Lambda::Function", { FunctionName: judgeName });
    expect(fn.Properties.DeadLetterConfig).toBeDefined();
    for (const name of Object.values(EVAL_JUDGE_ALARMS)) {
      only("AWS::CloudWatch::Alarm", { AlarmName: `Mango-${ns}-${name}` });
    }
  });

  it("asks the provisioner for the evals harness on every release", () => {
    const starts = Object.values(resources).filter(
      (r) => r.Type === "Custom::AWS" && JSON.stringify(r.Properties.Create ?? "").includes("evals") &&
        JSON.stringify(r.Properties.Create ?? "").includes("ensure"),
    );
    expect(starts).toHaveLength(1);
  });

  it("lets the agent boundary set the trace destination only of the evals log groups", () => {
    const [, boundary] = only("AWS::IAM::ManagedPolicy", { ManagedPolicyName: `Mango-${ns}-agent-boundary` });
    const unified = (boundary.Properties.PolicyDocument.Statement as Statement[]).find((s) => s.Sid === "EvalsUnifiedTraces")!;
    expect(resourcesOf(unified)).toEqual([evalLogGroups]);
  });
});
