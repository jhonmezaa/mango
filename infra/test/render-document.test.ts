import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import { loadInstallation } from "../lib/config/schema.js";
import { RENDER_DOCUMENT_ALARMS, RENDER_OUTPUT, RENDER_TIMEOUT } from "../lib/constructs/render-document.js";
import { releaseSynthesizer, UNPUBLISHED_TARGET } from "../lib/release-target.js";
import { CoreStack } from "../lib/stacks/core-stack.js";
import { expectOnlyTheEvalsContentDeny } from "./evals-deny.js";
import { fromCore, nestedStacks, nestedTemplate } from "./nested.js";

/* Mango-<ns>-RenderDocument (D117); threat model code-interpreter-threat-model.md (TM-CI8). */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resource = { Type: string; Properties: any; [k: string]: any };
interface Statement {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource: unknown;
  Condition?: Record<string, Record<string, unknown>>;
}

// A release as `bin/mango.ts` builds it, without signed packs.
const release = new CoreStack(new App({ context: { skipSpa: true, packsDir: mkdtempSync(join(tmpdir(), "d1-no-packs-")) } }), "Core", {
  env: { region: "us-east-1" },
  synthesizer: releaseSynthesizer(UNPUBLISHED_TARGET),
  release: UNPUBLISHED_TARGET,
});
const renderStack = nestedStacks(release).find((stack) => stack.node.id === "RenderDocument")!;
const own = nestedTemplate(renderStack).Resources as Record<string, Resource>;
const installed = fromCore(release).toJSON().Resources as Record<string, Resource>;
const ofType = (type: string) => Object.entries(own).filter(([, r]) => r.Type === type);
const [, fn] = ofType("AWS::Lambda::Function")[0]!;
const [roleId, role] = ofType("AWS::IAM::Role")[0]!;
const statements = ofType("AWS::IAM::Policy")
  .filter(([, p]) => (p.Properties.Roles as { Ref: string }[]).some((r) => r.Ref === roleId))
  .flatMap(([, p]) => p.Properties.PolicyDocument.Statement as Statement[]);
const bySid = (sid: string) => statements.find((s) => s.Sid === sid)!;
const actions = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);

describe("render-document (D117)", { timeout: 120_000 }, () => {
  it("is one function, its role, log group and alarms, in a stack nested in Core (D99)", () => {
    expect(ofType("AWS::Lambda::Function")).toHaveLength(1);
    expect(ofType("AWS::IAM::Role")).toHaveLength(1);
    expect(ofType("AWS::Logs::LogGroup")).toHaveLength(1);
    // Nothing that holds data: the chat files bucket and its key stay in Core.
    for (const type of ["AWS::S3::Bucket", "AWS::KMS::Key", "AWS::DynamoDB::Table"]) expect(ofType(type)).toEqual([]);
    expect(JSON.stringify(own)).not.toContain("AWS::Lambda::Permission");
  });

  it("runs the image of the release by digest, from the repository of mango-api (D58, D117 (2))", () => {
    expect(fn.Properties.PackageType).toBe("Image");
    const uri = JSON.stringify(fn.Properties.Code.ImageUri);
    expect(uri).toContain(`${UNPUBLISHED_TARGET.providerAccount}.dkr.ecr.`);
    expect(uri).toContain(`/${UNPUBLISHED_TARGET.imageRepository}@${UNPUBLISHED_TARGET.renderDocumentDigest}`);
    expect(uri).not.toContain(":latest");
  });

  it("is arm64, outside a VPC, with memory, time and /tmp for LibreOffice", () => {
    expect(fn.Properties.Architectures).toEqual(["arm64"]);
    expect(fn.Properties.VpcConfig).toBeUndefined();
    expect(fn.Properties.MemorySize).toBe(2048);
    expect(fn.Properties.Timeout).toBe(RENDER_TIMEOUT.toSeconds());
    expect(fn.Properties.EphemeralStorage).toEqual({ Size: 2048 });
    expect(fn.Properties.TracingConfig).toEqual({ Mode: "Active" });
    expect(fn.Properties.KmsKeyArn).toBeDefined();
    expect(Object.keys(fn.Properties.Environment.Variables)).toEqual(["CHAT_FILES_BUCKET"]);
    // Invoked synchronously: no dead-letter queue (agreed CKV_AWS_116 exception).
    expect(fn.Properties.DeadLetterConfig).toBeUndefined();
  });

  it("reads chat files under owner/ and writes only under renders/ (TM-CI8)", () => {
    expect(role.Properties.RoleName).toEqual({ "Fn::Join": ["", ["Mango-", { Ref: "Namespace" }, "-RenderDocument"]] });
    // No AWS managed policy: only the deny of the evals capture, which every role carries.
    expectOnlyTheEvalsContentDeny(role.Properties.ManagedPolicyArns);
    expect(actions(bySid("ReadChatFile"))).toEqual(["s3:GetObject"]);
    expect(JSON.stringify(bySid("ReadChatFile").Resource)).toMatch(/\/owner\/\*"\]\]\}$/);
    expect(actions(bySid("WriteRender"))).toEqual(["s3:PutObject"]);
    expect(JSON.stringify(bySid("WriteRender").Resource)).toContain(`/${RENDER_OUTPUT}`);
    expect(actions(bySid("ChatFilesKey")).sort()).toEqual(["kms:Decrypt", "kms:GenerateDataKey"]);
    expect(bySid("ChatFilesKey").Condition).toEqual({
      StringEquals: { "kms:ViaService": "s3.us-east-1.amazonaws.com" },
    });
    // Never a wildcard action, and `*` only where the API admits nothing else (X-Ray).
    for (const s of statements) {
      for (const action of actions(s)) expect(action).not.toMatch(/\*/);
      if (s.Resource === "*") expect(actions(s).every((a) => a.startsWith("xray:"))).toBe(true);
    }
    expect(statements.flatMap(actions)).not.toContain("s3:DeleteObject");
    expect(statements.flatMap(actions)).not.toContain("s3:ListBucket");
  });

  it("names the chat files bucket and key of Core, which reach it as parameters", () => {
    const fnId = Object.entries(installed).find(
      ([, r]) => r.Type === "AWS::Lambda::Function" && JSON.stringify(r.Properties.FunctionName ?? "").includes("-RenderDocument"),
    )![0];
    const env = JSON.stringify(installed[fnId]!.Properties.Environment.Variables.CHAT_FILES_BUCKET);
    const chatFiles = Object.entries(installed).find(
      ([, r]) => r.Type === "AWS::S3::Bucket" && JSON.stringify(r.Properties.LoggingConfiguration ?? {}).includes("chat-files/"),
    )!;
    expect(env).toBe(JSON.stringify({ Ref: chatFiles[0] }));
  });

  it("alarms on failures and on renders close to their timeout, by the names Operations lists", () => {
    const names = ofType("AWS::CloudWatch::Alarm").map(([, a]) => JSON.stringify(a.Properties.AlarmName));
    expect(names.sort()).toEqual(
      Object.values(RENDER_DOCUMENT_ALARMS)
        .map((name) => JSON.stringify({ "Fn::Join": ["", ["Mango-", { Ref: "Namespace" }, `-${name}`]] }))
        .sort(),
    );
    for (const [, alarm] of ofType("AWS::CloudWatch::Alarm")) expect(alarm.Properties.AlarmActions).toHaveLength(1);
  });

  it("is invoked by the code connector and, for the PDF of a Canvas export, by mango-api only (D119, D124 (6))", () => {
    const sandbox = nestedStacks(release).find((stack) => stack.node.id === "Sandbox")!;
    const sandboxResources = nestedTemplate(sandbox).Resources as Record<string, Resource>;
    const connectorFn = Object.values(sandboxResources).find(
      (r) => r.Type === "AWS::Lambda::Function" && JSON.stringify(r.Properties.FunctionName).includes("-CodeInterpreter"),
    )!;
    expect(connectorFn.Properties.Environment.Variables.RENDER_FUNCTION).toEqual(role.Properties.RoleName);
    // Every grant of lambda:InvokeFunction on it, in Core and in every stack nested in it.
    // `installed` is Core with every stack nested in it.
    const grants = Object.values(installed)
      .filter((r) => r.Type === "AWS::IAM::Policy" || r.Type === "AWS::IAM::ManagedPolicy")
      .flatMap((r) => r.Properties.PolicyDocument.Statement as Statement[])
      .filter((st) => JSON.stringify(st.Resource ?? "").includes("RenderDocument"))
      .filter((st) => actions(st).some((a) => a.startsWith("lambda:")));
    expect(grants.map((g) => g.Sid).sort()).toEqual(["InvokeRenderDocument", "RenderCanvasPdf"]);
    for (const grant of grants) {
      expect(actions(grant)).toEqual(["lambda:InvokeFunction"]);
      expect(JSON.stringify(grant.Resource)).toContain(":function:Mango-");
    }
    // mango-api's: in its managed policy of the chat files, on its task role.
    const api = Object.values(installed).find(
      (r) =>
        r.Type === "AWS::IAM::ManagedPolicy" &&
        (r.Properties.PolicyDocument.Statement as Statement[]).some((st) => st.Sid === "RenderCanvasPdf"),
    )!;
    expect(JSON.stringify(api.Properties.ManagedPolicyName)).toContain("-ApiChatFiles");
    const owner = Object.values(sandboxResources).find(
      (r) =>
        r.Type === "AWS::IAM::Policy" &&
        (r.Properties.PolicyDocument.Statement as Statement[]).some((st) => st.Sid === "InvokeRenderDocument"),
    )!;
    expect(JSON.stringify(owner.Properties.Roles)).toContain("CodeConnectorRole");
    // No resource policy opens it to anyone else either.
    expect(JSON.stringify(own)).not.toContain("AWS::Lambda::Permission");
  });

  it("exists only in a release: without one there is no image to name", () => {
    const cfg = loadInstallation(resolve(import.meta.dirname, "../config/example.json"));
    const lab = nestedStacks(
      new CoreStack(new App({ context: { skipSpa: true } }), "Lab", {
        installation: cfg,
        env: { account: cfg.mangoAccountId, region: cfg.region },
      }),
    );
    expect(lab.map((stack) => stack.node.id)).not.toContain("RenderDocument");
  });
});
