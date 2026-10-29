import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { App, Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { applyNagSuppressions } from "../lib/nag-suppressions.js";
import { describe, expect, it } from "vitest";
import { loadInstallation } from "../lib/config/schema.js";
import { REMOTE_PAYLOAD_TYPE, remoteReleaseDigest } from "../lib/constructs/remote-release.js";
import { CoreStack } from "../lib/stacks/core-stack.js";
import { nestedStacks, nestedTemplate } from "./nested.js";

type Resource = { Type: string; Properties: any; Condition?: string; DependsOn?: string[] }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A release with one signed remote profile, signed by a throwaway key the installation trusts. */
function signedRelease(): { dir: string; pem: string; digest: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const dir = mkdtempSync(join(tmpdir(), "mango-remotes-"));
  const tools = ["core_list_projects", "search_code"];
  const statement = {
    schema_version: 1,
    profile: {
      id: "azure-devops",
      version: "2026.10.27-2",
      name: "Azure DevOps",
      tools: tools.map((name) => ({ name, toolset: "core", access: "read" })),
    },
    tool_schema: { tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })) },
    source_revision: "f".repeat(40),
  };
  const payload = Buffer.from(JSON.stringify(statement));
  const kind = Buffer.from(REMOTE_PAYLOAD_TYPE);
  const message = Buffer.concat([Buffer.from(`DSSEv1 ${kind.length} `), kind, Buffer.from(` ${payload.length} `), payload]);
  const envelope = {
    payload_type: REMOTE_PAYLOAD_TYPE,
    payload: payload.toString("base64"),
    signature: {
      algorithm: "ECDSA_SHA_256",
      key_id: "alias/test",
      value: sign("sha256", message, { key: privateKey, dsaEncoding: "der" }).toString("base64"),
    },
  };
  writeFileSync(join(dir, "azure-devops-2026.10.27-2.remote.json"), JSON.stringify(envelope));
  const statementSha256 = createHash("sha256").update(payload).digest("hex");
  return {
    dir,
    pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    digest: remoteReleaseDigest({ "azure-devops": statementSha256 }),
  };
}

function remoteMcpTemplate(release?: ReturnType<typeof signedRelease>, nag = false) {
  const base = loadInstallation(resolve(import.meta.dirname, "../config/example.json"));
  const cfg = release ? { ...base, packs: { ...base.packs, signingPublicKey: release.pem } } : base;
  const context: Record<string, unknown> = {
    skipSpa: true,
    packsDir: mkdtempSync(join(tmpdir(), "mango-no-packs-")),
    remotesDir: release?.dir ?? mkdtempSync(join(tmpdir(), "mango-no-remotes-")),
  };
  const app = new App({ context });
  if (nag) Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  const core = new CoreStack(app, "Core", {
    installation: cfg,
    env: { account: cfg.mangoAccountId, region: cfg.region },
  });
  if (nag) applyNagSuppressions(core); // as bin/mango.ts does
  const nested = nestedStacks(core).find((n) => n.node.id === "RemoteMcp")!;
  // With cdk-nag on, the caller synthesizes (and reads the report) itself.
  return { app, core, nested, template: nag ? {} : nestedTemplate(nested) };
}

const sweeps = (resources: Record<string, Resource>) =>
  Object.entries(resources).filter(
    ([, r]) => r.Type === "Custom::AWS" && JSON.stringify(r.Properties.Create ?? "").includes("startExecution"),
  );

describe("the remote provisioner after an install (D101)", () => {
  it("names a release by the canonical JSON of its catalog, as the provisioner does", () => {
    // Pinned with functions/provisioner/tests/test_remote_release.py.
    const catalog = { another: "b".repeat(64), "azure-devops": "a".repeat(64) };
    expect(remoteReleaseDigest(catalog)).toBe("1aba42f0b502fe5bdbab8a16fcb189290f2f3ce2df5bd326819f147a489b27ca");
    expect(remoteReleaseDigest({ "azure-devops": "a".repeat(64), another: "b".repeat(64) })).toBe(
      remoteReleaseDigest(catalog),
    );
  });

  it("passes cdk-nag with a release that ships remote profiles, provider of the sweep included", () => {
    // CI synthesizes without signed profiles, where the sweep and its provider do not exist.
    const { app } = remoteMcpTemplate(signedRelease(), true);
    // Only the nested stack of remote MCP: findings elsewhere depend on this test's example config.
    let report = "";
    try {
      app.synth({ force: true });
    } catch (error) {
      report = String(error);
    }
    expect(report.split("\n").filter((line) => line.includes("Core/RemoteMcp/"))).toEqual([]);
  });

  it("starts one sweep with the release, only while RemoteMcpEnabled is on", () => {
    const release = signedRelease();
    const { template } = remoteMcpTemplate(release);
    const resources = template.Resources as Record<string, Resource>;
    const found = sweeps(resources);
    expect(found).toHaveLength(1);
    const [, sweep] = found[0]!;
    const call = JSON.stringify(sweep.Properties.Create);
    // Only the digest of the release: identifiers, never what becomes a target.
    const parts = sweep.Properties.Create["Fn::Join"][1] as unknown[];
    const sdkCall = JSON.parse(parts.map((p) => (typeof p === "string" ? p : "ARN")).join(""));
    expect(JSON.parse(sdkCall.parameters.input)).toEqual({ release: release.digest });
    expect(JSON.stringify(sweep.Properties.Update)).toBe(call);
    expect(sweep.Condition).toBeDefined();
    const condition = (template.Conditions as Record<string, any>)[sweep.Condition!]; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(JSON.stringify(condition)).toContain('"true"');
    // Its policy: StartExecution on this state machine and nothing else.
    const policies = Object.values(resources).filter(
      (r) => r.Type === "AWS::IAM::Policy" && JSON.stringify(r.Properties.PolicyDocument).includes("states:StartExecution"),
    );
    const statements = policies.flatMap((p) => p.Properties.PolicyDocument.Statement as { Action: unknown; Resource: unknown }[]);
    expect(statements.map((s) => s.Action)).toEqual(["states:StartExecution"]);
    expect(JSON.stringify(statements[0]!.Resource)).toMatch(/StateMachine/);
  });

  it("runs no sweep in an installation without signed profiles", () => {
    const { template } = remoteMcpTemplate();
    expect(sweeps(template.Resources as Record<string, Resource>)).toEqual([]);
  });

  it("re-signs one registration at a time, and one that cannot converge keeps its catalog", () => {
    const { template } = remoteMcpTemplate();
    const machine = Object.values(template.Resources as Record<string, Resource>).find(
      (r) => r.Type === "AWS::StepFunctions::StateMachine",
    )!;
    const definition = JSON.stringify(machine.Properties.DefinitionString);
    for (const step of ["release_plan", "release_begin", "release_check", "release_sign", "release_abort"]) {
      expect(definition).toContain(`\\"step\\":\\"${step}\\"`);
    }
    expect(definition).toContain('\\"Type\\":\\"Map\\"');
    expect(definition).toContain('\\"MaxConcurrency\\":1');
    expect(definition).toContain('\\"Variable\\":\\"$.release\\",\\"IsPresent\\":true');
  });

  it("reads the index of registrations, and writes nothing more", () => {
    const { template } = remoteMcpTemplate();
    const read = Object.values(template.Resources as Record<string, Resource>)
      .filter((r) => r.Type === "AWS::IAM::Policy")
      .flatMap((r) => r.Properties.PolicyDocument.Statement as { Sid?: string; Condition?: any }[]) // eslint-disable-line @typescript-eslint/no-explicit-any
      .find((s) => s.Sid === "ReadRemoteRegistrations")!;
    expect(read.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"]).toEqual([
      "REMOTE#*",
      "REMOTE_CHANGE#*",
      "MCP_REMOTE#*",
      "REMOTE_INDEX",
    ]);
  });
});
