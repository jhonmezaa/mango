import { App, DefaultStackSynthesizer } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ProviderStack } from "../lib/stacks/provider-stack.js";

type Statement = {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Principal?: unknown;
  Resource?: unknown;
  Condition?: Record<string, Record<string, unknown>>;
};

function synth(retain: boolean): Template {
  // Same flag as cdk.json: access logs are granted by bucket policy, not by ACL.
  const app = new App({ context: { "@aws-cdk/aws-s3:serverAccessLogsUseBucketPolicy": true } });
  const stack = new ProviderStack(app, "Provider", {
    stackName: "Mango-provider",
    synthesizer: new DefaultStackSynthesizer({ generateBootstrapVersionRule: false }),
    retain,
  });
  return Template.fromStack(stack);
}

const template = synth(true);
const json = template.toJSON() as { Resources: Record<string, { Type: string; Properties: Record<string, unknown> }> };
const resources = (type: string) => Object.values(json.Resources).filter((r) => r.Type === type);
const actions = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
const ORG_CONDITION = { StringEquals: { "aws:PrincipalOrgID": { Ref: "CustomerOrganizationIds" } } };

describe("provider stack", () => {
  it("needs no CDK bootstrap and ships no assets", () => {
    const whole = JSON.stringify(template.toJSON());
    expect(whole).not.toContain("BootstrapVersion");
    expect(whole).not.toContain("cdk-hnb659fds");
    expect(resources("AWS::Lambda::Function")).toHaveLength(0);
  });

  it("names everything it owns with the provider prefix", () => {
    for (const role of resources("AWS::IAM::Role")) {
      expect(role.Properties.RoleName).toMatch(/^Mango-provider-/);
    }
    for (const rule of resources("AWS::Events::Rule")) {
      expect(rule.Properties.Name).toMatch(/^Mango-provider-/);
    }
    template.hasResourceProperties("AWS::ECR::Repository", { RepositoryName: "mango-provider/api" });
  });

  it("trusts GitHub only for one exact subject per role", () => {
    const roles = resources("AWS::IAM::Role");
    expect(roles).toHaveLength(2);
    const environments = roles.map((role) => {
      const doc = role.Properties.AssumeRolePolicyDocument as { Statement: (Statement | { "Fn::If": unknown[] })[] };
      const statement = doc.Statement[0] as Statement;
      // Only the publisher has a second statement, and only when a local publisher is named.
      const local = doc.Statement[1] as { "Fn::If": [string, Statement, unknown] } | undefined;
      expect(local !== undefined).toBe(role.Properties.RoleName === "Mango-provider-release-publisher");
      if (local) {
        expect(local["Fn::If"][0]).toBe("HasLocalPublisher");
        expect(local["Fn::If"][1].Condition).toEqual({ ArnEquals: { "aws:PrincipalArn": { Ref: "LocalPublisherArn" } } });
        expect(local["Fn::If"][2]).toEqual({ Ref: "AWS::NoValue" });
      }
      expect(statement!.Action).toBe("sts:AssumeRoleWithWebIdentity");
      expect(statement!.Principal).toEqual({ Federated: { "Fn::GetAtt": ["GitHubOidc", "Arn"] } });
      // Equality only: no StringLike, no wildcard subject.
      expect(Object.keys(statement!.Condition!)).toEqual(["StringEquals"]);
      const equals = statement!.Condition!.StringEquals!;
      expect(equals["token.actions.githubusercontent.com:aud"]).toBe("sts.amazonaws.com");
      const sub = equals["token.actions.githubusercontent.com:sub"] as { "Fn::Join": [string, unknown[]] };
      expect(sub["Fn::Join"][1][0]).toEqual({ Ref: "GitHubSubjectPrefix" });
      return sub["Fn::Join"][1][1];
    });
    expect(environments.sort()).toEqual([":environment:pack-signing", ":environment:release"]);
  });

  it("gives the pack signing role no identity policy: it can only sign", () => {
    const policies = resources("AWS::IAM::Policy");
    expect(policies).toHaveLength(1);
    expect(JSON.stringify(policies[0]!.Properties.Roles)).toContain("ReleasePublisher");
    for (const role of resources("AWS::IAM::Role")) {
      expect(role.Properties.ManagedPolicyArns).toBeUndefined();
      expect(role.Properties.Policies).toBeUndefined();
    }
  });

  it("lets the publisher write releases and push the image, and nothing destructive", () => {
    const doc = resources("AWS::IAM::Policy")[0]!.Properties.PolicyDocument as { Statement: Statement[] };
    const all = doc.Statement.flatMap(actions);
    expect(all.filter((a) => a.startsWith("s3:"))).toEqual(["s3:PutObject", "s3:PutObject"]);
    for (const action of all) {
      expect(action).not.toMatch(/\*|Delete|Policy|kms:|iam:/);
    }
    const star = doc.Statement.filter((s) => s.Resource === "*");
    expect(star.map((s) => s.Action)).toEqual(["ecr:GetAuthorizationToken"]);
  });

  it("keeps signing to the two roles, over a digest, and denies everyone else", () => {
    const key = resources("AWS::KMS::Key").find((k) => k.Properties.KeySpec === "ECC_NIST_P256")!;
    expect(key.Properties.KeyUsage).toBe("SIGN_VERIFY");
    const statements = (key.Properties.KeyPolicy as { Statement: Statement[] }).Statement;
    const admin = statements.find((s) => s.Sid === "AccountAdministersTheKey")!;
    expect(actions(admin)).not.toContain("kms:*");
    expect(actions(admin)).not.toContain("kms:Sign");
    expect(actions(admin)).not.toContain("kms:CreateGrant");
    const sign = statements.find((s) => s.Sid === "SigningJobsSignDigests")!;
    expect(sign.Condition).toEqual({
      StringEquals: { "kms:SigningAlgorithm": "ECDSA_SHA_256", "kms:MessageType": "DIGEST" },
    });
    const deny = statements.find((s) => s.Sid === "NobodyElseSignsOrDelegates")!;
    expect(deny.Effect).toBe("Deny");
    expect(actions(deny).sort()).toEqual(["kms:CreateGrant", "kms:Sign"]);
    expect(Object.keys(deny.Condition!)).toEqual(["ArnNotEquals"]);
  });

  it("lets only customer organizations read releases, without listing", () => {
    const policies = resources("AWS::S3::BucketPolicy").filter((p) => !JSON.stringify(p.Properties.Bucket).includes("AccessLogs"));
    expect(policies).toHaveLength(2);
    for (const policy of policies) {
      const statements = (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement;
      const allows = statements.filter((s) => s.Effect === "Allow");
      expect(allows).toHaveLength(1);
      expect(allows[0]!.Action).toBe("s3:GetObject");
      expect(allows[0]!.Condition).toEqual(ORG_CONDITION);
      expect(JSON.stringify(allows[0]!.Resource)).toContain("/mango/*");
    }
  });

  it("never overwrites nor deletes a published key", () => {
    const policies = resources("AWS::S3::BucketPolicy").filter((p) => !JSON.stringify(p.Properties.Bucket).includes("AccessLogs"));
    for (const policy of policies) {
      const statements = (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement;
      const bySid = (sid: string) => statements.find((s) => s.Sid === sid)!;
      expect(bySid("OnlyThePublisherWrites").Condition).toEqual({
        ArnNotEquals: { "aws:PrincipalArn": { "Fn::GetAtt": [expect.stringMatching(/^ReleasePublisher/), "Arn"] } },
      });
      expect(bySid("NeverOverwriteAPublishedKey").Condition).toEqual({
        Null: { "s3:if-none-match": "true" },
        Bool: { "s3:ObjectCreationOperation": "true" },
      });
      expect(bySid("NeverDeleteAPublishedObject").Effect).toBe("Deny");
    }
    for (const bucket of resources("AWS::S3::Bucket")) {
      expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
    }
    template.resourcePropertiesCountIs(
      "AWS::S3::Bucket",
      { ObjectLockEnabled: true, VersioningConfiguration: { Status: "Enabled" } },
      2,
    );
  });

  it("lets customer organizations pull the image by an immutable reference only", () => {
    const repository = resources("AWS::ECR::Repository")[0]!;
    expect(repository.Properties.ImageTagMutability).toBe("IMMUTABLE");
    const statements = (repository.Properties.RepositoryPolicyText as { Statement: Statement[] }).Statement;
    expect(statements).toHaveLength(1);
    expect(statements[0]!.Condition).toEqual(ORG_CONDITION);
    expect(actions(statements[0]!).sort()).toEqual([
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]);
  });

  it("alerts on signing misuse and on changes to roles, key, buckets and repository", () => {
    const names = resources("AWS::Events::Rule").map((r) => r.Properties.Name).sort();
    expect(names).toEqual([
      "Mango-provider-image-repository-change",
      "Mango-provider-release-store-change",
      "Mango-provider-role-change",
      "Mango-provider-signing-key-change",
      "Mango-provider-signing-misuse",
    ]);
  });

  it("retains the key, the buckets and the repository unless the account is temporary", () => {
    const kept = ["AWS::S3::Bucket", "AWS::ECR::Repository"];
    for (const [temporary, policy] of [[false, "Retain"], [true, "Delete"]] as const) {
      const t = synth(!temporary).toJSON() as { Resources: Record<string, { Type: string; DeletionPolicy?: string; Properties: Record<string, unknown> }> };
      for (const r of Object.values(t.Resources)) {
        if (kept.includes(r.Type) || r.Properties?.KeySpec === "ECC_NIST_P256") expect(r.DeletionPolicy).toBe(policy);
      }
    }
    expect(JSON.stringify(synth(false).toJSON())).not.toContain("NeverDeleteAPublishedObject");
  });
});
