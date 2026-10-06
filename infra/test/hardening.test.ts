import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { loadInstallation } from "../lib/config/schema.js";
import { CHECKOV_EXCEPTIONS } from "../lib/checkov.js";
import { GUARD_EXCEPTIONS } from "../lib/guard.js";
import { API_DRAIN_SECONDS, API_TASKS } from "../lib/constructs/api-service.js";
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

describe("web session cookie (D63)", () => {
  const distribution = Object.values(template.findResources("AWS::CloudFront::Distribution"))[0]!.Properties
    .DistributionConfig as {
    DefaultCacheBehavior: Record<string, unknown>;
    CacheBehaviors: Record<string, unknown>[];
    Logging: { IncludeCookies?: boolean };
  };
  // Managed policies of CloudFront (fixed ids).
  const CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";
  const CACHING_OPTIMIZED = "658327ea-f89d-4fab-a63d-7e88639e58f6";

  it("never caches /api/*, where tokens and Set-Cookie travel (TM-S7)", () => {
    const api = distribution.CacheBehaviors.find((b) => b.PathPattern === "/api/*");
    expect(api?.CachePolicyId).toBe(CACHING_DISABLED);
    expect(api?.ViewerProtocolPolicy).toBe("https-only");
  });

  it("does not send the cookie to the SPA bucket", () => {
    // The managed policy forwards no cookies, and no origin request policy adds them.
    expect(distribution.DefaultCacheBehavior.CachePolicyId).toBe(CACHING_OPTIMIZED);
    expect(distribution.DefaultCacheBehavior.OriginRequestPolicyId).toBeUndefined();
  });

  it("keeps cookies out of the CloudFront access logs (TM-S6)", () => {
    expect(distribution.Logging.IncludeCookies ?? false).toBe(false);
  });

  it("keeps session records in a protected table that expires them, without a stream", () => {
    template.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
      TableName: `Mango-${cfg.namespace}-WebSessions`,
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
      SSESpecification: { SSEEnabled: true, SSEType: "KMS" },
      Replicas: [
        Match.objectLike({
          PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
          DeletionProtectionEnabled: cfg.retainData,
        }),
      ],
    });
  });

  it("lets mango-api reach session records by key only", () => {
    const statements = Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
      (p) => p.Properties.PolicyDocument.Statement as { Sid?: string; Action: string[]; Resource: unknown }[],
    );
    const sessions = statements.filter((s) => s.Sid === "WebSessionsTable");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.Action).toEqual(["dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:PutItem"]);
    expect(JSON.stringify(sessions[0]!.Resource)).not.toContain('"*"');
  });

  it("tells mango-api its public origin, the sessions table and the session length", () => {
    const tasks = Object.values(template.findResources("AWS::ECS::TaskDefinition"));
    const env = tasks.flatMap(
      (t) => (t.Properties.ContainerDefinitions[0].Environment ?? []) as { Name: string; Value: unknown }[],
    );
    const value = (name: string) => env.find((e) => e.Name === name)?.Value;
    expect(value("SESSION_HOURS")).toBe("8");
    expect(value("WEB_SESSIONS_TABLE")).toBeDefined();
    expect(JSON.stringify(value("APP_ORIGIN"))).toContain("https://");
  });

  it("limits the session to 8 hours in Cognito as well", () => {
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", { RefreshTokenValidity: 8 * 60 });
  });
});

describe("mango-api on two tasks with shared rate limits (D70)", () => {
  type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Condition?: unknown };
  const statements = Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
    (p) => p.Properties.PolicyDocument.Statement as Statement[],
  );
  const [service] = Object.values(template.findResources("AWS::ECS::Service"));
  const [rateLimitsId] = Object.entries(template.findResources("AWS::DynamoDB::GlobalTable"))
    .filter(([, table]) => JSON.stringify(table.Properties.TableName).includes("-RateLimits"))
    .map(([id]) => id);

  it("runs two tasks, one subnet per zone, and puts them back in balance", () => {
    // The limits mango-api still counts per task are multiplied by this number: changing it
    // is a decision (D70), not a tuning knob.
    expect(API_TASKS).toBe(2);
    expect(service!.Properties.DesiredCount).toBe(API_TASKS);
    expect(service!.Properties.AvailabilityZoneRebalancing).toBe("ENABLED");
    const subnets = service!.Properties.NetworkConfiguration.AwsvpcConfiguration.Subnets as { Ref: string }[];
    expect(subnets).toHaveLength(cfg.availabilityZoneIds.length);
    const zones = subnets.map(
      (subnet) => template.findResources("AWS::EC2::Subnet")[subnet.Ref]!.Properties.AvailabilityZoneId,
    );
    expect(new Set(zones).size).toBe(2);
  });

  it("does not scale the service on its own", () => {
    template.resourceCountIs("AWS::ApplicationAutoScaling::ScalableTarget", 0);
  });

  it("never drops below two healthy tasks during a deployment, and rolls a failed one back", () => {
    expect(service!.Properties.DeploymentConfiguration).toMatchObject({
      MinimumHealthyPercent: 100,
      MaximumPercent: 200,
      DeploymentCircuitBreaker: { Enable: true, Rollback: true },
    });
  });

  it("lets a task being replaced finish the chat turns it has", () => {
    expect(API_DRAIN_SECONDS).toBe(120);
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
      TargetGroupAttributes: Match.arrayWith([
        { Key: "deregistration_delay.timeout_seconds", Value: String(API_DRAIN_SECONDS) },
      ]),
    });
    // The heartbeat of a turn (15 s) keeps it under the idle timeout of the load balancer.
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
      LoadBalancerAttributes: Match.arrayWith([{ Key: "idle_timeout.timeout_seconds", Value: "120" }]),
    });
  });

  it("does not pin a request to a task: any of them answers", () => {
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
      TargetGroupAttributes: Match.arrayWith([{ Key: "stickiness.enabled", Value: "false" }]),
    });
  });

  it("sends a request to the task with fewer requests open, not to each task in turn", () => {
    const [group] = Object.values(template.findResources("AWS::ElasticLoadBalancingV2::TargetGroup"));
    const attributes = Object.fromEntries(
      (group!.Properties.TargetGroupAttributes as { Key: string; Value: string }[]).map((a) => [a.Key, a.Value]),
    );
    expect(attributes["load_balancing.algorithm.type"]).toBe("least_outstanding_requests");
    // The load balancer refuses this algorithm together with slow start.
    expect(attributes["slow_start.duration_seconds"] ?? "0").toBe("0");
  });

  it("keeps the counters in a table with the guarantees of the others", () => {
    template.hasResource("AWS::DynamoDB::GlobalTable", {
      Properties: {
        TableName: `Mango-${cfg.namespace}-RateLimits`,
        BillingMode: "PAY_PER_REQUEST",
        TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
        SSESpecification: { SSEEnabled: true, SSEType: "KMS" },
        Replicas: [
          Match.objectLike({
            PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
            DeletionProtectionEnabled: cfg.retainData,
            SSESpecification: { KMSMasterKeyId: Match.anyValue() },
          }),
        ],
      },
      DeletionPolicy: cfg.retainData ? "Retain" : "Delete",
    });
    const table = template.findResources("AWS::DynamoDB::GlobalTable")[rateLimitsId!]!;
    expect(table.Metadata?.guard).toBeUndefined();
    expect(table.Metadata?.checkov).toBeUndefined();
    expect(table.Properties.StreamSpecification).toBeUndefined();
  });

  it("lets mango-api read and put its own counters, and nothing else of that table", () => {
    const onTable = statements.filter((s) => JSON.stringify(s.Resource).includes(rateLimitsId!));
    expect(onTable).toHaveLength(1);
    expect(onTable[0]).toEqual({
      Sid: "RateLimitsTable",
      Effect: "Allow",
      Action: ["dynamodb:GetItem", "dynamodb:PutItem"],
      Resource: { "Fn::GetAtt": [rateLimitsId, "Arn"] },
      Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["LIMIT#*"] } },
    });
  });

  it("gives the table to the task role of mango-api only", () => {
    const policies = Object.entries(template.findResources("AWS::IAM::Policy")).filter(([, p]) =>
      JSON.stringify(p.Properties.PolicyDocument).includes(rateLimitsId!),
    );
    expect(policies.map(([id]) => id)).toEqual([expect.stringMatching(/^ApiTaskRoleDefaultPolicy/)]);
  });

  it("tells mango-api where the counters are", () => {
    const [task] = Object.values(template.findResources("AWS::ECS::TaskDefinition"));
    const env = task!.Properties.ContainerDefinitions[0].Environment as { Name: string; Value: unknown }[];
    expect(env.find((e) => e.Name === "RATE_LIMITS_TABLE")?.Value).toEqual({ Ref: rateLimitsId });
  });
});
