import { DefaultStackSynthesizer } from "aws-cdk-lib";
import { Node } from "constructs";
import { z } from "zod";
import { RELEASE_KEY_PREFIX } from "./stacks/provider-stack.js";

/**
 * Where a release is published (D58): the release store and the image repository of the
 * provider account. They are inputs of the build pipeline (`mise run dist`), never of a
 * customer: every template of the release names them, the same for all installations.
 */
const releaseTargetSchema = z
  .object({
    /** Account of the provider: owner of the release buckets and of the image repository. */
    providerAccount: z.string().regex(/^[0-9]{12}$/),
    /**
     * Name of the templates bucket. Assets go to `<bucket>-<region>`, one per Region, because
     * Lambda only loads code from a bucket of its own Region.
     */
    bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,50}[a-z0-9]$/),
    /** `v<version>` for a release, with a build suffix for anything else. Keys never change. */
    label: z.string().regex(/^v[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.]{1,40})?$/),
    /** Repository of the mango-api image, in the provider account. */
    imageRepository: z.string().regex(/^[a-z0-9][a-z0-9._/-]{1,200}$/),
    /** Digest of the published image: a release never names a tag. */
    imageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();

export type ReleaseTarget = z.infer<typeof releaseTargetSchema>;

/**
 * A target that exists nowhere: what the checks synthesize against (tests, CI, cdk-nag,
 * cfn-guard), since publishing is not part of them. Its templates cannot be installed.
 */
export const UNPUBLISHED_TARGET: ReleaseTarget = {
  providerAccount: "000000000000",
  bucket: "mango-releases-unpublished",
  label: "v0.0.0-unpublished",
  imageRepository: "mango-provider/api",
  imageDigest: `sha256:${"0".repeat(64)}`,
};

/** The target `mise run dist` passes as CDK context, or the unpublished one. */
export function releaseTarget(node: Node): ReleaseTarget {
  const given = node.tryGetContext("release") as unknown;
  if (given === undefined) return UNPUBLISHED_TARGET;
  return releaseTargetSchema.parse(typeof given === "string" ? JSON.parse(given) : given);
}

/** Key prefix of everything a release publishes: `mango/<label>/`. */
export function releasePrefix(target: ReleaseTarget): string {
  return `${RELEASE_KEY_PREFIX}${target.label}/`;
}

/** Name of the regional assets bucket, with the Region left to CloudFormation. */
export function assetsBucket(target: ReleaseTarget): string {
  return `${target.bucket}-\${AWS::Region}`;
}

/**
 * Synthesizer of the release templates (D8, D58; the pattern of Innovation Sandbox): assets
 * are read from the regional bucket of the provider, under the release prefix, and nothing
 * of the CDK bootstrap is needed in the account that installs.
 */
export function releaseSynthesizer(target: ReleaseTarget): DefaultStackSynthesizer {
  return new DefaultStackSynthesizer({
    generateBootstrapVersionRule: false,
    fileAssetsBucketName: assetsBucket(target),
    bucketPrefix: releasePrefix(target),
  });
}
