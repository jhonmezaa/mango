import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Annotations, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";
import { loadReleasePacks, packCatalog, PackCatalog, packSigningKey, ReleasePack } from "../config/pack-release.js";
import { Installation } from "../config/schema.js";
import { packNames } from "../names.js";
import { acknowledge } from "../nag.js";
import { AgentPlatform } from "./agent-platform.js";
import { PACK_EGRESS_SERVICES } from "./pack-network.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
/** Public key of the provider's pack signing key (U10); absent until that key exists. */
const RELEASE_SIGNING_KEY = resolve(REPO_ROOT, "packs/signing-key.pub");
/** Where the release pipeline leaves the signed packs (`packs.yml`). */
const RELEASE_PACKS_DIR = resolve(REPO_ROOT, "dist/packs");

/**
 * Data actions a pack role may ever be allowed (the ceiling of the pack permissions
 * boundary, TM-M1). A signed manifest asking for anything else is refused by the provisioner.
 * A new pack that needs more adds its actions here, in a reviewed release.
 *
 * The AWS Price List API has no resource types, so these actions only accept `Resource: "*"`.
 */
export const PACK_DATA_ACTIONS = [
  "pricing:DescribeServices",
  "pricing:GetAttributeValues",
  "pricing:GetProducts",
  "pricing:ListPriceLists",
  "pricing:GetPriceListFileUrl",
];

/** The signed packs a release ships and the key that vouches for them. */
export interface PackRelease {
  /** PEM of the key that verifies pack signatures, or "" while signing is not set up. */
  readonly signingPublicKey: string;
  readonly packs: ReleasePack[];
  /** Directory the packs were read from (and are copied from at deploy time). */
  readonly packsDir: string;
}

/**
 * Packs of the release, verified at synthesis. Customer installations only trust the key that
 * ships with the release; the lab may name another one (a test key) in its configuration.
 * Without a key nothing can be verified: the catalog is empty and no pack installs.
 */
export function loadPackRelease(scope: Construct, cfg: Pick<Installation, "packs">): PackRelease {
  const pem =
    cfg.packs.signingPublicKey ??
    (existsSync(RELEASE_SIGNING_KEY) ? readFileSync(RELEASE_SIGNING_KEY, "utf8") : undefined);
  const signingPublicKey = pem === undefined ? "" : packSigningKey(pem);
  // Context first, then MANGO_PACKS_DIR (the unit tests point it at an empty folder so a
  // developer's signed packs in dist/packs do not change what they synthesize).
  const packsDir = resolve(
    (scope.node.tryGetContext("packsDir") as string | undefined) ??
      process.env.MANGO_PACKS_DIR ??
      RELEASE_PACKS_DIR,
  );
  if (signingPublicKey === "") {
    Annotations.of(scope).addInfo("No pack signing key: the MCP pack catalog of this release is empty.");
    return { signingPublicKey, packs: [], packsDir };
  }
  const release = { signingPublicKey, packs: loadReleasePacks(packsDir, signingPublicKey), packsDir };
  assertPackEgress(release.packs);
  return release;
}

/**
 * R6: a pack runtime only reaches the VPC endpoints its signed manifest declares. A release
 * does not synthesize with a pack the pack network cannot serve: one that names a host
 * outside AWS (no control enforces a per-pack host allowlist yet) or an AWS API without an
 * endpoint in the catalog. The provisioner refuses the same packs at install time.
 */
export function assertPackEgress(packs: Pick<ReleasePack, "id" | "egress">[]): void {
  for (const pack of packs) {
    if (pack.egress.hosts.length > 0) {
      throw new Error(
        `MCP pack ${pack.id} declares hosts outside AWS (${pack.egress.hosts.join(", ")}): the pack network ` +
          "only reaches VPC endpoints, so no installation can ship it yet (R6)",
      );
    }
    const unknown = pack.egress.aws.filter((service) => !Object.hasOwn(PACK_EGRESS_SERVICES, service));
    if (unknown.length > 0) {
      throw new Error(`MCP pack ${pack.id} declares AWS endpoints the pack network does not have: ${unknown.join(", ")}`);
    }
  }
}

/** Packs of the release that read account data as the calling user (`central_only`, D37). */
export function accountDataPacks(release: PackRelease): string[] {
  return release.packs.filter((pack) => pack.identityMode === "central_only").map((pack) => pack.id);
}

/** Of those, the packs that read the member accounts through the Read broker (D51). */
export function memberChainPacks(release: PackRelease): string[] {
  return release.packs
    .filter((pack) => pack.identityMode === "central_only" && pack.identityChain === "member")
    .map((pack) => pack.id);
}

/** And the ones that read the payer account through the Billing broker (D37). */
export function payerChainPacks(release: PackRelease): string[] {
  const member = new Set(memberChainPacks(release));
  return accountDataPacks(release).filter((id) => !member.has(id));
}

export interface PackPlatformProps {
  readonly installation: Installation;
  readonly platform: AgentPlatform;
  readonly accessLogs: s3.IBucket;
  /** Signed packs of the release ({@link loadPackRelease}). */
  readonly release: PackRelease;
  /**
   * Broker a pack over account data assumes on every call, as the user (D10, D37). It is in
   * the ceiling of every pack role; only the roles the broker's trust names can use it.
   */
  readonly brokerRoleArn: string;
  /** Read broker: the one a pack of the member chain assumes instead (D51). Same rule. */
  readonly memberBrokerRoleArn: string;
}

/**
 * What every MCP pack of the installation shares (Marketplace v1, D19, D36): the bucket
 * CloudFormation fills with the release's signed packs, the public key and catalog that
 * decide what may be installed, and the permissions boundary of pack roles.
 *
 * Packs themselves are not stack resources: the pack provisioner creates a role, a runtime,
 * a Gateway target and Cedar policies per enabled pack by SDK (D25), under {@link packNames}.
 */
export class PackPlatform extends Construct {
  /** Signed packs of the release, copied at install or update time. Never written at runtime. */
  readonly bucket: s3.Bucket;
  /** Ceiling of what any pack execution role may be allowed to do. */
  readonly boundary: iam.ManagedPolicy;
  /** PEM of the key that verifies pack signatures, or "" while signing is not set up. */
  readonly signingPublicKey: string;
  /** One signed statement per pack: the only one this release installs (no rollback). */
  readonly catalog: PackCatalog;
  /** Signed statements of the release's packs, as object keys of {@link bucket}. */
  private readonly statementKeys: string[];

  /** `role/Mango-<ns>-mcp-*`. */
  readonly roleArns: string;
  /** `runtime/Mango_<ns>_mcp_*`: runtimes the provisioner manages and the Gateway invokes. */
  readonly runtimeArns: string;
  /** Log groups of those runtimes (one per runtime endpoint). */
  readonly runtimeLogGroupArns: string;

  constructor(scope: Construct, id: string, props: PackPlatformProps) {
    super(scope, id);
    const cfg = props.installation;
    const ns = cfg.namespace;
    const stack = Stack.of(this);
    this.roleArns = `arn:aws:iam::${stack.account}:role/${packNames.rolePrefix(ns)}*`;
    this.runtimeArns = `arn:aws:bedrock-agentcore:${stack.region}:${stack.account}:runtime/${packNames.runtimePrefix(ns)}*`;
    this.runtimeLogGroupArns =
      `arn:aws:logs:${stack.region}:${stack.account}:log-group:` +
      `/aws/bedrock-agentcore/runtimes/${packNames.runtimePrefix(ns)}*`;

    this.bucket = new s3.Bucket(this, "Bucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      serverAccessLogsBucket: props.accessLogs,
      serverAccessLogsPrefix: "packs/",
      // A runtime is created from one object version, the one whose digest was verified
      // (TM-M15). Versions are kept: a runtime version may still point at an old one.
      versioned: true,
      removalPolicy: cfg.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !cfg.retainData,
    });

    // --- Release: signing key and catalog --------------------------------------------------
    this.signingPublicKey = props.release.signingPublicKey;
    const { packs, packsDir } = props.release;
    this.catalog = packCatalog(packs);
    this.statementKeys = packs.map(
      (pack) => `${packNames.artifactPrefix}${pack.id}/${pack.version}/${pack.id}-${pack.version}.pack.json`,
    );
    for (const pack of packs) {
      new s3deploy.BucketDeployment(this, `Pack-${pack.id}`, {
        destinationBucket: this.bucket,
        destinationKeyPrefix: `${packNames.artifactPrefix}${pack.id}/${pack.version}/`,
        sources: [s3deploy.Source.asset(resolve(packsDir), { exclude: ["*", ...pack.files.map((f) => `!${f}`)] })],
        // Other packs and older versions stay: a runtime may still run from them.
        prune: false,
        memoryLimit: 512,
      });
    }

    // --- Runtime logs (D16): same key as agent runtimes ------------------------------------
    props.platform.runtimeLogsKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "CloudWatchLogsPackRuntimeLogGroups",
        principals: [new iam.ServicePrincipal(`logs.${stack.region}.amazonaws.com`)],
        actions: ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"],
        resources: ["*"],
        conditions: { ArnLike: { "kms:EncryptionContext:aws:logs:arn": this.runtimeLogGroupArns } },
      }),
    );

    // --- Permissions boundary of pack roles (TM-M1) ----------------------------------------
    // The provisioner can only create roles that carry this policy, so whatever a signed
    // manifest asks for, a pack role can never do more than this: the listed read-only data
    // actions, assuming the installation's broker (packs over account data, which get no data
    // action of their own) and what its runtime needs for itself. No IAM, no secrets, no
    // other role, no data stores of the installation.
    this.boundary = new iam.ManagedPolicy(this, "Boundary", {
      managedPolicyName: packNames.boundary(ns),
      description: "Permissions boundary of Mango MCP pack execution roles (created by the provisioner)",
      statements: [
        new iam.PolicyStatement({
          sid: "PackData",
          actions: PACK_DATA_ACTIONS,
          resources: ["*"],
        }),
        new iam.PolicyStatement({
          sid: "AssumeBroker",
          // Rule 5: account data is read as the calling user, never with the pack's role. The
          // broker's trust names the exact pack roles of the release and demands SourceIdentity.
          actions: ["sts:AssumeRole", "sts:SetSourceIdentity", "sts:TagSession"],
          resources: [props.brokerRoleArn, props.memberBrokerRoleArn],
        }),
        new iam.PolicyStatement({
          sid: "RuntimeLogs",
          actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"],
          resources: [this.runtimeLogGroupArns],
        }),
        new iam.PolicyStatement({
          sid: "Tracing",
          actions: ["xray:PutTraceSegments", "xray:PutTelemetryRecords"],
          resources: ["*"],
        }),
        new iam.PolicyStatement({
          sid: "Metrics",
          actions: ["cloudwatch:PutMetricData"],
          resources: ["*"],
          conditions: { StringEquals: { "cloudwatch:namespace": "bedrock-agentcore" } },
        }),
      ],
    });
    acknowledge(
      this.boundary,
      {
        id: "AwsSolutions-IAM5[Resource::*]",
        reason:
          "A boundary is a ceiling, not a grant. The AWS Price List API (pricing:*), X-Ray and CloudWatch " +
          "metrics (namespace-conditioned) have no resource scope; the data actions are an explicit list.",
      },
      {
        id: `AwsSolutions-IAM5[Resource::${this.runtimeLogGroupArns}]`,
        reason: "AgentCore names runtime log groups after the generated runtime id; the prefix pins this installation's packs.",
      },
    );
  }

  /**
   * What mango-api needs to list the packs of the release (catalog of MCP): the same public
   * key and catalog the provisioner verifies with. Not secrets.
   */
  get apiEnvironment(): Record<string, string> {
    return {
      PACKS_BUCKET: this.bucket.bucketName,
      PACKS_BUCKET_OWNER: Stack.of(this).account,
      PACK_CATALOG: JSON.stringify(this.catalog),
      PACK_SIGNING_PUBLIC_KEY: this.signingPublicKey,
    };
  }

  /**
   * Read-only access to the signed statements (JSON) of exactly the packs this release names:
   * no zips, no listing, no other object. mango-api shows them; it never installs anything.
   */
  grantReadStatements(grantee: iam.IGrantable): void {
    if (this.statementKeys.length === 0) return;
    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "ReadReleasePackStatements",
        actions: ["s3:GetObject"],
        resources: this.statementKeys.map((key) => this.bucket.arnForObjects(key)),
      }),
    );
  }
}
