import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

/**
 * MCP packs of a release, as the stack ships them (D36): the signed envelope
 * (`<id>-<version>.pack.json`) and the files it vouches for, built by `packs.yml`.
 *
 * Synthesis only admits a pack whose envelope was signed by the release's public key and
 * whose zip is the signed one; it then pins that exact statement by digest in the catalog
 * the pack provisioner receives. The provisioner verifies again at install time
 * (`mango_packs.signing`), so both must agree on the envelope format: keep in sync with
 * `packages/py/mango-packs/src/mango_packs/signing.py`.
 */
export const PAYLOAD_TYPE = "application/vnd.mango.pack.v1+json";
const ENVELOPE_SUFFIX = ".pack.json";
const MAX_ENVELOPE_BYTES = 1024 * 1024;

const base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const fileName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/);
const fileDigest = z.object({ file: fileName, sha256, size: z.number().int().positive() });

const envelopeSchema = z
  .object({
    payload_type: z.literal(PAYLOAD_TYPE),
    payload: base64,
    signature: z.object({ algorithm: z.literal("ECDSA_SHA_256"), key_id: z.string(), value: base64 }).strict(),
  })
  .strict();

/** The fields of the signed statement the stack needs; the provisioner validates all of it. */
const statementSchema = z.object({
  schema_version: z.literal(1),
  manifest: z.object({
    id: z
      .string()
      .max(24)
      .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/),
    version: z.string().regex(/^[0-9]+(\.[0-9]+){1,3}-[1-9][0-9]{0,3}$/),
    identity_mode: z.enum(["service", "central_only", "per_user_adapter"]),
    // Absent in a statement of the payer chain (the default is not serialized).
    identity: z.object({ chain: z.enum(["payer", "member"]) }).strict().optional(),
    // What the runtime may reach (R6). The stack builds the pack's network from it.
    egress: z.object({
      aws: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)).max(20),
      hosts: z.array(z.string().max(253)).max(20).default([]),
    }),
  }),
  artifact: fileDigest,
  sbom: fileDigest,
});

export interface ReleasePack {
  readonly id: string;
  readonly version: string;
  /** sha256 of the signed statement: the only one this release installs for the pack. */
  readonly statementSha256: string;
  /** Files copied to `packs/<id>/<version>/` of the packs bucket. */
  readonly files: string[];
  /**
   * How identity reaches the data (signed manifest). A `central_only` pack reads account data
   * as the calling user: the stack lets its role use the broker and the Gateway interceptor
   * sign its callers (D37).
   */
  readonly identityMode: "service" | "central_only" | "per_user_adapter";
  /**
   * Broker chain of a `central_only` pack (signed manifest, D51): `payer` reads the payer
   * account through the Billing broker; `member` reads the member account each call names,
   * through the Read broker. The trust of each broker names only the packs of its chain.
   */
  readonly identityChain: "payer" | "member";
  /**
   * Everything the pack's runtime may connect to (signed manifest, R6): ids of AWS APIs with
   * a VPC endpoint in the pack network, and hosts outside AWS (not installable yet).
   */
  readonly egress: { readonly aws: string[]; readonly hosts: string[] };
}

/** What the provisioner receives as `PACK_CATALOG`. */
export type PackCatalog = Record<string, { version: string; statement_sha256: string }>;

/** DSSE pre-authentication encoding: binds the payload to its type. */
function signedMessage(payload: Buffer): Buffer {
  const kind = Buffer.from(PAYLOAD_TYPE);
  return Buffer.concat([Buffer.from(`DSSEv1 ${kind.length} `), kind, Buffer.from(` ${payload.length} `), payload]);
}

/** PEM of an ECC NIST P-256 public key, normalized; anything else is rejected. */
export function packSigningKey(pem: string): string {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("the pack signing key must be ECC NIST P-256");
  }
  return key.export({ type: "spki", format: "pem" }).toString();
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Signed packs found in `dir`. Fails on anything that is not exactly what `publicKeyPem`
 * signed: a release never ships a pack its own provisioner would refuse.
 */
export function loadReleasePacks(dir: string, publicKeyPem: string): ReleasePack[] {
  if (!existsSync(dir)) return [];
  const key = createPublicKey(packSigningKey(publicKeyPem));
  const packs: ReleasePack[] = [];
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
      // Most often a pack signed before a field became mandatory (`egress`, R6): the release
      // does not ship it until it is built and signed again.
      const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
      throw new Error(`${name}: the signed statement is not one this release accepts (${fields})`);
    }
    const statement = parsed.data;
    const { id, version, identity_mode: identityMode, egress } = statement.manifest;
    const identityChain = statement.manifest.identity?.chain ?? "payer";
    if (identityChain === "member" && identityMode !== "central_only") {
      throw new Error(`${name}: the member chain is only for central_only packs`);
    }
    if (name !== `${id}-${version}${ENVELOPE_SUFFIX}`) {
      throw new Error(`${name}: the signed manifest is ${id} ${version}`);
    }
    if (packs.some((p) => p.id === id)) throw new Error(`${id}: a release ships one version of a pack`);
    for (const file of [statement.artifact, statement.sbom]) {
      const filePath = resolve(dir, file.file);
      if (!existsSync(filePath) || statSync(filePath).size !== file.size || sha256File(filePath) !== file.sha256) {
        throw new Error(`${name}: ${file.file} is missing or is not the signed file`);
      }
    }
    packs.push({
      id,
      version,
      statementSha256: createHash("sha256").update(payload).digest("hex"),
      files: [name, statement.artifact.file, statement.sbom.file],
      identityMode,
      identityChain,
      egress,
    });
  }
  return packs;
}

export function packCatalog(packs: ReleasePack[]): PackCatalog {
  return Object.fromEntries(
    packs.map((p) => [p.id, { version: p.version, statement_sha256: p.statementSha256 }]),
  );
}
