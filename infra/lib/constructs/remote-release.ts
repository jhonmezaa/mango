import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Annotations } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";
import { z } from "zod";
import { packSigningKey } from "../config/pack-release.js";

/**
 * Remote MCP profiles of a release (D93, D98 (14)): the signed envelopes `packs.yml` writes
 * (`<id>-<version>.remote.json`), each one a profile with its tool schema inside.
 *
 * Synthesis only admits an envelope signed by the release's pack key whose tools are all
 * `read`, uploads it to the packs bucket under the digest of its statement and names that
 * digest in `REMOTE_CATALOG`: the only profile of each id this release can register. Whoever
 * reads it verifies again (`mango_packs.remote`), so both must agree on the envelope format:
 * keep in sync with `packages/py/mango-packs/src/mango_packs/remote.py`.
 */
export const REMOTE_PAYLOAD_TYPE = "application/vnd.mango.remote-profile.v1+json";
const ENVELOPE_SUFFIX = ".remote.json";
/** The statement carries a tool schema of up to 1 MB, and base64 grows it by a third. */
const MAX_ENVELOPE_BYTES = 2 * 1024 * 1024;
/** Prefix of the packs bucket where CloudFormation copies the release's remote profiles. */
export const REMOTE_PREFIX = "remotes/";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
/** Where the release pipeline leaves the signed profiles (`release.yml`). */
const RELEASE_REMOTES_DIR = resolve(REPO_ROOT, "dist/remotes");

const base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/);
const toolName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);

const envelopeSchema = z
  .object({
    payload_type: z.literal(REMOTE_PAYLOAD_TYPE),
    payload: base64,
    signature: z.object({ algorithm: z.literal("ECDSA_SHA_256"), key_id: z.string(), value: base64 }).strict(),
  })
  .strict();

/** The fields of the signed statement the stack needs; whoever installs it validates all of it. */
const statementSchema = z.object({
  schema_version: z.literal(1),
  profile: z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]{1,23}$/),
    version: z.string().regex(/^[0-9]+(\.[0-9]+){1,3}-[1-9][0-9]{0,3}$/),
    // Required: an unclassified tool counts as a write (D84).
    tools: z
      .array(z.object({ name: toolName, access: z.enum(["read", "write", "destructive"]) }))
      .min(1)
      .max(100),
  }),
  tool_schema: z.object({ tools: z.array(z.object({ name: toolName })).min(1).max(100) }).strict(),
});

export interface ReleaseRemote {
  readonly id: string;
  readonly version: string;
  /** sha256 of the signed statement: the only profile of this id the release registers. */
  readonly statementSha256: string;
  /** Envelope file in the directory the profiles were read from. */
  readonly file: string;
  /** Where the envelope is copied in the packs bucket. */
  readonly objectKey: string;
  /** Tools of the profile, every one `read`. */
  readonly tools: string[];
}

/** What `mango-api` and the remote provisioner receive as `REMOTE_CATALOG`: id -> sha256. */
export type RemoteCatalog = Record<string, string>;

function signedMessage(payload: Buffer): Buffer {
  const kind = Buffer.from(REMOTE_PAYLOAD_TYPE);
  return Buffer.concat([Buffer.from(`DSSEv1 ${kind.length} `), kind, Buffer.from(` ${payload.length} `), payload]);
}

/**
 * Signed remote profiles found in `dir`. Fails on anything that is not exactly what
 * `publicKeyPem` signed, and on a profile with a tool that is not `read` (D84 (5)).
 */
export function loadReleaseRemotes(dir: string, publicKeyPem: string): ReleaseRemote[] {
  if (!existsSync(dir)) return [];
  const key = createPublicKey(packSigningKey(publicKeyPem));
  const remotes: ReleaseRemote[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(ENVELOPE_SUFFIX)).sort()) {
    const path = resolve(dir, name);
    if (statSync(path).size > MAX_ENVELOPE_BYTES) throw new Error(`${name}: envelope too large`);
    const envelope = envelopeSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    const payload = Buffer.from(envelope.payload, "base64");
    const signature = Buffer.from(envelope.signature.value, "base64");
    if (!verify("sha256", signedMessage(payload), { key, dsaEncoding: "der" }, signature)) {
      throw new Error(`${name}: not signed by the release's pack signing key`);
    }
    const parsed = statementSchema.safeParse(JSON.parse(payload.toString("utf8")));
    if (!parsed.success) {
      const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
      throw new Error(`${name}: the signed statement is not one this release accepts (${fields})`);
    }
    const { profile, tool_schema: schema } = parsed.data;
    if (name !== `${profile.id}-${profile.version}${ENVELOPE_SUFFIX}`) {
      throw new Error(`${name}: the signed profile is ${profile.id} ${profile.version}`);
    }
    if (remotes.some((r) => r.id === profile.id)) {
      throw new Error(`${profile.id}: a release ships one version of a remote profile`);
    }
    const notRead = profile.tools.filter((t) => t.access !== "read").map((t) => t.name);
    if (notRead.length > 0) {
      throw new Error(`${name}: a remote profile only has read tools (${notRead.join(", ")})`);
    }
    const tools = profile.tools.map((t) => t.name).sort();
    const served = schema.tools.map((t) => t.name).sort();
    if (JSON.stringify(tools) !== JSON.stringify(served)) {
      throw new Error(`${name}: the tool schema does not list exactly the profile's tools`);
    }
    const statementSha256 = createHash("sha256").update(payload).digest("hex");
    remotes.push({
      id: profile.id,
      version: profile.version,
      statementSha256,
      file: name,
      objectKey: `${REMOTE_PREFIX}${profile.id}/${statementSha256}.json`,
      tools,
    });
  }
  return remotes;
}

export function remoteCatalog(remotes: ReleaseRemote[]): RemoteCatalog {
  return Object.fromEntries(remotes.map((r) => [r.id, r.statementSha256]));
}

export interface RemoteReleaseProps {
  /** The packs bucket (`PackPlatform.bucket`): written only by CloudFormation's copy. */
  readonly bucket: s3.IBucket;
  /** PEM of the pack signing key, or "" while signing is not set up (`PackRelease`). */
  readonly signingPublicKey: string;
}

/**
 * The signed remote MCP profiles of the release, copied to the packs bucket at install or
 * update time. Without a signing key, or without profiles, the catalog is empty: nothing
 * remote can be registered.
 */
export class RemoteRelease extends Construct {
  readonly remotes: ReleaseRemote[];
  readonly catalog: RemoteCatalog;
  private readonly bucket: s3.IBucket;

  constructor(scope: Construct, id: string, props: RemoteReleaseProps) {
    super(scope, id);
    this.bucket = props.bucket;
    // Context first, then MANGO_REMOTES_DIR (the unit tests point it at an empty folder).
    const dir = resolve(
      (this.node.tryGetContext("remotesDir") as string | undefined) ??
        process.env.MANGO_REMOTES_DIR ??
        RELEASE_REMOTES_DIR,
    );
    if (props.signingPublicKey === "") {
      Annotations.of(this).addInfo("No pack signing key: the remote MCP catalog of this release is empty.");
      this.remotes = [];
    } else {
      this.remotes = loadReleaseRemotes(dir, props.signingPublicKey);
    }
    this.catalog = remoteCatalog(this.remotes);
    for (const remote of this.remotes) {
      new s3deploy.BucketDeployment(this, `Remote-${remote.id}`, {
        destinationBucket: props.bucket,
        destinationKeyPrefix: `${REMOTE_PREFIX}${remote.id}/`,
        // Named after its digest, so the catalog names exactly the bytes that were verified.
        sources: [s3deploy.Source.data(`${remote.statementSha256}.json`, readFileSync(resolve(dir, remote.file), "utf8"))],
        // Older profiles stay: a registration may still be on one until it is updated.
        prune: false,
        memoryLimit: 256,
      });
    }
  }

  /** Environment of whoever reads the catalog (`mango-api`, the remote provisioner). Not secret. */
  get environment(): Record<string, string> {
    return { REMOTE_CATALOG: JSON.stringify(this.catalog) };
  }

  /** Read-only access to exactly the profiles this release names: no listing, no other object. */
  grantRead(grantee: iam.IGrantable): void {
    if (this.remotes.length === 0) return;
    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "ReadReleaseRemoteProfiles",
        actions: ["s3:GetObject"],
        resources: this.remotes.map((remote) => this.bucket.arnForObjects(remote.objectKey)),
      }),
    );
  }
}
