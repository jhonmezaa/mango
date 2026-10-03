import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { loadInstallation } from "../lib/config/schema.js";
import { CHECKOV_EXCEPTIONS } from "../lib/checkov.js";
import { GUARD_EXCEPTIONS } from "../lib/guard.js";
import { CoreStack } from "../lib/stacks/core-stack.js";

const cfg = loadInstallation(resolve(import.meta.dirname, "../config/example.json"));
const app = new App();
const template = Template.fromStack(
  new CoreStack(app, "Core", { installation: cfg, env: { account: cfg.mangoAccountId, region: cfg.region } }),
);

function suppressed(resource: { Metadata?: { guard?: { SuppressedRules?: string[] } } }): string[] {
  return resource.Metadata?.guard?.SuppressedRules ?? [];
}

describe("hardening (cfn-guard, Well-Architected SEC)", () => {
  it("encrypts every CloudWatch log group with a customer-managed key", () => {
    const groups = Object.values(template.findResources("AWS::Logs::LogGroup"));
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) expect(group.Properties.KmsKeyId).toBeDefined();
  });

  it("does not auto-assign public IPs in any subnet", () => {
    template.allResourcesProperties("AWS::EC2::Subnet", { MapPublicIpOnLaunch: false });
  });

  it("versions the SPA bucket and expires old versions", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      VersioningConfiguration: { Status: "Enabled" },
      LifecycleConfiguration: {
        Rules: Match.arrayWith([Match.objectLike({ NoncurrentVersionExpiration: Match.anyValue() })]),
      },
    });
  });

  it("only suppresses agreed guard rules", () => {
    const allowed = new Set<string>(Object.values(GUARD_EXCEPTIONS));
    for (const resource of Object.values(template.toJSON().Resources as Record<string, never>)) {
      for (const rule of suppressed(resource)) expect(allowed).toContain(rule);
    }
  });

  it("keeps the TLS-only bucket policy suppression tied to an actual deny statement", () => {
    const policies = Object.values(template.findResources("AWS::S3::BucketPolicy"));
    for (const policy of policies) {
      if (!suppressed(policy).includes(GUARD_EXCEPTIONS.bucketTls)) continue;
      const statements = policy.Properties.PolicyDocument.Statement as {
        Effect: string;
        Condition?: { Bool?: Record<string, string> };
      }[];
      expect(
        statements.some((s) => s.Effect === "Deny" && s.Condition?.Bool?.["aws:SecureTransport"] === "false"),
      ).toBe(true);
    }
  });
});

type CheckovSkip = { id: string; comment?: string };

function checkovSkips(resource: { Metadata?: { checkov?: { skip?: CheckovSkip[] } } }): CheckovSkip[] {
  return resource.Metadata?.checkov?.skip ?? [];
}

describe("hardening (Checkov)", () => {
  it("only suppresses agreed Checkov checks, each with a reason", () => {
    const allowed = new Set<string>(Object.values(CHECKOV_EXCEPTIONS).map((e) => e.id));
    let total = 0;
    for (const resource of Object.values(template.toJSON().Resources as Record<string, never>)) {
      for (const skip of checkovSkips(resource)) {
        total += 1;
        expect(allowed).toContain(skip.id);
        expect(skip.comment?.length ?? 0).toBeGreaterThan(0);
      }
    }
    expect(total).toBeGreaterThan(0);
  });

  it("suppresses HTTPS/TLS on listeners only for the internal ALB", () => {
    const albIds = new Set<string>([CHECKOV_EXCEPTIONS.albHttps.id, CHECKOV_EXCEPTIONS.albTls.id]);
    const internal = Object.keys(
      template.findResources("AWS::ElasticLoadBalancingV2::LoadBalancer", {
        Properties: { Scheme: "internal" },
      }),
    );
    for (const listener of Object.values(template.findResources("AWS::ElasticLoadBalancingV2::Listener"))) {
      if (!checkovSkips(listener).some((s) => albIds.has(s.id))) continue;
      expect(internal).toContain(listener.Properties.LoadBalancerArn.Ref);
    }
  });

  it("encrypts Lambda environment variables of Mango functions with a customer-managed key", () => {
    const functions = template.findResources("AWS::Lambda::Function", {
      Properties: { FunctionName: Match.stringLikeRegexp("^Mango-") },
    });
    for (const fn of Object.values(functions)) {
      if (fn.Properties.Environment?.Variables) expect(fn.Properties.KmsKeyArn).toBeDefined();
    }
  });

  it("encrypts every Secrets Manager secret with a customer-managed key", () => {
    const secrets = Object.values(template.findResources("AWS::SecretsManager::Secret"));
    expect(secrets.length).toBeGreaterThan(0);
    for (const secret of secrets) expect(secret.Properties.KmsKeyId).toBeDefined();
  });

  it("scopes the provider and certificate suppressions to their resources", () => {
    const provider: string[] = [CHECKOV_EXCEPTIONS.cdkProviderWrite.id, CHECKOV_EXCEPTIONS.cdkProviderEnv.id];
    const resources = template.toJSON().Resources as Record<string, never>;
    for (const [logicalId, resource] of Object.entries(resources)) {
      const ids = checkovSkips(resource).map((s) => s.id);
      if (ids.some((id) => provider.includes(id))) {
        expect(logicalId).toMatch(/^CustomCDKBucketDeployment/);
      }
      if (ids.includes(CHECKOV_EXCEPTIONS.cloudfrontTls.id)) {
        const cert = (resource as { Properties: { DistributionConfig: { ViewerCertificate?: object } } })
          .Properties.DistributionConfig.ViewerCertificate;
        expect(cert === undefined || JSON.stringify(cert).includes('"CloudFrontDefaultCertificate":true')).toBe(true);
      }
      if (ids.includes(CHECKOV_EXCEPTIONS.runtimeImageToken.id)) {
        // The agent execution role and the permissions boundary of agent roles, nothing else.
        expect(logicalId).toMatch(/AgentExecutionRoleDefaultPolicy|^AgentPlatformBoundary/);
      }
    }
  });
});
