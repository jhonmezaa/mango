import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { Annotations, Template } from "aws-cdk-lib/assertions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import { describe, expect, it } from "vitest";
import {
  loadReleaseRemotes,
  REMOTE_PAYLOAD_TYPE,
  remoteCatalog,
  RemoteRelease,
} from "../lib/constructs/remote-release.js";

const TOOLS = ["core_list_projects", "wit_work_item"];

interface RemoteSpec {
  id?: string;
  /** `access` of each tool; `read` by default. */
  access?: (string | undefined)[];
  /** Names of the tool schema; the profile's by default. */
  served?: string[];
  /** Sign with this payload type instead (a pack envelope). */
  payloadType?: string;
  fileName?: string;
}

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { privateKey, pem: publicKey.export({ type: "spki", format: "pem" }).toString() };
}

function signedRemotes(specs: RemoteSpec[] = [{}], key = keyPair()) {
  const dir = mkdtempSync(join(tmpdir(), "mango-remotes-"));
  const digests: string[] = [];
  for (const spec of specs) {
    const id = spec.id ?? "azure-devops";
    const statement = {
      schema_version: 1,
      profile: {
        id,
        version: "2026.10.27-1",
        name: "A remote",
        tools: TOOLS.map((name, i) => {
          const access = spec.access === undefined ? "read" : spec.access[i];
          return { name, toolset: "core", ...(access === undefined ? {} : { access }) };
        }),
      },
      tool_schema: { tools: (spec.served ?? TOOLS).map((name) => ({ name, inputSchema: { type: "object" } })) },
      source_revision: "f".repeat(40),
    };
    const payload = Buffer.from(JSON.stringify(statement));
    const kind = Buffer.from(spec.payloadType ?? REMOTE_PAYLOAD_TYPE);
    const message = Buffer.concat([Buffer.from(`DSSEv1 ${kind.length} `), kind, Buffer.from(` ${payload.length} `), payload]);
    const envelope = {
      payload_type: REMOTE_PAYLOAD_TYPE,
      payload: payload.toString("base64"),
      signature: {
        algorithm: "ECDSA_SHA_256",
        key_id: "alias/test",
        value: sign("sha256", message, { key: key.privateKey, dsaEncoding: "der" }).toString("base64"),
      },
    };
    writeFileSync(join(dir, spec.fileName ?? `${id}-2026.10.27-1.remote.json`), JSON.stringify(envelope));
    digests.push(createHash("sha256").update(payload).digest("hex"));
  }
  return { dir, pem: key.pem, digests };
}

function synth(signingPublicKey: string, remotesDir: string) {
  const app = new App({ context: { remotesDir } });
  const stack = new Stack(app, "Test", { env: { account: "111122223333", region: "us-east-1" } });
  const bucket = new s3.Bucket(stack, "Packs");
  const release = new RemoteRelease(stack, "Remotes", { bucket, signingPublicKey });
  const reader = new iam.Role(stack, "Reader", { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") });
  release.grantRead(reader);
  return { stack, release, template: Template.fromStack(stack) };
}

describe("remote MCP profiles of the release (D98 (14))", () => {
  it("pins each signed profile by the digest of its statement", () => {
    const signed = signedRemotes();
    const remotes = loadReleaseRemotes(signed.dir, signed.pem);
    expect(remoteCatalog(remotes)).toEqual({ "azure-devops": signed.digests[0] });
    expect(remotes[0]!.objectKey).toBe(`remotes/azure-devops/${signed.digests[0]}.json`);
    expect(remotes[0]!.tools).toEqual(TOOLS);
  });

  it("refuses a profile signed with another key, or a pack signature", () => {
    const signed = signedRemotes();
    expect(() => loadReleaseRemotes(signed.dir, keyPair().pem)).toThrow(/not signed by the release/);
    const pack = signedRemotes([{ payloadType: "application/vnd.mango.pack.v1+json" }]);
    expect(() => loadReleaseRemotes(pack.dir, pack.pem)).toThrow(/not signed by the release/);
  });

  it("refuses a profile with a tool that is not read, or unclassified (D84 (5))", () => {
    for (const access of ["write", "destructive"]) {
      const signed = signedRemotes([{ access: ["read", access] }]);
      expect(() => loadReleaseRemotes(signed.dir, signed.pem)).toThrow(/only has read tools \(wit_work_item\)/);
    }
    const unclassified = signedRemotes([{ access: ["read", undefined] }]);
    expect(() => loadReleaseRemotes(unclassified.dir, unclassified.pem)).toThrow(/not one this release accepts/);
  });

  it("refuses a schema that is not the profile's, a renamed envelope or two versions of one profile", () => {
    const served = signedRemotes([{ served: [...TOOLS, "wit_work_item_write"] }]);
    expect(() => loadReleaseRemotes(served.dir, served.pem)).toThrow(/does not list exactly/);
    const renamed = signedRemotes([{ fileName: "other-2026.10.27-1.remote.json" }]);
    expect(() => loadReleaseRemotes(renamed.dir, renamed.pem)).toThrow(/the signed profile is azure-devops/);
    const key = keyPair();
    const twice = signedRemotes([{}, { fileName: "azure-devops-2026.10.28-1.remote.json" }], key);
    expect(() => loadReleaseRemotes(twice.dir, twice.pem)).toThrow(/the signed profile is azure-devops/);
  });

  it("copies each profile under its digest and exposes the catalog", () => {
    const signed = signedRemotes();
    const { release, template } = synth(signed.pem, signed.dir);
    expect(JSON.parse(release.environment.REMOTE_CATALOG!)).toEqual({ "azure-devops": signed.digests[0] });
    const deployments = template.findResources("Custom::CDKBucketDeployment");
    expect(Object.values(deployments)).toHaveLength(1);
    const deployment = Object.values(deployments)[0]!.Properties;
    expect(deployment.DestinationBucketKeyPrefix).toBe("remotes/azure-devops/");
    expect(deployment.Prune).toBe(false);
    // Readers get exactly the object of the catalog: no listing, no other key.
    const policies = Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
      (p) => p.Properties.PolicyDocument.Statement as { Sid?: string; Action: unknown; Resource: unknown }[],
    );
    const read = policies.find((s) => s.Sid === "ReadReleaseRemoteProfiles")!;
    expect(read.Action).toBe("s3:GetObject");
    expect(JSON.stringify(read.Resource)).toContain(`/remotes/azure-devops/${signed.digests[0]}.json`);
  });

  it("ships nothing without a signing key or without profiles", () => {
    const signed = signedRemotes();
    const unsigned = synth("", signed.dir);
    expect(unsigned.release.environment).toEqual({ REMOTE_CATALOG: "{}" });
    expect(Object.keys(unsigned.template.findResources("Custom::CDKBucketDeployment"))).toHaveLength(0);
    Annotations.fromStack(unsigned.stack).hasInfo("*", "No pack signing key: the remote MCP catalog of this release is empty.");
    const empty = synth(signed.pem, mkdtempSync(join(tmpdir(), "mango-no-remotes-")));
    expect(empty.release.catalog).toEqual({});
    expect(JSON.stringify(empty.template.toJSON())).not.toContain("ReadReleaseRemoteProfiles");
  });
});
